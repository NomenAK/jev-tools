import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  type FileHandle,
  lstat,
  open,
  readlink,
  realpath,
} from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  ASK_MAX_FILES,
  FIND_EXCERPT_CHARS,
  FIND_POINTER_EXCERPT_CHARS,
  FIND_READ_CHUNK_BYTES,
  STATE_MAX_CHARS,
  TIMEOUT_MS,
} from "../constants.ts";
import { createExcerptCollector } from "../core/find.ts";
import type { GitExec } from "../core/git.ts";
import type { FileIdentity } from "../core/integrity.ts";
import { isSecretPath, secretRefusal } from "../core/secret-path.ts";
import type { Result } from "../result.ts";
import type { Cause } from "../result-types.ts";
import { createUtf8Decoder, decodeUtf8 } from "./utf8.ts";

export async function checkFileAdmission(
  cwd: string,
  path: string,
  exec?: GitExec,
  signal?: AbortSignal,
  inventory?: ReadonlySet<string>,
): Promise<Result<object>> {
  if (path.split(/[\\/]/).includes(".git"))
    return {
      ok: false,
      cause: "forbidden_path",
      error: `${path}: .git metadata: not sent to Jev`,
    };
  // Before any inventory lookup or read: secret names are never admitted.
  if (isSecretPath(path))
    return { ok: false, cause: "secret_pattern", error: secretRefusal(path) };
  if (inventory)
    return inventory.has(path)
      ? { ok: true }
      : {
          ok: false,
          cause: "ignored_path",
          error: `${path}: outside admitted inventory: not sent to Jev`,
        };
  if (!exec) return { ok: true };
  const listed = await exec(
    "git",
    [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      path,
    ],
    { cwd, timeout: TIMEOUT_MS, signal },
  );
  if (listed.killed)
    return {
      ok: false,
      cause: signal?.aborted ? "cancelled" : "git_failure",
      error: `${path}: file admission interrupted`,
    };
  if (listed.code === 0 && !listed.stdout.split("\0").includes(path))
    return {
      ok: false,
      cause: "ignored_path",
      error: `${path}: gitignored: not sent to Jev`,
    };
  return { ok: true };
}

// Accepted TOCTOU limit: these checks and the later open are not atomic, so a
// concurrent writer to the repository could swap a path component in between;
// O_NOFOLLOW bounds the final component only.
export async function resolveInsideRepo(
  root: string,
  path: string,
  options: { allowLeafSymlink?: boolean } = {},
): Promise<Result<{ abs: string; rel: string }>> {
  if (isAbsolute(path) || path.split(/[\\/]/).includes(".."))
    return {
      ok: false,
      cause: "forbidden_path",
      error: `Path must remain inside the repository: ${path}.`,
    };
  try {
    const base = await realpath(root);
    const requested = resolve(base, path);
    const rel = relative(base, requested);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
      return {
        ok: false,
        cause: "forbidden_path",
        error: `Path escapes the repository: ${path}.`,
      };
    let current = base;
    for (const part of rel.split(sep).filter(Boolean)) {
      current = resolve(current, part);
      if ((await lstat(current)).isSymbolicLink()) {
        if (options.allowLeafSymlink && current === requested)
          return { ok: true, abs: requested, rel: rel.replaceAll(sep, "/") };
        return {
          ok: false,
          cause: "symlink",
          error: `Symbolic links are not read: ${path}.`,
        };
      }
    }
    const abs = await realpath(requested);
    const actual = relative(base, abs);
    if (actual === ".." || actual.startsWith(`..${sep}`) || isAbsolute(actual))
      return {
        ok: false,
        cause: "forbidden_path",
        error: `Path escapes the repository: ${path}.`,
      };
    return { ok: true, abs, rel: actual.replaceAll(sep, "/") };
  } catch (error) {
    return {
      ok: false,
      cause: "file_unavailable",
      error: `Cannot resolve ${path}: ${String(error)}`,
    };
  }
}

/** Leaf-link metadata is admitted without following the target. */
export async function admitRepoMetadata(
  cwd: string,
  path: string,
  exec?: GitExec,
  signal?: AbortSignal,
  inventory?: ReadonlySet<string>,
): Promise<Result<{ abs: string; rel: string }>> {
  const location = await resolveInsideRepo(cwd, path, {
    allowLeafSymlink: true,
  });
  if (!location.ok) return location;
  const admission = await checkFileAdmission(
    cwd,
    location.rel,
    exec,
    signal,
    inventory,
  );
  return admission.ok ? location : admission;
}

/**
 * History is admitted by its tracked base tree, independent of worktree ignores or links.
 * Invariant: an admitted path only ever feeds git object reads (ls-tree/show), never a
 * worktree open, so a worktree symlink cannot redirect the read; links are not resolved here.
 */
export async function admitGitPath(
  cwd: string,
  path: string,
  base: string,
  exec: GitExec,
  signal?: AbortSignal,
  inventory?: ReadonlyMap<string, string>,
): Promise<Result<object>> {
  if (isAbsolute(path) || path.split(/[\\/]/).includes(".."))
    return {
      ok: false,
      cause: "forbidden_path",
      error: `Path must remain inside the repository: ${path}.`,
    };
  const admission = await checkFileAdmission(cwd, path, undefined, signal);
  if (!admission.ok) return admission;
  // ls-tree cannot descend through a symlink or gitlink ancestor in the base tree.
  let entry = inventory?.get(path);
  if (!inventory) {
    const tree = await exec(
      "git",
      ["ls-tree", "-z", "--full-tree", "--end-of-options", base, "--", path],
      { cwd, timeout: TIMEOUT_MS, signal },
    );
    if (tree.code !== 0 || tree.killed)
      return {
        ok: false,
        cause: signal?.aborted ? "cancelled" : "git_failure",
        error: `${path}: comparison base tree unavailable`,
      };
    entry = tree.stdout
      .split("\0")
      .find((item) => item.slice(item.indexOf("\t") + 1) === path);
  }
  if (!entry || !/^(?:100644|100755|120000) blob /.test(entry))
    return {
      ok: false,
      cause: "file_unavailable",
      error: `${path}: not a file at comparison base`,
    };
  return { ok: true };
}

/**
 * The only content opener for repository files. Callers own and close the handle.
 * TOCTOU: resolveInsideRepo and this open are separate steps, so a concurrent writer
 * could swap a parent component; O_NOFOLLOW rejects a swapped leaf symlink.
 */
export async function openRepoFile(
  cwd: string,
  path: string,
  options: {
    exec?: GitExec;
    signal?: AbortSignal;
    inventory?: ReadonlySet<string>;
  } = {},
): Promise<Result<{ handle: FileHandle; size: number }>> {
  try {
    options.signal?.throwIfAborted();
    const location = await resolveInsideRepo(cwd, path);
    if (!location.ok) return location;
    const admission = await checkFileAdmission(
      cwd,
      location.rel,
      options.exec,
      options.signal,
      options.inventory,
    );
    if (!admission.ok) return admission;
    const handle = await open(
      location.abs,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) {
        await handle.close();
        return {
          ok: false,
          cause: "file_unavailable",
          error: `Not a file: ${path}.`,
        };
      }
      return { ok: true, handle, size: stat.size };
    } catch (error) {
      await handle.close();
      throw error;
    }
  } catch (error) {
    return {
      ok: false,
      cause: options.signal?.aborted
        ? "cancelled"
        : (error as NodeJS.ErrnoException).code === "ELOOP"
          ? "symlink"
          : "file_unavailable",
      error: `Cannot read ${path}: ${String(error)}`,
    };
  }
}

export async function collectFiles(
  cwd: string,
  paths: string[],
  signal?: AbortSignal,
  options: {
    exec?: GitExec;
    allowEmpty?: boolean;
    skipInvalidUtf8?: boolean;
    inventory?: ReadonlySet<string>;
  } = {},
): Promise<
  Result<{
    files: Record<string, string>;
    identities: FileIdentity[];
    skipped: string[];
  }>
> {
  for (const path of paths) {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path))
      return {
        ok: false,
        cause: "forbidden_path",
        error: `Internal URLs are not files; use read for ${path}.`,
      };
    const admission = await resolveInsideRepo(cwd, path);
    if (!admission.ok) return admission;
  }
  paths = [
    ...new Set(
      paths.map((path) =>
        relative(cwd, resolve(cwd, path)).split("\\").join("/"),
      ),
    ),
  ].sort();
  if (paths.length > ASK_MAX_FILES)
    return {
      ok: false,
      cause: "evidence_too_large",
      error: `paths exceeds ${ASK_MAX_FILES} files; split paths into several calls.`,
    };
  const results = await Promise.all(
    paths.map(async (path) => {
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path))
        return {
          ok: false as const,
          cause: "forbidden_path" as const,
          error: `Internal URLs are not files; use read for ${path}.`,
        };
      let handle: FileHandle | undefined;
      try {
        signal?.throwIfAborted();
        const opened = await openRepoFile(cwd, path, {
          exec: options.exec,
          signal,
          inventory: options.inventory,
        });
        if (!opened.ok) return opened;
        handle = opened.handle;
        const bytes = Buffer.alloc(
          Math.min(opened.size + 1, STATE_MAX_CHARS * 4 + 1),
        );
        let count = 0;
        while (count < bytes.length) {
          signal?.throwIfAborted();
          const read = await handle.read(
            bytes,
            count,
            bytes.length - count,
            null,
          );
          if (!read.bytesRead) break;
          count += read.bytesRead;
        }
        if (count === bytes.length)
          return {
            ok: false as const,
            cause: "evidence_too_large" as const,
            error: `File exceeds ${STATE_MAX_CHARS} chars: ${path}; files are never truncated. Split paths into several calls.`,
          };
        const decoded = decodeUtf8(bytes.subarray(0, count));
        if (!decoded.ok || (decoded.ok && decoded.text.includes("\0")))
          return {
            ok: false as const,
            invalidUtf8: true,
            cause: "binary_or_non_utf8" as const,
            error: `${path} is not UTF-8 text; provide a UTF-8 text file instead.`,
          };
        const text = decoded.text;
        if (count === bytes.length || text.length > STATE_MAX_CHARS)
          return {
            ok: false as const,
            cause: "evidence_too_large" as const,
            error: `File exceeds ${STATE_MAX_CHARS} chars: ${path}; files are never truncated. Split paths into several calls.`,
          };
        if (!text.length && !options.allowEmpty)
          return {
            ok: false as const,
            cause: "empty_required" as const,
            error: `${path} is empty.`,
          };
        return {
          ok: true as const,
          path,
          text,
          identity: {
            requestedPath: path,
            resolvedPath: resolve(cwd, path),
            insertedPath: resolve(cwd, path),
            content: text,
            readSha256: createHash("sha256")
              .update(bytes.subarray(0, count))
              .digest("hex"),
            insertedSha256: createHash("sha256").update(text).digest("hex"),
          },
        };
      } catch (error) {
        return {
          ok: false as const,
          cause: signal?.aborted
            ? ("cancelled" as const)
            : ("file_unavailable" as const),
          error: `Cannot read ${path}: ${String(error)}`,
        };
      } finally {
        await handle?.close();
      }
    }),
  );
  const failure = results.find(
    (result) =>
      !result.ok && !(options.skipInvalidUtf8 && "invalidUtf8" in result),
  );
  if (failure && !failure.ok) return failure;
  return {
    ok: true,
    skipped: results.flatMap((result) =>
      !result.ok && "invalidUtf8" in result ? [result.error] : [],
    ),
    identities: results.flatMap((result) =>
      result.ok ? [result.identity] : [],
    ),
    files: Object.fromEntries(
      results.flatMap((result) =>
        result.ok ? [[result.path, result.text]] : [],
      ),
    ),
  };
}

export async function collectSearchExcerpts(
  cwd: string,
  paths: readonly string[],
  keywords: readonly string[],
  signal?: AbortSignal,
  exec?: GitExec,
): Promise<
  Result<{
    files: Record<string, string>;
    pointers: Record<string, string>;
    ignored: string[];
    limits: { path: string; reason: string }[];
    omissions: { path: string; cause: Cause; reason: string }[];
  }>
> {
  const files: Record<string, string> = {},
    pointers: Record<string, string> = {};
  const ignored: string[] = [];
  const limits: { path: string; reason: string }[] = [];
  const omissions: { path: string; cause: Cause; reason: string }[] = [];
  const results = await Promise.all(
    paths.map(async (path) => {
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path))
        return {
          ok: false as const,
          cause: "forbidden_path" as const,
          error: `Internal URLs are not files; use read for ${path}.`,
        };
      try {
        const location = await admitRepoMetadata(cwd, path, exec, signal);
        if (!location.ok) {
          ignored.push(path);
          omissions.push({
            path,
            cause: location.cause ?? "file_unavailable",
            reason: location.error,
          });
          return { ok: true as const };
        }
        if ((await lstat(location.abs)).isSymbolicLink()) {
          const target = await readlink(location.abs);
          files[path] = target;
          pointers[path] = target;
          return { ok: true as const };
        }
        const opened = await openRepoFile(cwd, path, { exec, signal });
        if (!opened.ok) {
          ignored.push(path);
          omissions.push({
            path,
            cause: opened.cause ?? "file_unavailable",
            reason: opened.error,
          });
          return { ok: true as const };
        }
        const handle = opened.handle;
        const content = createExcerptCollector(keywords, FIND_EXCERPT_CHARS);
        const pointer = createExcerptCollector(
          keywords,
          FIND_POINTER_EXCERPT_CHARS,
        );
        const decode = createUtf8Decoder();
        const stream = handle.createReadStream({
          highWaterMark: FIND_READ_CHUNK_BYTES,
          signal,
        });
        for await (const chunk of stream) {
          const decoded = decode(chunk as Buffer);
          if (!decoded.ok) {
            limits.push({ path, reason: decoded.error });
            omissions.push({
              path,
              cause: "binary_or_non_utf8",
              reason: decoded.error,
            });
            ignored.push(path);
            stream.destroy();
            return { ok: true as const };
          }
          const text = decoded.text;
          if (text.includes("\0")) {
            ignored.push(path);
            omissions.push({
              path,
              cause: "binary_or_non_utf8",
              reason: "Binary NUL content is not sent to Jev",
            });
            stream.destroy();
            return { ok: true as const };
          }
          content.push(text);
          pointer.push(text);
        }
        const end = decode();
        if (!end.ok) {
          limits.push({ path, reason: end.error });
          omissions.push({
            path,
            cause: "binary_or_non_utf8",
            reason: end.error,
          });
          ignored.push(path);
          return { ok: true as const };
        }
        content.push(end.text);
        pointer.push(end.text);
        const excerpt = content.finish();
        if (!excerpt.length) {
          ignored.push(path);
          omissions.push({
            path,
            cause: "collection_empty",
            reason: "No non-empty search excerpt was collected",
          });
          return { ok: true as const };
        }
        files[path] = excerpt;
        pointers[path] = pointer.finish();
        return { ok: true as const };
      } catch (error) {
        if (signal?.aborted)
          return {
            ok: false as const,
            cause: "cancelled" as const,
            error: String(error),
          };
        ignored.push(path);
        omissions.push({
          path,
          cause: "file_unavailable",
          reason: String(error),
        });
        return { ok: true as const };
      }
    }),
  );
  const failure = results.find((result) => !result.ok);
  return failure && !failure.ok
    ? failure
    : { ok: true, files, pointers, ignored, limits, omissions };
}

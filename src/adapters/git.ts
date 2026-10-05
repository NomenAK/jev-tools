import { type FileHandle, lstat, readlink } from "node:fs/promises";
import { resolve } from "node:path";
import {
  GIT_BLOB_BATCH_SIZE,
  STATE_MAX_CHARS,
  TIMEOUT_MS,
} from "../constants.ts";
import { type DiffFile, parseDiff } from "../core/diff.ts";
import type { GitExec } from "../core/git.ts";
import { isSecretPath } from "../core/secret-path.ts";
import {
  buildUnits,
  type EvidenceUnit,
  type SourceFile,
  type SyntaxParser,
  type UnitLimit,
} from "../core/units.ts";
import type { Result } from "../result.ts";
import { admitGitPath, admitRepoMetadata, openRepoFile } from "./files.ts";
import { shareGitInventory } from "./git-inventory.ts";
import { loadSyntaxParser } from "./syntax.ts";
import { decodeUtf8, verifyGitUtf8 } from "./utf8.ts";

export type CollectionResult<T> =
  | Result<T>
  | {
      ok: false;
      kind: "inconsistent_diff";
      cause: "git_failure";
      error: string;
    };
export interface DiffOptions {
  cwd: string;
  base: string;
  paths?: string[];
  signal?: AbortSignal;
}
const config = [
  "-c",
  "color.ui=false",
  "-c",
  "core.quotePath=true",
  "-c",
  "diff.suppressBlankEmpty=false",
  "-c",
  "diff.relative=false",
  "-c",
  "diff.noprefix=false",
  "-c",
  "diff.mnemonicPrefix=false",
  "-c",
  "diff.algorithm=myers",
  "-c",
  "diff.indentHeuristic=false",
];
async function git(
  exec: GitExec,
  options: DiffOptions,
  args: string[],
): Promise<Result<{ text: string }>> {
  try {
    options.signal?.throwIfAborted();
    const result = await exec("git", [...config, ...args], {
      cwd: options.cwd,
      timeout: TIMEOUT_MS,
      signal: options.signal,
    });
    if (result.killed)
      return {
        ok: false,
        cause: options.signal?.aborted ? "cancelled" : "git_failure",
        error: "Git interrupted (cancelled or timed out).",
      };
    if (result.code !== 0)
      return {
        ok: false,
        cause: "git_failure",
        error: `Git failed: ${result.stderr}`,
      };
    return { ok: true, text: result.stdout };
  } catch (error) {
    return {
      ok: false,
      cause: options.signal?.aborted ? "cancelled" : "git_failure",
      error: `Unable to execute git: ${String(error)}`,
    };
  }
}
type ReadSource = {
  text: string;
  binary: boolean;
  limitation?: "too_large" | "unreadable" | "not UTF-8 text";
};
async function readWorktree(
  options: DiffOptions,
  exec: GitExec,
  path: string,
  inventory: ReadonlySet<string>,
): Promise<ReadSource> {
  let handle: FileHandle | undefined;
  try {
    options.signal?.throwIfAborted();
    const location = await admitRepoMetadata(
      options.cwd,
      path,
      exec,
      options.signal,
      inventory,
    );
    if (!location.ok)
      return { text: "", binary: false, limitation: "unreadable" };
    const stat = await lstat(location.abs);
    if (stat.isSymbolicLink())
      return { text: await readlink(location.abs), binary: false };
    if (stat.size > STATE_MAX_CHARS)
      return { text: "", binary: false, limitation: "too_large" };
    const opened = await openRepoFile(options.cwd, path, {
      exec,
      signal: options.signal,
      inventory,
    });
    if (!opened.ok)
      return { text: "", binary: false, limitation: "unreadable" };
    handle = opened.handle;
    const buffer = Buffer.alloc(STATE_MAX_CHARS + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        null,
      );
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > STATE_MAX_CHARS)
      return { text: "", binary: false, limitation: "too_large" };
    const bytes = buffer.subarray(0, offset);
    const decoded = decodeUtf8(bytes);
    return decoded.ok
      ? { text: decoded.text, binary: bytes.includes(0) }
      : { text: "", binary: false, limitation: "not UTF-8 text" };
  } catch {
    return { text: "", binary: false, limitation: "unreadable" };
  } finally {
    await handle?.close();
  }
}
async function readGitBlobs(
  exec: GitExec,
  options: DiffOptions,
  objects: readonly { id: string; size: number }[],
): Promise<
  Result<{ blobs: ReadonlyMap<string, string>; invalid: ReadonlySet<string> }>
> {
  const blobs = new Map<string, string>();
  const invalid = new Set<string>();
  for (let offset = 0; offset < objects.length; offset += GIT_BLOB_BATCH_SIZE) {
    const batch = objects.slice(offset, offset + GIT_BLOB_BATCH_SIZE);
    const result = await git(exec, options, [
      "show",
      "--no-ext-diff",
      "--no-textconv",
      "--end-of-options",
      ...batch.map((object) => object.id),
    ]);
    if (!result.ok) return result;
    const bytes = Buffer.from(result.text, "utf8");
    if (bytes.length !== batch.reduce((sum, object) => sum + object.size, 0)) {
      // Host decoding can replace invalid UTF-8: never split subsequent blobs at shifted offsets.
      for (const object of batch) {
        const single = await git(exec, options, [
          "show",
          "--no-ext-diff",
          "--no-textconv",
          "--end-of-options",
          object.id,
        ]);
        if (!single.ok) return single;
        const decoded = verifyGitUtf8(single.text, object.id, object.size);
        if (decoded.ok) blobs.set(object.id, decoded.text);
        else invalid.add(object.id);
      }
      continue;
    }
    let position = 0;
    for (const object of batch) {
      const decoded = verifyGitUtf8(
        bytes.subarray(position, position + object.size).toString("utf8"),
        object.id,
        object.size,
      );
      if (decoded.ok) blobs.set(object.id, decoded.text);
      else invalid.add(object.id);
      position += object.size;
    }
  }
  return { ok: true, blobs, invalid };
}
export async function collectDiff(
  exec: GitExec,
  options: DiffOptions,
): Promise<CollectionResult<{ files: SourceFile[] }>> {
  exec = shareGitInventory(exec);
  const root = await git(exec, options, ["rev-parse", "--show-toplevel"]);
  if (!root.ok) return root;
  const cwd = root.text.replace(/\n$/, "");
  const scoped = { ...options, cwd };
  const location = await git(exec, options, ["rev-parse", "--show-prefix"]);
  if (!location.ok) return location;
  const repositoryPrefix = location.text.replace(/\n$/, "");
  const paths = [
    "--",
    ...(options.paths ?? []).map(
      (path) => `:(top,literal)${repositoryPrefix}${path}`,
    ),
  ];
  const rawResult = await git(exec, scoped, [
    "diff",
    "--raw",
    "-z",
    "--no-ext-diff",
    "--no-textconv",
    "--ignore-submodules=none",
    "--end-of-options",
    options.base,
    ...paths,
  ]);
  if (!rawResult.ok) return rawResult;
  const untrackedResult = await git(exec, scoped, [
    "ls-files",
    "--full-name",
    "--others",
    "--exclude-standard",
    "-z",
    ...paths,
  ]);
  if (!untrackedResult.ok) return untrackedResult;
  let candidates: DiffFile[];
  try {
    candidates = parseDiff({
      raw: rawResult.text,
      numstat: "",
      patch: "",
      untracked: untrackedResult.text.split("\0").filter(Boolean),
    });
  } catch {
    return {
      ok: false,
      cause: "git_failure",
      error: "Inconsistent Git snapshots; collect again.",
      kind: "inconsistent_diff",
    };
  }
  const unsupported: string[] = [];
  // Secret-named paths (either side of a rename) stay named exclusions;
  // excluding them from every later pathspec keeps Git from emitting their
  // patch text or pairing them into a rename.
  const secret = candidates
    .filter((file) => isSecretPath(file.path) || isSecretPath(file.oldPath))
    .map((file) => file.path);
  await Promise.all(
    candidates.map(async (file) => {
      if (secret.includes(file.path)) return;
      try {
        const stat = await lstat(resolve(cwd, file.path));
        if (
          !stat.isFile() &&
          !stat.isSymbolicLink() &&
          file.oldMode !== "160000" &&
          file.newMode !== "160000"
        )
          unsupported.push(file.path);
      } catch {
        /* Missing tracked paths remain deletions. */
      }
    }),
  );
  for (const path of [...unsupported, ...secret])
    paths.push(`:(top,exclude,literal)${path}`);
  for (const file of candidates)
    if (secret.includes(file.path) && file.oldPath !== file.path)
      paths.push(`:(top,exclude,literal)${file.oldPath}`);
  const prefix = [
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--find-renames",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    "--no-relative",
    "--line-prefix=",
    "--submodule=short",
    "--ignore-submodules=none",
  ];
  const results = await Promise.all([
    git(exec, scoped, [
      ...prefix,
      "--raw",
      "-z",
      "--end-of-options",
      options.base,
      ...paths,
    ]),
    git(exec, scoped, [
      ...prefix,
      "--numstat",
      "-z",
      "--end-of-options",
      options.base,
      ...paths,
    ]),
    git(exec, scoped, [
      ...prefix,
      "--patch",
      "--unified=8",
      "--end-of-options",
      options.base,
      ...paths,
    ]),
    git(exec, scoped, [
      "ls-files",
      "--full-name",
      "--others",
      "--exclude-standard",
      "-z",
      ...paths,
    ]),
    git(exec, scoped, [
      "ls-files",
      "--full-name",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
    ]),
    git(exec, scoped, [
      "ls-tree",
      "-r",
      "--long",
      "-z",
      "--full-tree",
      "--end-of-options",
      options.base,
    ]),
  ]);
  for (const result of results) if (!result.ok) return result;
  const [raw, numstat, patch, untracked, current, base] = results;
  if (
    !raw.ok ||
    !numstat.ok ||
    !patch.ok ||
    !untracked.ok ||
    !current.ok ||
    !base.ok
  )
    return {
      ok: false,
      cause: "git_failure",
      error: "Incomplete Git collection.",
    };
  const currentInventory = new Set(current.text.split("\0").filter(Boolean));
  const baseInventory = new Map<string, string>();
  for (const entry of base.text.split("\0")) {
    const separator = entry.indexOf("\t");
    if (separator !== -1) baseInventory.set(entry.slice(separator + 1), entry);
  }
  let files: DiffFile[];
  try {
    files = parseDiff({
      raw: raw.text,
      numstat: numstat.text,
      patch: patch.text,
      verifyPaths: true,
      untracked: untracked.text.split("\0").filter(Boolean),
    });
  } catch {
    return {
      ok: false,
      cause: "git_failure",
      error: "Inconsistent Git snapshots; collect again.",
      kind: "inconsistent_diff",
    };
  }
  files.push(
    ...candidates.filter(
      (file) => unsupported.includes(file.path) || secret.includes(file.path),
    ),
  );
  const objects = new Map<string, { id: string; size: number }>();
  for (const file of files) {
    if (
      /^[A?]/.test(file.status) ||
      file.binary ||
      unsupported.includes(file.path) ||
      secret.includes(file.path)
    )
      continue;
    const admission = await admitGitPath(
      cwd,
      file.oldPath,
      options.base,
      exec,
      options.signal,
      baseInventory,
    );
    if (!admission.ok) continue;
    const entry = baseInventory.get(file.oldPath);
    const match =
      entry &&
      /^(?:100644|100755|120000) blob ([0-9a-f]+)\s+(\d+)\t/.exec(entry);
    if (match)
      objects.set(file.oldPath, { id: match[1] ?? "", size: Number(match[2]) });
  }
  const uniqueObjects = new Map(
    [...objects.values()]
      .filter((object) => object.size <= STATE_MAX_CHARS)
      .map((object) => [object.id, object]),
  );
  const loaded = await readGitBlobs(exec, scoped, [...uniqueObjects.values()]);
  if (!loaded.ok) return loaded;
  const collectFile = async (
    file: DiffFile,
  ): Promise<CollectionResult<{ file: SourceFile }>> => {
    if (secret.includes(file.path))
      return {
        ok: true,
        file: {
          ...file,
          hunks: [],
          binary: false,
          before: null,
          after: null,
          limitation: "secret_pattern",
        },
      };
    const historical = !/^[A?]/.test(file.status);
    const admission = historical
      ? await admitGitPath(
          cwd,
          file.oldPath,
          options.base,
          exec,
          options.signal,
          baseInventory,
        )
      : await admitRepoMetadata(
          cwd,
          file.path,
          exec,
          options.signal,
          currentInventory,
        );
    if (!admission.ok)
      return {
        ok: true,
        file: {
          ...file,
          hunks: [],
          before: null,
          after: null,
          limitation: "unreadable",
        },
      };
    if (unsupported.includes(file.path)) {
      return {
        ok: true,
        file: { ...file, before: null, after: null, limitation: "unreadable" },
      };
    }
    if (file.binary) {
      return { ok: true, file: { ...file, before: null, after: null } };
    }
    if (file.oldMode === "160000" || file.newMode === "160000") {
      return {
        ok: true,
        file: { ...file, before: null, after: null, limitation: "unreadable" },
      };
    }
    if (file.status === "D") {
      try {
        const replacement = await lstat(resolve(cwd, file.path));
        if (!replacement.isFile() && !replacement.isSymbolicLink()) {
          return {
            ok: true,
            file: {
              ...file,
              before: null,
              after: null,
              limitation: "unreadable",
            },
          };
        }
      } catch {
        /* A genuinely deleted path has no worktree version. */
      }
    }
    let before = "";
    let limitation: ReadSource["limitation"];
    if (!/^[A?]/.test(file.status)) {
      const object = objects.get(file.oldPath);
      if (!object)
        return {
          ok: false,
          cause: "git_failure",
          error: "Incomplete Git base tree; collect again.",
        };
      if (object.size > STATE_MAX_CHARS) limitation = "too_large";
      else if (loaded.invalid.has(object.id)) limitation = "not UTF-8 text";
      else before = loaded.blobs.get(object.id) ?? "";
    }
    const after =
      file.status === "D"
        ? { text: "", binary: false }
        : await readWorktree(scoped, exec, file.path, currentInventory);
    limitation = after.limitation ?? limitation;
    const unverifiableHunk =
      limitation === "too_large" &&
      file.hunks.some(
        (hunk) =>
          (hunk.beforeText ?? "").includes("\uFFFD") ||
          (hunk.afterText ?? "").includes("\uFFFD"),
      );
    if (unverifiableHunk) limitation = "not UTF-8 text";
    return {
      ok: true,
      file: {
        ...file,
        hunks:
          after.limitation === "unreadable" || limitation === "not UTF-8 text"
            ? file.hunks.map(
                ({ beforeText: _before, afterText: _after, ...hunk }) => hunk,
              )
            : file.hunks,
        binary: after.binary,
        limitation,
        before:
          /^[A?]/.test(file.status) ||
          limitation === "too_large" ||
          limitation === "not UTF-8 text"
            ? null
            : before,
        after: file.status === "D" || limitation ? null : after.text,
      },
    };
  };
  const sources: SourceFile[] = [];
  for (let offset = 0; offset < files.length; offset += 4) {
    const batch = await Promise.all(
      files.slice(offset, offset + 4).map(collectFile),
    );
    for (const result of batch) {
      if (!result.ok) return result;
      sources.push(result.file);
    }
  }
  return { ok: true, files: sources };
}
export async function collectUnits(
  exec: GitExec,
  options: DiffOptions,
  sourceParser?: SyntaxParser,
): Promise<
  CollectionResult<{
    files: SourceFile[];
    units: EvidenceUnit[];
    limits: UnitLimit[];
  }>
> {
  const [diff, parser] = await Promise.all([
    collectDiff(exec, options),
    sourceParser ?? loadSyntaxParser(),
  ]);
  if (!diff.ok) return diff;
  return { ok: true, files: diff.files, ...buildUnits(diff.files, parser) };
}

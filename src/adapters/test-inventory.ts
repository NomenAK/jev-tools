import { type FileHandle, lstat } from "node:fs/promises";
import { TEST_SOURCE_MAX_BYTES, TIMEOUT_MS } from "../constants.ts";
import type { GitExec } from "../core/git.ts";
import type { ImportSource } from "../core/imports.ts";
import { isSecretPath } from "../core/secret-path.ts";
import type { Result } from "../result.ts";
import {
  checkFileAdmission,
  openRepoFile,
  resolveInsideRepo,
} from "./files.ts";
import { decodeUtf8 } from "./utf8.ts";

export async function collectTestInventory(
  exec: GitExec,
  cwd: string,
  signal?: AbortSignal,
): Promise<
  Result<{
    cwd: string;
    paths: readonly string[];
    read(path: string): Promise<ImportSource | undefined>;
    limits: readonly {
      path: string;
      kind: "unreadable" | "too_large" | "not UTF-8 text" | "secret_pattern";
    }[];
  }>
> {
  const root = await exec("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    timeout: TIMEOUT_MS,
    signal,
  });
  if (root.code !== 0 || root.killed)
    return {
      ok: false,
      cause: signal?.aborted ? "cancelled" : "git_failure",
      error: root.stderr || "Cannot identify repository root.",
    };
  cwd = root.stdout.replace(/\n$/, "");
  const listed = await exec(
    "git",
    [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "--full-name",
      "-z",
    ],
    { cwd, timeout: TIMEOUT_MS, signal },
  );
  if (listed.code !== 0 || listed.killed)
    return {
      ok: false,
      cause: signal?.aborted ? "cancelled" : "git_failure",
      error: listed.stderr || "Cannot inventory repository files.",
    };
  const ignored = await exec(
    "git",
    ["ls-files", "--cached", "--ignored", "--exclude-standard", "-z"],
    { cwd, timeout: TIMEOUT_MS, signal },
  );
  if (ignored.code !== 0 || ignored.killed)
    return {
      ok: false,
      cause: signal?.aborted ? "cancelled" : "git_failure",
      error: ignored.stderr || "Cannot identify ignored tracked files.",
    };
  const excluded = new Set(ignored.stdout.split("\0").filter(Boolean));
  const listedPaths = listed.stdout
    .split("\0")
    .filter(
      (path) =>
        path &&
        (!excluded.has(path) ||
          /(?:^|\/)(?:package|tsconfig[^/]*)\.json$/.test(path)),
    );
  // Secret-named files are named exclusions, never inventory members to read.
  const paths = listedPaths.filter((path) => !isSecretPath(path));
  const admitted = new Set(paths);
  const limits: {
    path: string;
    kind: "unreadable" | "too_large" | "not UTF-8 text" | "secret_pattern";
  }[] = listedPaths
    .filter(isSecretPath)
    .map((path) => ({ path, kind: "secret_pattern" as const }));
  const cache = new Map<string, Promise<ImportSource | undefined>>();
  for (let offset = 0; offset < paths.length; offset += 16) {
    const inspected = await Promise.all(
      paths.slice(offset, offset + 16).map(async (path) => {
        try {
          signal?.throwIfAborted();
          const admission = await checkFileAdmission(
            cwd,
            path,
            exec,
            signal,
            admitted,
          );
          if (!admission.ok) return "unreadable" as const;
          const resolved = await resolveInsideRepo(cwd, path);
          if (!resolved.ok) return "unreadable" as const;
          const stat = await lstat(resolved.abs);
          if (!stat.isFile()) return "unreadable" as const;
          return stat.size > TEST_SOURCE_MAX_BYTES
            ? ("too_large" as const)
            : undefined;
        } catch {
          return "unreadable" as const;
        }
      }),
    );
    for (const [index, kind] of inspected.entries()) {
      if (!kind) continue;
      const path = paths[offset + index];
      if (path === undefined || cache.has(path)) continue;
      limits.push({ path, kind });
      cache.set(path, Promise.resolve(undefined));
    }
  }
  const read = (path: string): Promise<ImportSource | undefined> => {
    const cached = cache.get(path);
    if (cached) return cached;
    const pending = (async () => {
      let handle: FileHandle | undefined;
      try {
        signal?.throwIfAborted();
        const opened = await openRepoFile(cwd, path, {
          exec,
          signal,
          inventory: admitted,
        });
        if (!opened.ok) return { path, kind: "unreadable" as const };
        handle = opened.handle;
        const stat = { size: opened.size };
        if (stat.size > TEST_SOURCE_MAX_BYTES)
          return { path, kind: "too_large" as const };
        const bytes = Buffer.alloc(
          Math.min(stat.size + 1, TEST_SOURCE_MAX_BYTES + 1),
        );
        let count = 0;
        while (count < bytes.length) {
          signal?.throwIfAborted();
          const part = await handle.read(
            bytes,
            count,
            bytes.length - count,
            null,
          );
          if (!part.bytesRead) break;
          count += part.bytesRead;
        }
        if (count === bytes.length) return { path, kind: "too_large" as const };
        if (bytes.subarray(0, count).includes(0)) return { path, text: "" };
        const decoded = decodeUtf8(bytes.subarray(0, count));
        if (!decoded.ok) return { path, kind: "not UTF-8 text" as const };
        const text = decoded.text;
        return { path, text };
      } catch {
        return { path, kind: "unreadable" as const };
      } finally {
        await handle?.close();
      }
    })().then((file) => {
      if (file.kind) {
        limits.push({ path: file.path, kind: file.kind });
        return undefined;
      }
      return { path: file.path, text: file.text };
    });
    cache.set(path, pending);
    return pending;
  };
  return { ok: true, cwd, paths, read, limits };
}

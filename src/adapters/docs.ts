import { STATE_MAX_CHARS, TIMEOUT_MS } from "../constants.ts";
import {
  attributeDocsDeclarations,
  docsDeclarationPattern,
} from "../core/docs.ts";
import type { GitExec } from "../core/git.ts";
import type { Result } from "../result.ts";
import type { Cause } from "../result-types.ts";
import {
  checkFileAdmission,
  openRepoFile,
  resolveInsideRepo,
} from "./files.ts";
import { decodeUtf8 } from "./utf8.ts";

export interface DocsSource {
  path: string;
  text: string;
}
export interface DocsInventory {
  cwd: string;
  files: DocsSource[];
  tracked: ReadonlySet<string>;
  limits: { path: string; reason: string; cause?: Cause }[];
  read: (path: string) => Promise<DocsSource | undefined>;
}
/** Inventory paths eagerly, but load only Markdown/configuration and subsequently reached sources. */
export async function collectDocsInventory(
  exec: GitExec,
  cwd: string,
  signal?: AbortSignal,
): Promise<Result<DocsInventory>> {
  const root = await exec("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    timeout: TIMEOUT_MS,
    signal,
  });
  if (root.code || root.killed)
    return {
      ok: false,
      cause: signal?.aborted ? "cancelled" : "git_failure",
      error: root.stderr.trim() || "Repository root not found.",
    };
  cwd = root.stdout.trim();
  const list = await exec("git", ["ls-files", "-z"], {
    cwd,
    timeout: TIMEOUT_MS,
    signal,
  });
  if (list.code || list.killed)
    return {
      ok: false,
      cause: signal?.aborted ? "cancelled" : "git_failure",
      error: list.stderr.trim() || "Unable to inventory tracked files.",
    };
  const tracked = new Set(list.stdout.split("\0").filter(Boolean));
  const limits: DocsInventory["limits"] = [];
  const cache = new Map<string, Promise<DocsSource | undefined>>();
  const read = (path: string): Promise<DocsSource | undefined> => {
    const previous = cache.get(path);
    if (previous) return previous;
    const pending = (async () => {
      if (!tracked.has(path) || path.split("/").includes(".git"))
        return undefined;
      if (signal?.aborted) {
        limits.push({ path, reason: "collection interrupted" });
        return undefined;
      }
      try {
        const opened = await openRepoFile(cwd, path, {
          exec,
          signal,
          inventory: tracked,
        });
        if (!opened.ok) {
          limits.push({
            path,
            reason: opened.error,
            ...(opened.cause ? { cause: opened.cause } : {}),
          });
          return undefined;
        }
        const handle = opened.handle;
        try {
          const stat = await handle.stat();
          if (!stat.isFile() || stat.size > STATE_MAX_CHARS * 4) {
            limits.push({
              path,
              reason: "not a regular file or file too large",
            });
            return undefined;
          }
          const buffer = Buffer.alloc(stat.size + 1);
          let bytesRead = 0;
          while (bytesRead < buffer.length) {
            signal?.throwIfAborted();
            const chunk = await handle.read(
              buffer,
              bytesRead,
              buffer.length - bytesRead,
              null,
            );
            if (!chunk.bytesRead) break;
            bytesRead += chunk.bytesRead;
          }
          if (bytesRead > stat.size) {
            limits.push({ path, reason: "file changed during reading" });
            return undefined;
          }
          const decoded = decodeUtf8(buffer.subarray(0, bytesRead));
          if (!decoded.ok) {
            limits.push({ path, reason: decoded.error });
            return undefined;
          }
          const text = decoded.text;
          if (text.includes("\0")) {
            limits.push({ path, reason: "binary file" });
            return undefined;
          }
          return { path, text };
        } finally {
          await handle.close();
        }
      } catch (error) {
        limits.push({ path, reason: `unable to read: ${String(error)}` });
        return undefined;
      }
    })();
    cache.set(path, pending);
    return pending;
  };
  const paths = [...tracked].filter(
    (path) =>
      /\.(?:md|mdx|markdown)$/i.test(path) ||
      /(?:^|\/)(?:package|tsconfig[^/]*)\.json$/.test(path),
  );
  const files: DocsSource[] = [];
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(8, paths.length) }, async () => {
      for (;;) {
        const path = paths[index++];
        if (path === undefined) return;
        const source = await read(path);
        if (source) files.push(source);
      }
    }),
  );
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { ok: true, cwd, files, tracked, limits, read };
}

/** Admitted paths only; one batch search transports declaration lines to the pure core. */
export function docsDeclarationSearch(
  exec: GitExec,
  inventory: DocsInventory,
  signal?: AbortSignal,
): (
  names: readonly string[],
) => Promise<ReadonlyMap<string, readonly string[]>> {
  let admittedPaths: Promise<string[]> | undefined;
  return async (names) => {
    if (!names.length) return new Map();
    admittedPaths ??= (async () => {
      const candidates = [...inventory.tracked].filter(
        (path) =>
          /\.[cm]?[jt]sx?$|\.py$|\.go$/i.test(path) &&
          !path.split("/").some((part) => part === ".." || part === ".git"),
      );
      const paths: string[] = [];
      let index = 0;
      await Promise.all(
        Array.from({ length: Math.min(16, candidates.length) }, async () => {
          for (;;) {
            const path = candidates[index++];
            if (path === undefined) return;
            const location = await resolveInsideRepo(inventory.cwd, path);
            const admission = location.ok
              ? await checkFileAdmission(
                  inventory.cwd,
                  location.rel,
                  exec,
                  signal,
                  inventory.tracked,
                )
              : location;
            if (admission.ok) paths.push(path);
            else if (admission.cause === "secret_pattern")
              inventory.limits.push({
                path,
                reason: admission.error,
                cause: admission.cause,
              });
          }
        }),
      );
      return paths;
    })();
    const paths = await admittedPaths;
    if (!paths.length) return new Map();
    const patterns = ["-e", docsDeclarationPattern(names)];
    const result = await exec("rg", ["--json", ...patterns, "--", ...paths], {
      cwd: inventory.cwd,
      timeout: TIMEOUT_MS,
      signal,
    });
    if (result.killed || (result.code !== 0 && result.code !== 1)) {
      inventory.limits.push({
        path: "documentation",
        reason: "declaration search unavailable",
      });
      return new Map(
        names.map((name) => [
          name,
          paths.length > 1 ? paths : [...paths, "<unknown declaration owner>"],
        ]),
      );
    }
    const admitted = new Set(paths);
    const rows: { path: string; text: string }[] = [];
    for (const line of result.stdout.split("\n")) {
      if (!line) continue;
      const item = JSON.parse(line) as {
        type: string;
        data?: { path?: { text?: string }; lines?: { text?: string } };
      };
      const path = item.data?.path?.text;
      if (item.type === "match" && path && admitted.has(path))
        rows.push({ path, text: item.data?.lines?.text ?? "" });
    }
    return attributeDocsDeclarations(names, rows);
  };
}

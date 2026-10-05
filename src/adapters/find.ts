import { isAbsolute } from "node:path";
import type { FileFinder, GrepCursor } from "@ff-labs/fff-node";
import {
  FIND_GREP_PAGE_SIZE,
  FIND_PATH_WEIGHT,
  TIMEOUT_MS,
} from "../constants.ts";
import { pathAllowed } from "../core/find.ts";
import type { GitExec } from "../core/git.ts";
import type { Result } from "../result.ts";

export async function prefilter(
  exec: GitExec,
  cwd: string,
  keywords: readonly string[],
  limit: number,
  scope?: string | readonly string[],
  exclude?: readonly string[],
  signal?: AbortSignal,
  native = true,
): Promise<Result<{ paths: string[]; scopeFiles: number }>> {
  const restrictions = [
    ...(typeof scope === "string" ? [scope] : (scope ?? [])),
    ...(exclude ?? []),
  ];
  for (const restriction of restrictions) {
    if (
      isAbsolute(restriction) ||
      restriction
        .split(/[\\/]/)
        .some((segment) => segment === ".." || segment === ".git")
    )
      return {
        ok: false,
        cause: "forbidden_path",
        error: `Discovery restriction must remain inside admitted files: ${restriction}`,
      };
  }
  try {
    const listed = await exec(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { cwd, timeout: TIMEOUT_MS, signal },
    );
    if (listed.killed || listed.code !== 0)
      return {
        ok: false,
        cause: signal?.aborted ? "cancelled" : "git_failure",
        error: `Cannot list repository files: ${listed.stderr || "git interrupted"}`,
      };
    const paths = [
      ...new Set(
        listed.stdout
          .split("\0")
          .filter((path) => path && pathAllowed(path, scope, exclude)),
      ),
    ];
    if (!paths.length) return { ok: true, paths: [], scopeFiles: 0 };
    const allowed = new Set(paths);
    let finder: FileFinder | undefined;
    if (native) {
      try {
        // Static loading would break hosts where this optional native package is absent.
        const { FileFinder } = await import("@ff-labs/fff-node");
        const created = FileFinder.create({
          basePath: cwd,
          disableWatch: true,
        });
        if (created.ok) {
          finder = created.value;
          const ready = await finder.waitForScan(TIMEOUT_MS);
          if (!ready.ok || !ready.value) {
            finder.destroy();
            finder = undefined;
          }
        }
      } catch {
        /* Optional native package is unavailable in this host. */
      }
    }
    if (!finder) {
      const available = await exec("rg", ["--version"], {
        cwd,
        timeout: TIMEOUT_MS,
        signal,
      });
      if (available.killed || available.code !== 0)
        return { ok: false, error: "rg is required when fff is unavailable" };
    }
    try {
      const matches = await Promise.all(
        keywords.map(async (word) => {
          signal?.throwIfAborted();
          if (finder) {
            const found = new Set<string>();
            let cursor: GrepCursor | null = null;
            do {
              const result = finder.multiGrep({
                patterns: [word],
                smartCase: true,
                maxMatchesPerFile: 1,
                pageSize: FIND_GREP_PAGE_SIZE,
                cursor,
              });
              if (!result.ok) throw new Error(result.error);
              for (const item of result.value.items)
                if (allowed.has(item.relativePath))
                  found.add(item.relativePath);
              cursor = result.value.nextCursor;
            } while (cursor);
            return found;
          }
          const result = await exec(
            "rg",
            [
              "--files-with-matches",
              "--hidden",
              "--null",
              "--fixed-strings",
              "--ignore-case",
              "--",
              word,
              ".",
            ],
            { cwd, timeout: TIMEOUT_MS, signal },
          );
          if (
            result.killed ||
            (result.code !== 0 && result.code !== 1) ||
            (result.code === 1 && result.stderr.trim())
          )
            throw new Error(result.stderr || "rg interrupted");
          return new Set(
            result.stdout
              .split("\0")
              .map((path) => path.replace(/^\.\//u, ""))
              .filter((path) => allowed.has(path)),
          );
        }),
      );
      const scores = paths.map((path) => ({
        path,
        score: keywords.reduce((sum, word, index) => {
          const matchesForWord = matches[index];
          if (!matchesForWord) return sum;
          const weight = Math.log(1 + paths.length / (1 + matchesForWord.size));
          return (
            sum +
            weight *
              (Number(matchesForWord.has(path)) +
                FIND_PATH_WEIGHT * Number(path.toLowerCase().includes(word)))
          );
        }, 0),
      }));
      scores.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
      return {
        ok: true,
        paths: scores
          .filter((item) => item.score > 0)
          .slice(0, limit)
          .map((item) => item.path),
        scopeFiles: paths.length,
      };
    } finally {
      finder?.destroy();
    }
  } catch (error) {
    return {
      ok: false,
      cause: signal?.aborted ? "cancelled" : "git_failure",
      error: `Cannot prefilter files: ${String(error)}`,
    };
  }
}

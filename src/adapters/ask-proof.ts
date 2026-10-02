import { relative, resolve } from "node:path";
import { STATE_MAX_CHARS, TIMEOUT_MS } from "../constants.ts";
import type { GitExec } from "../core/git.ts";
import type { ImportSource } from "../core/imports.ts";
import type { Result } from "../result.ts";
import { collectFiles } from "./files.ts";
import { verifyGitUtf8 } from "./utf8.ts";

export interface AskRepository {
  root: string;
  known: ReadonlySet<string>;
  baseSha?: string;
  read(path: string): Promise<Result<ImportSource>>;
  readBefore(path: string): Promise<Result<{ text: string | null }>>;
}

export async function collectAskRepository(
  exec: GitExec,
  cwd: string,
  base: string | undefined,
  signal?: AbortSignal,
): Promise<Result<AskRepository>> {
  try {
    const options = { cwd, timeout: TIMEOUT_MS, signal };
    const location = await exec(
      "git",
      ["rev-parse", "--show-toplevel"],
      options,
    );
    if (location.code !== 0 || location.killed)
      return {
        ok: false,
        error: location.stderr || "Cannot resolve repository root.",
      };
    const root = location.stdout.trimEnd();
    const gitOptions = { ...options, cwd: root };
    const [listed, ignored, revision] = await Promise.all([
      exec(
        "git",
        ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        gitOptions,
      ),
      exec(
        "git",
        ["ls-files", "--cached", "--ignored", "--exclude-standard", "-z"],
        gitOptions,
      ),
      base === undefined
        ? undefined
        : exec(
            "git",
            ["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`],
            gitOptions,
          ),
    ]);
    if (listed.code !== 0 || listed.killed)
      return {
        ok: false,
        error: listed.stderr || "Cannot list repository paths.",
      };
    if (revision && (revision.code !== 0 || revision.killed))
      return { ok: false, error: revision.stderr || "Cannot resolve base." };
    if (ignored.code !== 0 || ignored.killed)
      return {
        ok: false,
        error: ignored.stderr || "Cannot list ignored repository paths.",
      };
    const known = new Set(listed.stdout.split("\0").filter(Boolean));
    for (const path of ignored.stdout.split("\0")) known.delete(path);
    const baseSha = revision?.stdout.trim();
    const basePaths = baseSha
      ? await exec(
          "git",
          ["ls-tree", "-r", "--name-only", "-z", baseSha],
          gitOptions,
        )
      : undefined;
    if (basePaths && (basePaths.code !== 0 || basePaths.killed))
      return {
        ok: false,
        error: basePaths.stderr || "Cannot list base paths.",
      };
    const beforeKnown = new Set(basePaths?.stdout.split("\0").filter(Boolean));
    const reads = new Map<string, Promise<Result<ImportSource>>>();
    const beforeReads = new Map<
      string,
      Promise<Result<{ text: string | null }>>
    >();
    return {
      ok: true,
      root,
      known,
      baseSha,
      read(path) {
        let pending = reads.get(path);
        if (!pending) {
          pending = (async () => {
            if (!known.has(path))
              return {
                ok: false as const,
                error: `${path}: not in repository inventory`,
              };
            const loaded = await collectFiles(root, [path], signal, {
              allowEmpty: true,
              exec,
              inventory: known,
            });
            return loaded.ok
              ? { ok: true as const, path, text: loaded.files[path] ?? "" }
              : loaded;
          })();
          reads.set(path, pending);
        }
        return pending;
      },
      readBefore(path) {
        let pending = beforeReads.get(path);
        if (!pending) {
          pending = (async () => {
            if (!baseSha || !beforeKnown.has(path))
              return { ok: true as const, text: null };
            try {
              const object = await exec(
                "git",
                [
                  "rev-parse",
                  "--verify",
                  "--end-of-options",
                  `${baseSha}:${path}`,
                ],
                gitOptions,
              );
              if (object.code !== 0 || object.killed)
                return {
                  ok: false as const,
                  error: `before evidence unavailable for ${path}`,
                };
              const id = object.stdout.trim();
              const sizeResult = await exec(
                "git",
                ["cat-file", "-s", id],
                gitOptions,
              );
              const size = Number(sizeResult.stdout);
              if (
                sizeResult.code !== 0 ||
                sizeResult.killed ||
                !Number.isFinite(size) ||
                size > STATE_MAX_CHARS * 4
              )
                return {
                  ok: false as const,
                  error: `before evidence unavailable for ${path}`,
                };
              const loaded = await exec(
                "git",
                [
                  "show",
                  "--no-ext-diff",
                  "--no-textconv",
                  "--end-of-options",
                  id,
                ],
                gitOptions,
              );
              if (
                loaded.code !== 0 ||
                loaded.killed ||
                loaded.stdout.length > STATE_MAX_CHARS
              )
                return {
                  ok: false as const,
                  error: `before evidence unavailable for ${path}`,
                };
              const decoded = verifyGitUtf8(loaded.stdout, id, size);
              return decoded.ok
                ? decoded
                : { ok: false as const, error: `${path}: ${decoded.error}` };
            } catch (error) {
              return { ok: false as const, error: String(error) };
            }
          })();
          beforeReads.set(path, pending);
        }
        return pending;
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: `Cannot collect repository proof: ${String(error)}`,
    };
  }
}

export function repositoryPath(
  root: string,
  cwd: string,
  path: string,
): string {
  return relative(root, resolve(cwd, path)).split("\\").join("/");
}

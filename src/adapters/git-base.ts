import { TIMEOUT_MS } from "../constants.ts";
import type { GitExec } from "../core/git.ts";
import type { Result } from "../result.ts";

export async function resolveBase(
  exec: GitExec,
  cwd: string,
  base?: string,
  signal?: AbortSignal,
): Promise<Result<{ base: string }>> {
  if (!base) return { ok: true, base: "HEAD" };
  try {
    const result = await exec("git", ["merge-base", "--", "HEAD", base], {
      cwd,
      timeout: TIMEOUT_MS,
      signal,
    });
    if (result.killed)
      return {
        ok: false,
        cause: signal?.aborted ? "cancelled" : "git_failure",
        error: "Git interrupted (cancelled or timed out).",
      };
    if (result.code === 0 && result.stdout.trim())
      return { ok: true, base: result.stdout.trim() };
    return {
      ok: false,
      cause: "invalid_base",
      error: `Cannot resolve base=${base}: history may be truncated or no shared ancestor is available. Run git fetch --unshallow (or git fetch --deepen=<count>), or choose a base that is an ancestor of HEAD.${result.stderr.trim() ? ` Git: ${result.stderr.trim()}` : ""}`,
    };
  } catch (error) {
    return {
      ok: false,
      cause: signal?.aborted ? "cancelled" : "git_failure",
      error: `Unable to resolve base=${base}: ${String(error)}`,
    };
  }
}

import { lstat, realpath } from "node:fs/promises";
import { parse, resolve, sep } from "node:path";
import { TIMEOUT_MS } from "../constants.ts";
import type { GitExec } from "../core/git.ts";
import type { State } from "../jev/types.ts";
import type { Cause } from "../result-types.ts";

export type EvidenceContext = {
  authority: { path: string; origin: "host" | "server" };
  authorityReason?: string;
  requestedRoot?: string;
  effectiveRoot?: {
    path: string;
    origin: "host" | "server" | "override";
    commonDir?: string;
  };
  requestedBase?: string;
  resolvedBase?: string;
};
export interface ContextDependencies {
  exec: GitExec;
  signal?: AbortSignal;
  origin?: "host" | "server";
  lstat?: typeof lstat;
  realpath?: typeof realpath;
}
export type EvidenceContextResult =
  | { ok: true; cwd: string; context: EvidenceContext }
  | { ok: false; error: string; cause: Cause; context: EvidenceContext };

/** Bind each judgment (including controls) to its admitted per-call provenance. */
export function withEvidenceContext(
  state: State,
  context: EvidenceContext,
): State {
  const provenance = {
    ...context,
    authority: { ...context.authority },
    ...(context.effectiveRoot
      ? { effectiveRoot: { ...context.effectiveRoot } }
      : {}),
  };
  const evidence = state.evidence;
  // A producer's non-object evidence is content, not a metadata container.
  if (
    evidence !== undefined &&
    (evidence === null ||
      typeof evidence !== "object" ||
      Array.isArray(evidence))
  )
    return { ...state, evidenceContext: provenance };
  return { ...state, evidence: { ...evidence, context: provenance } };
}

/** Metadata-only admission. No evidence, commands, caches or judgments precede this. */
export async function resolveEvidenceContext(
  initialCwd: string,
  root: string | undefined,
  deps: ContextDependencies,
): Promise<EvidenceContextResult> {
  const canonical = deps.realpath ?? realpath;
  const inspect = deps.lstat ?? lstat;
  let initial: string;
  try {
    initial = await canonical(initialCwd);
  } catch {
    return {
      ok: false,
      cause: "file_unavailable",
      error: "Initial evidence authority cannot be canonicalized",
      context: {
        authority: { path: "", origin: deps.origin ?? "host" },
        authorityReason: "Initial evidence authority cannot be canonicalized",
        ...(root !== undefined ? { requestedRoot: root } : {}),
      },
    };
  }
  const origin = deps.origin ?? "host";
  const context: EvidenceContext = {
    authority: { path: initial, origin },
    ...(root !== undefined ? { requestedRoot: root } : {}),
  };
  if (root === undefined) {
    context.effectiveRoot = { path: initial, origin };
    return { ok: true, cwd: initial, context };
  }
  const refuse = (
    reason: string,
    cause: Cause = "invalid_root",
  ): EvidenceContextResult => ({
    ok: false,
    cause,
    error: `Invalid root: ${reason}`,
    context,
  });
  if (!root.trim()) return refuse("provide a non-empty directory");
  if (root.split(/[\\/]/).includes(".."))
    return refuse("parent traversal is forbidden");
  const candidate = resolve(initial, root);
  try {
    let component = parse(candidate).root;
    for (const part of candidate
      .slice(component.length)
      .split(sep)
      .filter(Boolean)) {
      component = resolve(component, part);
      const metadata = await inspect(component);
      if (metadata.isSymbolicLink())
        return refuse("symbolic links are forbidden");
      if (!metadata.isDirectory())
        return refuse("root must be an existing directory");
    }
    const path = await canonical(candidate);
    const git = async (cwd: string, args: string[]) => {
      const result = await deps.exec("git", args, {
        cwd,
        timeout: TIMEOUT_MS,
        signal: deps.signal,
      });
      if (result.code || result.killed)
        throw new Error("Git metadata unavailable");
      return args.includes("-z")
        ? result.stdout
        : result.stdout.replace(/\r?\n$/, "");
    };
    const initialTop = await canonical(
      await git(initial, ["rev-parse", "--show-toplevel"]),
    );
    const candidateTop = await canonical(
      await git(path, ["rev-parse", "--show-toplevel"]),
    );
    if (candidateTop !== path)
      return refuse("root must equal a Git top-level directory");
    const common = await canonical(
      resolve(initial, await git(initial, ["rev-parse", "--git-common-dir"])),
    );
    const candidateCommon = await canonical(
      resolve(path, await git(path, ["rev-parse", "--git-common-dir"])),
    );
    if (candidateCommon !== common)
      return refuse("root belongs to a different repository");
    const listed = await git(initial, [
      "worktree",
      "list",
      "--porcelain",
      "-z",
    ]);
    const registered = listed.split("\0\0").some((block) => {
      const fields = block.split("\0");
      const worktree = fields
        .find((field) => field.startsWith("worktree "))
        ?.slice(9);
      return (
        worktree !== undefined &&
        resolve(worktree) === path &&
        !fields.some((field) => /^prunable(?: |$)/.test(field))
      );
    });
    if (path !== initialTop && !registered)
      return refuse("root is not a registered live worktree");
    context.effectiveRoot = { path, origin: "override", commonDir: common };
    return { ok: true, cwd: path, context };
  } catch (error) {
    return refuse(
      `cannot admit directory (${error instanceof Error ? error.message : String(error)})`,
      deps.signal?.aborted ? "cancelled" : "invalid_root",
    );
  }
}

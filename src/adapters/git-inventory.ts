import type { GitExec, GitResult } from "../core/git.ts";

/**
 * The two lookups collectDiff and collectRiskCallers both need. Each is a pure
 * function of (cwd, ref) and neither reads the worktree or the index, so the
 * second collector reuses the first one's result instead of spawning again.
 */
const TREE_SHAPES: readonly ((
  args: readonly string[],
) => string | undefined)[] = [
  // git rev-parse --show-toplevel
  (args) =>
    args.length === 2 &&
    args[0] === "rev-parse" &&
    args[1] === "--show-toplevel"
      ? "root"
      : undefined,
  // git ls-tree -r --long -z --full-tree --end-of-options <ref>
  (args) =>
    args.length === 7 &&
    args[0] === "ls-tree" &&
    args[1] === "-r" &&
    args[2] === "--long" &&
    args[3] === "-z" &&
    args[4] === "--full-tree" &&
    args[5] === "--end-of-options" &&
    args[6] !== "--" &&
    !args[6]?.startsWith("-")
      ? `tree:${args[6]}`
      : undefined,
];
/**
 * Settings whose value cannot change the output of either shape above, checked
 * byte for byte on paths with spaces, tabs and non-ASCII. A prefix carrying any
 * other setting is left unshared, because a setting this list omits may well
 * be output-relevant (core.abbrev, core.bare, i18n.logOutputEncoding, ...).
 */
const NEUTRAL_SETTINGS: ReadonlySet<string> = new Set([
  "color.ui",
  "core.quotePath",
  "diff.suppressBlankEmpty",
  "diff.relative",
  "diff.noprefix",
  "diff.mnemonicPrefix",
  "diff.algorithm",
  "diff.indentHeuristic",
]);

/** Fresh per tool call, like the inventory snapshot below. */
export function shareGitTree(exec: GitExec): GitExec {
  const trees = new Map<string, Promise<GitResult>>();
  return async (command, args, options) => {
    if (command !== "git") return exec(command, args, options);
    let rest = args;
    while (rest[0] === "-c") {
      const setting = (rest[1] ?? "").split("=", 1)[0];
      if (!setting || !NEUTRAL_SETTINGS.has(setting))
        return exec(command, args, options);
      rest = rest.slice(2);
    }
    const shape = TREE_SHAPES.find((match) => match(rest) !== undefined);
    if (!shape) return exec(command, args, options);
    // The bare form is the same question as the prefixed one, so the key is the
    // shape and cwd rather than the argv the caller happened to build.
    const key = `${shape(rest)}\0${options.cwd}`;
    let tree = trees.get(key);
    if (!tree) {
      tree = exec(command, args, options);
      trees.set(key, tree);
    }
    return tree;
  };
}

/** Fresh per tool call: HEAD/index timestamps cannot detect untracked or ignore changes. */
export function shareGitInventory(exec: GitExec): GitExec {
  const snapshots = new Map<string, ReturnType<GitExec>>();
  return async (command, args, options) => {
    const offset = args.indexOf("ls-files");
    if (command !== "git" && command !== "rg") snapshots.clear();
    if (command !== "git" || offset === -1) return exec(command, args, options);
    const flags = args.slice(offset + 1);
    if (
      !flags.includes("-z") ||
      flags.includes("--ignored") ||
      flags.some((flag) => flag.startsWith("--with-tree"))
    )
      return exec(command, args, options);
    const separator = flags.indexOf("--");
    const filters = separator === -1 ? [] : flags.slice(separator + 1);
    if (
      filters.some(
        (path) =>
          !path.startsWith(":(top,literal)") &&
          !path.startsWith(":(top,exclude,literal)") &&
          /[*?[\]:]/.test(path),
      )
    )
      return exec(command, args, options);
    const allowed = new Set([
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--full-name",
    ]);
    if (
      (separator === -1 ? flags : flags.slice(0, separator)).some(
        (flag) => !allowed.has(flag),
      )
    )
      return exec(command, args, options);
    const key = `${options.cwd}\0${flags.includes("--full-name")}`;
    let snapshot = snapshots.get(key);
    if (!snapshot) {
      snapshot = exec(
        "git",
        [
          "ls-files",
          "--cached",
          "--others",
          "--exclude-standard",
          ...(flags.includes("--full-name") ? ["--full-name"] : []),
          "-t",
          "-z",
        ],
        options,
      );
      snapshots.set(key, snapshot);
    }
    const result = await snapshot;
    if (result.code !== 0 || result.killed) return result;
    const entries = result.stdout.split("\0").filter(Boolean);
    const othersOnly =
      flags.includes("--others") && !flags.includes("--cached");
    const trackedOnly = !flags.includes("--others");
    const include = filters.filter(
      (path) => !path.startsWith(":(top,exclude,literal)"),
    );
    const exclude = filters
      .filter((path) => path.startsWith(":(top,exclude,literal)"))
      .map((path) => path.slice(":(top,exclude,literal)".length));
    const matches = (path: string, filter: string) => {
      const literal = filter.replace(/^:\(top,literal\)/, "");
      return path === literal || path.startsWith(`${literal}/`);
    };
    return {
      ...result,
      stdout: entries
        .filter(
          (entry) =>
            !(othersOnly && entry[0] !== "?") &&
            !(trackedOnly && entry[0] === "?"),
        )
        .map((entry) => entry.slice(2))
        .filter(
          (path) =>
            (!include.length ||
              include.some((filter) => matches(path, filter))) &&
            !exclude.some((filter) => matches(path, filter)),
        )
        .map((path) => `${path}\0`)
        .join(""),
    };
  };
}

import type { GitExec } from "../core/git.ts";

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

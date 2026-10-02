import { posix } from "node:path";
import { SELECT_FILE_SHARE } from "../constants.ts";
import { VERIFIED_NAME_FILTERS } from "./runner-version.ts";
import type { Framework, TestEntry, TestScenario } from "./test-discovery.ts";

export interface RunnerCommand {
  cwd: string;
  framework: Framework;
  config?: string;
  project?: string;
  executable: string;
  args: readonly string[];
  files: readonly string[];
}

export interface RunnerSelection {
  entry: TestEntry;
  scenarioIds: readonly string[] | null;
}

export interface RunnerCommands {
  commands: readonly RunnerCommand[];
  limits: readonly {
    files: readonly string[];
    reason: string;
    action: string;
  }[];
}

const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const exactPattern = (names: readonly string[]): string =>
  [...new Set(names)].map((name) => `^${escapeRegex(name)}$`).join("|");
const localPath = (entry: TestEntry, path = entry.path): string =>
  posix.relative(entry.cwd, path) || ".";

function resolveSelection(selection: RunnerSelection): {
  entry: TestEntry;
  scenarios: readonly TestScenario[] | null;
  reason?: string;
} {
  const { entry, scenarioIds } = selection;
  if (scenarioIds === null) return { entry, scenarios: null };
  if (!entry.countKnown)
    return { entry, scenarios: null, reason: "unknown scenario count" };
  const ids = new Set(scenarioIds);
  const scenarios = entry.scenarios.filter((scenario) => ids.has(scenario.id));
  if (scenarios.length !== ids.size)
    return {
      entry,
      scenarios: null,
      reason: "unresolved scenario identifier",
    };
  if (scenarios.length >= entry.scenarios.length * SELECT_FILE_SHARE)
    return { entry, scenarios: null };
  if (entry.scenarios.some((scenario) => !scenario.reliable))
    return { entry, scenarios: null, reason: "dynamic names or parameters" };
  const names = new Set<string>();
  for (const scenario of entry.scenarios) {
    if (names.has(scenario.name))
      return { entry, scenarios: null, reason: "ambiguous scenario names" };
    names.add(scenario.name);
  }
  return { entry, scenarios };
}

/** Builds argument vectors only; neither collects nor executes any runner. */
export function buildRunnerCommands(
  selected: readonly RunnerSelection[],
): RunnerCommands {
  const commands: RunnerCommand[] = [];
  const limits: { files: readonly string[]; reason: string; action: string }[] =
    [];
  const groups = new Map<string, [RunnerSelection, ...RunnerSelection[]]>();
  for (const selection of selected) {
    if (selection.scenarioIds !== null && selection.scenarioIds.length === 0)
      continue;
    const { entry } = selection;
    const key = JSON.stringify([
      entry.cwd,
      entry.framework,
      entry.runnerVersion,
      entry.config,
      entry.project,
      entry.options,
      entry.kind,
      entry.invocation,
      entry.commandRefusal,
      entry.nameFilterBlocked,
      entry.nameFilterReason,
    ]);
    const group = groups.get(key);
    if (group) group.push(selection);
    else groups.set(key, [selection]);
  }
  for (const group of groups.values()) {
    const entry = group[0].entry;
    const files = [...new Set(group.map((item) => item.entry.path))];
    const limit = (reason: string, action: string): void => {
      limits.push({ files, reason, action });
    };
    if (entry.kind === "types") {
      if (entry.invocation?.kind === "typecheck") {
        commands.push({
          cwd: entry.cwd,
          framework: entry.framework,
          ...(entry.config ? { config: entry.config } : {}),
          ...(entry.project ? { project: entry.project } : {}),
          executable: entry.invocation.executable,
          args: [...entry.invocation.args],
          files,
        });
        limit(
          "typecheck project scope: selected files do not restrict the command",
          "run the identified project type-check command without file or name filters",
        );
      } else {
        limit(
          "type tests: command not identified",
          "run the project's type-check command",
        );
      }
      continue;
    }
    if (entry.framework === "unknown") {
      limit(
        "framework unknown",
        "run the listed files with the project runner",
      );
      continue;
    }
    if (entry.commandRefusal) {
      limit(
        entry.commandRefusal,
        "run the listed files with the project runner",
      );
      continue;
    }
    if (
      ["ava", "mocha"].includes(entry.framework) &&
      files.some((file) => /[*?[\]{}()!]/.test(localPath(entry, file)))
    ) {
      limit(
        "targeted path has unverified glob metacharacters",
        "run the listed files with the project runner",
      );
      continue;
    }
    if (entry.invocation?.kind !== "runner")
      limit(
        "local_runner_unproven: native executable availability is not established",
        "verify the local executable or use the project's runner script",
      );
    const resolved = group.map(resolveSelection);
    for (const item of resolved)
      if (item.entry.nameFilterReason)
        limits.push({
          files: [item.entry.path],
          reason: `fallback: all — ${item.entry.nameFilterReason}`,
          action: "run the whole file with the project runner",
        });
    for (const item of resolved) {
      if (item.reason)
        limits.push({
          files: [item.entry.path],
          reason: `fallback: all — ${item.reason}`,
          action: "run the whole file with the project runner",
        });
    }
    let wholeGroup = false;
    const nominal = ["vitest", "jest", "node", "bun", "go", "mocha"].includes(
      entry.framework,
    );
    if (
      nominal &&
      resolved.some((item) => item.scenarios === null) &&
      resolved.some((item) => item.scenarios !== null)
    ) {
      wholeGroup = true;
      limit(
        "fallback: all — whole files and name filters in the same group",
        "run all listed files without a name filter",
      );
    }
    const paths = files.map((file) => localPath(entry, file));
    const scenarios = resolved.flatMap((item) => item.scenarios ?? []);
    let pattern =
      !wholeGroup && resolved.every((item) => item.scenarios !== null)
        ? exactPattern(scenarios.map((scenario) => scenario.name))
        : undefined;
    if (
      pattern &&
      (entry.framework === "vitest" ||
        entry.framework === "jest" ||
        entry.framework === "mocha")
    ) {
      const contract = VERIFIED_NAME_FILTERS[entry.framework].find(
        (candidate) => candidate.version.test(entry.runnerVersion ?? ""),
      );
      if (
        !contract ||
        (contract.separator !== " " &&
          scenarios.some((scenario) => !scenario.nameParts))
      ) {
        pattern = undefined;
        limit(
          `name filter skipped: ${entry.framework} ${entry.runnerVersion ?? "unknown"} not verified`,
          "run the whole file with the project runner",
        );
      } else {
        pattern = exactPattern(
          scenarios.map(
            (scenario) =>
              scenario.nameParts?.join(contract.separator) ?? scenario.name,
          ),
        );
      }
    }
    if (entry.nameFilterBlocked) pattern = undefined;
    let executable: string;
    let args: string[];
    const config = entry.config ? localPath(entry, entry.config) : undefined;
    switch (entry.framework) {
      case "ava":
        executable = "ava";
        args = [...entry.options];
        if (config && !config.endsWith("package.json"))
          args.push("--config", config);
        args.push(...paths);
        break;
      case "mocha":
        executable = "mocha";
        args = [...entry.options];
        if (config && !config.endsWith("package.json"))
          args.push("--config", config);
        if (pattern) args.push("--grep", pattern);
        args.push(...paths);
        break;
      case "deno":
        executable = "deno";
        args = ["test", ...entry.options];
        if (config) args.push("--config", config);
        args.push(...paths);
        break;
      case "vitest":
        executable = "vitest";
        args = ["run", ...entry.options];
        if (config) args.push("--config", config);
        if (entry.project) args.push("--project", entry.project);
        if (pattern) args.push("-t", pattern);
        args.push(...paths);
        break;
      case "jest":
        executable = "jest";
        args = [...entry.options];
        if (config) args.push("--config", config);
        if (entry.project) args.push("--selectProjects", entry.project);
        if (pattern) args.push("-t", pattern);
        args.push("--runTestsByPath", ...paths);
        break;
      case "node":
        executable = "node";
        if (pattern) {
          if (scenarios.some((scenario) => scenario.ancestors === undefined)) {
            pattern = undefined;
            limit(
              "fallback: all — unresolved node:test hierarchy",
              "run all listed files without a name filter",
            );
          } else {
            pattern = exactPattern(
              scenarios.flatMap((scenario) => [
                ...(scenario.ancestors ?? []),
                scenario.name,
              ]),
            );
            if (
              scenarios.some(
                (scenario) => (scenario.ancestors?.length ?? 0) > 0,
              )
            )
              limit(
                "node:test: admitting an ancestor may also run its other subtests",
                "verify the expanded subtree with the project runner",
              );
          }
        }
        args = [...entry.options, "--test"];
        if (pattern) args.push("--test-name-pattern", pattern);
        args.push(...paths);
        break;
      case "bun":
        executable = "bun";
        args = config ? ["--config", config, "test"] : ["test"];
        args.push(...entry.options);
        if (pattern) args.push("--test-name-pattern", pattern);
        args.push(
          ...paths.map((path) => (posix.isAbsolute(path) ? path : `./${path}`)),
        );
        break;
      case "playwright":
        executable = "playwright";
        args = ["test", ...entry.options];
        if (config) args.push("--config", config);
        if (entry.project) args.push("--project", entry.project);
        for (const item of resolved) {
          const path = escapeRegex(localPath(item.entry));
          if (
            item.scenarios === null ||
            item.scenarios.some((scenario) => scenario.line < 1)
          ) {
            args.push(path);
            if (item.scenarios !== null)
              limit(
                "fallback: all — unknown declaration line",
                "run the whole file with the project runner",
              );
          } else {
            args.push(
              ...new Set(
                item.scenarios.map((scenario) => `${path}:${scenario.line}`),
              ),
            );
          }
        }
        break;
      case "go": {
        executable = "go";
        const packages = [
          ...new Set(
            paths.map((path) => {
              const directory = posix.dirname(path);
              return directory === "."
                ? "."
                : directory.startsWith(".")
                  ? directory
                  : `./${directory}`;
            }),
          ),
        ];
        if (pattern) {
          const names = scenarios.map((scenario) => {
            const separator = scenario.name.indexOf("/");
            return separator < 0
              ? scenario.name
              : scenario.name.slice(0, separator);
          });
          if (
            names.some((name) => !/^(Test|Example)[A-Za-z0-9_]*$/.test(name))
          ) {
            pattern = undefined;
            limit(
              "fallback: all — benchmarks or fuzz targets cannot be expressed safely",
              "run the affected packages, benchmarks and fuzz targets with the project runner",
            );
          } else {
            pattern = exactPattern(names);
            if (scenarios.some((scenario) => scenario.name.includes("/")))
              limit(
                "fallback: all — Go subtest: whole parent retained",
                "run the selected top-level parents with the project runner",
              );
          }
        }
        args = ["test", ...entry.options, ...packages];
        if (pattern) args.push("-run", pattern);
        limit(
          "Go runs packages, not files; examples and build constraints depend on the project",
          "verify build constraints and executable examples with the project runner",
        );
        break;
      }
      case "pytest":
        executable = "python";
        args = ["-m", "pytest", ...entry.options];
        if (config) args.push("-c", config);
        for (const item of resolved) {
          const path = localPath(item.entry);
          if (item.scenarios === null) args.push(path);
          else
            for (const scenario of item.scenarios) {
              const separator = scenario.name.indexOf("::");
              const nodePath = scenario.name.slice(0, separator);
              const isFullId =
                separator >= 0 &&
                (nodePath === item.entry.path || nodePath === path);
              args.push(
                isFullId
                  ? path + scenario.name.slice(separator)
                  : `${path}::${scenario.name}`,
              );
            }
        }
        break;
      default:
        continue;
    }
    if (entry.invocation?.kind === "runner") {
      // Identified options are already part of the invocation prefix.
      const bunConfig = entry.framework === "bun" && config ? 2 : 0;
      const prefixLength =
        entry.options.length +
        bunConfig +
        (entry.framework === "pytest"
          ? 2
          : ["jest", "ava", "mocha"].includes(entry.framework)
            ? 0
            : 1);
      executable = entry.invocation.executable;
      args = [
        ...(bunConfig ? ["--config", config as string] : []),
        ...(entry.framework === "vitest" && entry.invocation.args[0] !== "run"
          ? ["run"]
          : []),
        ...entry.invocation.args,
        ...args.slice(prefixLength),
      ];
    }
    commands.push({
      cwd: entry.cwd,
      framework: entry.framework,
      ...(entry.config ? { config: entry.config } : {}),
      ...(entry.project ? { project: entry.project } : {}),
      executable,
      args,
      files,
    });
  }
  return { commands, limits };
}

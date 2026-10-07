import { posix } from "node:path";
import { isTestFile } from "./diff.ts";
import { type LexicalSource, tokenize } from "./lexical.ts";
import { goScenarios } from "./test-discovery/go.ts";
import { imports, jsScenarios } from "./test-discovery/javascript.ts";
import { pythonScenarios } from "./test-discovery/python.ts";
import {
  type Literal,
  literal,
  matches,
  record,
  shellWords,
  strings,
  unknown,
} from "./test-discovery/shared.ts";
import type {
  Discovery,
  Framework,
  TestEntry,
  TestScenario,
} from "./test-discovery/types.ts";

export type {
  Discovery,
  Framework,
  TestEntry,
  TestScenario,
} from "./test-discovery/types.ts";

interface Group {
  framework: Framework;
  cwd: string;
  config?: string;
  project?: string;
  include: string[];
  exclude: string[];
  setup: string[];
  options: string[];
  settings: { [key: string]: Literal };
  provenance: string;
  incomplete: boolean;
  types?: boolean;
}
function native(path: string, framework: Framework): boolean {
  if (framework === "go") return /_test\.go$/.test(path);
  if (framework === "pytest")
    return /(?:^|\/)(?:test_[^/]+|[^/]+_test)\.py$/.test(path);
  if (framework === "bun")
    return /(?:\.(?:test|spec)|_(?:test|spec))\.[cm]?[jt]sx?$/.test(path);
  if (framework === "jest" && /(?:^|\/)__tests__\/.*\.[cm]?[jt]sx?$/.test(path))
    return true;
  if (framework === "ava")
    return /(?:^|\/)test(?:s)?\/.*\.[cm]?[jt]sx?$/.test(path);
  return (
    /\.(?:test|spec|vitest)\.[cm]?[jt]sx?$/.test(path) ||
    /(?:^|\/)test\.[cm]?[jt]s$/.test(path)
  );
}
function directory(path: string): string {
  const dir = posix.dirname(path);
  return dir === "." ? "." : dir;
}
function relative(cwd: string, path: string): string {
  return posix.relative(cwd, path);
}
function under(cwd: string, path: string): boolean {
  const rel = relative(cwd, path);
  return rel !== ".." && !rel.startsWith("../");
}
function configFramework(path: string): Framework | undefined {
  const name = posix.basename(path);
  if (
    !/\.(?:setup|workspace)\./.test(name) &&
    /^vitest(?:\.[\w-]+)*\.(?:[cm]?[jt]s)$/.test(name)
  )
    return "vitest";
  if (/^jest\.config\./.test(name)) return "jest";
  if (/^playwright\.config\./.test(name)) return "playwright";
  if (["pytest.ini", "pyproject.toml", "setup.cfg", "tox.ini"].includes(name))
    return "pytest";
  if (name === "bunfig.toml") return "bun";
  if (name === "deno.json" || name === "deno.jsonc") return "deno";
  if (/^\.mocharc\./.test(name)) return "mocha";
  if (/^ava\.config\.[cm]?js$/.test(name)) return "ava";
  return undefined;
}

/** Configuration files needed before planning configured test paths. */
export function isTestConfiguration(path: string): boolean {
  const name = posix.basename(path);
  return (
    configFramework(path) !== undefined ||
    name === "package.json" ||
    /^vitest\.workspace\.[cm]?[jt]s$/.test(name)
  );
}
function iniSettings(
  text: string,
  path: string,
): { settings: { [key: string]: Literal }; complete: boolean } | undefined {
  const settings: { [key: string]: Literal } = {};
  let active = posix.basename(path) === "pytest.ini";
  let seen = active;
  let key = "";
  let complete = true;
  const source = text.split("\n");
  for (let lineIndex = 0; lineIndex < source.length; lineIndex++) {
    const line = source[lineIndex] ?? "";
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";"))
      continue;
    if (trimmed.startsWith("[")) {
      active = [
        "[pytest]",
        "[tool.pytest.ini_options]",
        "[tool:pytest]",
        "[test]",
      ].includes(trimmed);
      seen ||= active;
      continue;
    }
    if (!active) continue;
    const equal = line.indexOf("=");
    if (equal >= 0) {
      key = line.slice(0, equal).trim();
      let value = line.slice(equal + 1).trim();
      if (value.startsWith("[")) {
        while (
          !literal(tokenize(value), 0).complete &&
          lineIndex + 1 < source.length
        )
          value += `\n${source[++lineIndex] ?? ""}`;
      }
      if (
        value.startsWith("[") ||
        value.startsWith('"') ||
        value.startsWith("'")
      ) {
        const parsed = literal(tokenize(value), 0);
        if (parsed.value !== unknown) settings[key] = parsed.value;
        complete &&= parsed.complete;
      } else settings[key] = value;
    } else if (/^\s/.test(line) && key)
      settings[key] = `${String(settings[key] ?? "")} ${trimmed}`;
    else complete = false;
  }
  return seen ? { settings, complete } : undefined;
}
function readConfig(
  text: string,
  tokens = tokenize(text),
): {
  settings: { [key: string]: Literal };
  complete: boolean;
} {
  let start = -1;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i]?.value === "default" && tokens[i - 1]?.value === "export") {
      start = i + 1;
      if (
        tokens[start]?.value === "defineConfig" &&
        tokens[start + 1]?.value === "("
      )
        start += 2;
      break;
    }
    if (tokens[i]?.value === "exports" && tokens[i + 1]?.value === "=") {
      start = i + 2;
      break;
    }
  }
  if (start < 0 && tokens[0]?.value === "{") start = 0;
  const parsed = literal(tokens, start);
  return {
    settings: record(parsed.value),
    complete:
      parsed.complete && !!tokens[start] && tokens[start]?.value === "{",
  };
}
function groupFrom(
  framework: Framework,
  cwd: string,
  config: string,
  settings: { [key: string]: Literal },
  complete: boolean,
  project?: string,
): Group {
  const test = ["vitest", "deno"].includes(framework)
    ? record(settings.test)
    : settings;
  const root =
    typeof settings.root === "string"
      ? settings.root
      : typeof test.root === "string"
        ? test.root
        : undefined;
  const actualCwd = root ? posix.normalize(posix.join(cwd, root)) : cwd;
  let include = strings(
    test.include ?? test.testMatch ?? test.files ?? test.spec,
  );
  let exclude = strings(test.exclude ?? test.testPathIgnorePatterns);
  if (framework === "deno") exclude.push(...strings(settings.exclude));
  if (framework === "mocha") exclude.push(...strings(test.ignore));
  if (framework === "playwright") {
    const testDir = typeof test.testDir === "string" ? test.testDir : ".";
    include = strings(test.testMatch).map((p) => posix.join(testDir, p));
    if (!include.length && testDir !== ".")
      include = [
        `${testDir}/**/*.spec.{js,ts,jsx,tsx,mjs,cjs}`,
        `${testDir}/**/*.test.{js,ts,jsx,tsx,mjs,cjs}`,
      ];
    exclude = strings(test.testIgnore);
  }
  if (framework === "pytest") {
    const paths = strings(test.testpaths).flatMap((s) => shellWords(s));
    const filenames = strings(test.python_files).flatMap((s) => shellWords(s));
    if (paths.length || filenames.length)
      include = (paths.length ? paths : ["."]).flatMap((p) =>
        (filenames.length ? filenames : ["test_*.py", "*_test.py"]).map((f) =>
          posix.join(p, "**", f),
        ),
      );
    exclude = strings(test.norecursedirs)
      .flatMap((s) => shellWords(s))
      .map((p) => `**/${p}/**`);
  }
  const negatives = include
    .filter((p) => p.startsWith("!"))
    .map((p) => p.slice(1));
  exclude.push(...negatives);
  include = include.filter((p) => !p.startsWith("!"));
  const options =
    framework === "pytest"
      ? typeof test.addopts === "string"
        ? shellWords(test.addopts)
        : strings(test.addopts)
      : [];
  return {
    framework,
    cwd: actualCwd,
    config,
    ...(project
      ? { project }
      : typeof test.name === "string"
        ? { project: test.name }
        : {}),
    include,
    exclude,
    setup: strings(test.setupFiles ?? test.globalSetup),
    options,
    settings: test,
    provenance: `config:${config}`,
    incomplete: !complete,
  };
}

/** Pure discovery over the caller's tracked-file snapshot; no I/O or configuration evaluation. */
export function discoverTests(
  files: readonly { path: string; text: string }[],
  plannedPaths?: Set<string>,
  lexical?: LexicalSource,
  configurationPaths?: Set<string>,
): Discovery {
  const ordered = [...files].sort((a, b) => a.path.localeCompare(b.path));
  const byPath = new Map(ordered.map((f) => [posix.normalize(f.path), f]));
  const groups: Group[] = [];
  const invocations: {
    cwd: string;
    framework: Framework;
    config?: string;
    project?: string;
    invocation: NonNullable<TestEntry["invocation"]>;
  }[] = [];
  const typechecks: {
    cwd: string;
    invocation: NonNullable<TestEntry["invocation"]>;
  }[] = [];
  const limits: {
    path: string;
    kind:
      | "incomplete"
      | "unsupported"
      | "unknown"
      | "types"
      | "local_runner_unproven"
      | "interactive_script_skipped";
    framework?: Framework;
  }[] = [];
  const addLimit = (
    path: string,
    kind:
      | "incomplete"
      | "unsupported"
      | "unknown"
      | "types"
      | "local_runner_unproven"
      | "interactive_script_skipped",
    framework?: Framework,
  ) => {
    if (
      !limits.some(
        (l) => l.path === path && l.kind === kind && l.framework === framework,
      )
    )
      limits.push({ path, kind, ...(framework ? { framework } : {}) });
  };
  const visited = new Set<string>();
  const addConfig = (
    path: string,
    framework: Framework,
    options: string[] = [],
    project?: string,
  ) => {
    configurationPaths?.add(path);
    const key = `${path}:${framework}:${project ?? ""}:${JSON.stringify(options)}`;
    if (visited.has(key)) return;
    visited.add(key);
    const file = byPath.get(path);
    if (!file) {
      addLimit(path, "incomplete", framework);
      return;
    }
    const parsed =
      framework === "pytest" || path.endsWith(".toml")
        ? iniSettings(file.text, path)
        : readConfig(file.text, lexical?.tokenize(file.path, file.text));
    if (!parsed) return;
    const group = groupFrom(
      framework,
      directory(path),
      path,
      parsed.settings,
      parsed.complete,
      project,
    );
    if (framework === "deno") {
      const task = record(parsed.settings.tasks).test;
      if (typeof task === "string") {
        const words = shellWords(task);
        const flags = words.slice(2).filter((word) => word.startsWith("-"));
        const safe =
          words[0] === "deno" &&
          words[1] === "test" &&
          flags.every((flag) =>
            /^(?:-A|--allow-all|--allow-(?:read|write|net|env|run|sys|ffi)(?:=[\w@./,:*-]+)?|--no-check|--parallel|--fail-fast|--quiet)$/.test(
              flag,
            ),
          ) &&
          words
            .slice(2)
            .every((word) => flags.includes(word) || /^[\w./*-]+$/.test(word));
        if (safe) group.options.push(...flags);
        else group.incomplete = true;
      }
    }
    group.options.push(...options);
    const projects =
      parsed.settings.projects ?? record(parsed.settings.test).projects;
    if (Array.isArray(projects)) {
      for (const item of projects) {
        if (typeof item === "string") {
          const reference = posix.normalize(posix.join(directory(path), item));
          const found = ordered.filter(
            (f) =>
              matches(f.path, reference) ||
              (under(reference, f.path) &&
                configFramework(f.path) === framework),
          );
          if (!found.length) addLimit(reference, "incomplete", framework);
          for (const child of found)
            addConfig(child.path, framework, group.options);
        } else {
          const childSettings = record(item);
          const child = groupFrom(
            framework,
            group.cwd,
            path,
            {
              ...parsed.settings,
              ...childSettings,
              ...(framework === "vitest"
                ? {
                    test: {
                      ...record(parsed.settings.test),
                      ...record(childSettings.test),
                    },
                  }
                : {}),
            },
            parsed.complete,
          );
          child.options.push(...options);
          groups.push(child);
        }
      }
      // A projects list defines separate execution contexts, not an extra root run.
      if (group.incomplete) addLimit(path, "incomplete", framework);
    } else groups.push(group);
    const typecheck = record(group.settings.typecheck);
    if (strings(typecheck.include).length)
      groups.push({
        ...group,
        include: strings(typecheck.include),
        exclude: strings(typecheck.exclude),
        types: true,
      });
    if (group.incomplete) addLimit(path, "incomplete", framework);
  };
  // Configs must constrain implicit package scripts regardless of path ordering.
  for (const file of ordered) {
    const framework = configFramework(file.path);
    if (framework) addConfig(file.path, framework);
  }
  for (const file of ordered) {
    const framework = configFramework(file.path);
    if (framework) addConfig(file.path, framework);
    if (/^vitest\.workspace\.[cm]?[jt]s$/.test(posix.basename(file.path))) {
      const tokens = lexical
        ? lexical.tokenize(file.path, file.text)
        : tokenize(file.text);
      const index = tokens.findIndex(
        (t, i) => t.value === "default" && tokens[i - 1]?.value === "export",
      );
      const parsed = literal(tokens, index + 1);
      if (!parsed.complete) addLimit(file.path, "incomplete", "vitest");
      if (Array.isArray(parsed.value))
        for (const item of parsed.value) {
          if (typeof item === "string") {
            const pattern = posix.join(directory(file.path), item);
            const refs = ordered.filter(
              (f) =>
                matches(f.path, pattern) ||
                (under(pattern, f.path) &&
                  configFramework(f.path) === "vitest"),
            );
            if (!refs.length) addLimit(pattern, "incomplete", "vitest");
            for (const ref of refs) addConfig(ref.path, "vitest");
          } else
            groups.push(
              groupFrom(
                "vitest",
                directory(file.path),
                file.path,
                record(item),
                parsed.complete,
              ),
            );
        }
    }
    if (posix.basename(file.path) !== "package.json") continue;
    let manifest: { [key: string]: Literal };
    try {
      manifest = record(JSON.parse(file.text));
    } catch {
      addLimit(file.path, "incomplete");
      continue;
    }
    for (const framework of ["jest", "ava", "mocha"] as const)
      if (manifest[framework])
        groups.push(
          groupFrom(
            framework,
            directory(file.path),
            file.path,
            record(manifest[framework]),
            true,
          ),
        );
    const scripts = record(manifest.scripts);
    const claimedScripts = new Set<string>();
    for (const [scriptName, script] of Object.entries(scripts).sort(
      ([a], [b]) => Number(b === "test") - Number(a === "test"),
    )) {
      if (typeof script !== "string") continue;
      const allWords = shellWords(script);
      const lastSeparator = allWords.lastIndexOf("&");
      const tail = allWords.slice(lastSeparator + 1);
      const avaLoader =
        tail[1] === "ava" &&
        /^NODE_OPTIONS=--import=[\w@./-]+$/.test(tail[0] ?? "") &&
        allWords
          .slice(0, lastSeparator + 1)
          .every((word) => ["xo", "tsc", "&"].includes(word));
      const words = avaLoader ? tail : allWords;
      const simple = !words.some(
        (w) =>
          [";", "&", "|", "<", ">"].includes(w) ||
          w.includes("$") ||
          w.includes("`"),
      );
      if (
        words[0] === "tsc" &&
        simple &&
        words.some(
          (w) => w === "-p" || w === "--project" || w.startsWith("--project="),
        )
      ) {
        typechecks.push({
          cwd: directory(file.path),
          invocation: {
            executable: "tsc",
            args: words.slice(1),
            kind: "typecheck",
          },
        });
      }
      const commands: Record<string, Framework> = {
        vitest: "vitest",
        jest: "jest",
        bun: "bun",
        playwright: "playwright",
        pytest: "pytest",
        ava: "ava",
        mocha: "mocha",
        deno: "deno",
        node: "node",
        go: "go",
      };
      const index = words.findIndex(
        (w, i) =>
          commands[w] &&
          (w !== "node" || words.slice(i + 1).includes("--test")) &&
          (!["bun", "deno", "go"].includes(w) || words[i + 1] === "test"),
      );
      if (index < 0) continue;
      const framework = commands[words[index] ?? ""];
      if (!framework) continue;
      const args = words.slice(index + 1);
      const configIndex = args.findIndex((w) => ["--config", "-c"].includes(w));
      const configFlag = args.find((w) => w.startsWith("--config="));
      const reference =
        configIndex >= 0 ? args[configIndex + 1] : configFlag?.slice(9);
      const options: string[] = [];
      const includes: string[] = [];
      let incomplete = words.some(
        (w) =>
          [";", "&", "|", "<", ">"].includes(w) ||
          w.includes("$") ||
          w.includes("`"),
      );
      if (
        ["ava", "mocha", "deno"].includes(framework) &&
        index > 0 &&
        !avaLoader
      )
        incomplete = true;
      let scriptCwd = directory(file.path);
      let unsafeOptions = false;
      let project: string | undefined;
      const interactive = args.some(
        (arg) =>
          [
            "--watch",
            "--watchAll",
            "-w",
            ...(framework === "mocha" ? [] : ["--ui"]),
          ].includes(arg) ||
          (framework === "mocha"
            ? /^(?:--watch|--watchAll)=/
            : /^(?:--watch|--watchAll|--ui)=/
          ).test(arg),
      );
      for (let i = 0; i < args.length; i++) {
        const arg = args[i] ?? "";
        if (["run", "test", "--test"].includes(arg)) continue;
        if (
          [
            "--watch",
            "--watchAll",
            "-w",
            ...(framework === "mocha" ? [] : ["--ui"]),
          ].includes(arg) ||
          (framework === "mocha"
            ? /^(?:--watch|--watchAll)=/
            : /^(?:--watch|--watchAll|--ui)=/
          ).test(arg)
        )
          continue;
        if (["--config", "-c"].includes(arg)) {
          i++;
          continue;
        }
        if (arg.startsWith("--config=")) continue;
        if (["--project", "--selectProjects"].includes(arg)) {
          project = args[++i];
          continue;
        }
        if (arg.startsWith("--project=")) {
          project = arg.slice(10);
          continue;
        }
        if (arg === "--cwd" || arg.startsWith("--cwd=")) {
          const cwd = arg === "--cwd" ? args[++i] : arg.slice(6);
          if (cwd) scriptCwd = posix.normalize(posix.join(scriptCwd, cwd));
          else {
            incomplete = true;
            unsafeOptions = true;
          }
          continue;
        }
        if (
          framework === "deno" &&
          /^(?:-A|--allow-all|--allow-(?:read|write|net|env|run|sys|ffi)(?:=.*)?)$/.test(
            arg,
          )
        ) {
          options.push(arg);
          continue;
        }
        if (
          [
            "--reporter",
            "--environment",
            "--pool",
            "--timeout",
            "--testTimeout",
            "--loader",
            "--import",
            "--require",
            "--grep",
            "--fgrep",
            "--file",
            "--spec",
            "--ui",
            "--extension",
            "--maxWorkers",
            "--minWorkers",
            "-n",
            "-r",
            "-m",
            "-k",
          ].includes(arg)
        ) {
          options.push(arg, args[++i] ?? "");
          continue;
        }
        if (arg.startsWith("-")) {
          if (
            !arg.includes("=") &&
            args[i + 1] &&
            !args[i + 1]?.startsWith("-") &&
            ![
              "--coverage",
              "--run",
              "--noEmit",
              "--passWithNoTests",
              "--bail",
            ].includes(arg)
          ) {
            unsafeOptions = true;
            incomplete = true;
            i++;
          } else options.push(arg);
        } else if (
          /\.(?:[cm]?[jt]sx?|py)$/.test(arg) ||
          arg.includes("*") ||
          (framework === "deno" && arg.endsWith("/")) ||
          byPath.has(posix.join(directory(file.path), arg))
        )
          includes.push(arg);
        else incomplete = true;
      }
      if (unsafeOptions) options.length = 0;
      if (
        reference &&
        ["ava", "mocha", "deno"].includes(framework) &&
        !byPath.has(
          posix.normalize(posix.join(directory(file.path), reference)),
        )
      )
        incomplete = true;
      const context = JSON.stringify([
        framework,
        scriptCwd,
        reference ?? "",
        project ?? "",
      ]);
      if (claimedScripts.has(context)) continue;
      claimedScripts.add(context);
      if (interactive)
        addLimit(file.path, "interactive_script_skipped", framework);
      if (reference)
        addConfig(
          posix.normalize(posix.join(directory(file.path), reference)),
          framework,
          options,
          project,
        );
      if (reference && ["ava", "mocha", "deno"].includes(framework)) {
        const configPath = posix.normalize(
          posix.join(directory(file.path), reference),
        );
        for (const group of groups.filter(
          (group) =>
            group.config === configPath && group.framework === framework,
        )) {
          group.cwd = scriptCwd;
          if (!group.include.length || framework === "mocha")
            group.include.push(...includes);
          group.incomplete ||= incomplete;
        }
      }
      if (!reference) {
        const existing = groups.filter(
          (g) => g.framework === framework && g.cwd === scriptCwd,
        );
        if (!existing.length)
          groups.push({
            framework,
            cwd: scriptCwd,
            ...(project ? { project } : {}),
            include: includes,
            exclude: [],
            setup: [],
            options,
            settings: {},
            provenance: `script:${file.path}:${scriptName}`,
            incomplete,
          });
        else
          for (const group of existing) {
            group.options.push(...options);
            if (
              ["ava", "mocha", "deno"].includes(framework) &&
              (!group.include.length || framework === "mocha")
            )
              group.include.push(...includes);
            if (["ava", "mocha", "deno"].includes(framework))
              group.incomplete ||= incomplete;
          }
      }
      if (simple && (index === 0 || avaLoader) && !incomplete && !interactive) {
        const prefix =
          framework === "node"
            ? ["--test"]
            : ["bun", "go", "deno", "playwright"].includes(framework)
              ? ["test"]
              : framework === "vitest" && args.includes("run")
                ? ["run"]
                : [];
        invocations.push({
          cwd: scriptCwd,
          framework,
          ...(reference
            ? {
                config: posix.normalize(
                  posix.join(directory(file.path), reference),
                ),
              }
            : {}),
          ...(project ? { project } : {}),
          invocation: {
            executable: index === 1 ? "env" : (words[index] ?? framework),
            args: [
              ...(index === 1
                ? [words[0] ?? "", words[index] ?? framework]
                : []),
              ...prefix,
              ...options,
            ],
            kind: "runner",
          },
        });
      }
      if (incomplete) addLimit(file.path, "incomplete", framework);
    }
  }
  const entries: TestEntry[] = [];
  for (const file of ordered) {
    const typeFile = /\.(?:test|spec)-d\.[cm]?tsx?$/.test(file.path);
    const candidate =
      typeFile ||
      ["vitest", "jest", "node", "bun", "ava", "go", "pytest"].some(
        (framework) => native(file.path, framework as Framework),
      ) ||
      groups.some((group) => {
        if (!under(group.cwd, file.path)) return false;
        const local = relative(group.cwd, file.path);
        return group.include.some(
          (pattern) =>
            matches(local, pattern) ||
            (under(pattern, local) && !pattern.includes("*")),
        );
      });
    if (!candidate) continue;
    if (plannedPaths) {
      plannedPaths.add(file.path);
      continue;
    }
    const python = file.path.endsWith(".py");
    const tokens = lexical
      ? lexical.tokenize(file.path, file.text, python)
      : tokenize(file.text, python);
    const bindings = imports(tokens);
    if (file.path.endsWith("_test.go")) {
      bindings.frameworks.add("go");
      if (
        /^\/\/\s*(?:go:build|\+build)\b/m.test(file.text) ||
        /_(?:linux|windows|darwin|amd64|arm64)_test\.go$/.test(file.path)
      )
        addLimit(file.path, "incomplete", "go");
    }
    if (file.path.endsWith(".py") && native(file.path, "pytest"))
      bindings.frameworks.add("pytest");
    const applicable = groups.filter((g) => under(g.cwd, file.path));
    const matched: Group[] = [];
    const blocked = new Set<Framework>();
    for (const group of applicable) {
      const local = relative(group.cwd, file.path);
      if (group.exclude.some((p) => matches(local, p) || local.includes(p))) {
        blocked.add(group.framework);
        continue;
      }
      const explicit = group.include.length > 0;
      if (
        !explicit &&
        group.provenance.startsWith("script:") &&
        !bindings.frameworks.has(group.framework) &&
        !["pytest", "go"].includes(group.framework)
      )
        continue;
      const included = explicit
        ? group.include.some(
            (p) => matches(local, p) || (under(p, local) && !p.includes("*")),
          )
        : native(local, group.framework) || typeFile;
      if (!included) {
        blocked.add(group.framework);
        continue;
      }
      if (!explicit && group.setup.some((p) => matches(local, p))) {
        blocked.add(group.framework);
        continue;
      }
      if (typeFile && !group.types) continue;
      matched.push(group);
    }
    // A closer package/config overrides an ancestor's default convention.
    const deepest = new Map<Framework, number>();
    for (const group of applicable)
      deepest.set(
        group.framework,
        Math.max(deepest.get(group.framework) ?? 0, group.cwd.length),
      );
    const candidates = matched.filter(
      (g) => g.cwd.length === deepest.get(g.framework),
    );
    for (const framework of bindings.frameworks) {
      if (
        blocked.has(framework) ||
        candidates.some((g) => g.framework === framework) ||
        applicable.some((g) => g.framework === framework)
      )
        continue;
      if (!native(file.path, framework)) continue;
      candidates.push({
        framework,
        cwd: framework === "go" ? directory(file.path) : ".",
        include: [],
        exclude: [],
        setup: [],
        options: [],
        settings: {},
        provenance: `declaration:${framework}`,
        incomplete: false,
      });
    }
    const frameworks = new Set([
      ...candidates.map((g) => g.framework),
      ...bindings.frameworks,
    ]);
    if (frameworks.size > 1 && candidates.length) {
      addLimit(file.path, "incomplete");
      continue;
    }
    if (typeFile && !candidates.length)
      candidates.push({
        framework: bindings.frameworks.values().next().value ?? "unknown",
        cwd: ".",
        include: [],
        exclude: [],
        setup: [],
        options: [],
        settings: {},
        provenance: "type convention",
        incomplete: false,
        types: true,
      });
    for (const group of candidates) {
      if (
        group.framework === "ava" &&
        !group.include.length &&
        /(?:^|\/)(?:_[^/]*|helpers|fixtures)(?:\/|$)/.test(file.path)
      )
        continue;
      let extracted: { scenarios: TestScenario[]; countKnown: boolean };
      const exclusiveMocha =
        group.framework === "mocha" &&
        tokens.some(
          (token, index) =>
            token.value === "only" &&
            tokens[index - 1]?.value === "." &&
            tokens[index + 1]?.value === "(",
        );
      if (group.framework === "pytest")
        extracted = pythonScenarios(file.text, group.settings);
      else if (group.framework === "go")
        extracted = goScenarios(tokens, file.text);
      else extracted = jsScenarios(tokens, group.framework, bindings);
      if (exclusiveMocha) extracted.countKnown = false;
      const explicit = group.include.length > 0;
      if (!explicit && !extracted.scenarios.length && !typeFile) continue;
      const kind = typeFile || group.types ? "types" : "runtime";
      const entry: TestEntry = {
        path: file.path,
        framework: group.framework,
        cwd: group.cwd,
        ...(group.config ? { config: group.config } : {}),
        ...(group.project ? { project: group.project } : {}),
        options: group.options,
        scenarios: extracted.scenarios,
        countKnown:
          extracted.countKnown &&
          !group.incomplete &&
          extracted.scenarios.length > 0,
        kind,
        provenance: group.provenance,
        ...(["ava", "deno"].includes(group.framework) && group.incomplete
          ? {
              commandRefusal:
                "runner configuration or options are not statically resolved",
            }
          : {}),
        ...(group.framework === "mocha"
          ? {
              ...(applicable.some(
                (candidate) =>
                  candidate.framework === "mocha" &&
                  (candidate.settings.spec !== undefined ||
                    candidate.settings.file !== undefined ||
                    candidate.options.some((option) =>
                      /^(?:--spec|--file)(?:=|$)/.test(option),
                    )),
              )
                ? { commandRefusal: "Mocha additive spec is not neutralized" }
                : applicable.some(
                      (candidate) =>
                        candidate.framework === "mocha" &&
                        (candidate.incomplete ||
                          candidate.settings.extends !== undefined),
                    )
                  ? {
                      commandRefusal:
                        "Mocha configuration is not statically resolved",
                    }
                  : {}),
              ...(exclusiveMocha
                ? {
                    nameFilterReason:
                      "Mocha .only declarations restrict project execution",
                  }
                : {}),
              nameFilterBlocked:
                applicable.some(
                  (candidate) =>
                    candidate.framework === "mocha" &&
                    (["grep", "fgrep", "invert"].some(
                      (key) => candidate.settings[key] !== undefined,
                    ) ||
                      (candidate.settings.ui !== undefined &&
                        candidate.settings.ui !== "bdd")),
                ) ||
                group.options.some(
                  (option, index) =>
                    /^(?:--grep|--fgrep|--invert|-g|-f|-i)(?:=|$)/.test(
                      option,
                    ) ||
                    (option === "--ui" && group.options[index + 1] !== "bdd") ||
                    (option.startsWith("--ui=") && option !== "--ui=bdd"),
                ),
            }
          : {}),
      };
      const proven = invocations.find(
        (i) =>
          i.framework === group.framework &&
          under(i.cwd, file.path) &&
          (!i.config || i.config === group.config) &&
          (!i.project || i.project === group.project),
      );
      if (kind === "types") {
        const typecheck = typechecks
          .filter((t) => under(t.cwd, file.path))
          .sort((a, b) => b.cwd.length - a.cwd.length)[0];
        if (typecheck) {
          entry.invocation = typecheck.invocation;
          entry.cwd = typecheck.cwd;
        }
      } else if (proven) entry.invocation = proven.invocation;
      else if (!["ava", "mocha", "deno", "unknown"].includes(group.framework))
        addLimit(file.path, "local_runner_unproven", group.framework);
      if (
        !entries.some(
          (e) =>
            e.path === entry.path &&
            e.framework === entry.framework &&
            e.cwd === entry.cwd &&
            e.config === entry.config &&
            e.project === entry.project &&
            e.kind === entry.kind &&
            JSON.stringify(e.options) === JSON.stringify(entry.options),
        )
      )
        entries.push(entry);
      if (
        ["ava", "mocha", "deno"].includes(group.framework) &&
        group.incomplete
      )
        addLimit(file.path, "incomplete", group.framework);
      if (kind === "types") addLimit(file.path, "types", group.framework);
    }
  }
  const evidence = ordered
    .filter((f) => isTestFile(f.path) || entries.some((e) => e.path === f.path))
    .map((f) => f.path);
  for (const path of evidence)
    if (!entries.some((e) => e.path === path)) {
      addLimit(path, "incomplete");
      if (!limits.some((limit) => limit.path === path && limit.framework))
        addLimit(path, "unknown", "unknown");
    }
  return { entries, evidence, limits };
}

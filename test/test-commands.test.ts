import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRunnerCommands } from "../src/core/test-commands.ts";
import type {
  Framework,
  TestEntry,
  TestScenario,
} from "../src/core/test-discovery.ts";

function entry(
  framework: Framework,
  overrides: Partial<TestEntry> = {},
): TestEntry {
  return {
    framework,
    ...(framework === "vitest"
      ? { runnerVersion: "3.2.7" }
      : framework === "jest"
        ? { runnerVersion: "30.4.2" }
        : {}),
    path: "test/example.test.ts",
    cwd: ".",
    options: [],
    scenarios: Array.from({ length: 5 }, (_, index) => ({
      id: `s${index}`,
      name: `case ${index}`,
      line: index + 1,
      reliable: true,
      ancestors: [],
    })),
    countKnown: true,
    kind: "runtime",
    provenance: "fixture",
    ...overrides,
  };
}

function selected(framework: Framework, scenarios: readonly TestScenario[]) {
  return entry(framework, {
    scenarios: [
      ...scenarios,
      ...Array.from({ length: 5 }, (_, index) => ({
        id: `other${index}`,
        name: `other ${index}`,
        line: 100 + index,
        reliable: true,
        ancestors: [],
      })),
    ],
  });
}

test("the 80% guard is inclusive and counts each identity only once", () => {
  const file = entry("vitest");
  const below = buildRunnerCommands([
    { entry: file, scenarioIds: ["s0", "s1", "s2", "s2"] },
  ]);
  assert.equal(below.commands[0]?.args.includes("-t"), true);
  const boundary = buildRunnerCommands([
    { entry: file, scenarioIds: ["s0", "s1", "s2", "s3"] },
  ]);
  assert.deepEqual(boundary.commands[0]?.args, ["run", "test/example.test.ts"]);
});

test("a whole file never receives another file's name filter", () => {
  const result = buildRunnerCommands([
    { entry: entry("jest", { path: "test/all.test.ts" }), scenarioIds: null },
    {
      entry: entry("jest", { path: "test/part.test.ts" }),
      scenarioIds: ["s0"],
    },
  ]);
  assert.deepEqual(result.commands[0]?.args, [
    "--runTestsByPath",
    "test/all.test.ts",
    "test/part.test.ts",
  ]);
  assert.ok(
    result.limits.some((limit) => limit.reason.startsWith("fallback: all")),
  );
});

test("Vitest and Jest escape and anchor native names without inventing a separator", () => {
  for (const framework of ["vitest", "jest"] as const) {
    const file = selected(framework, [
      { id: "chosen", name: "suite case (a+b)[x]", line: 3, reliable: true },
    ]);
    const command = buildRunnerCommands([
      { entry: file, scenarioIds: ["chosen"] },
    ]).commands[0];
    assert.ok(command);
    const namePattern = command.args[command.args.indexOf("-t") + 1];
    assert.ok(namePattern);
    const pattern = new RegExp(namePattern);
    assert.equal(pattern.test("suite case (a+b)[x]"), true);
    assert.equal(pattern.test("prefix suite case (a+b)[x]"), false);
    assert.equal(pattern.test("suite > case (a+b)[x]"), false);
  }
});

test("node admits each exact ancestor and places the filter before files", () => {
  const file = selected("node", [
    {
      id: "chosen",
      name: "outer middle child [x]",
      line: 4,
      reliable: true,
      ancestors: ["outer", "outer middle"],
    },
  ]);
  const command = buildRunnerCommands([
    { entry: file, scenarioIds: ["chosen"] },
  ]).commands[0];
  assert.ok(command);
  assert.deepEqual(command.args.slice(0, 2), ["--test", "--test-name-pattern"]);
  const namePattern = command.args[2];
  assert.ok(namePattern);
  const pattern = new RegExp(namePattern);
  for (const name of ["outer", "outer middle", "outer middle child [x]"])
    assert.ok(pattern.test(name));
  for (const name of ["outer sibling", "outer middle child x", "prefix outer"])
    assert.equal(pattern.test(name), false);
  const unresolved = selected("node", [
    { id: "chosen", name: "child", line: 4, reliable: true },
  ]);
  const fallback = buildRunnerCommands([
    { entry: unresolved, scenarioIds: ["chosen"] },
  ]);
  assert.deepEqual(fallback.commands[0]?.args, [
    "--test",
    "test/example.test.ts",
  ]);
  assert.ok(
    fallback.limits.some((limit) => limit.reason.startsWith("fallback: all")),
  );
});

test("cwd, config, project and options are never merged across groups", () => {
  const common = entry("vitest", {
    cwd: "packages/a",
    path: "packages/a/test/a.test.ts",
    config: "packages/a/vitest.config.ts",
    project: "browser",
    options: ["--environment", "jsdom"],
  });
  const result = buildRunnerCommands([
    { entry: common, scenarioIds: null },
    { entry: { ...common, project: "node" }, scenarioIds: null },
    { entry: { ...common, options: ["--pool", "forks"] }, scenarioIds: null },
    { entry: { ...common, cwd: "." }, scenarioIds: null },
    {
      entry: { ...common, config: "packages/a/vitest.other.ts" },
      scenarioIds: null,
    },
  ]);
  assert.equal(result.commands.length, 5);
  assert.deepEqual(result.commands[0]?.args, [
    "run",
    "--environment",
    "jsdom",
    "--config",
    "vitest.config.ts",
    "--project",
    "browser",
    "test/a.test.ts",
  ]);
  assert.deepEqual(result.commands[2]?.args.slice(0, 3), [
    "run",
    "--pool",
    "forks",
  ]);
});

test("pytest preserves full nodeids, classes, parameters and spaces in one argument", () => {
  const path = "packages/python/tests/test_cases.py";
  const file = selected("pytest", [
    {
      id: "one",
      name: `${path}::TestCases::test_value[a b]`,
      line: 3,
      reliable: true,
    },
    {
      id: "two",
      name: "TestOther::test_value[hello world]",
      line: 8,
      reliable: true,
    },
  ]);
  const result = buildRunnerCommands([
    {
      entry: {
        ...file,
        path,
        cwd: "packages/python",
        options: ["-m", "not stress"],
        config: "packages/python/pytest.ini",
      },
      scenarioIds: ["one", "two"],
    },
  ]);
  assert.deepEqual(result.commands[0]?.args, [
    "-m",
    "pytest",
    "-m",
    "not stress",
    "-c",
    "pytest.ini",
    "tests/test_cases.py::TestCases::test_value[a b]",
    "tests/test_cases.py::TestOther::test_value[hello world]",
  ]);
});

test("Bun forces exact paths and Playwright escapes the path before the line", () => {
  assert.deepEqual(
    buildRunnerCommands([{ entry: entry("bun"), scenarioIds: null }])
      .commands[0]?.args,
    ["test", "./test/example.test.ts"],
  );
  const file = selected("playwright", [
    { id: "chosen", name: "test", line: 42, reliable: true },
  ]);
  const command = buildRunnerCommands([
    { entry: { ...file, path: "test/a[1].spec.ts" }, scenarioIds: ["chosen"] },
  ]).commands[0];
  assert.ok(command);
  assert.deepEqual(command.args, ["test", "test/a\\[1\\]\\.spec\\.ts:42"]);
});

test("Go targets packages and preserves top-level examples and build options", () => {
  const file = selected("go", [
    { id: "example", name: "ExampleValue_suffix", line: 2, reliable: true },
    { id: "test", name: "TestValue", line: 8, reliable: true },
  ]);
  const result = buildRunnerCommands([
    {
      entry: {
        ...file,
        path: "doc/value_test.go",
        options: ["-tags", "integration"],
      },
      scenarioIds: ["example", "test"],
    },
  ]);
  assert.deepEqual(result.commands[0]?.args, [
    "test",
    "-tags",
    "integration",
    "./doc",
    "-run",
    "^ExampleValue_suffix$|^TestValue$",
  ]);
  const subtest = selected("go", [
    { id: "sub", name: "TestValue/child", line: 3, reliable: true },
  ]);
  const fallback = buildRunnerCommands([
    { entry: subtest, scenarioIds: ["sub"] },
  ]);
  assert.deepEqual(fallback.commands[0]?.args, [
    "test",
    "./test",
    "-run",
    "^TestValue$",
  ]);
  assert.ok(
    fallback.limits.some((limit) => limit.reason.startsWith("fallback: all")),
  );
});

test("unknown runners and type tests retain a manual action", () => {
  for (const framework of ["unknown"] as const) {
    const result = buildRunnerCommands([
      { entry: entry(framework), scenarioIds: null },
    ]);
    assert.deepEqual(result.commands, []);
    assert.deepEqual(result.limits, [
      {
        files: ["test/example.test.ts"],
        reason: "framework unknown",
        action: "run the listed files with the project runner",
      },
    ]);
  }
  const types = buildRunnerCommands([
    { entry: entry("vitest", { kind: "types" }), scenarioIds: null },
  ]);
  assert.deepEqual(types.commands, []);
  assert.equal(types.limits[0]?.action, "run the project's type-check command");
});

test("unknown counts, dynamic or ambiguous names and missing identities fall back to the file", () => {
  const files = [
    entry("vitest", { countKnown: false }),
    entry("vitest", {
      scenarios: entry("vitest").scenarios.map((scenario, index) => ({
        ...scenario,
        reliable: index !== 4,
      })),
    }),
    entry("vitest", {
      scenarios: entry("vitest").scenarios.map((scenario) => ({
        ...scenario,
        name: "duplicate",
      })),
    }),
  ];
  for (const file of files) {
    const result = buildRunnerCommands([{ entry: file, scenarioIds: ["s0"] }]);
    assert.deepEqual(result.commands[0]?.args, ["run", "test/example.test.ts"]);
    assert.ok(
      result.limits.some((limit) => limit.reason.startsWith("fallback: all")),
    );
  }
  const absent = buildRunnerCommands([
    { entry: entry("jest"), scenarioIds: ["absent"] },
  ]);
  assert.deepEqual(absent.commands[0]?.args, [
    "--runTestsByPath",
    "test/example.test.ts",
  ]);
});

test("an empty selection produces neither commands nor empty patterns", () => {
  assert.deepEqual(buildRunnerCommands([]), { commands: [], limits: [] });
  assert.deepEqual(
    buildRunnerCommands([{ entry: entry("vitest"), scenarioIds: [] }]),
    { commands: [], limits: [] },
  );
});

test("a typecheck invocation keeps its project scope without adding files", () => {
  const file = entry("vitest", {
    kind: "types",
    config: "tsconfig.test.json",
    project: "types",
    options: ["--ignored-for-typecheck"],
    invocation: {
      executable: "tsc",
      args: ["--noEmit", "-p", "tsconfig.test.json"],
      kind: "typecheck",
    },
  });
  const result = buildRunnerCommands([{ entry: file, scenarioIds: ["s0"] }]);
  assert.equal(result.commands[0]?.executable, "tsc");
  assert.deepEqual(result.commands[0]?.args, [
    "--noEmit",
    "-p",
    "tsconfig.test.json",
  ]);
  assert.ok(
    result.limits.some((limit) =>
      limit.reason.startsWith("typecheck project scope"),
    ),
  );
});

test("a local invocation preserves its prefix without duplicating options", () => {
  const file = entry("vitest", {
    options: ["--pool", "forks"],
    project: "unit",
    config: "vitest.config.ts",
    invocation: {
      executable: "./node_modules/.bin/vitest",
      args: ["run", "--pool", "forks"],
      kind: "runner",
    },
  });
  const result = buildRunnerCommands([{ entry: file, scenarioIds: ["s0"] }]);
  assert.equal(result.commands[0]?.executable, "./node_modules/.bin/vitest");
  assert.deepEqual(result.commands[0]?.args, [
    "run",
    "--pool",
    "forks",
    "--config",
    "vitest.config.ts",
    "--project",
    "unit",
    "-t",
    "^case 0$",
    "test/example.test.ts",
  ]);
  assert.equal(
    result.limits.some((limit) =>
      limit.reason.includes("local_runner_unproven"),
    ),
    false,
  );
  assert.ok(file.invocation);
  const other = {
    ...file,
    invocation: { ...file.invocation, executable: "./vendor/vitest" },
  };
  assert.equal(
    buildRunnerCommands([
      { entry: file, scenarioIds: null },
      { entry: other, scenarioIds: null },
    ]).commands.length,
    2,
  );
});

test("a framework import preserves the native command without claiming availability", () => {
  const result = buildRunnerCommands([
    { entry: entry("vitest"), scenarioIds: null },
  ]);
  assert.equal(result.commands[0]?.executable, "vitest");
  assert.ok(
    result.limits.some((limit) =>
      limit.reason.startsWith("local_runner_unproven"),
    ),
  );
});

test("a Vitest script without a subcommand remains a single run", () => {
  for (const prefix of [
    ["--pool", "forks"],
    ["run", "--pool", "forks"],
  ]) {
    const file = entry("vitest", {
      options: ["--pool", "forks"],
      invocation: { executable: "vitest", args: prefix, kind: "runner" },
    });
    const result = buildRunnerCommands([{ entry: file, scenarioIds: null }]);
    assert.equal(result.commands[0]?.executable, "vitest");
    assert.deepEqual(result.commands[0]?.args, [
      "run",
      "--pool",
      "forks",
      "test/example.test.ts",
    ]);
  }
});

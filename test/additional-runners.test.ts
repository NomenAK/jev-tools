import assert from "node:assert/strict";
import test from "node:test";
import { buildRunnerCommands } from "../src/core/test-commands.ts";
import { discoverTests } from "../src/core/test-discovery.ts";

const file = (path: string, text: string) => ({ path, text });
test("AVA preserves its loader and exclusions without a name filter", () => {
  const result = discoverTests([
    file(
      "package.json",
      JSON.stringify({
        scripts: { test: "xo && NODE_OPTIONS='--import=tsx/esm' ava" },
        ava: {
          files: ["test/*.ts", "!test/*.types.ts"],
          extensions: { ts: "module" },
        },
      }),
    ),
    file(
      "test/chosen.ts",
      "import test from 'ava'; test('chosen', t => t.pass()); test('other', t => t.pass());",
    ),
    file(
      "test/chosen.types.ts",
      "import test from 'ava'; test('types', t => t.pass());",
    ),
  ]);
  assert.deepEqual(
    result.entries.map((entry) => entry.path),
    ["test/chosen.ts"],
  );
  const entry = result.entries[0];
  assert.ok(entry);
  const commands = buildRunnerCommands([{ entry, scenarioIds: ["s1"] }]);
  assert.deepEqual(
    commands.commands.map((command) => [command.executable, command.args]),
    [["env", ["NODE_OPTIONS=--import=tsx/esm", "ava", "test/chosen.ts"]]],
  );
});

test("Mocha additive spec refuses a falsely targeted command", () => {
  const result = discoverTests([
    file(
      "package.json",
      JSON.stringify({
        scripts: { test: "mocha tests/*.test.cjs" },
        mocha: { spec: ["tests/extra.test.cjs"] },
      }),
    ),
    file(
      "tests/chosen.test.cjs",
      "describe('outer', () => { it('chosen', () => {}); it('other', () => {}); });",
    ),
    file("tests/extra.test.cjs", "it('extra', () => {});"),
  ]);
  const entry = result.entries.find(
    (entry) => entry.path === "tests/chosen.test.cjs",
  );
  assert.ok(entry);
  const resultCommands = buildRunnerCommands([{ entry, scenarioIds: null }]);
  assert.deepEqual(resultCommands.commands, []);
  assert.ok(
    resultCommands.limits.some((limit) => limit.reason.includes("spec")),
  );
});

test("Deno preserves permission and import-map configuration at file granularity", () => {
  const result = discoverTests([
    file(
      "smoke/deno.jsonc",
      '{"imports":{"axios":"../../dist/axios.js"},"test":{"include":["tests/*.test.ts"],"exclude":["tests/excluded.test.ts"]},"tasks":{"test":"deno test --allow-read tests/"}}',
    ),
    file(
      "smoke/tests/chosen.test.ts",
      "Deno.test('chosen', async t => { await t.step('step', () => {}); }); Deno.test('other', () => {});",
    ),
    file("smoke/tests/excluded.test.ts", "Deno.test('excluded', () => {});"),
  ]);
  assert.deepEqual(
    result.entries.map((entry) => entry.path),
    ["smoke/tests/chosen.test.ts"],
  );
  const entry = result.entries[0];
  assert.ok(entry);
  const command = buildRunnerCommands([{ entry, scenarioIds: ["s1"] }])
    .commands[0];
  assert.ok(command);
  assert.deepEqual(command.args, [
    "test",
    "--allow-read",
    "--config",
    "deno.jsonc",
    "tests/chosen.test.ts",
  ]);
});

test("Mocha verified fullTitle filter never overrides project filters", () => {
  const entry = discoverTests([
    file("package.json", '{"scripts":{"test":"mocha tests/*.test.cjs"}}'),
    file(
      "tests/chosen.test.cjs",
      "describe('outer', () => { it('chosen (a+b)', () => {}); it('other', () => {}); });",
    ),
  ]).entries[0];
  assert.ok(entry);
  entry.runnerVersion = "11.8.0";
  assert.deepEqual(
    buildRunnerCommands([{ entry, scenarioIds: ["s1"] }]).commands[0]?.args,
    ["--grep", "^outer chosen \\(a\\+b\\)$", "tests/chosen.test.cjs"],
  );
  entry.nameFilterBlocked = true;
  assert.deepEqual(
    buildRunnerCommands([{ entry, scenarioIds: ["s1"] }]).commands[0]?.args,
    ["tests/chosen.test.cjs"],
  );
  entry.nameFilterBlocked = false;
  entry.runnerVersion = "11.9.0";
  assert.deepEqual(
    buildRunnerCommands([{ entry, scenarioIds: ["s1"] }]).commands[0]?.args,
    ["tests/chosen.test.cjs"],
  );
});

test("AVA and Mocha glob metacharacters cannot generate targeted commands", () => {
  for (const framework of ["ava", "mocha"] as const) {
    const entry = discoverTests([
      file(
        "package.json",
        JSON.stringify({ scripts: { test: `${framework} tests/*.test.js` } }),
      ),
      file("tests/[chosen].test.js", "it('chosen', () => {});"),
    ]).entries[0];
    assert.ok(entry);
    const result = buildRunnerCommands([{ entry, scenarioIds: null }]);
    assert.deepEqual(result.commands, []);
    assert.ok(
      result.limits.some((limit) => limit.reason.includes("metacharacters")),
    );
  }
});

test("Mocha BDD aliases preserve fullTitle and the scenario count", () => {
  const entry = discoverTests([
    file("package.json", '{"scripts":{"test":"mocha tests/*.test.cjs"}}'),
    file(
      "tests/aliases.test.cjs",
      "describe('outer', () => { context('ctx', () => { it('chosen', () => {}); specify('other', () => {}); xspecify('pending', () => {}); }); xcontext('skipped', () => { it('nested', () => {}); }); });",
    ),
  ]).entries[0];
  assert.ok(entry);
  assert.deepEqual(
    entry.scenarios.map((scenario) => scenario.name),
    [
      "outer ctx chosen",
      "outer ctx other",
      "outer ctx pending",
      "outer skipped nested",
    ],
  );
  entry.runnerVersion = "11.8.0";
  assert.deepEqual(
    buildRunnerCommands([{ entry, scenarioIds: ["s1"] }]).commands[0]?.args,
    ["--grep", "^outer ctx chosen$", "tests/aliases.test.cjs"],
  );
});

test("Mocha scripts cannot add spec or file outside selected identities", () => {
  for (const option of [
    "--spec=tests/extra.cjs",
    "--spec tests/extra.cjs",
    "--file tests/extra.cjs",
    "--file=tests/extra.cjs",
  ]) {
    const result = discoverTests([
      file(
        "package.json",
        JSON.stringify({
          scripts: { test: `mocha ${option} tests/*.test.cjs` },
        }),
      ),
      file("tests/chosen.test.cjs", "it('chosen', () => {});"),
      file("tests/extra.cjs", "it('extra', () => {});"),
    ]);
    const entry = result.entries.find(
      (entry) => entry.path === "tests/chosen.test.cjs",
    );
    assert.ok(entry);
    const commands = buildRunnerCommands([{ entry, scenarioIds: null }]);
    assert.deepEqual(commands.commands, []);
    assert.ok(commands.limits.some((limit) => /additive/.test(limit.reason)));
  }
});

test("Deno top-level exclude and Mocha ignore remove executable candidates", () => {
  for (const framework of ["deno", "mocha"] as const) {
    const config = framework === "deno" ? "deno.json" : ".mocharc.json";
    const settings =
      framework === "deno"
        ? {
            exclude: ["tests/excluded.test.js"],
            test: { include: ["tests/*.test.js"] },
          }
        : { ignore: ["tests/excluded.test.js"] };
    const result = discoverTests([
      file(config, JSON.stringify(settings)),
      file(
        "package.json",
        JSON.stringify({
          scripts: {
            test: `${framework}${framework === "deno" ? " test" : ""} tests/*.test.js`,
          },
        }),
      ),
      file(
        "tests/excluded.test.js",
        framework === "deno"
          ? "Deno.test('excluded', () => {});"
          : "it('excluded', () => {});",
      ),
      file(
        "tests/kept.test.js",
        framework === "deno"
          ? "Deno.test('kept', () => {});"
          : "it('kept', () => {});",
      ),
    ]);
    assert.deepEqual(
      result.entries.map((entry) => entry.path),
      ["tests/kept.test.js"],
    );
  }
});

test("AVA loader cannot hide a preceding cwd change", () => {
  const result = discoverTests([
    file(
      "package.json",
      JSON.stringify({
        scripts: {
          test: "cd packages/x && NODE_OPTIONS='--import=tsx/esm' ava",
        },
      }),
    ),
    file(
      "packages/x/test/a.js",
      "import test from 'ava'; test('chosen', t => t.pass());",
    ),
  ]);
  const entry = result.entries[0];
  assert.ok(entry);
  assert.equal(entry.invocation, undefined);
  assert.deepEqual(
    buildRunnerCommands([{ entry, scenarioIds: null }]).commands,
    [],
  );
});

test("Deno task retains explicit all permissions", () => {
  for (const permission of ["-A", "--allow-all"]) {
    const entry = discoverTests([
      file(
        "deno.json",
        JSON.stringify({
          test: { include: ["tests/*.test.js"] },
          tasks: { test: `deno test ${permission} tests/` },
        }),
      ),
      file(
        "tests/a.test.js",
        "Deno.test('chosen', () => Deno.readTextFileSync('deno.json'));",
      ),
    ]).entries[0];
    assert.ok(entry);
    assert.deepEqual(
      buildRunnerCommands([{ entry, scenarioIds: null }]).commands[0]?.args,
      ["test", permission, "--config", "deno.json", "tests/a.test.js"],
    );
  }
});

test("AVA conventions exclude underscore files and fixture directories", () => {
  const source = "import test from 'ava'; test('chosen', t => t.pass());";
  const result = discoverTests([
    file("package.json", '{"scripts":{"test":"ava"}}'),
    ...[
      "test/_hidden.js",
      "test/helpers/a.js",
      "test/fixtures/a.js",
      "test/a.js",
    ].map((path) => file(path, source)),
  ]);
  assert.deepEqual(
    result.entries.map((entry) => entry.path),
    ["test/a.js"],
  );
});

test("AVA ignored conventions remain planned and unresolved test evidence", () => {
  const paths = [
    "tests/helpers/a.ts",
    "test/_harness.ts",
    "tests/fixtures/a.ts",
  ];
  const snapshot = paths.map((path) => file(path, "export const helper = 1;"));
  const planned = new Set<string>();
  discoverTests(snapshot, planned);
  assert.deepEqual([...planned].sort(), [...paths].sort());
  const discovered = discoverTests(
    snapshot.filter((file) => planned.has(file.path)),
  );
  assert.deepEqual([...discovered.evidence].sort(), [...paths].sort());
  for (const path of paths) {
    assert.ok(
      discovered.limits.some(
        (limit) => limit.path === path && limit.kind === "incomplete",
      ),
    );
    assert.ok(
      discovered.limits.some(
        (limit) => limit.path === path && limit.kind === "unknown",
      ),
    );
  }
});

test("Mocha exclusive declarations suppress narrow filters with a named limit", () => {
  const entry = discoverTests([
    file("package.json", '{"scripts":{"test":"mocha tests/*.test.cjs"}}'),
    file(
      "tests/a.test.cjs",
      "describe('outer', () => {it('chosen', () => {}); it.only('exclusive', () => {});});",
    ),
  ]).entries[0];
  assert.ok(entry);
  entry.runnerVersion = "11.8.0";
  const result = buildRunnerCommands([{ entry, scenarioIds: ["s1"] }]);
  assert.deepEqual(result.commands[0]?.args, ["tests/a.test.cjs"]);
  assert.ok(result.limits.some((limit) => limit.reason.includes(".only")));
});

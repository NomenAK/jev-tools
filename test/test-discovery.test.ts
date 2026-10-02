import assert from "node:assert/strict";
import test from "node:test";
import { buildRunnerCommands } from "../src/core/test-commands.ts";
import { discoverTests } from "../src/core/test-discovery.ts";

const file = (path: string, text: string) => ({ path, text });

test("discovery preserves fixtures and suffixes without inventing a runner", () => {
  const result = discoverTests([
    file("package.json", '{"devDependencies":{"vitest":"1"}}'),
    file("tests/fixture.ts", "export const fixture = 1"),
    file("value.test.ts", "export const fixture = 1"),
    file(
      "tests/conftest.py",
      "import pytest\n@pytest.fixture\ndef data(): return 1",
    ),
  ]);
  assert.deepEqual(result.entries, []);
  assert.deepEqual(result.evidence, [
    "tests/conftest.py",
    "tests/fixture.ts",
    "value.test.ts",
  ]);
  assert.deepEqual(
    result.limits.filter((l) => l.kind === "incomplete").map((l) => l.path),
    result.evidence,
  );
  assert.deepEqual(
    result.limits.filter((l) => l.kind === "unknown").map((l) => l.framework),
    ["unknown", "unknown", "unknown"],
  );
});

test("syntactic imports ignore comments and strings", () => {
  const result = discoverTests([
    file(
      "fake.test.ts",
      `// import {test} from 'vitest';\nconst x = "import {test} from 'vitest'";`,
    ),
    file(
      "real.test.ts",
      `import { test as check, describe as group } from 'vitest'; group('outer', () => { check.only('inner', () => {}); });`,
    ),
  ]);
  assert.deepEqual(
    result.entries.map((e) => e.path),
    ["real.test.ts"],
  );
  assert.deepEqual(
    result.entries[0]?.scenarios.map((s) => [s.name, s.reliable]),
    [["outer inner", true]],
  );
});

test("suite properties and conditional factories preserve native names without todo ghosts", () => {
  const result = discoverTests([
    file(
      "forms.spec.ts",
      `import { test } from '@playwright/test';
      test.describe('outer', () => {
        test('chosen', () => {});
        test.todo('pending');
      });`,
    ),
    file(
      "conditional.test.ts",
      `import { test } from 'vitest';
      test.if(true)('conditional', () => {});
      test('pending');
      test('options-only', {todo: true});`,
    ),
  ]);
  assert.deepEqual(
    result.entries.map((entry) =>
      entry.scenarios.map((scenario) => scenario.name),
    ),
    [["conditional"], ["outer › chosen"]],
  );
  assert.ok(result.entries.every((entry) => entry.countKnown));
});

test("Node object titles, named functions and context tests keep literal identities", () => {
  const result = discoverTests([
    file(
      "forms.test.js",
      `import test from 'node:test';
    test({name: 'object title'}, () => {});
    test(function namedCase() {});
    test('outer', async (ctx) => {
      await ctx.test('child', (context) => { context.test('leaf', () => {}); });
    });`,
    ),
  ]);
  assert.deepEqual(
    result.entries[0]?.scenarios.map((scenario) => scenario.name),
    ["object title", "namedCase", "outer", "outer child", "outer child leaf"],
  );
  assert.equal(result.entries[0]?.countKnown, true);
});

test("anonymous Node arrows cannot become reliable parameter-name filters", () => {
  for (const callback of [
    "(t) => {}",
    "async (t) => {}",
    "(t) => { t.test('child', () => {}); }",
  ]) {
    const result = discoverTests([
      file(
        "arrows.test.js",
        `import test from 'node:test';\ntest(${callback});\ntest('other', () => {});`,
      ),
    ]);
    const entry = result.entries[0];
    assert.ok(entry);
    assert.equal(entry.scenarios[0]?.name, "<dynamic:2>");
    assert.equal(entry.scenarios[0]?.reliable, false);
    assert.equal(entry.countKnown, false);
    const commands = buildRunnerCommands([{ entry, scenarioIds: ["s1"] }]);
    assert.equal(
      commands.commands[0]?.args.includes("--test-name-pattern"),
      false,
    );
    assert.ok(
      commands.limits.some((limit) => limit.reason.startsWith("fallback: all")),
    );
  }
});

test("calculated titles and callback references cannot produce narrow runner filters", () => {
  const result = discoverTests([
    file(
      "forms.test.ts",
      `import { test } from 'vitest';
    test('prefix' + suffix, () => {});
    test('callback reference', handler);
    test.each([1, 2])('row %i', () => {});`,
    ),
  ]);
  assert.equal(result.entries[0]?.countKnown, false);
  assert.ok(
    result.entries[0]?.scenarios.every((scenario) => !scenario.reliable),
  );
  const entry = result.entries[0];
  assert.ok(entry);
  const commands = buildRunnerCommands([{ entry, scenarioIds: ["s1"] }]);
  assert.ok(
    commands.limits.some((limit) => limit.reason.startsWith("fallback: all")),
  );
  assert.equal(commands.commands[0]?.args.includes("-t"), false);
});

test("arbitrary inclusions, priority exclusions and explicitly included helpers", () => {
  const result = discoverTests([
    file(
      "vitest.config.ts",
      `export default defineConfig({test:{include:['checks/*.ts'],exclude:['checks/skip.ts']}})`,
    ),
    file("checks/helper.ts", `test('helper',()=>{})`),
    file("checks/skip.ts", `import {test} from 'vitest'; test('skip',()=>{})`),
    file("else.test.ts", `import {test} from 'vitest'; test('outside',()=>{})`),
  ]);
  assert.deepEqual(
    result.entries.map((e) => e.path),
    ["checks/helper.ts"],
  );
  assert.equal(result.entries[0]?.config, "vitest.config.ts");
});

test("Vitest projects preserve cwd and project without duplicating root execution", () => {
  const result = discoverTests([
    file(
      "vitest.config.ts",
      `export default defineConfig({test:{projects:[{root:'packages/a',test:{name:'unit',include:['checks/*.ts']}},{root:'packages/a',test:{name:'browser',include:['checks/*.ts']}}]}})`,
    ),
    file("packages/a/checks/arbitrary.ts", `test('works',()=>{})`),
  ]);
  assert.deepEqual(
    result.entries.map((e) => [e.cwd, e.project, e.path]),
    [
      ["packages/a", "unit", "packages/a/checks/arbitrary.ts"],
      ["packages/a", "browser", "packages/a/checks/arbitrary.ts"],
    ],
  );
});

test("workspaces and missing references remain explicit", () => {
  const result = discoverTests([
    file(
      "vitest.workspace.ts",
      `export default ['packages/*/vitest.config.ts','missing/config.ts']`,
    ),
    file(
      "packages/a/vitest.config.ts",
      `export default {test:{include:['checks/*.ts']}}`,
    ),
    file("packages/a/checks/a.ts", `test('a',()=>{})`),
  ]);
  assert.equal(result.entries[0]?.cwd, "packages/a");
  assert.ok(
    result.limits.some(
      (l) => l.path === "missing/config.ts" && l.kind === "incomplete",
    ),
  );
});

test("calculated fragments remain usable without claiming a complete inventory", () => {
  const result = discoverTests([
    file(
      "vitest.config.ts",
      `export default defineConfig({test:{include:['checks/*.ts'],exclude: computeExcludes()}})`,
    ),
    file("checks/a.ts", `test('a',()=>{})`),
  ]);
  assert.equal(result.entries[0]?.countKnown, false);
  assert.ok(
    result.limits.some(
      (l) => l.path === "vitest.config.ts" && l.kind === "incomplete",
    ),
  );
});

test("pytest preserves options, classes, functions and conservative parameters", () => {
  const result = discoverTests([
    file(
      "pyproject.toml",
      `[tool.pytest.ini_options]\ntestpaths = ["checks"]\npython_files = ["case_*.py"]\naddopts = "-m 'not stress'"`,
    ),
    file(
      "checks/case_math.py",
      `import pytest\nclass TestMath:\n    def test_one(self): pass\n    @pytest.mark.parametrize('x', [1,2], ids=['one','two'])\n    def test_many(self,x): pass\nclass Helper:\n    def test_no(self): pass\ndef test_plain(): pass`,
    ),
    file(
      "checks/conftest.py",
      `import pytest\n@pytest.fixture\ndef input(): pass`,
    ),
  ]);
  assert.deepEqual(result.entries[0]?.options, ["-m", "not stress"]);
  assert.deepEqual(
    result.entries[0]?.scenarios.map((s) => [s.name, s.reliable]),
    [
      ["TestMath::test_one", true],
      ["TestMath::test_many[one]", true],
      ["TestMath::test_many[two]", true],
      ["test_plain", true],
    ],
  );
  assert.equal(result.entries[0]?.countKnown, true);
  assert.ok(result.evidence.includes("checks/conftest.py"));
  assert.ok(!result.entries.some((e) => e.path === "checks/conftest.py"));
});

test("type tests remain separate and runner conflicts visible", () => {
  const result = discoverTests([
    file("a.test-d.ts", "declare const value: number"),
    file(
      "both.test.ts",
      `import {test} from 'vitest'; import {it} from '@jest/globals'; test('a',()=>{}); it('b',()=>{});`,
    ),
  ]);
  assert.deepEqual(
    result.entries.map((e) => [e.path, e.kind]),
    [["a.test-d.ts", "types"]],
  );
  assert.ok(
    result.limits.some(
      (l) => l.path === "both.test.ts" && l.kind === "incomplete",
    ),
  );
});

test("Node preserves native ancestors and dynamic titles prevent filtering", () => {
  const result = discoverTests([
    file(
      "nest.test.js",
      `import test from 'node:test'; test('parent', async t => { await t.test('child', async t => { await t.test('leaf',()=>{}); }); });`,
    ),
    file(
      "dyn.test.ts",
      `import {test} from 'vitest'; test.each([1,2])('case %s',()=>{}); test(name,()=>{});`,
    ),
  ]);
  const node = result.entries.find((e) => e.framework === "node");
  assert.ok(node);
  assert.deepEqual(
    node.scenarios.map((s) => [s.name, s.ancestors]),
    [
      ["parent", []],
      ["parent child", ["parent"]],
      ["parent child leaf", ["parent", "parent child"]],
    ],
  );
  const dynamic = result.entries.find((e) => e.framework === "vitest");
  assert.ok(dynamic);
  assert.equal(dynamic.countKnown, false);
  assert.ok(dynamic.scenarios.every((s) => !s.reliable));
});

test("Go separates Test from runnable Example and reports constraints", () => {
  const result = discoverTests([
    file(
      "sub/value_test.go",
      `//go:build linux\npackage sub\nfunc TestValue(t *testing.T) {}\nfunc ExampleValue() { println(1)\n// Output: 1\n}\nfunc ExampleDoc() {}\nfunc BenchmarkValue(b *testing.B) {}`,
    ),
  ]);
  assert.equal(result.entries[0]?.cwd, "sub");
  assert.deepEqual(
    result.entries[0]?.scenarios.map((s) => s.name),
    ["TestValue", "ExampleValue"],
  );
  assert.ok(
    result.limits.some((l) => l.framework === "go" && l.kind === "incomplete"),
  );
});

test("literal scripts identify Node and options without an installed dependency", () => {
  const result = discoverTests([
    file(
      "pkg/package.json",
      JSON.stringify({
        scripts: { test: "node --import tsx --test checks/*.ts" },
      }),
    ),
    file(
      "pkg/checks/custom.ts",
      `import test from 'node:test'; test('custom',()=>{})`,
    ),
  ]);
  assert.deepEqual(
    result.entries.map((e) => [e.cwd, e.options]),
    [["pkg", ["--import", "tsx"]]],
  );
});

test("explicit invocations preserve options and typecheck scope", () => {
  const result = discoverTests([
    file(
      "pkg/package.json",
      JSON.stringify({
        scripts: {
          test: "vitest run --pool forks",
          types: "tsc -p tsconfig.test.json --noEmit",
        },
      }),
    ),
    file("pkg/a.test.ts", `import {test} from 'vitest'; test('a',()=>{})`),
    file("pkg/a.test-d.ts", "declare const x: number"),
  ]);
  assert.deepEqual(
    result.entries.find((e) => e.kind === "runtime")?.invocation,
    { executable: "vitest", args: ["run", "--pool", "forks"], kind: "runner" },
  );
  assert.deepEqual(result.entries.find((e) => e.kind === "types")?.invocation, {
    executable: "tsc",
    args: ["-p", "tsconfig.test.json", "--noEmit"],
    kind: "typecheck",
  });
  assert.equal(result.entries.find((e) => e.kind === "types")?.cwd, "pkg");
});

test("pytest does not fabricate generated or calculated IDs", () => {
  const result = discoverTests([
    file(
      "test_params.py",
      `import pytest\n@pytest.mark.parametrize('x',[1,2])\ndef test_generated(x): pass\n@pytest.mark.parametrize('x',values,ids=make_ids())\ndef test_dynamic(x): pass`,
    ),
  ]);
  assert.deepEqual(
    result.entries[0]?.scenarios.map((s) => [s.name, s.reliable]),
    [
      ["test_generated", false],
      ["test_dynamic", false],
    ],
  );
  assert.equal(result.entries[0]?.countKnown, false);
});

test("ranges bound each declaration and include Python decorators", () => {
  const result = discoverTests([
    file(
      "ranges.test.ts",
      `import {test,describe} from 'vitest';\ndescribe('suite',()=>{\n  test('one',()=>{\n    const text = ') }';\n  });\n  test('two',()=>{});\n});`,
    ),
    file(
      "test_ranges.py",
      `class TestRanges:\n    @mark.slow\n    @mark.timeout(1)\n    def test_one(self):\n        assert True\n\n    def test_two(self):\n        assert False\n`,
    ),
    file(
      "ranges_test.go",
      `package ranges\nfunc TestOne(t *testing.T) {\n  t.Log("}")\n}\nfunc ExampleOne() {\n // Output: one\n}`,
    ),
  ]);
  assert.deepEqual(
    result.entries
      .find((e) => e.framework === "vitest")
      ?.scenarios.map((s) => s.range),
    [
      { start: 3, end: 5 },
      { start: 6, end: 6 },
    ],
  );
  assert.deepEqual(
    result.entries
      .find((e) => e.framework === "pytest")
      ?.scenarios.map((s) => s.range),
    [
      { start: 2, end: 5 },
      { start: 7, end: 8 },
    ],
  );
  assert.deepEqual(
    result.entries
      .find((e) => e.framework === "go")
      ?.scenarios.map((s) => s.range),
    [
      { start: 2, end: 4 },
      { start: 5, end: 7 },
    ],
  );
});

test("an implicit script respects the loaded config and its exclusions", () => {
  const result = discoverTests([
    file("package.json", JSON.stringify({ scripts: { test: "vitest run" } })),
    file(
      "vitest.config.ts",
      `export default {test:{include:['src/**/*.test.ts'],exclude:['src/skip.test.ts']}}`,
    ),
    file("src/a.test.ts", `test('a',()=>{})`),
    file(
      "src/skip.test.ts",
      `import {test} from 'vitest'; test('skip',()=>{})`,
    ),
    file(
      "e2e/outside.test.ts",
      `import {test} from 'vitest'; test('outside',()=>{})`,
    ),
  ]);
  assert.deepEqual(
    result.entries.map((e) => e.path),
    ["src/a.test.ts"],
  );
  assert.deepEqual(result.entries[0]?.invocation, {
    executable: "vitest",
    args: ["run"],
    kind: "runner",
  });
});

test("the test script takes priority and watch fallback preserves coverage", () => {
  const preferred = discoverTests([
    file(
      "package.json",
      JSON.stringify({
        scripts: {
          "test:watch": "vitest --watch --coverage",
          test: "vitest run --coverage",
        },
      }),
    ),
    file("a.test.ts", `import {test} from 'vitest'; test('a',()=>{})`),
  ]);
  assert.deepEqual(preferred.entries[0]?.invocation, {
    executable: "vitest",
    args: ["run", "--coverage"],
    kind: "runner",
  });
  const watch = discoverTests([
    file(
      "package.json",
      JSON.stringify({
        scripts: { "test:watch": "vitest --watch --coverage" },
      }),
    ),
    file("vitest.config.ts", `export default {test:{include:['a.test.ts']}}`),
    file("a.test.ts", `test('a',()=>{})`),
  ]);
  assert.equal(watch.entries[0]?.invocation, undefined);
  assert.deepEqual(watch.entries[0]?.options, ["--coverage"]);
  assert.ok(watch.limits.some((l) => l.kind === "interactive_script_skipped"));
});

test("scripts without config do not override an imported runner and preserve cwd/options", () => {
  const result = discoverTests([
    file(
      "package.json",
      JSON.stringify({
        scripts: {
          bun: "bun test --cwd tests/bun",
          pytest: "pytest -n auto",
          jest: "jest --maxWorkers 2",
          bad: "vitest --mystery value --coverage",
        },
      }),
    ),
    file(
      "vitest.config.ts",
      `export default {test:{include:['src/*.test.ts']}}`,
    ),
    file("src/a.test.ts", `import {test} from 'vitest'; test('a',()=>{})`),
    file(
      "tests/bun/b.test.ts",
      `import {test} from 'bun:test'; test('b',()=>{})`,
    ),
    file("j.test.ts", `import {test} from '@jest/globals'; test('j',()=>{})`),
    file("test_p.py", `def test_p(): pass`),
  ]);
  assert.equal(
    result.entries.find((e) => e.path === "src/a.test.ts")?.framework,
    "vitest",
  );
  assert.deepEqual(
    result.entries.find((e) => e.framework === "bun")?.cwd,
    "tests/bun",
  );
  assert.deepEqual(
    result.entries.find((e) => e.framework === "jest")?.options,
    ["--maxWorkers", "2"],
  );
  assert.deepEqual(
    result.entries.find((e) => e.framework === "pytest")?.options,
    ["-n", "auto"],
  );
  assert.deepEqual(
    result.entries.find((e) => e.framework === "vitest")?.options,
    [],
  );
});

test("glob character classes and setup files do not become configs", () => {
  const result = discoverTests([
    file(
      "vitest.config.ts",
      `export default {test:{include:['src/*.[jt]s','src/[!a]*.ts'],exclude:['src/skip.ts'],setupFiles:['vitest.setup.ts']}}`,
    ),
    file("vitest.setup.ts", `throw new Error('never evaluate')`),
    file("src/a.js", `test('a',()=>{})`),
    file("src/b.ts", `test('b',()=>{})`),
    file("src/skip.ts", `test('skip',()=>{})`),
  ]);
  assert.deepEqual(
    result.entries.map((e) => e.path),
    ["src/a.js", "src/b.ts"],
  );
  assert.ok(!result.limits.some((l) => l.path === "vitest.setup.ts"));
});

test("pytest TOML arrays and multiline decorators preserve ranges and TestCase", () => {
  const result = discoverTests([
    file(
      "pyproject.toml",
      `[tool.pytest.ini_options]\ntestpaths = [\n "checks",\n]\npython_files = [\n "case_*.py",\n]`,
    ),
    file(
      "checks/case_a.py",
      `import unittest\nclass Arbitrary(unittest.TestCase):\n    @mark.parametrize(\n        'x', [1,2],\n        ids=['one','two'],\n    )\n    def test_one(self,x):\n        assert x\n`,
    ),
  ]);
  assert.deepEqual(
    result.entries[0]?.scenarios.map((s) => s.name),
    ["Arbitrary::test_one[one]", "Arbitrary::test_one[two]"],
  );
  assert.deepEqual(result.entries[0]?.scenarios[0]?.range, {
    start: 3,
    end: 8,
  });
});

test("Toolkit include motif preserves classes extension alternatives and optional JSX", () => {
  const result = discoverTests([
    file(
      "vitest.config.mts",
      `export default {test:{globals:true,setupFiles:['./vitest.setup.ts'],include:['./src/**/*.(spec|test).[jt]s?(x)']}}`,
    ),
    file(
      "vitest.setup.ts",
      `import {test} from 'vitest'; test('setup is not config',()=>{})`,
    ),
    file("src/query/tests/buildHooks.test.tsx", `test('hook',()=>{})`),
    file("src/tests/createSlice.spec.js", `test('slice',()=>{})`),
    file("src/tests/createSlice.test.jsx", `test('jsx',()=>{})`),
    file("src/tests/not-a-test.ts", `test('helper',()=>{})`),
  ]);
  assert.deepEqual(
    result.entries.map((entry) => entry.path),
    [
      "src/query/tests/buildHooks.test.tsx",
      "src/tests/createSlice.spec.js",
      "src/tests/createSlice.test.jsx",
    ],
  );
});

test("pytest preserves each TOML addopts argument without shell splitting", () => {
  const options = [
    "-m",
    "not stress",
    "--override-ini",
    "cache_dir=cache with spaces",
    "--tag='literal'",
    "",
  ];
  const result = discoverTests([
    file(
      "pyproject.toml",
      `[tool.pytest.ini_options]\naddopts = ${JSON.stringify(options)}`,
    ),
    file("test_options.py", "def test_options(): pass"),
  ]);
  assert.deepEqual(result.entries[0]?.options, options);
});

test("regex literals hide neither email scenarios nor their ranges", () => {
  const result = discoverTests([
    file(
      "email-regex.test.ts",
      String.raw`import { test, describe } from 'vitest';
const email = /^[a-z'"#]+@[a-z]+\.[a-z]+$/i;
const slash = /[\]/]\/\/*#'"/g;
const fake = /test('phantom', ()=>{})/;
describe('email', () => {
  test('accepts address', () => {
    const punctuation = /[(){}\[\]'"#]/;
    const quotient = 12 / 3 / 2;
  });
  test('rejects address', () => {});
});`,
    ),
  ]);
  assert.deepEqual(
    result.entries.map((entry) => entry.path),
    ["email-regex.test.ts"],
  );
  assert.deepEqual(
    result.entries[0]?.scenarios.map((scenario) => ({
      name: scenario.name,
      reliable: scenario.reliable,
      range: scenario.range,
    })),
    [
      {
        name: "email accepts address",
        reliable: true,
        range: { start: 6, end: 9 },
      },
      {
        name: "email rejects address",
        reliable: true,
        range: { start: 10, end: 10 },
      },
    ],
  );
  assert.equal(result.entries[0]?.countKnown, true);
});

test("Python decorator comments cannot swallow following test declarations", () => {
  const result = discoverTests([
    file("pytest.ini", "[pytest]\n"),
    file(
      "tests/test_money.py",
      "@pytest.mark.parametrize(\n    'amount',\n    [1, 2], # ( ignored comment\n)\ndef test_money(amount):\n    assert amount > 0\n\ndef test_other():\n    assert True\n",
    ),
  ]);
  assert.deepEqual(
    result.entries[0]?.scenarios.map((scenario) => scenario.name),
    ["test_money", "test_other"],
  );
  assert.equal(result.entries[0]?.scenarios[0]?.range?.start, 1);
});

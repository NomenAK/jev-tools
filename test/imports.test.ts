import assert from "node:assert/strict";
import test from "node:test";
import {
  buildImportGraph,
  createImportGraphBuilder,
  importClosure,
  importSearchSpecifiers,
} from "../src/core/imports.ts";

test("static closure resolves reexports, module-relative data and Python packages without inventing external edges", () => {
  const graph = buildImportGraph([
    {
      path: "tests/money.test.ts",
      text: "import { invoice } from '../src/index.js'; import fs from 'node:fs';",
    },
    { path: "src/index.ts", text: "export { invoice } from './invoice.js';" },
    {
      path: "src/invoice.ts",
      text: "import './money.js'; const data = new URL('./rates.json', import.meta.url);",
    },
    { path: "src/money.ts", text: "export const cents = 1;" },
    { path: "src/rates.json", text: "{}" },
    { path: "tests/test_python.py", text: "from pkg import billing\n" },
    { path: "pkg/__init__.py", text: "from . import billing\n" },
    { path: "pkg/billing.py", text: "from .money import cents\n" },
    { path: "pkg/money.py", text: "cents = 1\n" },
  ]);
  assert.deepEqual(
    new Set(importClosure(graph, "tests/money.test.ts").paths),
    new Set([
      "tests/money.test.ts",
      "src/index.ts",
      "src/invoice.ts",
      "src/money.ts",
      "src/rates.json",
    ]),
  );
  assert.ok(
    importClosure(graph, "tests/test_python.py").paths.includes("pkg/money.py"),
  );
  assert.deepEqual(graph.limits, []);
});

test("closure depth and stop policy are caller-owned, cycles terminate, unresolved imports remain visible", () => {
  const graph = buildImportGraph([
    {
      path: "a.ts",
      text: "import './b.js'; import('./' + name); import x from '@/alias';",
    },
    { path: "b.ts", text: "import './c.js';" },
    { path: "c.ts", text: "import './a.js';" },
  ]);
  assert.deepEqual(importClosure(graph, "a.ts", { maxDepth: 1 }).paths, [
    "a.ts",
    "b.ts",
  ]);
  assert.deepEqual(
    importClosure(graph, "a.ts", { stop: (path) => path === "b.ts" }).paths,
    ["a.ts", "b.ts"],
  );
  assert.deepEqual(importClosure(graph, "a.ts").paths, [
    "a.ts",
    "b.ts",
    "c.ts",
  ]);
  assert.deepEqual(graph.limits.map((limit) => limit.kind).sort(), [
    "dynamic",
    "unresolved",
  ]);
});

test("comments and string contents do not become imports; ambiguous module targets are limits", () => {
  const graph = buildImportGraph([
    {
      path: "a.ts",
      text: "// import './missing'\nconst s = \"import './also-missing'\"; import './dual';",
    },
    { path: "dual.ts", text: "" },
    { path: "dual.js", text: "" },
  ]);
  assert.equal(graph.limits.length, 1);
  assert.equal(graph.limits[0]?.kind, "ambiguous");
});

test("Python src roots, namespace packages and path mutations cannot justify skipping tests", () => {
  const graph = buildImportGraph([
    {
      path: "tests/test_money.py",
      text: 'import finance.money\nimport sys\nsys.path.insert(0, "src")\n',
    },
    { path: "src/finance/money.py", text: "value = 1\n" },
  ]);
  assert.ok(
    graph.limits.some(
      (limit) =>
        limit.path === "tests/test_money.py" && limit.kind === "unresolved",
    ),
  );
  assert.ok(
    graph.limits.some(
      (limit) =>
        limit.path === "tests/test_money.py" && limit.kind === "dynamic",
    ),
  );
});

test("literal module-relative URL passed to readFileSync is a resolved data edge", () => {
  const graph = buildImportGraph([
    {
      path: "src/report.js",
      text: 'const data=readFileSync(new URL("../config/report.json", import.meta.url), "utf8");',
    },
    { path: "config/report.json", text: "{}" },
  ]);
  assert.deepEqual(importClosure(graph, "src/report.js").paths, [
    "src/report.js",
    "config/report.json",
  ]);
  assert.deepEqual(graph.limits, []);
});

test("Python missing references are deduplicated and future imports are external", () => {
  const graph = buildImportGraph([
    {
      path: "pkg/tests/test_api.py",
      text: "from __future__ import annotations\nfrom ..core import Api\nfrom ..core import Factory\nimport plugin_unknown\nimport plugin_unknown\nimport importlib\nimportlib.import_module(name)\n",
    },
  ]);
  assert.deepEqual(
    graph.limits
      .filter((limit) => limit.kind === "unresolved")
      .map((limit) => limit.specifier),
    ["..core", "plugin_unknown"],
  );
  assert.ok(graph.limits.some((limit) => limit.kind === "dynamic"));
});

test("Python sibling directories resolve explicit relative imports without guessing src roots", () => {
  const graph = buildImportGraph([
    {
      path: "pkg/tests/test_api.py",
      text: "from .. import core\nfrom ..core import Api\n",
    },
    { path: "pkg/core.py", text: "from .support import helper\n" },
    { path: "pkg/support/__init__.py", text: "helper = 1\n" },
  ]);
  assert.deepEqual(importClosure(graph, "pkg/tests/test_api.py").paths, [
    "pkg/tests/test_api.py",
    "pkg/core.py",
    "pkg/support/__init__.py",
  ]);
  assert.deepEqual(graph.limits, []);
});

test("workspace exports resolve statically and unproven local aliases remain limits", () => {
  const graph = buildImportGraph([
    {
      path: "tests/billing.test.ts",
      text: "import {bill} from '@acme/billing'; import missing from '@acme/missing'; import util from 'src/util'; import ext from 'external-package';",
    },
    {
      path: "packages/billing/package.json",
      text: JSON.stringify({
        name: "@acme/billing",
        exports: { ".": "./src/index.ts" },
      }),
    },
    { path: "packages/billing/src/index.ts", text: "export const bill = 1" },
    {
      path: "packages/missing/package.json",
      text: JSON.stringify({ name: "@acme/missing", main: "./missing.js" }),
    },
    {
      path: "tsconfig.json",
      text: JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "src/*": ["src/*"] } },
      }),
    },
    { path: "src/util.ts", text: "export const util = 1" },
  ]);
  assert.ok(
    importClosure(graph, "tests/billing.test.ts").paths.includes("src/util.ts"),
  );
  assert.ok(
    importClosure(graph, "tests/billing.test.ts").paths.includes(
      "packages/billing/src/index.ts",
    ),
  );
  assert.deepEqual(
    graph.limits.map((l) => l.specifier),
    ["@acme/missing", "external-package"],
  );
});

test("workspace names cannot silently override local paths aliases", () => {
  const graph = buildImportGraph([
    { path: "test/lib.test.ts", text: "import {lib} from 'lib';" },
    {
      path: "legacy/lib/package.json",
      text: '{"name":"lib","main":"./legacy.js"}',
    },
    { path: "legacy/lib/legacy.js", text: "export const lib = 1;" },
    {
      path: "tsconfig.json",
      text: '{"compilerOptions":{"paths":{"lib":["./src/lib/index.ts"]}}}',
    },
    { path: "src/lib/index.ts", text: "export const lib = 2;" },
  ]);
  assert.deepEqual(importClosure(graph, "test/lib.test.ts").limits, [
    { path: "test/lib.test.ts", specifier: "lib", kind: "ambiguous" },
  ]);
});

test("unreadable or invalid local manifests limit bare imports but absent external packages do not", () => {
  const graph = buildImportGraph(
    [
      {
        path: "tests/local.test.ts",
        text: "import 'broken/subpath'; import '@acme/unreadable'; import 'absent-external';",
      },
      { path: "packages/broken/package.json", text: "invalid json" },
    ],
    {
      known: new Set([
        "tests/local.test.ts",
        "packages/broken/package.json",
        "packages/@acme/unreadable/package.json",
      ]),
    },
  );
  assert.deepEqual(importClosure(graph, "tests/local.test.ts").limits, [
    {
      path: "tests/local.test.ts",
      specifier: "broken/subpath",
      kind: "unresolved",
    },
    {
      path: "tests/local.test.ts",
      specifier: "@acme/unreadable",
      kind: "unresolved",
    },
  ]);
});

test("imported fs reader alias preserves literal data edges", () => {
  const graph = buildImportGraph([
    {
      path: "src/report.ts",
      text: "import {readFileSync as load} from 'node:fs'; const data=load('./data.json','utf8');",
    },
    { path: "src/data.json", text: "{}" },
  ]);
  assert.deepEqual(importClosure(graph, "src/report.ts").paths, [
    "src/report.ts",
    "src/data.json",
  ]);
  assert.deepEqual(graph.limits, []);
});

test("JSONC without aliases does not assume baseUrl and only module-relative URLs create edges", () => {
  const graph = buildImportGraph([
    {
      path: "tsconfig.json",
      text: '{ // comment\n "compilerOptions": {"strict":true,},}',
    },
    {
      path: "a.ts",
      text: `import ext from 'external'; new URL('./wrong.json','https://example.com'); new URL(value,base); const real=new URL('./data.json',import.meta.url);`,
    },
    { path: "wrong.json", text: "{}" },
    { path: "data.json", text: "{}" },
  ]);
  assert.deepEqual(importClosure(graph, "a.ts").paths, ["a.ts", "data.json"]);
  assert.deepEqual(graph.limits, []);
});

test("search specifiers round trip through the exact workspace and JSONC paths resolver", () => {
  const target = "packages/lib/src/value.ts";
  const configuration = [
    {
      path: "packages/lib/package.json",
      text: '{"name":"@acme/lib","exports":{".":"./src/value.ts","./value":"./src/value.ts"}}',
    },
    {
      path: "tsconfig.json",
      text: '{/*comment*/"compilerOptions":{"baseUrl":".","paths":{"@lib/*":["packages/lib/src/*"],"@value":["packages/lib/src/value.ts"],},},}',
    },
  ];
  const specifiers = importSearchSpecifiers(configuration, [target]);
  assert.ok(specifiers.includes("@acme/lib"));
  assert.ok(specifiers.includes("@acme/lib/value"));
  assert.ok(specifiers.includes("@lib/value"));
  assert.ok(specifiers.includes("@value"));
  const known = new Set([target]);
  const build = createImportGraphBuilder(configuration, known);
  for (const specifier of specifiers) {
    const suffix = specifier.startsWith("./") ? specifier.slice(2) : undefined;
    const cwd = suffix
      ? target
          .slice(0, target.length - ".ts".length - suffix.length)
          .replace(/\/$/, "")
      : "";
    const path = cwd ? `${cwd}/consumer.ts` : "consumer.ts";
    assert.deepEqual(
      build([{ path, text: `import '${specifier}';` }]).edges.get(path),
      [target],
      specifier,
    );
  }
});

test("conditional wildcard exports and folder aliases round trip", () => {
  const configuration = [
    {
      path: "packages/shared/package.json",
      text: JSON.stringify({
        name: "@paperclipai/shared",
        exports: { "./*": { types: "./src/*.ts", default: "./src/*.ts" } },
      }),
    },
    {
      path: "tsconfig.json",
      text: JSON.stringify({
        compilerOptions: { paths: { "@lib/*": ["packages/lib/*"] } },
      }),
    },
  ];
  const targets = [
    "packages/shared/src/node-version.ts",
    "packages/lib/widget/index.ts",
  ];
  const specifiers = importSearchSpecifiers(configuration, targets);
  assert.ok(specifiers.includes("@paperclipai/shared/node-version"));
  assert.ok(specifiers.includes("@lib/widget"));
  const build = createImportGraphBuilder(configuration, new Set(targets));
  for (const [specifier, target] of [
    ["@paperclipai/shared/node-version", targets[0]],
    ["@lib/widget", targets[1]],
  ]) {
    assert.deepEqual(
      build([
        { path: "consumer.ts", text: `import '${specifier}';` },
      ]).edges.get("consumer.ts"),
      [target],
    );
  }
});

test("private fields and Python floor division preserve following import evidence", () => {
  const graph = buildImportGraph([
    {
      path: "src/a.js",
      text: 'class Loader { async load() { this.#mod ??= await import("./heavy.js"); } }',
    },
    { path: "src/heavy.js", text: "export const value = 1;" },
    {
      path: "src/plugin.py",
      text: 'n = total // 2; mod = __import__("plugins")',
    },
  ]);
  assert.deepEqual(graph.edges.get("src/a.js"), ["src/heavy.js"]);
  assert.ok(
    graph.limits.some(
      (limit) => limit.path === "src/plugin.py" && limit.kind === "dynamic",
    ),
  );
});

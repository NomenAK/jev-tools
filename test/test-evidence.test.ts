import assert from "node:assert/strict";
import test from "node:test";
import { loadSyntaxRootParser } from "../src/adapters/syntax.ts";
import { buildImportGraph, type ImportSource } from "../src/core/imports.ts";
import type { TestEntry } from "../src/core/test-discovery.ts";
import { prepareTestEvidence } from "../src/core/test-evidence.ts";
import type { EvidenceUnit } from "../src/core/units.ts";

const parser = await loadSyntaxRootParser();
assert.ok(parser);
const entry: TestEntry = {
  path: "invoice.test.ts",
  framework: "node",
  cwd: ".",
  options: [],
  scenarios: [],
  countKnown: false,
  kind: "runtime",
  provenance: "fixture",
};
const moneySource = "export function money() { return 2; }";
const money: EvidenceUnit = {
  id: "money",
  file: "money.ts",
  name: "money",
  kind: "function",
  exported: true,
  before: null,
  after: moneySource,
  beforeRange: null,
  afterRange: { start: 1, end: 1 },
};
const run = (
  sources: Record<string, string>,
  changed: readonly EvidenceUnit[] = [money],
  candidate = entry,
) => {
  const files = Object.entries(sources).map(([path, text]) => ({ path, text }));
  return prepareTestEvidence(
    files,
    buildImportGraph(files),
    changed,
    parser,
  )(candidate);
};

test("retains whole invoice declaration but not unrelated format or duplicate test body", () => {
  const result = run({
    "invoice.test.ts": 'import { invoice } from "./invoice"; invoice();',
    "invoice.ts":
      'import { money } from "./money";\nexport function invoice() {\n return money();\n}\nexport function format() { return "unrelated"; }',
    "money.ts": moneySource,
  });
  assert.equal(result.uncertain, false);
  assert.deepEqual(
    result.units.map((unit) => unit.id),
    ["money"],
  );
  assert.deepEqual(result.imports, [
    {
      path: "invoice.ts",
      text: "export function invoice() {\n return money();\n}",
    },
  ]);
  assert.deepEqual(result.usedBy.get("money"), []);
});

test("named aliases, default imports, namespaces and cyclic barrels resolve without unrelated declarations", () => {
  const result = run({
    "invoice.test.ts": 'import bill from "./invoice"; bill();',
    "invoice.ts":
      'import * as api from "./core";\nexport default function invoice() { return api.cash(); }\nexport function format() { return "unrelated"; }',
    "core.ts":
      'export * from "./other";\nexport { money as cash } from "./money";',
    "other.ts":
      'export * from "./core";\nexport function unrelated() { return 0; }',
    "money.ts": moneySource,
  });
  assert.equal(result.uncertain, false);
  assert.deepEqual(
    result.units.map((unit) => unit.id),
    ["money"],
  );
  assert.deepEqual(
    result.imports.map((source) => source.text),
    ["export default function invoice() { return api.cash(); }"],
  );
  const alias = run({
    "invoice.test.ts": 'import { invoice as bill } from "./invoice"; bill();',
    "invoice.ts":
      'import { money as cash } from "./money";\nfunction invoice() { return cash(); }\nexport { invoice };',
    "money.ts": moneySource,
  });
  assert.equal(alias.uncertain, false);
  assert.deepEqual(
    alias.units.map((unit) => unit.id),
    ["money"],
  );
});

test("same-file callers remain whole declarations", () => {
  const result = run({
    "invoice.test.ts": 'import { invoice } from "./money"; invoice();',
    "money.ts": `${money.after}\nexport function invoice() { return money(); }\nexport function format() { return "unrelated"; }`,
  });
  assert.equal(result.uncertain, false);
  assert.deepEqual(result.imports, []);
  assert.deepEqual(result.usedBy.get("money"), [
    { path: "money.ts", text: "export function invoice() { return money(); }" },
  ]);
});

test("dynamic and ambiguous resolution retain candidates with typed limitations", () => {
  const dynamic = run({
    "invoice.test.ts": "const module = import(target);",
    "money.ts": moneySource,
  });
  assert.ok(dynamic.limits.some((limit) => limit.kind === "dynamic"));
  assert.equal(dynamic.uncertain, true);
  assert.deepEqual(
    dynamic.units.map((unit) => unit.id),
    ["money"],
  );
  const ambiguous = run({
    "invoice.test.ts": 'import { money } from "./core"; money();',
    "core.ts": 'export * from "./money"; export * from "./other";',
    "other.ts": "export function money() { return 0; }",
    "money.ts": moneySource,
  });
  assert.ok(ambiguous.limits.some((limit) => limit.kind === "ambiguous"));
  assert.equal(ambiguous.uncertain, true);
  assert.deepEqual(
    ambiguous.units.map((unit) => unit.id),
    ["money"],
  );
});

test("declaration limits in imported branches without a path to the diff do not make evidence uncertain", () => {
  const result = run({
    "invoice.test.ts":
      'import { invoice } from "./invoice"; import { helper } from "./helper"; invoice(); helper();',
    "invoice.ts":
      'import { money } from "./money";\nexport function invoice() { return money(); }',
    "helper.ts":
      'import * as api from "./unrelated"; export function helper() { return api; }',
    "unrelated.ts": "export function unrelated() { return 0; }",
    "money.ts": moneySource,
  });
  assert.equal(
    result.limits.some((limit) => limit.path === "helper.ts"),
    false,
  );
  assert.equal(result.uncertain, false);
  assert.deepEqual(result.imports, [
    {
      path: "invoice.ts",
      text: "export function invoice() { return money(); }",
    },
  ]);
});

test("declaration limits stay uncertain when their branch can reach the diff", () => {
  const result = run({
    "invoice.test.ts": 'import { helper } from "./helper"; helper();',
    "helper.ts":
      'import * as api from "./money"; export function helper() { return api; }',
    "money.ts": moneySource,
  });
  assert.ok(
    result.limits.some(
      (limit) => limit.path === "helper.ts" && limit.kind === "unsupported",
    ),
  );
  assert.equal(result.uncertain, true);
  assert.deepEqual(
    result.units.map((unit) => unit.id),
    ["money"],
  );
});

test("malformed unrelated imports do not make an entry uncertain", () => {
  const files = Object.entries({
    "invoice.test.ts": 'import { helper } from "./helper"; helper();',
    "helper.ts": "export function helper( {",
    "unused.ts": "const loaded = import(target);",
    "money.ts": moneySource,
  }).map(([path, text]) => ({ path, text }));
  const graph = buildImportGraph(files);
  assert.deepEqual(
    graph.limits.map((limit) => limit.path),
    ["unused.ts"],
  );
  let parses = 0;
  const counted = Object.create(parser) as NonNullable<typeof parser>;
  counted.parseRaw = (path, text) => {
    parses++;
    return parser.parseRaw(path, text);
  };
  const result = prepareTestEvidence(files, graph, [money], counted)(entry);
  assert.equal(parses, 0);
  assert.deepEqual(result.limits, []);
  assert.equal(result.uncertain, false);
  assert.deepEqual(result.units, []);
  assert.deepEqual(result.imports, []);
});

test("parser absence is explicit and keeps reached units", () => {
  const files: ImportSource[] = [
    { path: entry.path, text: 'import { money } from "./money"; money();' },
    { path: "money.ts", text: moneySource },
  ];
  const result = prepareTestEvidence(
    files,
    buildImportGraph(files),
    [money],
    undefined,
  )(entry);
  assert.ok(result.limits.some((limit) => limit.kind === "grammar_absent"));
  assert.deepEqual(
    result.units.map((unit) => unit.id),
    ["money"],
  );
});

test("Python conftest fixture intermediates use declarations without whole files", () => {
  const unit = {
    ...money,
    file: "money.py",
    after: "def money():\n return 2",
    afterRange: { start: 1, end: 2 },
  };
  const result = run(
    {
      "invoice.test.py": "def test_invoice(bill):\n assert bill == 2",
      "conftest.py":
        "import pytest\nfrom invoice import invoice\n@pytest.fixture\ndef bill():\n return invoice()\ndef unrelated():\n return 0",
      "invoice.py":
        "from money import money\ndef invoice():\n return money()\ndef format():\n return 'unrelated'",
      "money.py": unit.after,
    },
    [unit],
    { ...entry, path: "invoice.test.py", framework: "pytest" },
  );
  assert.ok(
    result.limits.some(
      (limit) => limit.kind === "unresolved" && limit.specifier === "pytest",
    ),
  );
  assert.deepEqual(
    result.units.map((value) => value.id),
    ["money"],
  );
  assert.deepEqual(
    result.imports.map((source) => source.text).sort(),
    [
      "@pytest.fixture\ndef bill():\n return invoice()",
      "def invoice():\n return money()",
    ].sort(),
  );
});

test("inventory parsing is cached across entries and units", () => {
  const files: ImportSource[] = [
    { path: entry.path, text: 'import { money } from "./money"; money();' },
    { path: "money.ts", text: moneySource },
  ];
  let count = 0;
  const counted = Object.create(parser);
  counted.parseRaw = (path: string, text: string) => {
    count++;
    return parser.parseRaw(path, text);
  };
  const evidence = prepareTestEvidence(
    files,
    buildImportGraph(files),
    [money],
    counted,
  );
  assert.equal(evidence(entry).uncertain, false);
  assert.equal(evidence(entry).uncertain, false);
  assert.equal(count, 2);
});

test("unresolved imported calls remain uncertain and cached ambiguity persists across entries", () => {
  const absent = run({
    "invoice.test.ts": 'import { absent } from "./money"; absent();',
    "money.ts": moneySource,
  });
  assert.equal(absent.uncertain, true);
  assert.ok(
    absent.limits.some(
      (limit) => limit.kind === "unresolved" && limit.specifier === "absent",
    ),
  );
  assert.deepEqual(
    absent.units.map((unit) => unit.id),
    ["money"],
  );
  const files = Object.entries({
    "invoice.test.ts": 'import { invoice } from "./invoice"; invoice();',
    "second.test.ts": 'import { invoice } from "./invoice"; invoice();',
    "invoice.ts":
      'import { money } from "./barrel"; export function invoice() { return money(); }',
    "barrel.ts": 'export * from "./money"; export * from "./other";',
    "money.ts": moneySource,
    "other.ts": "export function money() { return 3; }",
  }).map(([path, text]) => ({ path, text }));
  const evidence = prepareTestEvidence(
    files,
    buildImportGraph(files),
    [money],
    parser,
  );
  for (const candidate of [entry, { ...entry, path: "second.test.ts" }]) {
    const result = evidence(candidate);
    assert.equal(result.uncertain, true);
    assert.ok(result.limits.some((limit) => limit.kind === "ambiguous"));
  }
});

test("empty diff keeps lexical uncertainty without parsing declarations", () => {
  let parses = 0;
  const counted = Object.create(parser) as NonNullable<typeof parser>;
  counted.parseRaw = (path, text) => {
    parses++;
    return parser.parseRaw(path, text);
  };
  const files = [{ path: entry.path, text: "const module = import(target);" }];
  const result = prepareTestEvidence(
    files,
    buildImportGraph(files),
    [],
    counted,
  )(entry);
  assert.equal(parses, 0);
  assert.deepEqual(result.units, []);
  assert.equal(result.uncertain, true);
  assert.deepEqual(
    result.limits.map((limit) => limit.kind),
    ["dynamic"],
  );
});

test("shared inverse propagation keeps distinct callers and cycles correct across test order", () => {
  const files = Object.entries({
    "invoice.test.ts": 'import { invoice } from "./invoice"; invoice();',
    "second.test.ts": 'import { second } from "./second"; second();',
    "invoice.ts":
      'import { money } from "./money"; export function invoice() { return money(); }',
    "second.ts":
      'import { cycle } from "./cycle"; export function second() { return cycle(); }',
    "cycle.ts":
      'import { second } from "./second"; import { money } from "./money"; export function cycle() { second(); return money(); }',
    "money.ts": moneySource,
  }).map(([path, text]) => ({ path, text }));
  for (const order of [
    [entry, { ...entry, path: "second.test.ts" }],
    [{ ...entry, path: "second.test.ts" }, entry],
  ]) {
    const evidence = prepareTestEvidence(
      files,
      buildImportGraph(files),
      [money],
      parser,
    );
    for (const candidate of order) {
      const result = evidence(candidate);
      assert.deepEqual(
        result.imports.map((source) => source.path).sort(),
        candidate.path === entry.path
          ? ["invoice.ts"]
          : ["cycle.ts", "second.ts"],
      );
      assert.equal(result.uncertain, false);
      assert.deepEqual(
        result.units.map((unit) => unit.id),
        ["money"],
      );
    }
  }
});

test("root export errors on a reached module keep test evidence uncertain", () => {
  const result = run({
    "invoice.test.ts": 'import { invoice } from "./invoice"; invoice();',
    "invoice.ts":
      'import { money } from "./money";\nexport type * from "./types";\nexport function invoice() { return money(); }',
    "money.ts": moneySource,
  });
  assert.equal(result.uncertain, true);
  assert.ok(
    result.limits.some(
      (limit) =>
        limit.path === "invoice.ts" &&
        limit.kind === "parse_partial" &&
        !limit.declaration,
    ),
  );
  assert.deepEqual(
    result.units.map((unit) => unit.id),
    ["money"],
  );
});

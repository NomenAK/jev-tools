import assert from "node:assert/strict";
import test from "node:test";
import { collectProofSyntax } from "../src/adapters/ask-syntax.ts";
import {
  CLOSURE_MAX_CHARS,
  STATE_MAX_CHARS,
  UNIT_MAX_CHARS,
} from "../src/constants.ts";
import { buildAskClosure } from "../src/core/ask-closure.ts";
import type { ProofDeclaration, ProofSyntax } from "../src/core/ask-proof.ts";
import type { ImportGraph } from "../src/core/imports.ts";
import type { State } from "../src/jev/types.ts";

const graph: ImportGraph = {
  edges: new Map([["main.ts", ["values.ts"]]]),
  limits: [],
};
function packed(
  declarations: readonly ProofDeclaration[],
  state: State = { files: { "main.ts": "source intact" } },
  intentions = "",
) {
  const syntax: ProofSyntax = {
    declarations,
    bindings: declarations.map((item) => ({
      path: "main.ts",
      local: item.name,
      imported: item.name,
      specifier: "./values",
      reexport: false,
      used: true,
    })),
    limits: [],
  };
  return buildAskClosure({
    graph,
    syntax,
    paths: ["main.ts"],
    intentions,
    state,
  });
}

test("priority, omission then smaller fit, closure budget and originals", () => {
  const declarations = [0, 1, 2, 3].map((index) => ({
    path: "values.ts",
    name: `value${index}`,
    text: "x".repeat(UNIT_MAX_CHARS),
    usedNames: [],
    ...(index === 3 ? { before: null } : {}),
  }));
  declarations.push({
    path: "values.ts",
    name: "ztiny",
    text: "42",
    usedNames: [],
  });
  const result = packed(declarations, undefined, "value3");
  assert.equal(result.added[0]?.name, "value3");
  assert.equal(result.omitted.length, 1);
  assert.equal(result.added.at(-1)?.name, "ztiny");
  assert.ok(
    JSON.stringify(result.state.closure).length - 2 <= CLOSURE_MAX_CHARS,
  );
  assert.deepEqual(result.state.files, { "main.ts": "source intact" });
});

test("serialized global cap includes escaped strings and key overhead, skips to fitting declaration", () => {
  const state = {
    files: { "main.ts": "source intact" },
    note: "n".repeat(STATE_MAX_CHARS - 200),
  };
  const result = packed(
    [
      {
        path: "values.ts",
        name: "large",
        text: '"'.repeat(100),
        usedNames: [],
      },
      { path: "values.ts", name: "small", text: "42", usedNames: [] },
    ],
    state,
  );
  assert.deepEqual(
    result.added.map((item) => item.name),
    ["small"],
  );
  assert.ok(JSON.stringify(result.state).length <= STATE_MAX_CHARS);
});

test("base declarations preserve before/after and slices never bisect Unicode", () => {
  const result = packed([
    {
      path: "values.ts",
      name: "value",
      text: `${"x".repeat(2999)}😀${"y".repeat(5000)}`,
      before: "a".repeat(4000),
      usedNames: [],
    },
  ]);
  const value = result.state.closure as Record<
    string,
    { before: string; after: string }
  >;
  assert.equal(value["values.ts (value)"]?.before.length, 3000);
  assert.equal(value["values.ts (value)"]?.after, "x".repeat(2999));
});

test("AST bindings cross alias barrel without unused imports or depth two", async () => {
  const files = [
    {
      path: "main.ts",
      text: 'import { limit as cap, unused } from "./barrel"; export const result = cap;',
    },
    {
      path: "barrel.ts",
      text: 'export { VALUE as limit, UNUSED as unused } from "./values";',
    },
    {
      path: "values.ts",
      text: 'import { DEEP } from "./deep"; export const VALUE = DEEP; export const UNUSED = 4;',
    },
    { path: "deep.ts", text: "export const DEEP = 9;" },
  ] satisfies [
    { path: string; text: string },
    ...{ path: string; text: string }[],
  ];
  const syntax = await collectProofSyntax(files, {
    "values.ts": "export const VALUE = 1; export const UNUSED = 4;",
  });
  const result = buildAskClosure({
    graph: {
      edges: new Map([
        ["main.ts", ["barrel.ts"]],
        ["barrel.ts", ["values.ts"]],
        ["values.ts", ["deep.ts"]],
      ]),
      limits: [],
    },
    syntax,
    paths: ["main.ts"],
    intentions: "limit",
    state: { files: { "main.ts": files[0]?.text } },
  });
  assert.deepEqual(
    result.added.map((item) => item.name),
    ["VALUE"],
  );
  assert.deepEqual(
    (result.state.closure as Record<string, unknown>)["values.ts (VALUE)"],
    { before: "export const VALUE = 1;", after: "export const VALUE = DEEP;" },
  );
});

test("type-only imported annotation adds its declaration at depth one", async () => {
  const files = [
    {
      path: "main.ts",
      text: 'import type { X } from "./values"; export let x: X;',
    },
    {
      path: "values.ts",
      text: 'import type { Deep } from "./deep"; export interface X { value: Deep }',
    },
    { path: "deep.ts", text: "export interface Deep { hidden: true }" },
  ] satisfies [
    { path: string; text: string },
    ...{ path: string; text: string }[],
  ];
  const syntax = await collectProofSyntax(files);
  const result = buildAskClosure({
    graph: {
      edges: new Map([
        ["main.ts", ["values.ts"]],
        ["values.ts", ["deep.ts"]],
      ]),
      limits: [],
    },
    syntax,
    paths: ["main.ts"],
    intentions: "",
    state: { files: { "main.ts": files[0]?.text } },
  });
  assert.deepEqual(
    result.added.map((item) => item.name),
    ["X"],
  );
  assert.equal(
    (result.state.closure as Record<string, string>)["values.ts (X)"],
    "export interface X { value: Deep }",
  );
});

test("namespace imported annotation resolves the type member without namespace limitation", async () => {
  const files = [
    {
      path: "main.ts",
      text: 'import * as t from "./values"; export let x: t.Foo;',
    },
    {
      path: "values.ts",
      text: "export interface Foo { value: number } export const unused = 3;",
    },
  ] satisfies [
    { path: string; text: string },
    ...{ path: string; text: string }[],
  ];
  const syntax = await collectProofSyntax(files);
  const result = buildAskClosure({
    graph: { edges: new Map([["main.ts", ["values.ts"]]]), limits: [] },
    syntax,
    paths: ["main.ts"],
    intentions: "",
    state: { files: { "main.ts": files[0]?.text } },
  });
  assert.deepEqual(
    result.added.map((item) => item.name),
    ["Foo"],
  );
  assert.ok(
    result.limitations.every((limit) => !limit.fact.includes("namespace")),
  );
});

test("qualified annotation does not use a same-named named import", async () => {
  const text =
    'import { Foo } from "./a"; import * as t from "./b"; let x: t.Foo;';
  const syntax = await collectProofSyntax([
    { path: "main.ts", text },
    { path: "a.ts", text: "export interface Foo { wrong: true }" },
    { path: "b.ts", text: "export interface Foo { right: true }" },
  ]);
  const result = buildAskClosure({
    graph: { edges: new Map([["main.ts", ["a.ts", "b.ts"]]]), limits: [] },
    syntax,
    paths: ["main.ts"],
    intentions: "",
    state: { files: { "main.ts": text } },
  });
  assert.deepEqual(
    result.added.map((item) => `${item.path}:${item.name}`),
    ["b.ts:Foo"],
  );
});

for (const source of [
  "function f<T>(x: T): T { return x; }",
  "type Result<V> = V extends infer T ? T : never;",
  "type Result = { [T in keyof Input]: T };",
])
  test(`local type binder does not use import: ${source}`, async () => {
    const text = `import { T } from "./a"; ${source}`;
    const syntax = await collectProofSyntax([
      { path: "main.ts", text },
      { path: "a.ts", text: "export interface T { wrong: true }" },
    ]);
    const result = buildAskClosure({
      graph: { edges: new Map([["main.ts", ["a.ts"]]]), limits: [] },
      syntax,
      paths: ["main.ts"],
      intentions: "",
      state: { files: { "main.ts": text } },
    });
    assert.deepEqual(result.added, []);
  });

test("namespace value member precedes its type member under the state budget", async () => {
  const text =
    'import * as ns from "./values"; export const result = ns.zValue; export let typed: ns.AType;';
  const syntax = await collectProofSyntax([
    { path: "main.ts", text },
    {
      path: "values.ts",
      text: "export const zValue = 42; export interface AType { field: number }",
    },
  ]);
  const result = buildAskClosure({
    graph: { edges: new Map([["main.ts", ["values.ts"]]]), limits: [] },
    syntax,
    paths: ["main.ts"],
    intentions: "",
    state: {
      files: { "main.ts": text },
      note: "x".repeat(STATE_MAX_CHARS - text.length - 130),
    },
  });
  assert.deepEqual(
    result.added.map((item) => item.name),
    ["zValue"],
  );
  assert.ok(result.omitted.some((item) => item.name === "AType"));
});

test("local type binding leaves imported references outside its scope visible", async () => {
  const text =
    'import { T } from "./a"; function f<T>(x: T): T { return x; } export let outside: T;';
  const syntax = await collectProofSyntax([
    { path: "main.ts", text },
    { path: "a.ts", text: "export interface T { external: true }" },
  ]);
  const result = buildAskClosure({
    graph: { edges: new Map([["main.ts", ["a.ts"]]]), limits: [] },
    syntax,
    paths: ["main.ts"],
    intentions: "",
    state: { files: { "main.ts": text } },
  });
  assert.deepEqual(
    result.added.map((item) => item.name),
    ["T"],
  );
});

test("type-only candidates do not displace value evidence under the state budget", async () => {
  const text =
    'import { value } from "./z"; import { Type } from "./a"; export const result = value; export let typed: Type;';
  const syntax = await collectProofSyntax([
    { path: "main.ts", text },
    { path: "z.ts", text: "export const value = 42;" },
    { path: "a.ts", text: "export interface Type { field: number }" },
  ]);
  const result = buildAskClosure({
    graph: { edges: new Map([["main.ts", ["a.ts", "z.ts"]]]), limits: [] },
    syntax,
    paths: ["main.ts"],
    intentions: "",
    state: {
      files: { "main.ts": text },
      note: "x".repeat(STATE_MAX_CHARS - text.length - 120),
    },
  });
  assert.deepEqual(
    result.added.map((item) => item.name),
    ["value"],
  );
  assert.ok(result.omitted.some((item) => item.name === "Type"));
});

test("value import used only as a type includes its declaration, but unused and unimported types do not", async () => {
  const files = [
    {
      path: "main.ts",
      text: 'import { Foo, Unused } from "./values"; export let x: Foo; export let local: Local;',
    },
    {
      path: "values.ts",
      text: "export interface Foo { value: number } export interface Unused { hidden: true } export interface Local { unrelated: true }",
    },
  ] satisfies [
    { path: string; text: string },
    ...{ path: string; text: string }[],
  ];
  const syntax = await collectProofSyntax(files);
  const result = buildAskClosure({
    graph: { edges: new Map([["main.ts", ["values.ts"]]]), limits: [] },
    syntax,
    paths: ["main.ts"],
    intentions: "",
    state: { files: { "main.ts": files[0]?.text } },
  });
  assert.deepEqual(
    result.added.map((item) => item.name),
    ["Foo"],
  );
});

test("unimported local type alone does not add unrelated provider declarations", async () => {
  const files = [
    {
      path: "main.ts",
      text: "interface Local { own: true } export let local: Local;",
    },
    { path: "values.ts", text: "export interface Local { unrelated: true }" },
  ] satisfies [
    { path: string; text: string },
    ...{ path: string; text: string }[],
  ];
  const syntax = await collectProofSyntax(files);
  const result = buildAskClosure({
    graph: { edges: new Map([["main.ts", ["values.ts"]]]), limits: [] },
    syntax,
    paths: ["main.ts"],
    intentions: "",
    state: { files: { "main.ts": files[0]?.text } },
  });
  assert.deepEqual(result.added, []);
});

test("Python imported annotations resolve named and qualified types only", async () => {
  const files = [
    {
      path: "main.py",
      text: "from values import Foo as Named, Unused\nimport values as t\ndef use(x: Named, y: t.Foo, z: Local) -> Named:\n return x",
    },
    {
      path: "values.py",
      text: "class Foo:\n value: int\nclass Unused:\n hidden: bool\nclass Local:\n unrelated: bool",
    },
  ] satisfies [
    { path: string; text: string },
    ...{ path: string; text: string }[],
  ];
  const syntax = await collectProofSyntax(files);
  const result = buildAskClosure({
    graph: { edges: new Map([["main.py", ["values.py"]]]), limits: [] },
    syntax,
    paths: ["main.py"],
    intentions: "",
    state: { files: { "main.py": files[0]?.text } },
  });
  assert.deepEqual(
    result.added.map((item) => item.name),
    ["Foo"],
  );
  assert.ok(
    result.limitations.every((limit) => !limit.fact.includes("namespace")),
  );
});

test("Python aliases, package reexports and ancestor fixture helpers", async () => {
  const files = [
    {
      path: "tests/test_limit.py",
      text: "from pkg import LIMIT as cap\ndef test_limit(fixture):\n assert cap == fixture",
    },
    { path: "pkg/__init__.py", text: "from .values import VALUE as LIMIT" },
    { path: "pkg/values.py", text: "VALUE = 2\nUNUSED = 3" },
    {
      path: "tests/conftest.py",
      text: "import pytest\nHELPER = 2\n@pytest.fixture\ndef fixture():\n return HELPER",
    },
    {
      path: "other/conftest.py",
      text: "import pytest\n@pytest.fixture\ndef fixture():\n return 99",
    },
  ] satisfies [
    { path: string; text: string },
    ...{ path: string; text: string }[],
  ];
  const syntax = await collectProofSyntax(files);
  const result = buildAskClosure({
    graph: {
      edges: new Map([
        ["tests/test_limit.py", ["pkg/__init__.py", "tests/conftest.py"]],
        ["pkg/__init__.py", ["pkg/values.py"]],
      ]),
      limits: [],
    },
    syntax,
    paths: [files[0]?.path],
    intentions: "",
    state: { files: { [files[0]?.path]: files[0]?.text } },
  });
  assert.deepEqual(
    result.added.map((item) => `${item.path}:${item.name}`).sort(),
    [
      "pkg/values.py:VALUE",
      "tests/conftest.py:HELPER",
      "tests/conftest.py:fixture",
    ],
  );
});

test("literal readFileSync aliases rely on I8 data edges and missing edge is visible", async () => {
  const files = [
    {
      path: "main.ts",
      text: 'import {readFileSync as read} from "node:fs"; const data = read("./data.json");',
    },
    { path: "data.json", text: '{"value":2}' },
  ] satisfies [{ path: string; text: string }, { path: string; text: string }];
  const syntax = await collectProofSyntax(files);
  const result = buildAskClosure({
    graph: { edges: new Map([["main.ts", ["data.json"]]]), limits: [] },
    syntax,
    paths: ["main.ts"],
    intentions: "",
    state: { files: { "main.ts": files[0]?.text } },
  });
  assert.deepEqual(Object.values(result.state.closure ?? {}), [files[1]?.text]);
  const missing = buildAskClosure({
    graph: { edges: new Map(), limits: [] },
    syntax,
    paths: ["main.ts"],
    intentions: "",
    state: { files: { "main.ts": files[0]?.text } },
  });
  assert.deepEqual(missing.added, []);
  assert.ok(
    missing.limitations.some((limit) => limit.fact.includes("./data.json")),
  );
});

test("missing grammar metadata and dynamic imports stay visible", async () => {
  const syntax = await collectProofSyntax([
    { path: "main.rs", text: "fn main() {}" },
    { path: "dynamic.py", text: '__import__("plugins")' },
  ]);
  assert.deepEqual(syntax.declarations, []);
  for (const path of ["main.rs", "dynamic.py"])
    assert.ok(syntax.limits.some((item) => item.fact.includes(path)));
});

test("deleted declaration retains base evidence and canonical originals are not duplicated", async () => {
  const files = [
    {
      path: "main.ts",
      text: 'import { VALUE } from "./values"; const result = VALUE;',
    },
    { path: "values.ts", text: "export const OTHER = 2;" },
  ] satisfies [{ path: string; text: string }, { path: string; text: string }];
  const syntax = await collectProofSyntax(files, {
    "values.ts": "export const VALUE = 1;",
  });
  const result = buildAskClosure({
    graph,
    syntax,
    paths: ["main.ts"],
    intentions: "",
    state: { files: { "./main.ts": files[0]?.text } },
  });
  assert.deepEqual(
    (result.state.closure as Record<string, unknown>)["values.ts (VALUE)"],
    { before: "export const VALUE = 1;", after: null },
  );
  const alreadyPresent = buildAskClosure({
    graph,
    syntax,
    paths: ["main.ts", "values.ts"],
    intentions: "",
    state: {
      files: { "./main.ts": files[0]?.text, "./values.ts": files[1]?.text },
    },
  });
  assert.deepEqual(alreadyPresent.added, []);
});

test("unchanged base declarations consume one evidence unit", () => {
  const text = "x".repeat(UNIT_MAX_CHARS - 10);
  const result = packed([
    { path: "values.ts", name: "value", text, before: text, usedNames: [] },
  ]);
  assert.deepEqual(result.state.closure, { "values.ts (value)": text });
  assert.equal(result.added[0]?.chars, text.length);
});

test("one malformed declaration does not hide valid TS variance or JSX declarations", async () => {
  const syntax = await collectProofSyntax([
    {
      path: "checks.ts",
      text: "export interface Check<in T = never> { check(value: T): boolean }\nexport const broken = ;\nexport const GOOD = 2;",
    },
    { path: "view.jsx", text: "export const View = () => <div />;" },
    { path: "module.mjs", text: "export function value() { return 3; }" },
    { path: "module.cjs", text: "function value() { return 4; }" },
  ]);
  assert.equal(
    syntax.declarations.find((item) => item.name === "Check")?.text,
    "export interface Check<in T = never> { check(value: T): boolean }",
  );
  assert.ok(syntax.declarations.some((item) => item.name === "GOOD"));
  assert.ok(syntax.declarations.some((item) => item.name === "View"));
  assert.equal(
    syntax.declarations.filter((item) => item.name === "value").length,
    2,
  );
  assert.ok(syntax.declarations.some((item) => item.name === "broken"));
  assert.deepEqual(
    syntax.limits.map((item) => item.fact),
    ["checks.ts : parse_partial (Check)", "checks.ts : parse_partial (broken)"],
  );
});

test("root syntax errors stay visible while swallowed declarations are not proof", async () => {
  const partial = await collectProofSyntax([
    {
      path: "barrel.ts",
      text: 'export type * from "./types";\nexport function healthy() { return 1; }',
    },
  ]);
  assert.ok(
    partial.limits.some((limit) => limit.fact === "barrel.ts : parse_partial"),
  );
  assert.ok(
    partial.declarations.some((declaration) => declaration.name === "healthy"),
  );
  const failed = await collectProofSyntax([
    {
      path: "broken.ts",
      text: "export function broken( {\nexport function healthy() { return 2; }",
    },
  ]);
  assert.ok(
    failed.limits.some((limit) => limit.fact === "broken.ts : parse_failed"),
  );
  assert.deepEqual(failed.declarations, []);
});

test("native parse failure remains an explicit proof limitation", async () => {
  const syntax = await collectProofSyntax(
    [{ path: "broken.ts", text: "unreadable syntax" }],
    undefined,
    {
      supports: () => true,
      parseRaw: () => ({ ok: false, error: "native parser failed" }),
      parse: () => ({ ok: false, error: "native parser failed" }),
      declarations: () => ({
        declarations: [],
        limits: [{ kind: "parse_failed" }],
      }),
    },
  );
  assert.ok(
    syntax.limits.some((limit) => limit.fact === "broken.ts: parse_failed"),
  );
  assert.deepEqual(syntax.declarations, []);
});
test("unresolved non-relative imports share one actionable dependency limit", () => {
  const binding = {
    path: "main.py",
    local: "gettext",
    imported: "gettext",
    specifier: "gettext",
    reexport: false,
    used: true,
  };
  const result = buildAskClosure({
    graph: {
      edges: new Map(),
      limits: [{ path: "main.py", specifier: "gettext", kind: "unresolved" }],
    },
    syntax: { declarations: [], bindings: [binding, binding], limits: [] },
    paths: ["main.py"],
    intentions: "",
    state: { files: { "main.py": "from gettext import gettext" } },
  });
  const dependency = result.limitations.filter((limit) =>
    limit.fact.includes("gettext"),
  );
  assert.equal(dependency.length, 1);
  assert.match(dependency[0]?.fact ?? "", /external or standard-library/);
  assert.match(
    dependency[0]?.next ?? "",
    /repository-local.*contract|contract.*repository-local/,
  );
  assert.doesNotMatch(
    dependency[0]?.next ?? "",
    /dependency explicitly in paths/,
  );
});
test("dynamic empty and sys.path dependencies keep local evidence actions and occurrence counts", () => {
  const result = buildAskClosure({
    graph: {
      edges: new Map(),
      limits: [
        { path: "a.py", specifier: "", kind: "dynamic" },
        { path: "a.py", specifier: "", kind: "dynamic" },
        {
          path: "a.py",
          specifier: "sys.path mutation or lookup",
          kind: "dynamic",
        },
      ],
    },
    syntax: { declarations: [], bindings: [], limits: [] },
    paths: ["a.py"],
    intentions: "",
    state: { files: { "a.py": "source" } },
  });
  const dynamic = result.limitations.filter(
    (limit) => limit.cause === "dynamic import",
  );
  assert.equal(dynamic.length, 2);
  assert.equal(dynamic[0]?.count, 2);
  for (const limit of dynamic) {
    assert.doesNotMatch(limit.fact, /external or standard-library/);
    assert.equal(limit.next, "Provide the dependency explicitly in paths.");
  }
});

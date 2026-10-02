import assert from "node:assert/strict";
import test from "node:test";
import { loadSyntaxParser } from "../src/adapters/syntax.ts";
import { sectionFile } from "../src/core/sections.ts";

test("locate descends large functions while diff declarations retain their original seam", async () => {
  const parser = await loadSyntaxParser();
  assert.ok(
    parser,
    "installed optional parser is required by this constructed syntax test",
  );
  const source = [
    "function outer() {",
    "  function first() {",
    ...Array(80).fill("    useFirst();"),
    "  }",
    "  function second() {",
    ...Array(80).fill("    useSecond();"),
    "  }",
    "}",
  ].join("\n");
  const plain = parser.declarations("sample.ts", source);
  assert.deepEqual(plain.limits, []);
  assert.equal(plain.declarations.length, 1);
  const nested = parser.declarations("sample.ts", source, {
    descendAbove: 150,
  });
  assert.deepEqual(nested.limits, []);
  assert.deepEqual(
    nested.declarations.map((d) => d.name),
    ["outer", "first", "second"],
  );
  const sections = sectionFile(
    "sample.ts",
    source,
    nested.declarations,
  ).sections;
  assert.deepEqual(
    sections.map((s) => [s.start, s.end]),
    [
      [1, 83],
      [84, 166],
    ],
  );
});
test("locate emits classes and keeps parent initialization and trailing code", async () => {
  const parser = await loadSyntaxParser();
  assert.ok(parser);
  const source = [
    "class Owner {",
    ...Array(10).fill("  field = 1;"),
    "  first() {",
    ...Array(80).fill("    use();"),
    "  }",
    "  second() {",
    ...Array(80).fill("    other();"),
    "  }",
    ...Array(10).fill("  final = 2;"),
    "}",
  ].join("\n");
  const parsed = parser.declarations("class.ts", source, { descendAbove: 150 });
  assert.deepEqual(parsed.limits, []);
  assert.deepEqual(
    parsed.declarations.map((d) => d.name),
    ["Owner", "Owner.first", "Owner.second"],
  );
  const sections = sectionFile(
    "class.ts",
    source,
    parsed.declarations,
  ).sections;
  assert.equal(sections[0]?.label, "Owner");
  assert.equal(sections[0]?.start, 1);
  assert.match(sections.at(-1)?.label ?? "", /Owner continuation/);
  assert.equal(sections.map((s) => s.text).join("\n"), source);
});

test("partial syntax retains whole named declarations and localizes limitations", async () => {
  const parser = await loadSyntaxParser();
  assert.ok(parser);
  const source =
    "export function broken() {\n  const value = ;\n  return 1;\n}\nexport function healthy() { return 2; }";
  const declarations = parser.declarations("partial.ts", source);
  assert.deepEqual(declarations.limits, [
    { kind: "parse_partial", declaration: "broken" },
  ]);
  assert.deepEqual(
    declarations.declarations.map((declaration) => ({
      name: declaration.name,
      start: declaration.start,
      end: declaration.end,
    })),
    [
      { name: "broken", start: 1, end: 4 },
      { name: "healthy", start: 5, end: 5 },
    ],
  );
});

test("syntax recovery never extracts declarations swallowed by a root error", async () => {
  const parser = await loadSyntaxParser();
  assert.ok(parser);
  assert.deepEqual(
    parser.declarations(
      "createSlice.ts",
      "export function broken( {\nexport function healthy() { return 2; }",
    ),
    { declarations: [], limits: [{ kind: "parse_failed" }] },
  );
});

test("root errors outside declarations remain visible without tainting healthy declarations", async () => {
  const parser = await loadSyntaxParser();
  assert.ok(parser);
  const result = parser.declarations(
    "barrel.ts",
    'export type * from "./types";\nexport function healthy() { return 1; }',
  );
  assert.deepEqual(result.limits, [{ kind: "parse_partial" }]);
  assert.deepEqual(
    result.declarations.map((declaration) => declaration.name),
    ["healthy"],
  );
});

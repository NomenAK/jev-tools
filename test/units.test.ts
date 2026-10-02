import assert from "node:assert/strict";
import test from "node:test";
import { loadSyntaxParser } from "../src/adapters/syntax.ts";
import { truncate } from "../src/core/truncate.ts";
import {
  buildUnits,
  type EvidenceUnit,
  type SourceFile,
} from "../src/core/units.ts";

function file(
  path: string,
  before: string | null,
  after: string | null,
  start = 1,
): SourceFile {
  return {
    path,
    oldPath: path,
    status: before === null ? "?" : after === null ? "D" : "M",
    binary: false,
    added: 1,
    deleted: 1,
    before,
    after,
    hunks: [
      {
        beforeStart: start,
        beforeCount: 1,
        afterStart: start,
        afterCount: 1,
        changes: [
          {
            beforeStart: start,
            beforeCount: 1,
            afterStart: start,
            afterCount: 1,
          },
        ],
      },
    ],
  };
}
test("whitespace-only function change retains both complete versions and leading comment", async () => {
  const parser = await loadSyntaxParser();
  assert.ok(parser);
  const before =
    "// price\nexport function price(x: number) {\n  return x * 2;\n}";
  const after = before.replace("x * 2", "x*2");
  const result = buildUnits([file("price.ts", before, after, 3)], parser);
  assert.ok(result.units[0]);
  assert.equal(result.units[0].kind, "function");
  assert.equal(result.units[0].before, before);
  assert.equal(result.units[0].after, after);
  assert.equal(result.units[0].exported, true);
});
test("Python decorators, async and qualified class methods remain whole", async () => {
  const parser = await loadSyntaxParser();
  assert.ok(parser?.supports("a.py"));
  const before =
    "class Service:\n    @cache\n    async def fetch(self):\n        return 1\n\nVALUE = 2";
  const after = before.replace("return 1", "return 3");
  const result = buildUnits([file("a.py", before, after, 4)], parser);
  assert.ok(result.units[0]);
  assert.equal(result.units[0].name, "Service.fetch");
  assert.match(result.units[0].before ?? "", /@cache\n {4}async def fetch/);
  assert.equal(result.units[0].kind, "function");
  const declaration = buildUnits(
    [file("a.py", before, before.replace("VALUE = 2", "VALUE = 4"), 6)],
    parser,
  );
  assert.ok(declaration.units[0]);
  assert.equal(declaration.units[0].kind, "declaration");
  assert.equal(declaration.units[0].name, "VALUE");
});
test("TS declarations and exported methods are code units", async () => {
  const parser = await loadSyntaxParser();
  for (const before of [
    "export type Mode = 'a';",
    "export interface Options { a: number }",
    "export enum Color { Red }",
  ]) {
    const result = buildUnits(
      [file("a.ts", before, before.replace(/a|Red/, "Green"))],
      parser,
    );
    assert.ok(result.units[0]);
    assert.equal(result.units[0].kind, "declaration");
  }
  const result = buildUnits(
    [
      file(
        "a.ts",
        "export class C {\n method() { return 1; }\n}",
        "export class C {\n method() { return 2; }\n}",
        2,
      ),
    ],
    parser,
  );
  assert.ok(result.units[0]);
  assert.equal(result.units[0].name, "C.method");
  assert.equal(result.units[0].exported, true);
});
test("new/deleted declarations, configuration, outside-declaration hunks and test exclusion", async () => {
  const parser = await loadSyntaxParser();
  const result = buildUnits(
    [
      file("new.ts", null, "export const x = 1;"),
      file("gone.ts", "const old = 1;", null),
      file("config.json", '{"x":1}', '{"x":2}'),
      file("a.ts", "import 'old';", "import 'new';"),
      file("tests/fixture.ts", null, "const test = 1;"),
    ],
    parser,
  );
  assert.deepEqual(
    result.units.map((u) => u.kind),
    ["declaration", "declaration", "file", "hunk"],
  );
  assert.ok(result.units[0]);
  assert.ok(result.units[1]);
  assert.equal(result.units[0].before, null);
  assert.equal(result.units[1].after, null);
});

test("a function added at the top does not select its unchanged neighbor", async () => {
  const parser = await loadSyntaxParser();
  assert.ok(parser);
  const neighbor = "function neighbor() { return 1; }";
  const added = "function added() {\n return 2;\n}";
  const input = file("a.ts", neighbor, `${added}\n${neighbor}`);
  const hunk = input.hunks[0];
  assert.ok(hunk);
  hunk.changes = [
    { beforeStart: 1, beforeCount: 0, afterStart: 1, afterCount: 3 },
  ];
  assert.deepEqual(
    buildUnits([input], parser).units.map((u) => [u.name, u.before, u.after]),
    [["added", null, added]],
  );
});

test("deleting the line above a function does not select that neighbor", async () => {
  const parser = await loadSyntaxParser();
  assert.ok(parser);
  const neighbor = "function neighbor() { return 1; }";
  const input = file("a.ts", `import 'unused';\n${neighbor}`, neighbor);
  const hunk = input.hunks[0];
  assert.ok(hunk);
  hunk.changes = [
    { beforeStart: 1, beforeCount: 1, afterStart: 1, afterCount: 0 },
  ];
  const result = buildUnits([input], parser);
  assert.deepEqual(
    result.units.map((u) => u.kind),
    ["hunk"],
  );
  assert.match(result.units[0]?.before ?? "", /import 'unused';/);
});

test("unit selection excludes renames into tests but preserves renames into sources", async () => {
  const parser = await loadSyntaxParser();
  assert.ok(parser);
  const source = "export function value() { return 1; }";
  const toTest = {
    ...file("test/value.test.ts", source, source),
    oldPath: "src/value.ts",
    status: "R100",
    hunks: [],
  };
  const toSource = {
    ...file("src/value.ts", source, source),
    oldPath: "test/value.test.ts",
    status: "R100",
    hunks: [],
  };
  assert.deepEqual(buildUnits([toTest], parser), { units: [], limits: [] });
  const result = buildUnits([toSource], parser);
  assert.deepEqual(
    result.units.map((u) => [u.file, u.name, u.before, u.after]),
    [["src/value.ts", "value", source, source]],
  );
  assert.deepEqual(result.limits, []);
});
test("large function slices retain signature, changed zone, language omission and eight context lines", async () => {
  const parser = await loadSyntaxParser();
  for (const path of ["large.ts", "large.py"]) {
    const python = path.endsWith("py");
    const signature = python ? "def large():" : "export function large() {";
    const before = [
      signature,
      ...Array.from({ length: 300 }, (_, i) =>
        python
          ? `    value = ${i} # row ${i} ${"x".repeat(30)}`
          : `    const value${i} = ${i}; // row ${i} ${"x".repeat(30)}`,
      ),
      ...(python ? [] : ["}"]),
    ].join("\n");
    const after = before.replace("row 150", "changed 150");
    const result = buildUnits([file(path, before, after, 152)], parser);
    const unit = result.units[0];
    assert.ok(unit);
    assert.equal(unit.kind, "slice");
    assert.ok(unit.after?.startsWith(signature));
    assert.match(unit.after ?? "", /changed 150/);
    assert.match(
      unit.after ?? "",
      python ? /# … omitted …/ : /\/\/ … omitted …/,
    );
    assert.equal(unit.afterRange?.start, 144);
    assert.equal(unit.afterRange?.end, 160);
    assert.ok((unit.before?.length ?? 0) + (unit.after?.length ?? 0) <= 6000);
  }
});
test("missing grammar and binary omission are typed visible limits", () => {
  const binary = { ...file("image.bin", null, null), binary: true };
  const result = buildUnits([
    file("a.py", "def f():\n    return 1", "def f():\n    return 2", 2),
    binary,
  ]);
  assert.ok(result.units[0]);
  assert.deepEqual(
    result.limits.map((l) => l.kind),
    ["grammar_absent", "binary_ignored"],
  );
  assert.equal(result.units[0].name, "f");
});
test("all constructed UTF-16 cuts preserve valid surrogate pairs and budgets", () => {
  for (const text of ["😀abc", "a😀b🚀z", "x".repeat(100) + "😀".repeat(100)])
    for (let max = 0; max <= text.length + 1; max++) {
      const cut = truncate(text, max);
      assert.ok(cut.length <= max);
      assert.equal(/[\uD800-\uDBFF]$/.test(cut), false);
      assert.ok(text.startsWith(cut));
    }
});

test("declaration types, accessors and qualified names remain distinct", async () => {
  const parser = await loadSyntaxParser();
  assert.ok(parser);
  const before =
    "type Value = number;\nconst Value = 1;\nclass C {\n get value() { return 1; }\n set value(v: number) { save(v); }\n}\nclass D {\n get value() { return 3; }\n}";
  const after = before
    .replace("number;", "string;")
    .replace("Value = 1", "Value = 2")
    .replace("return 1", "return 2")
    .replace("save(v)", "store(v)")
    .replace("return 3", "return 4");
  const input = file("a.ts", before, after);
  const hunk = input.hunks[0];
  assert.ok(hunk);
  hunk.changes = [
    { beforeStart: 1, beforeCount: 9, afterStart: 1, afterCount: 9 },
  ];
  const units = buildUnits([input], parser).units.filter(
    (u) => u.kind !== "hunk",
  );
  assert.deepEqual(
    units.map((u) => u.name),
    ["Value", "Value", "C.value", "C.value", "D.value"],
  );
  const [type, value, getter, setter] = units;
  assert.ok(type?.before);
  assert.ok(value?.before);
  assert.ok(getter?.after);
  assert.ok(setter?.after);
  assert.match(type.before, /^type/);
  assert.match(value.before, /^const/);
  assert.match(getter.after, /get value.*return 2/);
  assert.match(setter.after, /set value.*store/);
});

test("bodies do not produce nested declarations", async () => {
  const parser = await loadSyntaxParser();
  assert.ok(parser);
  for (const [path, source] of [
    [
      "a.ts",
      "function outer() {\n function inner() { return 1; }\n return inner();\n}",
    ],
    [
      "a.py",
      "def outer():\n    def inner():\n        return 1\n    return inner()",
    ],
  ] as const) {
    const units: EvidenceUnit[] = buildUnits(
      [file(path, source, source.replace("return 1", "return 2"), 3)],
      parser,
    ).units;
    assert.deepEqual(
      units.map((u) => u.name),
      ["outer"],
    );
  }
});

test("a whole-file addition with blank lines creates no spurious hunk", async () => {
  const parser = await loadSyntaxParser();
  const source = "export function added() {\n return 1;\n}\n\n";
  const input = file("new.ts", null, source);
  const hunk = input.hunks[0];
  assert.ok(hunk);
  hunk.changes = [
    { beforeStart: 0, beforeCount: 0, afterStart: 1, afterCount: 5 },
  ];
  assert.deepEqual(
    buildUnits([input], parser).units.map((u) => [u.kind, u.before, u.after]),
    [["function", null, source.trimEnd()]],
  );
});

test("identical renames are paired deterministically and others preserved with a limit", async () => {
  const parser = await loadSyntaxParser();
  const before =
    "function oldA() { return 'a b'; }\nfunction oldB() { return 'a b'; }";
  const after =
    "function newA() { return 'a b'; }\nfunction newB() { return 'a b'; }";
  const input = file("a.ts", before, after);
  const hunk = input.hunks[0];
  assert.ok(hunk);
  hunk.changes = [
    { beforeStart: 1, beforeCount: 2, afterStart: 1, afterCount: 2 },
  ];
  const paired = buildUnits([input], parser);
  assert.deepEqual(
    paired.units.map((u) => [u.name, u.before]),
    [
      ["newA", before.split("\n")[0]],
      ["newB", before.split("\n")[1]],
    ],
  );
  assert.deepEqual(paired.limits, []);
  const unpaired = buildUnits(
    [
      file(
        "a.ts",
        "function old() { return 'a b'; }",
        "function fresh() { return 'ab'; }",
      ),
    ],
    parser,
  );
  assert.deepEqual(
    unpaired.units.map((u) => [u.name, u.before === null, u.after === null]),
    [
      ["old", false, true],
      ["fresh", true, false],
    ],
  );
  assert.deepEqual(unpaired.limits, [
    { kind: "rename_unpaired", file: "a.ts" },
  ]);
});

test("large functions: one slice per region, multiline signature and independent suffix", async () => {
  const parser = await loadSyntaxParser();
  const signature =
    "export function large(\n  first: number,\n  second: number,\n): number {";
  const before = [
    signature,
    ...Array.from(
      { length: 300 },
      (_, i) => `  const row${i} = ${i}; // ${"x".repeat(35)}`,
    ),
    "  return first + second;",
    "}",
  ].join("\n");
  const after = before
    .replace("row80 = 80", "row80 = 81")
    .replace("row230 = 230", "row230 = 231");
  const input = file("a.ts", before, after);
  const hunk = input.hunks[0];
  assert.ok(hunk);
  hunk.changes = [85, 235].map((line) => ({
    beforeStart: line,
    beforeCount: 1,
    afterStart: line,
    afterCount: 1,
  }));
  const units = buildUnits([input], parser).units;
  assert.equal(units.length, 2);
  for (const unit of units) {
    assert.equal(unit.kind, "slice");
    assert.ok(unit.after);
    assert.ok(unit.after.startsWith(`${signature}\n// … omitted …\n`));
    assert.ok(unit.after.endsWith("\n// … omitted …"));
  }
  const [first, second] = units;
  assert.ok(first?.after);
  assert.ok(second?.after);
  assert.match(first.after, /row80 = 81/);
  assert.match(second.after, /row230 = 231/);
  const head = buildUnits(
    [file("a.ts", before, before.replace("row0 = 0", "row0 = 1"), 5)],
    parser,
  ).units[0];
  assert.ok(head?.after);
  assert.ok(head.after.startsWith(signature));
  assert.ok(head.after.endsWith("\n// … omitted …"));
});

test("expected syntax failures are values with a visible fallback", async () => {
  const parser = await loadSyntaxParser();
  assert.ok(parser);
  assert.deepEqual(parser.declarations("a.ts", "function broken( {"), {
    declarations: [],
    limits: [{ kind: "parse_failed" }],
  });
  const result = buildUnits(
    [file("a.ts", "function broken( {", "function broken( {\n x();")],
    parser,
  );
  assert.deepEqual(result.limits, [{ kind: "parse_failed", file: "a.ts" }]);
  const unit = result.units[0];
  assert.ok(unit?.after);
  assert.match(unit.after, /x\(\)/);
});

test("limited sources: patch-only evidence and absent sides are preserved", () => {
  for (const status of ["M", "A", "D"]) {
    const input = {
      ...file("huge.ts", null, null),
      status,
      limitation: "too_large" as const,
    };
    const hunk = input.hunks[0];
    assert.ok(hunk);
    Object.assign(hunk, {
      beforeText: "ancienne",
      afterText: "nouvelle",
    });
    const result = buildUnits([input], {
      supports: () => {
        throw new Error("pas de parsing");
      },
      declarations: () => ({ declarations: [], limits: [] }),
    });
    assert.deepEqual(result.limits, [{ kind: "too_large", file: "huge.ts" }]);
    const unit = result.units[0];
    assert.ok(unit);
    assert.equal(unit.before, status === "A" ? null : "ancienne");
    assert.equal(unit.after, status === "D" ? null : "nouvelle");
  }
  const result = buildUnits([
    { ...file("lost.ts", null, null), limitation: "unreadable" },
  ]);
  assert.deepEqual(result, {
    units: [],
    limits: [{ kind: "unreadable", file: "lost.ts" }],
  });
});

test("qualified namespaces and Python renames", async () => {
  const parser = await loadSyntaxParser();
  assert.ok(parser);
  const before =
    "namespace A {\n export function value() { return 1; }\n}\nnamespace B {\n export function value() { return 2; }\n}";
  const input = file(
    "a.ts",
    before,
    before.replace("return 1", "return 3").replace("return 2", "return 4"),
  );
  const hunk = input.hunks[0];
  assert.ok(hunk);
  hunk.changes = [
    { beforeStart: 1, beforeCount: 6, afterStart: 1, afterCount: 6 },
  ];
  assert.deepEqual(
    buildUnits([input], parser)
      .units.filter((u) => u.kind === "function")
      .map((u) => u.name),
    ["A.value", "B.value"],
  );
  const renamed = buildUnits(
    [file("a.py", "def old():\n    return 1", "def fresh():\n    return 1")],
    parser,
  );
  assert.deepEqual(
    renamed.units.map((u) => [u.name, u.before, u.after]),
    [["fresh", "def old():\n    return 1", "def fresh():\n    return 1"]],
  );
  const signature = "@cache\ndef large(\n    first,\n    second,\n):";
  const large = [
    signature,
    ...Array.from(
      { length: 300 },
      (_, i) => `    row${i} = ${i} # ${"x".repeat(35)}`,
    ),
  ].join("\n");
  const slice = buildUnits(
    [file("a.py", large, large.replace("row80 = 80", "row80 = 81"), 86)],
    parser,
  ).units[0];
  assert.ok(slice?.after);
  assert.ok(slice.after.startsWith(`${signature}\n# … omitted …\n`));
  assert.match(slice.after, /row80 = 81/);
  assert.ok(slice.after.endsWith("\n# … omitted …"));
});

test("a root error preserves a file limit and the valid declaration", async () => {
  const parser = await loadSyntaxParser();
  assert.ok(parser);
  const before =
    'export type * from "./types";\nexport function healthy() { return 1; }';
  const result = buildUnits(
    [file("barrel.ts", before, before.replace("return 1", "return 2"), 2)],
    parser,
  );
  assert.deepEqual(result.limits, [
    { kind: "parse_partial", file: "barrel.ts" },
  ]);
  assert.equal(result.units[0]?.name, "healthy");
});

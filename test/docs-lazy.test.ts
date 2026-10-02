import assert from "node:assert/strict";
import test from "node:test";
import {
  attributeDocsDeclarations,
  collectDocsCandidates,
  inlineDocIdentifiers,
} from "../src/core/docs.ts";
import type { EvidenceUnit } from "../src/core/units.ts";

const unit: EvidenceUnit = {
  id: "u001",
  kind: "declaration",
  file: "constant.ts",
  name: "REFUND_WINDOW_DAYS",
  exported: true,
  before: "export const REFUND_WINDOW_DAYS = 30",
  after: "export const REFUND_WINDOW_DAYS = 15",
  beforeRange: null,
  afterRange: null,
};

test("anchored forward closure reaches changes through cycles and excludes mention-only modules", async () => {
  const files = [
    { path: "constant.ts", text: unit.after ?? "" },
    {
      path: "refund.ts",
      text: "import { REFUND_WINDOW_DAYS } from './constant.js'; import './entry.js';\nexport function canRefund() { return REFUND_WINDOW_DAYS; }",
    },
    { path: "entry.ts", text: "export { canRefund } from './refund.js';" },
    {
      path: "noise.ts",
      text: "// constant.ts refund.ts entry.ts\nexport function imaginaryAnchor() {}",
    },
    {
      path: "README.md",
      text: "# API\n`canRefund` allows thirty days.\n# Entry\nSee entry.ts.\n# Noise\n`imaginaryAnchor` promises nothing.",
    },
  ];
  const reads: string[] = [];
  const result = await collectDocsCandidates(files, [unit], {
    known: new Set(files.map((file) => file.path)),
    read: async (path) => {
      reads.push(path);
      return files.find((file) => file.path === path);
    },
    declarations: async (names) => attributeDocsDeclarations(names, files),
  });
  assert.deepEqual(
    new Set(result.candidates.map((candidate) => candidate.heading)),
    new Set(["API", "Entry"]),
  );
  assert.deepEqual(
    result.candidates.map((candidate) =>
      candidate.units.map((value) => value.id),
    ),
    [["u001"], ["u001"]],
  );
});

test("level zero completes naturally when no undecided documentation anchor remains", async () => {
  const files = [
    {
      path: "README.md",
      text: "# Direct\n`REFUND_WINDOW_DAYS` was thirty.\n# Other\nNothing relevant.",
    },
  ];
  const result = await collectDocsCandidates(files, [unit], {
    known: new Set(["constant.ts"]),
    read: async () => undefined,
    shouldStop: () => true,
  });
  assert.deepEqual(
    result.candidates.map((section) => section.heading),
    ["Direct"],
  );
  assert.deepEqual(result.omitted, []);
  assert.deepEqual(result.limits, []);
});

test("a reached modified dependency survives the collection deadline", async () => {
  let interrupted = false;
  const files = [
    { path: "consumer.ts", text: "import './constant.js';" },
    {
      path: "README.md",
      text: "# Consumer\nSee consumer.ts.\n# Other\nUnrelated content.",
    },
  ];
  const result = await collectDocsCandidates(files, [unit], {
    known: new Set(["constant.ts", "consumer.ts"]),
    read: async (path) => {
      interrupted = true;
      return files.find((file) => file.path === path);
    },
    shouldStop: () => interrupted,
  });
  assert.deepEqual(
    result.candidates.map((section) => section.heading),
    ["Consumer"],
  );
  assert.deepEqual(result.omitted, []);
  assert.deepEqual(result.limits, []);
});

test("only inline identifiers of at least three characters become search anchors", () => {
  assert.deepEqual(
    inlineDocIdentifiers(
      "ordinary prose `ab` `canRefund` `some.path` ``fenced`` `canRefund`",
    ),
    ["canRefund"],
  );
});

for (const configuration of [
  {
    path: "packages/lib/package.json",
    text: '{"name":"@acme/lib","exports":"./src/value.ts"}',
  },
  {
    path: "tsconfig.json",
    text: '{// aliases\n"compilerOptions":{"baseUrl":".","paths":{"@lib/*":["packages/lib/src/*"],},},}',
  },
])
  test(`progressive closure confirms discriminating workspace or alias imports: ${configuration.path}`, async () => {
    const changed = { ...unit, file: "packages/lib/src/value.ts" };
    const specifier = configuration.path.endsWith("package.json")
      ? "@acme/lib"
      : "@lib/value";
    const files = [
      configuration,
      { path: changed.file, text: changed.after ?? "" },
      {
        path: "app.ts",
        text: `import {REFUND_WINDOW_DAYS} from '${specifier}';\nexport function uniqueConsumer() {return REFUND_WINDOW_DAYS;}`,
      },
      { path: "other.ts", text: "export function run() {}" },
      {
        path: "README.md",
        text: "# Path\nSee app.ts.\n# Unique\n`uniqueConsumer` promises thirty days.\n# Noise\n`run` does something.",
      },
    ];
    const result = await collectDocsCandidates(files, [changed], {
      known: new Set(files.map((file) => file.path)),
      read: async (path) => files.find((file) => file.path === path),
      declarations: async (names) => attributeDocsDeclarations(names, files),
    });
    assert.deepEqual(
      result.candidates.map((section) => section.heading),
      ["Path", "Unique"],
    );
  });

test("ambiguous declaration names do not identify documentation", async () => {
  const files = [
    { path: unit.file, text: unit.after ?? "" },
    { path: "app.ts", text: "import './constant';\nexport function run() {}" },
    { path: "other.ts", text: "export function run() {}" },
    {
      path: "README.md",
      text: "# Ambiguous\n`run` promises something.\n# Path\napp.ts `run` promises something.",
    },
  ];
  const result = await collectDocsCandidates(files, [unit], {
    known: new Set(files.map((file) => file.path)),
    read: async (path) => files.find((file) => file.path === path),
    declarations: async (names) => attributeDocsDeclarations(names, files),
  });
  assert.deepEqual(
    result.candidates.map((section) => section.heading),
    ["Path"],
  );
});

test("declaration ownership escapes dollar, dot and opening parenthesis", () => {
  const rows = [
    {
      path: "a.ts",
      text: "export const cost$ = 1;\nexport const literal.name = 2;\nexport const strange( = 3;",
    },
    {
      path: "noise.ts",
      text: "export const costX = 1;\nexport const literalXname = 2;\n// strange( is only mentioned",
    },
  ];
  const owners = attributeDocsDeclarations(
    ["cost$", "literal.name", "strange("],
    rows,
  );
  for (const name of ["cost$", "literal.name", "strange("])
    assert.deepEqual(owners.get(name), ["a.ts"]);
});

test("changed literals retain code evidence when tests change the same literal", async () => {
  const changed = { ...unit, file: "cli.ts", name: "parseArgs" };
  const file = {
    path: "cli.ts",
    oldPath: "cli.ts",
    status: "M",
    binary: false,
    added: 1,
    deleted: 1,
    before: 'const unchanged = "--context";\nconst flag = "--legacy";',
    after: 'const unchanged = "--context";\nconst flag = "--compat";',
    hunks: [
      {
        beforeStart: 1,
        beforeCount: 2,
        afterStart: 1,
        afterCount: 2,
        changes: [
          { beforeStart: 2, beforeCount: 1, afterStart: 2, afterCount: 1 },
        ],
      },
    ],
  };
  const files = [
    {
      path: "README.md",
      text: "# Flags\n`--legacy` reads old invoices.\n# Context\n`--context` stays available.",
    },
  ];
  const result = await collectDocsCandidates(files, [changed], {
    known: new Set(["cli.ts", "cli.test.ts"]),
    read: async () => undefined,
    changedFiles: [file, { ...file, path: "cli.test.ts" }],
  });
  assert.deepEqual(
    result.candidates.map((candidate) => [
      candidate.heading,
      candidate.units.map((value) => value.id),
    ]),
    [["Flags", ["u001"]]],
  );
});

test("an exhausted anchor does not hide a second unexplored anchor of the same section", async () => {
  let expired = false;
  const files = [
    { path: "README.md", text: "# Pending\nSee empty.ts and middle.ts." },
    { path: "empty.ts", text: "export const value = 1;" },
    { path: "middle.ts", text: "import './constant.ts';" },
  ];
  const result = await collectDocsCandidates(files, [unit], {
    known: new Set([...files.map((file) => file.path), unit.file]),
    read: async (path) => {
      expired = true;
      return files.find((file) => file.path === path);
    },
    shouldStop: () => expired,
  });
  assert.deepEqual(
    result.limits.flatMap((limit) => limit.sections ?? []),
    ["README.md § Pending"],
  );
});

test("bounded anchors preserve reached changes and share dependency reads", async () => {
  const files = Array.from({ length: 140 }, (_, index) => ({
    path: `chain${index}.ts`,
    text: `import './chain${index + 1}.js';`,
  }));
  files.push({
    path: "README.md",
    text: "# Too deep\nSee chain0.ts.\n# Reached\nSee chain130.ts.\n# Shared\nSee chain129.ts.",
  });
  const reads = new Map<string, number>();
  const result = await collectDocsCandidates(
    files,
    [{ ...unit, file: "chain140.ts" }],
    {
      known: new Set([...files.map((file) => file.path), "chain140.ts"]),
      read: async (path) => {
        reads.set(path, (reads.get(path) ?? 0) + 1);
        return files.find((file) => file.path === path);
      },
    },
  );
  assert.deepEqual(
    result.candidates.map((candidate) => candidate.heading),
    ["Reached", "Shared"],
  );
  assert.deepEqual(
    result.limits.flatMap((limit) => limit.sections ?? []),
    ["README.md § Too deep"],
  );
  assert.equal(reads.get("chain130.ts"), 1);
  assert.equal(reads.has("chain100.ts"), false);
});

test("forty direct candidates stop declaration search and dependency exploration", async () => {
  const text = `${Array.from({ length: 40 }, (_, index) => `# Direct ${index}\nconstant.ts`).join("\n")}\n# Unchecked\n\`otherAnchor\``;
  const result = await collectDocsCandidates(
    [{ path: "README.md", text }],
    [unit],
    {
      known: new Set(["constant.ts", "other.ts"]),
      declarations: async () => {
        assert.fail("declaration search after candidate cap");
      },
      read: async () => {
        assert.fail("dependency read after candidate cap");
      },
    },
  );
  assert.equal(result.candidates.length, 40);
  assert.deepEqual(
    result.limits.flatMap((limit) => limit.sections ?? []),
    ["README.md § Unchecked"],
  );
});

test("a direct changed anchor also includes its changed imported constant", async () => {
  const consumer: EvidenceUnit = {
    ...unit,
    id: "u002",
    file: "refund.ts",
    name: "canRefund",
    kind: "function",
    after:
      "export function canRefund(days) { return days <= REFUND_WINDOW_DAYS; }",
  };
  const files = [
    {
      path: "README.md",
      text: "# Refunds\n`canRefund` accepts refunds within 30 days.",
    },
    {
      path: "refund.ts",
      text: `import { REFUND_WINDOW_DAYS } from './constant.js';\n${consumer.after}`,
    },
    { path: "constant.ts", text: unit.after ?? "" },
  ];
  const result = await collectDocsCandidates(files, [consumer, unit], {
    known: new Set(files.map((file) => file.path)),
    read: async (path) => files.find((file) => file.path === path),
    declarations: async (names) => attributeDocsDeclarations(names, files),
  });
  assert.deepEqual(
    result.candidates[0]?.units.map((value) => value.name),
    ["canRefund", "REFUND_WINDOW_DAYS"],
  );
});

import assert from "node:assert/strict";
import test from "node:test";
import { DOCS_MAX_SECTIONS } from "../src/constants.ts";
import {
  attributeDocsDeclarations,
  collectDocsCandidates,
  docSentences,
} from "../src/core/docs.ts";
import type { EvidenceUnit } from "../src/core/units.ts";

const unit: EvidenceUnit = {
  id: "u001",
  kind: "function",
  file: "leaf.ts",
  name: "secretLeaf",
  exported: true,
  before: "export function secretLeaf() { return 1; }",
  after: "export function secretLeaf() { return 2; }",
  beforeRange: { start: 1, end: 1 },
  afterRange: { start: 1, end: 1 },
};
test("documentation anchors follow transitive imports without treating arbitrary words as declarations", async () => {
  const files = [
    { path: "leaf.ts", text: unit.after ?? "" },
    {
      path: "middle.ts",
      text: "import { secretLeaf } from './leaf.js';\nexport function intermediary() { return secretLeaf(); }",
    },
    {
      path: "entry.ts",
      text: "import { intermediary } from './middle.js';\nexport function lowerCaseEntry() { return intermediary(); }\n// imaginaryAnchor",
    },
    {
      path: "README.md",
      text: "# API\n`lowerCaseEntry` returns one.\n# Noise\n`imaginaryAnchor` returns one.\n# Path\nSee entry.ts for the old value.",
    },
  ];
  const result = await collectDocsCandidates(files, [unit], {
    known: new Set(files.map((file) => file.path)),
    read: async (path) => files.find((file) => file.path === path),
    declarations: async (names) => attributeDocsDeclarations(names, files),
  });
  assert.deepEqual(
    result.candidates.map((candidate) => candidate.heading),
    ["Path", "API"],
  );
  assert.deepEqual(
    result.candidates.map((candidate) =>
      candidate.units.map((value) => value.id),
    ),
    [["u001"], ["u001"]],
  );
  assert.equal(
    result.candidates[1]?.sentences.some(
      (sentence) => sentence.text === "# API\n`lowerCaseEntry` returns one.",
    ),
    true,
  );
});
test("the section cap preserves the exact remaining sections as unchecked evidence", async () => {
  const files = [
    { path: "leaf.ts", text: unit.after ?? "" },
    {
      path: "README.md",
      text: Array.from(
        { length: DOCS_MAX_SECTIONS + 2 },
        (_, index) => `# Heading ${index}\n\`secretLeaf\` returns one.`,
      ).join("\n"),
    },
  ];
  const result = await collectDocsCandidates(files, [unit], {
    known: new Set(files.map((file) => file.path)),
    read: async (path) => files.find((file) => file.path === path),
  });
  assert.deepEqual(
    result.candidates.map((candidate) => candidate.heading),
    Array.from({ length: DOCS_MAX_SECTIONS }, (_, index) => `Heading ${index}`),
  );
  assert.deepEqual(
    result.omitted.map((candidate) => candidate.heading),
    [`Heading ${DOCS_MAX_SECTIONS}`, `Heading ${DOCS_MAX_SECTIONS + 1}`],
  );
});
test("sentence pointers preserve fenced code punctuation and exact prose fragments", () => {
  const text =
    "First claim. Second claim!\n\n```js\nconsole.log('First. Second!');\n```\n\nFinal claim?";
  assert.deepEqual(docSentences(text), [
    { id: "s1", text: "First claim." },
    { id: "s2", text: "Second claim!" },
    { id: "s3", text: "```js\nconsole.log('First. Second!');\n```" },
    { id: "s4", text: "Final claim?" },
  ]);
});

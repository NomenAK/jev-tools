import assert from "node:assert/strict";
import test from "node:test";
import { sectionFile } from "../src/core/sections.ts";

test("Markdown sections preserve introductory text, fenced headings and line evidence", () => {
  const text = [
    "intro",
    "# First",
    "```",
    "# not a heading",
    "```",
    ...Array(8).fill("body"),
    "# Last",
    ...Array(8).fill("end"),
  ].join("\n");
  const result = sectionFile("guide.md", text);
  assert.equal(result.sections[0]?.start, 1);
  assert.equal(result.sections.at(-1)?.end, 22);
  assert.equal(result.sections.length, 2);
  assert.match(result.sections[0]?.text ?? "", /# not a heading/);
  assert.equal(result.sections[1]?.label, "Last");
});

test("large declarations descend to inner declarations and tiny neighbors merge", () => {
  const text = Array.from({ length: 180 }, (_, i) => `line ${i + 1}`).join(
    "\n",
  );
  const result = sectionFile("file.ts", text, [
    { name: "Large", start: 1, end: 180 },
    { name: "Large.first", start: 10, end: 70 },
    { name: "Large.second", start: 71, end: 175 },
    { name: "Large.tiny", start: 176, end: 180 },
  ]);
  assert.equal(result.sections.length, 3);
  assert.deepEqual(
    result.sections.map((s) => [s.start, s.end]),
    [
      [1, 9],
      [10, 70],
      [71, 180],
    ],
  );
  assert.equal(result.sections.map((s) => s.text).join("\n"), text);
});

test("unstructured files use complete eighty-line windows", () => {
  const text = Array.from({ length: 173 }, (_, i) => `plain ${i}`).join("\n");
  const result = sectionFile("data.txt", text);
  assert.deepEqual(
    result.sections.map((s) => [s.start, s.end]),
    [
      [1, 80],
      [81, 160],
      [161, 173],
    ],
  );
  assert.equal(result.sections.map((s) => s.text).join("\n"), text);
});

test("Python indentation finds methods without swallowing the next class", () => {
  const text = [
    "class First:",
    "    def one(self):",
    ...Array(10).fill("        work()"),
    "    def two(self):",
    ...Array(10).fill("        other()"),
    "class Second:",
    "    def three(self):",
    ...Array(10).fill("        final()"),
  ].join("\n");
  const result = sectionFile("sample.py", text);
  assert.equal(result.sections.length, 3);
  assert.equal(result.sections[0]?.start, 1);
  assert.equal(result.sections.at(-1)?.end, 35);
  assert.match(result.sections.at(-1)?.text ?? "", /^class Second:/);
});

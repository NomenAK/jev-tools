import assert from "node:assert/strict";
import test from "node:test";
import { markdownSections, sectionFile } from "../src/core/sections.ts";

test("Markdown sections exclude front matter, fenced code and HTML headings", () => {
  const source = [
    "---",
    "title: Example",
    "# YAML",
    "---",
    "# Real",
    "Text.",
    "````js",
    "# code",
    "```",
    "# still code",
    "````",
    "<div>",
    "# HTML",
    "</div>",
    "",
    "Second",
    "------",
    "Last.",
  ].join("\n");
  const sections = markdownSections(source);
  assert.deepEqual(
    sections.map((section) => section.label),
    ["Real", "Second"],
  );
  assert.equal(sections[0]?.start, 5);
  assert.equal(sections[0]?.end, 15);
  assert.equal(sections[1]?.start, 16);
  assert.equal(sections[1]?.text, "Second\n------\nLast.");
  assert.equal(sectionFile("a.md", source).method, "markdown");
});
test("a shorter fence cannot close a code block and inline HTML does not swallow the next heading", () => {
  const source =
    "# First\n<span>text</span>\n\n# Second\n~~~\n# code\n~~~\n# Third";
  assert.deepEqual(
    markdownSections(source).map((section) => section.label),
    ["First", "Second", "Third"],
  );
});
test("exact Markdown sections remain separate while Locate groups short neighbors", () => {
  const source = "Preamble.\n# One\nFirst.\n# Two\nSecond.\n";
  assert.deepEqual(
    markdownSections(source).map(({ label, start, end, text }) => ({
      label,
      start,
      end,
      text,
    })),
    [
      { label: "One", start: 2, end: 3, text: "# One\nFirst." },
      { label: "Two", start: 4, end: 5, text: "# Two\nSecond." },
    ],
  );
  const located = sectionFile("guide.md", source);
  assert.deepEqual(
    located.sections.map(({ label, start, end, text }) => ({
      label,
      start,
      end,
      text,
    })),
    [{ label: "One / Two", start: 1, end: 5, text: source.trimEnd() }],
  );
});

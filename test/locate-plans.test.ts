import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readLocateFile, scanRange } from "../src/adapters/locate-file.ts";
import {
  outlineEvidence,
  sectionOutline,
  sectionStateFits,
} from "../src/core/locate.ts";

test("streamed app and wide logs have only bounded multi-section refinements", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "jev-plan-"));
  try {
    for (const [name, count, width] of [
      ["app.log", 4040, 100],
      ["wide.log", 4040, 450],
    ] as const) {
      await writeFile(
        join(cwd, name),
        Array.from(
          { length: count },
          (_, i) => `line ${i + 1} ${"x".repeat(width)}`,
        ).join("\n"),
      );
      const file = await readLocateFile(cwd, name);
      assert.ok(file.ok && file.kind === "outline");
      const sections = file.windows.map((window, index) => ({
        ...window,
        id: `S${index + 1}`,
      }));
      const blocks = sectionOutline(name, "last failure", sections);
      assert.ok(blocks.length > 1);
      assert.equal(blocks.at(-1)?.end, count);
      assert.ok(
        sectionStateFits(
          name,
          "last failure",
          outlineEvidence(name, "last failure", blocks),
        ),
      );
      for (const block of blocks) {
        const members = sections.filter(
          (s) => s.start >= block.start && s.end <= block.end,
        );
        assert.ok(members.length >= 2);
        assert.equal(block.label, members.map((s) => s.label).join(" / "));
        const selected = await scanRange(cwd, name, block);
        assert.ok(selected.ok);
        const lines = selected.text.split("\n");
        const refined = members.map((s) => ({
          ...s,
          text: lines
            .slice(s.start - block.start, s.end - block.start + 1)
            .join("\n"),
        }));
        assert.ok(refined.length >= 2);
        assert.ok(sectionStateFits(name, "last failure", refined));
      }
    }
  } finally {
    await rm(cwd, { recursive: true });
  }
});

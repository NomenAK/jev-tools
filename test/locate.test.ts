import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { withEvidenceContext } from "../src/adapters/evidence-context.ts";
import { STATE_MAX_CHARS } from "../src/constants.ts";
import {
  outlineEvidence,
  sectionOutline,
  sectionState,
  sectionStateFits,
} from "../src/core/locate.ts";
import { Guide } from "../src/guide.ts";
import { detectHost } from "../src/host.ts";
import type { JevClient, State } from "../src/jev/types.ts";
import { Session } from "../src/session.ts";
import { createLocateTool } from "../src/tools/locate.ts";

const source = Array.from(
  { length: 6 },
  (_, i) =>
    `# Section ${i + 1}\n${Array(10)
      .fill(`evidence ${i} ${"x".repeat(350)}`)
      .join("\n")}`,
).join("\n");
async function run(
  text: string,
  probabilities: Record<string, number>[],
  path = "large.md",
) {
  const cwd = await mkdtemp(join(tmpdir(), "jev-locate-"));
  const states: State[] = [];
  const orders: string[][] = [];
  const host = detectHost({});
  const client: JevClient = {
    clearCache() {},
    async judge(state, questions, options) {
      assert.ok(JSON.stringify(state).length <= STATE_MAX_CHARS);
      const evidence = state.evidence as { context?: unknown } | undefined;
      assert.ok(evidence?.context, "every pointer stage retains provenance");
      const admitted = options?.beforeRequest?.(1);
      if (admitted && !admitted.ok) return admitted;
      states.push(state);
      const pointer = questions.pointer;
      assert.equal(pointer?.type, "choice");
      if (pointer?.type !== "choice") throw Error("expected pointer choice");
      orders.push(Object.keys(pointer.criteria));
      const p = probabilities.shift();
      if (!p) throw Error("unexpected judgment");
      return {
        ok: true,
        calls: 1,
        questions: 1,
        cacheRequests: 1,
        answers: {
          pointer: {
            type: "choice",
            source: "fresh",
            choice:
              Object.entries(p).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "none",
            confidence: 0.01,
            probabilities: p,
          },
        },
      };
    },
  };
  try {
    await writeFile(join(cwd, path), text);
    const output = await createLocateTool({
      client,
      host,
      runtime: { session: new Session({}), guide: new Guide(host) },
      exec: async (command, args) => {
        assert.equal(command, "git");
        assert.equal(args[0], "ls-files");
        return {
          code: 0,
          stdout: `${args.includes("-t") ? "H " : ""}${path}\0`,
          stderr: "",
          killed: false,
        };
      },
    }).execute(
      "1",
      { path, goal: "where is evidence three" },
      undefined,
      undefined,
      { cwd },
    );
    return {
      text: output.content[0]?.text ?? "",
      report: output.details.result,
      states,
      orders,
    };
  } finally {
    await rm(cwd, { recursive: true });
  }
}
test("files under 19 KB are refused before any Jev call, 19 000 bytes proceed", async () => {
  const refused = await run("x".repeat(18_999), []);
  assert.match(refused.text, /small file \(1 lines\): read it directly/);
  assert.deepEqual(refused.states, []);
  for (const size of [19_000, 19_001]) {
    const admitted = await run("x".repeat(size), [{ none: 0.95, S1: 0.05 }]);
    assert.equal(admitted.states.length > 0, true);
  }
});
test("verdict uses file evidence and probability, not confidence", async () => {
  const result = await run(source, [{ S3: 0.9, S1: 0.05, none: 0.05 }]);
  assert.match(result.text, /large.md:23-33/);
  assert.equal(result.report.items[0]?.treatment, "judged");
  const item = result.report.items[0];
  assert.ok(item);
  if (item.treatment === "judged") assert.equal(item.judgment.band, "verdict");
});
test("unsure ranks top two after reverse, not adjacent sections", async () => {
  const p = { S1: 0.55, S5: 0.4, none: 0.05 };
  const result = await run(source, [p, p]);
  const item = result.report.items[0];
  assert.ok(item);
  assert.equal(item.treatment, "judged");
  if (item.treatment === "judged") assert.equal(item.judgment.band, "unsure");
  assert.match(result.text, /large.md:45-55/);
  assert.equal(result.orders[1]?.at(-1), "none");
  assert.equal(result.orders[1]?.[0], "S6");
});
test("a weak pointer stays unsure without a shrinking re-ask", async () => {
  const p = { S1: 0.3, S5: 0.28, S3: 0.22, S2: 0.1, none: 0.1 };
  const result = await run(source, [p, p]);
  assert.equal(result.states.length, 2);
  assert.match(result.text, /unsure.*large.md:1-11/);
});
test("large source uses a bounded plan then refines only the selected evidence", async () => {
  const large = Array.from(
    { length: 40 },
    (_, i) =>
      `# Part ${i + 1}\n${Array(12)
        .fill(`part ${i + 1} ${"x".repeat(500)}`)
        .join("\n")}`,
  ).join("\n");
  const result = await run(large, [
    { B2: 0.95, none: 0.05 },
    { S13: 0.95, none: 0.05 },
  ]);
  assert.equal(result.states.length, 2);
  assert.ok(JSON.stringify(result.states[0]).length < 80000);
  assert.ok(JSON.stringify(result.states[1]).length < 80000);
  assert.match(result.text, /large.md:157-169/);
  assert.ok(
    Array.isArray(result.states[1]?.sections) &&
      result.states[1].sections.length >= 2,
  );
  assert.match(JSON.stringify(result.states[0]), /part 1/);
});
test("streaming outlines do not carry the file and refinement preserves absolute lines", async () => {
  const large = Array.from(
    { length: 1100 },
    (_, i) => `plain line ${i + 1} ${"x".repeat(350)}`,
  ).join("\n");
  const result = await run(large, [
    { B2: 0.95, none: 0.05 },
    { S4: 0.95, none: 0.05 },
  ]);
  assert.match(result.text, /large.md:166-220/);
  assert.match(result.text, /lines 166-220/);
  assert.match(result.text, /large file: window outline, not declarations/);
  assert.match(JSON.stringify(result.states[0]), /plain line 166/);
  assert.ok(JSON.stringify(result.states[0]).length <= 80000);
  assert.match(JSON.stringify(result.states[1]), /plain line 166/);
});
test("verdict threshold is inclusive after averaging both orders", async () => {
  const p = { S2: 0.7, none: 0.3 };
  const result = await run(source, [p, p]);
  assert.match(result.text, /large.md:12-22/);
  const item = result.report.items[0];
  assert.ok(item);
  if (item.treatment === "judged") assert.equal(item.judgment.band, "verdict");
});
test("a weak none pointer stays unsure with search elsewhere", async () => {
  const p = { none: 0.45, S1: 0.3, S2: 0.15, S3: 0.1 };
  const result = await run(source, [p, p]);
  assert.equal(result.states.length, 2);
  assert.match(result.text, /unsure.*none/);
  assert.ok(
    result.report.actions.some(
      (action) =>
        action.code === "inspect_native" &&
        action.target.status === "known" &&
        action.target.value === "large.md",
    ),
  );
});
test("an unsure plan cannot promote a confident refinement", async () => {
  const large = Array.from(
    { length: 40 },
    (_, i) =>
      `# Part ${i + 1}\n${Array(12)
        .fill(`part ${i + 1} ${"x".repeat(500)}`)
        .join("\n")}`,
  ).join("\n");
  const p = { B2: 0.55, B1: 0.4, none: 0.05 };
  const result = await run(large, [p, p, { S13: 0.95, none: 0.05 }]);
  const item = result.report.items[0];
  assert.ok(item);
  if (item.treatment === "judged") assert.equal(item.judgment.band, "unsure");
  assert.match(
    result.text,
    /plan unsure: refined only the top block; also consider large.md:1-156/,
  );
});
test("an unsure none plan retains the readable alternative block", async () => {
  const large = Array.from(
    { length: 40 },
    (_, i) => `# Part ${i + 1}\n${Array(12).fill("x".repeat(500)).join("\n")}`,
  ).join("\n");
  const p = { none: 0.55, B2: 0.4, B1: 0.05 };
  const result = await run(large, [p, p]);
  const item = result.report.items[0];
  assert.ok(item);
  assert.equal(item.treatment, "judged");
  if (item.treatment === "judged") {
    assert.equal(item.judgment.band, "unsure");
    assert.equal(item.judgment.result, "no section fits");
  }
  assert.match(result.text, /large.md:170-338/);
  assert.equal(result.states.length, 2);
});
test("a degenerate one-block plan refuses without judging labels", async () => {
  const large = `# One\n${"x".repeat(90000)}`;
  const result = await run(large, []);
  assert.match(result.text, /use grep/);
  assert.equal(result.states.length, 0);
});
test("a none verdict includes search elsewhere", async () => {
  const result = await run(source, [{ none: 0.95, S1: 0.05 }]);
  assert.equal(result.report.execution, "complete");
  const item = result.report.items[0];
  assert.ok(item);
  assert.equal(item.treatment, "judged");
  if (item.treatment !== "judged") throw Error("expected judgment");
  assert.equal(item.judgment.result, "no section fits");
  assert.equal(item.judgment.band, "verdict");
  assert.ok(item.actionIds.length > 0);
  const action = result.report.actions.find((action) =>
    item.actionIds.includes(action.id),
  );
  assert.ok(action);
  assert.deepEqual(action.target, { status: "known", value: "large.md" });
  assert.equal(action.code, "inspect_native");
  assert.match(action.instruction, /search elsewhere/i);
  assert.equal(action.repeatUnchanged, false);
});

test("locate reports root syntax errors outside its healthy declarations", async () => {
  const text =
    'export type * from "./types";\n' +
    `export function healthy() {\n${Array(80)
      .fill(`  // ${"evidence ".repeat(35)}`)
      .join("\n")}\n  return 1;\n}`;
  const result = await run(text, [{ S1: 0.95, none: 0.05 }], "large.ts");
  assert.match(result.text, /parse_partial: large.ts/);
  assert.match(result.text, /large.ts:/);
});

test("block planning reserves serialized context in both plan and refinement", () => {
  const path = "large.md";
  const goal = "find the final section";
  const context = {
    authority: { path: `/repo/${"x".repeat(10_000)}`, origin: "host" as const },
    effectiveRoot: {
      path: `/repo/${"x".repeat(10_000)}`,
      origin: "host" as const,
    },
  };
  const empty = sectionState(path, goal, []);
  const capacity =
    STATE_MAX_CHARS -
    (JSON.stringify(withEvidenceContext(empty, context)).length -
      JSON.stringify(empty).length);
  const sections = Array.from({ length: 12 }, (_, index) => ({
    id: `S${index + 1}`,
    start: index * 10 + 1,
    end: index * 10 + 10,
    label: `section ${index + 1}`,
    text: `section ${index + 1} ${"x".repeat(8_000)}`,
  }));
  const blocks = sectionOutline(path, goal, sections, capacity);
  assert.ok(blocks.length > 1);
  const plan = outlineEvidence(path, goal, blocks, capacity);
  assert.ok(sectionStateFits(path, goal, plan, false, capacity));
  assert.ok(
    JSON.stringify(withEvidenceContext(sectionState(path, goal, plan), context))
      .length <= STATE_MAX_CHARS,
  );
  for (const block of blocks) {
    const refinement = sections.filter(
      (section) => section.start >= block.start && section.end <= block.end,
    );
    assert.ok(refinement.length >= 2);
    assert.ok(sectionStateFits(path, goal, refinement, false, capacity));
    assert.ok(
      JSON.stringify(
        withEvidenceContext(sectionState(path, goal, refinement), context),
      ).length <= STATE_MAX_CHARS,
    );
  }
});

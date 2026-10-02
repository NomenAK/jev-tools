import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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
    return { text: output.content[0]?.text ?? "", states, orders };
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
  assert.doesNotMatch(result.text, /unsure|evidence 2/);
});
test("gray ranks top two after reverse, not adjacent sections", async () => {
  const p = { S1: 0.55, S5: 0.4, none: 0.05 };
  const result = await run(source, [p, p]);
  assert.match(result.text, /unsure.*large.md:1-11/);
  assert.match(result.text, /also:.*large.md:45-55/);
  assert.equal(result.orders[1]?.at(-1), "none");
  assert.equal(result.orders[1]?.[0], "S6");
});
test("shrinking re-ask retains unsure even when final choice becomes clear", async () => {
  const p = { S1: 0.3, S5: 0.28, S3: 0.22, S2: 0.1, none: 0.1 };
  const result = await run(source, [
    p,
    p,
    { S5: 0.92, S1: 0.03, S3: 0.03, none: 0.02 },
  ]);
  assert.equal((result.states[2]?.sections as unknown[])?.length, 3);
  assert.match(result.text, /unsure.*large.md:45-55.*0.92/);
  assert.equal(result.states.length, 3);
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
  assert.doesNotMatch(result.text, /unsure/);
});
test("none after shrinking remains unsure with search elsewhere", async () => {
  const p = { S1: 0.3, S2: 0.25, S3: 0.24, none: 0.21 };
  const result = await run(source, [
    p,
    p,
    { none: 0.9, S1: 0.05, S2: 0.03, S3: 0.02 },
  ]);
  assert.match(result.text, /unsure.*none/);
  assert.match(result.text, /search elsewhere/);
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
  assert.match(result.text, /unsure.*large.md:157-169/);
  assert.match(
    result.text,
    /plan unsure: refined only the top block; also consider large.md:1-156/,
  );
});
test("a gray none plan retains the readable alternative block", async () => {
  const large = Array.from(
    { length: 40 },
    (_, i) => `# Part ${i + 1}\n${Array(12).fill("x".repeat(500)).join("\n")}`,
  ).join("\n");
  const p = { none: 0.55, B2: 0.4, B1: 0.05 };
  const result = await run(large, [p, p]);
  assert.match(result.text, /unsure.*none/);
  assert.match(result.text, /also:.*large.md:170-338/);
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
  assert.match(result.text, /none = no section fits/);
  assert.match(result.text, /search elsewhere/);
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

import assert from "node:assert/strict";
import { test } from "node:test";
import type { EnvelopeInput } from "../src/core/output.ts";
import { buildEnvelope } from "../src/core/output.ts";
import { renderEnvelope } from "../src/render.ts";

const yieldData = {
  calls: 0,
  questions: 0,
  costUsd: 0,
  cacheHits: 0,
  cacheRequests: 0,
  elapsedMs: 0,
};

test("session refusal is exactly refusal then yield before any send", () => {
  assert.deepEqual(
    buildEnvelope({
      budget: { kind: "session", message: "limit reached" },
      unchecked: ["q1"],
      yield: yieldData,
    }),
    {
      lines: [
        { type: "refusal", message: "limit reached" },
        { type: "yield", value: yieldData },
      ],
    },
  );
});
test("session refusal after send lists unchecked without failed controls", () => {
  const sent = { ...yieldData, calls: 1 };
  assert.deepEqual(
    buildEnvelope({
      budget: { kind: "session", message: "limit reached" },
      unchecked: ["q2"],
      yield: sent,
    }),
    {
      lines: [
        { type: "refusal", message: "limit reached" },
        { type: "unchecked", items: ["q2"] },
        { type: "yield", value: sent },
      ],
    },
  );
});
test("preset policy and precomputed bands preserve displayed aggregate probability", () => {
  const envelope = buildEnvelope({
    policy: (value) => (value.p >= 0.7 ? "verdict" : "unsure"),
    answers: [
      { label: "risk", value: { head: "security", p: 0.72 } },
      {
        label: "locate",
        value: { head: "method", p: 0.55 },
        band: "unsure",
        orderDependent: true,
        candidates: [
          { label: "a.ts:20-30", value: { head: "other", p: 0.41 } },
        ],
      },
    ],
    yield: yieldData,
  });
  assert.equal(
    envelope.lines[0]?.type === "answer" && envelope.lines[0].band,
    "verdict",
  );
  assert.match(renderEnvelope(envelope), /0.55.*order-dependent/);
  assert.match(renderEnvelope(envelope), /a.ts:20-30.*0.41/);
});
test("unjudged is separate from gray share and has an action", () => {
  const envelope = buildEnvelope({
    answers: [{ label: "a", value: { head: "x", p: 0.5 }, band: "unsure" }],
    unjudged: [{ label: "b", reason: "omitted", next: "raise max_calls" }],
    yield: yieldData,
  });
  assert.deepEqual(envelope.lines[1], {
    type: "unjudged",
    label: "b",
    reason: "omitted",
    next: "raise max_calls",
  });
  assert.equal(
    envelope.lines.some(
      (line) => line.type === "fact" && line.fact === "1/1 answers unsure",
    ),
    true,
  );
});
const examples: Record<string, Omit<EnvelopeInput, "yield">> = {
  jev_ask: {
    answers: [
      { label: "claim", value: { head: "holds", p: 0.9 }, band: "verdict" },
    ],
  },
  jev_ask_files: {
    answers: [
      { label: "a.ts claim", value: { head: "yes", p: 0.98 }, band: "verdict" },
    ],
  },
  jev_find_files: {
    lines: [
      {
        type: "entry",
        candidate: { label: "a.ts", value: { head: "a.ts", p: 0.96 } },
        band: "verdict",
      },
    ],
  },
  jev_locate_in_file: {
    answers: [
      {
        label: "a.ts:10-20",
        value: { head: "method", p: 0.55 },
        band: "unsure",
        candidates: [
          { label: "a.ts:30-40", value: { head: "other", p: 0.41 } },
        ],
      },
    ],
  },
  jev_check_diff: {
    answers: [
      {
        label: "a.ts:10-20",
        value: { head: "security", p: 0.97 },
        band: "verdict",
      },
    ],
  },
  jev_select_tests: {
    lines: [
      { type: "list", title: "run", items: ["npm test -- a.test.ts"] },
      { type: "list", title: "changed, run by no test", items: ["a.ts:10-20"] },
      { type: "list", title: "fallback", items: ["all"] },
    ],
  },
};
for (const [tool, model] of Object.entries(examples))
  test(`${tool} renders its typed model without tool-side formatting`, () => {
    const text = renderEnvelope(buildEnvelope({ ...model, yield: yieldData }));
    if (tool === "jev_select_tests")
      assert.match(text, /npm test -- a.test.ts[\s\S]*a.ts:10-20[\s\S]*all/);
    else if (tool === "jev_find_files") assert.match(text, /entry: a.ts.*0.96/);
    else assert.match(text, /0\.\d+/);
    assert.match(text, /0 calls · 0 questions · \$0.00000/);
  });
test("grouped limits retain all counts, prioritize affected paths and bound examples", () => {
  const limitations = Array.from({ length: 100 }, (_, i) => ({
    fact: `missing import: src/${i}.ts`,
    next: "run the project runner",
    cause: "missing import",
    path: `src/${i}.ts`,
    dependency: "library",
  }));
  const envelope = buildEnvelope({
    limitations,
    limitationPriorityPaths: ["src/99.ts"],
    yield: yieldData,
  });
  const text = renderEnvelope(envelope);
  assert.match(text, /missing import.*1 limit.*src\/99.ts/);
  assert.match(text, /missing import.*99 limits/);
  assert.match(text, /more/);
  assert.ok(text.length < 2000);
});
test("unsure entries recommend only readable candidates", () => {
  for (const [paths, action] of [
    [["a.ts", "none"], /read a\.ts/],
    [["none"], /rephrase goal or widen scope/],
    [["a.ts", "b.ts"], /read both/],
  ] as const) {
    const text = renderEnvelope(
      buildEnvelope({
        lines: [
          {
            type: "entry",
            band: "unsure",
            candidate: { label: paths[0], value: { head: paths[0], p: 0.6 } },
            candidates: paths
              .slice(1)
              .map((path) => ({ label: path, value: { head: path, p: 0.3 } })),
          },
        ],
        yield: yieldData,
      }),
    );
    assert.match(text, action);
    if (paths.some((path) => path === "none"))
      assert.doesNotMatch(text, /read both|read the first two|read none/);
  }
});
test("every priority dependency is rendered while unrelated inventory remains bounded", () => {
  const limitations = Array.from({ length: 10 }, (_, i) => ({
    fact: `unresolved changed.ts library${i}`,
    next: "read dependency",
    cause: "unresolved",
    path: "changed.ts",
    dependency: `library${i}`,
  }));
  const text = renderEnvelope(
    buildEnvelope({
      limitations,
      limitationPriorityPaths: ["changed.ts"],
      yield: yieldData,
    }),
  );
  for (let i = 0; i < 10; i++) assert.ok(text.includes(`library${i}`));
  assert.match(text, /10 limits/);
  assert.doesNotMatch(text, /more/);
});

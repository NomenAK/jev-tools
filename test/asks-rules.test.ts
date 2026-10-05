import assert from "node:assert/strict";
import { test } from "node:test";
import { compileAsks, readAsks, reverseQuestions } from "../src/core/asks.ts";
import type { Answer } from "../src/jev/types.ts";

function plan(input: unknown) {
  const result = compileAsks(input, { surface: "ask" });
  assert.equal(result.ok, true);
  return result;
}
const c = (p: Record<string, number>): Answer => ({
  type: "choice",
  choice: "unused",
  confidence: 0.01,
  probabilities: p,
});
for (const [head, p, exact, band] of [
  ["holds", 0.9, 0.49, "unsure"],
  ["holds", 0.9, 0.5, "verdict"],
  ["contradicted", 0.9, 0.5, "unsure"],
  ["contradicted", 0.9, 0.49, "verdict"],
  ["cannot_tell", 0.3, 0.79, "abstain"],
  ["cannot_tell", 0.3, 0.8, "unsure"],
] as const)
  test(`verify ${head} ${exact} reads ${band}`, () => {
    const result = plan({
      intent: "verify",
      claims: { c1: "The file validates tokens" },
    });
    const probabilities = {
      holds: 0,
      contradicted: 0,
      not_addressed: 1 - p,
      cannot_tell: 0,
      [head]: p,
    };
    const [line] = readAsks(result, {
      q1: c(probabilities),
      q2: c(probabilities),
      q3: { type: "bool", p: exact },
    });
    assert.equal(line?.band, band);
  });
for (const head of ["other", "cannot_tell", "bug"])
  test(`decide disagreement ${head}`, () => {
    const result = plan({
      intent: "decide",
      hypotheses: {
        bug: "Implementation is wrong",
        env: "Environment is wrong",
      },
    });
    const controls = Object.fromEntries(
      Object.entries(result.readings[0]?.controls ?? {}).map(([key, id]) => [
        id,
        {
          type: "bool",
          p: key === "bug" ? (head === "bug" ? 0.1 : 0.8) : 0.1,
        } as Answer,
      ]),
    );
    const [line] = readAsks(result, {
      q1: c({ bug: 0, env: 0, other: 0, cannot_tell: 0, [head]: 0.95 }),
      ...controls,
    });
    assert.equal(line?.band, "unsure");
    assert.match(line?.reason ?? "", /disagreement/);
  });
test("classify many and locate many preserve simultaneous yes answers", () => {
  for (const ask of [
    {
      intent: "classify",
      pick: "many",
      categories: { a: "Validates tokens", b: "Writes logs" },
    },
    {
      intent: "locate",
      count: "many",
      target: "writes logs",
      among: ["a", "b"],
    },
  ]) {
    const result = plan(ask);
    assert.equal(Object.keys(result.questions).length, 2);
    assert.ok(Object.values(result.questions).every((q) => q.type === "bool"));
    const lines = readAsks(result, {
      q1: { type: "bool", p: 0.98 },
      q2: { type: "bool", p: 0.96 },
    });
    assert.deepEqual(
      lines.map((l) => l.answer),
      [
        { type: "bool", p: 0.98 },
        { type: "bool", p: 0.96 },
      ],
    );
  }
});
test("choice threshold is inclusive and cannot_tell remains last", () => {
  const result = plan({
    intent: "classify",
    categories: { a: "Validates tokens", b: "Writes logs" },
  });
  assert.deepEqual(
    reverseQuestions(result, {
      q1: c({ a: 0.85, b: 0.1, other: 0.04, cannot_tell: 0.01 }),
    }),
    {},
  );
  assert.equal(
    Object.keys(
      reverseQuestions(result, {
        q1: c({ a: 0.849, b: 0.1, other: 0.04, cannot_tell: 0.011 }),
      }),
    ).length,
    1,
  );
  assert.equal(
    readAsks(result, { q1: c({ a: 0.7, b: 0, other: 0, cannot_tell: 0.3 }) })[0]
      ?.band,
    "abstain",
  );
});
test("rate is one score, free adds other and locate fixes none first", () => {
  const rate = plan({
    intent: "rate",
    dimension: "risk",
    levels: ["Covered isolated change", "Shared security-critical module"],
  });
  assert.equal(rate.questions.q1?.type, "score");
  const free = plan({
    intent: "free",
    question: {
      type: "choice",
      instructions: "Which behavior matches?",
      criteria: { a: "Validates tokens" },
    },
  });
  assert.equal(free.warnings.length, 1);
  const locate = plan({
    intent: "locate",
    target: "validates tokens",
    among: ["a", "b"],
    count: "one",
    attribution: true,
  });
  const q = locate.questions.q1;
  assert.equal(q?.type, "choice");
  if (q?.type === "choice")
    assert.deepEqual(
      [Object.keys(q.criteria)[0], Object.keys(q.criteria).at(-1)],
      ["none", "cannot_tell"],
    );
  assert.equal(locate.readings[0]?.attributable, true);
});
test("ablation is requested explicitly on a single pointer", () => {
  const passive = plan({
    intent: "locate",
    target: "validates tokens",
    among: ["a", "b"],
  });
  assert.equal(passive.readings[0]?.attributable, false);
  const matrix = plan({
    intent: "locate",
    target: "validates tokens",
    among: ["a", "b"],
    count: "many",
    attribution: true,
  });
  assert.equal(
    matrix.readings.some((reading) => reading.attributable),
    false,
  );
  assert.match(matrix.warnings[0]?.fact ?? "", /only to locate count: one/);
  const claims = plan([
    {
      intent: "verify",
      claims: { first: "A validates tokens", second: "B writes logs" },
    },
    {
      intent: "rate",
      dimension: "risk",
      levels: ["Isolated covered change", "Shared security-sensitive change"],
    },
  ]);
  assert.deepEqual(
    claims.readings.map((reading) => reading.askIndex),
    [0, 0, 1],
  );
});
test("missing coherence controls cannot produce a verdict", () => {
  const result = plan({
    intent: "decide",
    hypotheses: { bug: "Implementation fails" },
  });
  const reading = readAsks(result, {
    q1: c({ bug: 0.98, other: 0.01, cannot_tell: 0.01 }),
  })[0];
  assert.equal(reading?.unjudged, true);
  assert.equal(reading?.band, undefined);
  assert.equal(reading?.answer, undefined);
  assert.ok(reading?.reason?.includes("unjudged"));
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { compileAsks, readAsks, reverseQuestions } from "../src/core/asks.ts";
import type { Answer } from "../src/jev/types.ts";

const verify = {
  intent: "verify",
  claims: { c1: "The file validates tokens" },
};
const choice = (probabilities: Record<string, number>): Answer => ({
  type: "choice",
  choice:
    Object.keys(probabilities).sort(
      (a, b) => (probabilities[b] ?? 0) - (probabilities[a] ?? 0),
    )[0] ?? "other",
  confidence: 0.99,
  probabilities,
});
function plan(input: unknown, surface: "ask" | "files" = "ask") {
  const result = compileAsks(input, { surface });
  assert.equal(result.ok, true);
  return result;
}
test("verify preserves the exact claim and groups issues, twin and exact bool", () => {
  const result = plan(JSON.stringify(verify));
  assert.deepEqual(result.groups, [["q1", "q2", "q3"]]);
  assert.equal(
    result.questions.q3?.instructions,
    "Is the following statement true of the state: The file validates tokens",
  );
  const a = result.questions.q1;
  const b = result.questions.q2;
  assert.equal(a?.type, "choice");
  assert.equal(b?.type, "choice");
  if (a?.type !== "choice" || b?.type !== "choice") return;
  assert.deepEqual(Object.keys(a.criteria), [
    "not_addressed",
    "holds",
    "contradicted",
    "cannot_tell",
  ]);
  assert.deepEqual(Object.keys(b.criteria), [
    "not_addressed",
    "contradicted",
    "holds",
    "cannot_tell",
  ]);
  assert.match(a.instructions, /If a document, file, requirement or output/);
});
test("verify averages and merges unknown mass without promoting the bool", () => {
  const result = plan(verify);
  const answers = {
    q1: choice({
      holds: 0.03,
      contradicted: 0.02,
      not_addressed: 0.72,
      cannot_tell: 0.23,
    }),
    q2: choice({
      holds: 0.01,
      contradicted: 0.02,
      not_addressed: 0.74,
      cannot_tell: 0.23,
    }),
    q3: { type: "bool", p: 0.02 } as Answer,
  };
  const [line] = readAsks(result, answers);
  assert.deepEqual(line?.value, { head: "not_addressed", p: 0.96 });
  assert.equal(line?.band, "verdict");
  assert.deepEqual(reverseQuestions(result, answers), {});
});
test("verify disagreement overrides abstention only for its own claim", () => {
  const result = plan(verify);
  const [line] = readAsks(result, {
    q1: choice({
      holds: 0.02,
      contradicted: 0.02,
      not_addressed: 0.6,
      cannot_tell: 0.36,
    }),
    q2: choice({
      holds: 0.02,
      contradicted: 0.02,
      not_addressed: 0.6,
      cannot_tell: 0.36,
    }),
    q3: { type: "bool", p: 0.92 },
  });
  assert.equal(line?.band, "unsure");
  assert.match(
    line?.reason ?? "",
    /scope\/evidence disagreement: issues cannot_tell 0.36, bool yes 0.92/,
  );
});
test("decide has frozen hypotheses and indivisible coherence bools", () => {
  const a = plan({
    intent: "decide",
    hypotheses: {
      bug: "The implementation fails",
      env: "The environment fails",
    },
  });
  const b = plan({
    intent: "decide",
    hypotheses: {
      env: "The environment fails",
      bug: "The implementation fails",
    },
  });
  assert.deepEqual(a.questions, b.questions);
  assert.deepEqual(a.groups, [["q1", "q2", "q3"]]);
  const q = a.questions.q1;
  assert.equal(q?.type, "choice");
  if (q?.type !== "choice") return;
  assert.deepEqual(Object.keys(q.criteria).slice(-2), ["other", "cannot_tell"]);
  const answers = {
    q1: choice({ bug: 0.7, env: 0.25, other: 0.03, cannot_tell: 0.02 }),
    q2: { type: "bool", p: 0.9 } as Answer,
    q3: { type: "bool", p: 0.9 } as Answer,
  };
  const reverse = reverseQuestions(a, answers).q1;
  assert.equal(reverse?.type, "choice");
  if (reverse?.type === "choice")
    assert.deepEqual(Object.keys(reverse.criteria), [
      ...Object.keys(q.criteria).slice(0, -2).reverse(),
      "other",
      "cannot_tell",
    ]);
  const [line] = readAsks(a, answers, {
    q1: choice({ bug: 0.5, env: 0.45, other: 0.03, cannot_tell: 0.02 }),
  });
  assert.equal(line?.value?.p, 0.6);
  assert.equal(line?.orderDependent, true);
});
test("files verify is a bool and locate is unavailable", () => {
  const result = plan(verify, "files");
  assert.equal(result.questions.q1?.type, "bool");
  assert.deepEqual(result.groups, [["q1"]]);
  assert.equal(
    compileAsks(
      {
        intent: "locate",
        target: "validates tokens",
        among: ["a"],
        count: "one",
      },
      { surface: "files" },
    ).ok,
    false,
  );
});
test("lints warn without rewriting and only claims/free receive negation warnings", () => {
  const result = plan([
    {
      intent: "verify",
      claims: {
        c1: "The file does not invoke exactly 3 calls after 2024-01-01",
      },
    },
    {
      intent: "decide",
      hypotheses: { a: "The file never connects", b: "The file connects" },
    },
  ]);
  assert.equal(result.warnings.length, 2);
  assert.match(result.warnings[0]?.fact ?? "", /negated/);
  assert.match(result.warnings[1]?.fact ?? "", /count or a date/);
});
for (const input of [
  [],
  { intent: "verify", claims: { c1: "Is it correct?" } },
  { intent: "rate", dimension: "risk", levels: ["low", "moderate"] },
  { intent: "unknown" },
  "bad json",
])
  test(`invalid intent ${JSON.stringify(input)}`, () =>
    assert.equal(compileAsks(input, { surface: "ask" }).ok, false));

test("every verify claim remains visible when issues or twin are unjudged", () => {
  const result = plan({
    intent: "verify",
    about: 'files["auth.ts"]',
    claims: {
      c1: "The file validates tokens",
      c2: "The file exports a function",
    },
  });
  assert.deepEqual(result.groups, [
    ["q1", "q2", "q3"],
    ["q4", "q5", "q6"],
  ]);
  const lines = readAsks(result, {
    q1: choice({
      holds: 0.98,
      contradicted: 0.01,
      not_addressed: 0.01,
      cannot_tell: 0,
    }),
    q2: { type: "unjudged", reason: "missing twin" },
    q3: { type: "bool", p: 0.98 },
    q4: { type: "unjudged", reason: "missing issues" },
    q5: choice({
      holds: 0.98,
      contradicted: 0.01,
      not_addressed: 0.01,
      cannot_tell: 0,
    }),
    q6: { type: "bool", p: 0.98 },
  });
  assert.equal(lines.length, 2);
  assert.ok(
    lines.every(
      (l) =>
        l.unjudged === true && l.band === undefined && l.value === undefined,
    ),
  );
  assert.match(lines[0]?.label ?? "", /The file validates tokens/);
  assert.match(lines[0]?.reason ?? "", /twin.*missing twin.*auth.ts/);
  assert.match(lines[1]?.reason ?? "", /issues.*missing issues/);
});
test("ordinary modal verbs and unqualified month words are not dates", () => {
  const result = plan({
    intent: "verify",
    claims: {
      a: "The function may throw",
      b: "Workers march through the queue",
    },
  });
  assert.deepEqual(result.warnings, []);
});
test("classify explains that other is reserved and supplied automatically", () => {
  const result = compileAsks(
    {
      intent: "classify",
      categories: { validation: "Validates arguments", other: "Anything else" },
    },
    { surface: "files" },
  );
  assert.equal(result.ok, false);
  if (!result.ok)
    assert.match(result.error, /categories\.other is reserved.*automatically/);
});

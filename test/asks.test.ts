import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compileAsks,
  readAsks,
  reverseQuestions,
  sameSubjectQuestions,
} from "../src/core/asks.ts";
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
  // The same-subject control is compiled but kept out of the first round:
  // it is judged only for contradicted verdicts.
  assert.match(
    result.questions.q4?.instructions ?? "",
    /same subject.*same entity, file, version, run and moment/,
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
test("files verify ports the ask issues structure with twin and controls", () => {
  const result = plan(verify, "files");
  assert.deepEqual(result.groups, [["q1", "q2", "q3"]]);
  const issues = result.questions.q1;
  const twin = result.questions.q2;
  assert.equal(issues?.type, "choice");
  assert.equal(twin?.type, "choice");
  if (issues?.type !== "choice" || twin?.type !== "choice") return;
  assert.deepEqual(Object.keys(issues.criteria), [
    "not_addressed",
    "holds",
    "contradicted",
    "cannot_tell",
  ]);
  assert.deepEqual(Object.keys(twin.criteria), [
    "not_addressed",
    "contradicted",
    "holds",
    "cannot_tell",
  ]);
  assert.doesNotMatch(
    issues.instructions,
    /If a document, file, requirement or output/,
  );
  assert.equal(result.questions.q3?.type, "bool");
  assert.equal(result.questions.q4?.type, "bool");
  assert.match(
    result.questions.q4?.instructions ?? "",
    /content.*same subject/,
  );
  const [line] = readAsks(result, {
    q1: choice({
      holds: 0.9,
      contradicted: 0.03,
      not_addressed: 0.05,
      cannot_tell: 0.02,
    }),
    q2: choice({
      holds: 0.9,
      contradicted: 0.03,
      not_addressed: 0.05,
      cannot_tell: 0.02,
    }),
    q3: { type: "bool", p: 0.9 } as Answer,
    q4: { type: "bool", p: 0.9 } as Answer,
  });
  assert.deepEqual(line?.value, { head: "holds", p: 0.9 });
  assert.equal(line?.band, "verdict");
  assert.deepEqual(
    reverseQuestions(result, {
      q1: choice({
        holds: 0.9,
        contradicted: 0.03,
        not_addressed: 0.05,
        cannot_tell: 0.02,
      }),
      q2: choice({
        holds: 0.9,
        contradicted: 0.03,
        not_addressed: 0.05,
        cannot_tell: 0.02,
      }),
      q3: { type: "bool", p: 0.9 } as Answer,
      q4: { type: "bool", p: 0.9 } as Answer,
    }),
    {},
  );
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
    ["q5", "q6", "q7"],
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
    q5: { type: "unjudged", reason: "missing issues" },
    q6: choice({
      holds: 0.98,
      contradicted: 0.01,
      not_addressed: 0.01,
      cannot_tell: 0,
    }),
    q7: { type: "bool", p: 0.98 },
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
test("contradicted verdicts demote on a low same-subject check, holds never does", () => {
  const result = plan(verify);
  const probs = (head: string): Record<string, number> => ({
    holds: 0,
    contradicted: 0,
    not_addressed: 0.05,
    cannot_tell: 0,
    [head]: 0.95,
  });
  const contradicted = (same: number) => ({
    q1: choice(probs("contradicted")),
    q2: choice(probs("contradicted")),
    q3: { type: "bool", p: 0.02 } as Answer,
    q4: { type: "bool", p: same } as Answer,
  });
  const [low] = readAsks(result, contradicted(0.2));
  assert.equal(low?.band, "unsure");
  assert.match(low?.reason ?? "", /different subject/);
  const [high] = readAsks(result, contradicted(0.9));
  assert.equal(high?.band, "verdict");
  assert.deepEqual(high?.value, { head: "contradicted", p: 0.95 });
  // A missing or unjudged control demotes the contradiction as unproven.
  const [missing] = readAsks(result, {
    q1: choice(probs("contradicted")),
    q2: choice(probs("contradicted")),
    q3: { type: "bool", p: 0.02 } as Answer,
  });
  assert.equal(missing?.band, "unsure");
  assert.match(missing?.reason ?? "", /same-subject control unjudged/);
  const [failed] = readAsks(result, {
    q1: choice(probs("contradicted")),
    q2: choice(probs("contradicted")),
    q3: { type: "bool", p: 0.02 } as Answer,
    q4: { type: "unjudged", reason: "max_calls=1 reached" } as Answer,
  });
  assert.equal(failed?.band, "unsure");
  assert.match(
    failed?.reason ?? "",
    /same-subject control unjudged: max_calls=1 reached/,
  );
  const [holds] = readAsks(result, {
    q1: choice(probs("holds")),
    q2: choice(probs("holds")),
    q3: { type: "bool", p: 0.98 },
  });
  assert.equal(holds?.band, "verdict");
  assert.deepEqual(holds?.value, { head: "holds", p: 0.95 });
  const [holdsLowSame] = readAsks(result, {
    q1: choice(probs("holds")),
    q2: choice(probs("holds")),
    q3: { type: "bool", p: 0.98 },
    q4: { type: "bool", p: 0.1 },
  });
  assert.equal(holdsLowSame?.band, "verdict");
  assert.deepEqual(holdsLowSame?.value, { head: "holds", p: 0.95 });
});
test("unsure scores split across non-adjacent levels name the split", () => {
  const result = plan({
    intent: "rate",
    dimension: "risk",
    levels: ["Isolated", "Shared", "Critical", "Catastrophic"],
  });
  const score = (probabilities: Record<string, number>): Answer => ({
    type: "score",
    score: 0,
    confidence: 0.5,
    legend: null,
    probabilities,
  });
  const [split] = readAsks(result, {
    q1: score({
      Isolated: 0.45,
      Shared: 0.05,
      Critical: 0.05,
      Catastrophic: 0.45,
    }),
  });
  assert.match(
    split?.reason ?? "",
    /split between non-adjacent levels 0 and 3/,
  );
  const [adjacent] = readAsks(result, {
    q1: score({
      Isolated: 0.45,
      Shared: 0.45,
      Critical: 0.05,
      Catastrophic: 0.05,
    }),
  });
  assert.equal(adjacent?.reason, undefined);
  const [clear] = readAsks(result, {
    q1: score({
      Isolated: 0.9,
      Shared: 0.05,
      Critical: 0,
      Catastrophic: 0.05,
    }),
  });
  assert.equal(clear?.reason, undefined);
});
test("order-invariant choices schedule no reverse re-ask", () => {
  const single = plan({
    intent: "classify",
    categories: { lone: "The only behavior" },
  });
  const low = {
    q1: choice({ lone: 0.6, other: 0.3, cannot_tell: 0.1 }),
  };
  assert.deepEqual(reverseQuestions(single, low), {});
  const two = plan({
    intent: "classify",
    categories: { a: "First behavior", b: "Second behavior" },
  });
  const uncertain = {
    q1: choice({ a: 0.6, b: 0.3, other: 0.05, cannot_tell: 0.05 }),
  };
  const reverse = reverseQuestions(two, uncertain);
  assert.equal(Object.keys(reverse).length, 1);
  const question = reverse.q1;
  assert.equal(question?.type, "choice");
  if (question?.type !== "choice") return;
  assert.deepEqual(Object.keys(question.criteria), [
    "b",
    "a",
    "other",
    "cannot_tell",
  ]);
  const decided = plan({
    intent: "decide",
    hypotheses: { lone: "The only hypothesis" },
  });
  assert.deepEqual(
    reverseQuestions(decided, {
      q1: choice({ lone: 0.6, other: 0.3, cannot_tell: 0.1 }),
      q2: { type: "bool", p: 0.6 } as Answer,
    }),
    {},
  );
});
test("same-subject round fires only for contradicted verdicts", () => {
  const result = plan(verify);
  const issues = (head: string, peak: number): Record<string, Answer> => {
    const rest = (1 - peak) / 3;
    return {
      q1: choice({
        holds: head === "holds" ? peak : rest,
        contradicted: head === "contradicted" ? peak : rest,
        not_addressed: head === "not_addressed" ? peak : rest,
        cannot_tell: rest,
      }),
      q2: choice({
        holds: head === "holds" ? peak : rest,
        contradicted: head === "contradicted" ? peak : rest,
        not_addressed: head === "not_addressed" ? peak : rest,
        cannot_tell: rest,
      }),
      q3: { type: "bool", p: head === "holds" ? 0.9 : 0.02 },
    };
  };
  const contradicted = sameSubjectQuestions(
    result,
    issues("contradicted", 0.9),
  );
  assert.deepEqual(Object.keys(contradicted), ["q4"]);
  assert.equal(contradicted.q4?.type, "bool");
  assert.deepEqual(sameSubjectQuestions(result, issues("holds", 0.9)), {});
  assert.deepEqual(
    sameSubjectQuestions(result, issues("not_addressed", 0.9)),
    {},
  );
  // Below the verdict band there is no verdict to defend.
  assert.deepEqual(
    sameSubjectQuestions(result, issues("contradicted", 0.5)),
    {},
  );
  // An exact-statement disagreement already demotes: no round fires.
  assert.deepEqual(
    sameSubjectQuestions(result, {
      q1: choice({
        holds: 0.02,
        contradicted: 0.9,
        not_addressed: 0.04,
        cannot_tell: 0.04,
      }),
      q2: choice({
        holds: 0.02,
        contradicted: 0.9,
        not_addressed: 0.04,
        cannot_tell: 0.04,
      }),
      q3: { type: "bool", p: 0.9 },
    }),
    {},
  );
});
test("unjudged exact control leaves no verdict even with a clear head", () => {
  const result = plan(verify);
  const [line] = readAsks(result, {
    q1: choice({
      holds: 0.95,
      contradicted: 0.02,
      not_addressed: 0.02,
      cannot_tell: 0.01,
    }),
    q2: choice({
      holds: 0.95,
      contradicted: 0.02,
      not_addressed: 0.02,
      cannot_tell: 0.01,
    }),
    q3: { type: "unjudged", reason: "budget refused" } as Answer,
  });
  assert.equal(line?.band, "unsure");
  assert.match(line?.reason ?? "", /exact bool unjudged: budget refused/);
});

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { compileAsks } from "../src/core/asks.ts";
import { Guide } from "../src/guide.ts";
import { detectHost } from "../src/host.ts";
import type { Answer, JevClient, Judgment, State } from "../src/jev/types.ts";
import { Session } from "../src/session.ts";
import { createAskTool } from "../src/tools/ask.ts";

function dependencies(client: JevClient | undefined) {
  const host = detectHost({});
  return {
    client,
    host,
    runtime: { session: new Session({}), guide: new Guide(host) },
    exec: async () => ({
      stdout: "",
      stderr: "not a repository",
      code: 128,
      killed: false,
    }),
  };
}

const args = {
  state: '{"request":"review"}',
  paths: ["a.ts"],
  asks: [
    {
      intent: "free" as const,
      question: {
        type: "bool" as const,
        instructions: "Does a.ts export a value?",
      },
    },
  ],
};
const judgment: Judgment = {
  ok: true,
  model: "openjev",
  usage: { inputTokens: 100, costUsd: 0.00006 },
  calls: 1,
  questions: 1,
  cacheHits: 0,
  cacheRequests: 1,
  answers: {
    q1: { type: "bool", source: "fresh", p: 0.98 },
    q2: {
      type: "choice",
      source: "fresh",
      choice: "yes",
      confidence: 0.3,
      probabilities: { yes: 0.92, no: 0.08 },
    },
    q3: {
      type: "score",
      source: "fresh",
      score: 1.8,
      confidence: 0.2,
      legend: ["low", "medium", "high"],
      probabilities: { low: 0.05, medium: 0.1, high: 0.85 },
    },
    q4: { type: "unjudged", reason: "missing answer" },
  },
};
test("injected client judges assembled files while content hides files and confidence", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "jev-ask-test-"));
  try {
    await writeFile(join(cwd, "a.ts"), "export const value = 1;\n");
    let captured: State | undefined;
    const client: JevClient = {
      clearCache() {},
      async judge(state, _questions, options) {
        options?.beforeRequest?.(1);
        if (judgment.usage) options?.onUsage?.(judgment.usage);
        captured = state;
        return judgment;
      },
    };
    const result = await createAskTool(dependencies(client)).execute(
      "1",
      {
        ...args,
        asks: JSON.stringify({
          intent: "free",
          question: args.asks[0]?.question,
        }),
      },
      undefined,
      undefined,
      { cwd },
    );
    assert.equal(captured?.request, "review");
    assert.deepEqual(captured?.files, { "a.ts": "export const value = 1;\n" });
    assert.ok(captured?.evidence);
    const text = result.content[0]?.text ?? "";
    assert.equal(result.details.result.items[0]?.treatment, "judged");
    assert.doesNotMatch(text, /export const value/);
    assert.equal(result.details.result.accounting.httpAttempts, 1);
    assert.equal(result.details.result.accounting.questionsSent, 1);
    assert.ok(result.details.ok);
    assert.deepEqual(result.details.answers, judgment.answers);
    assert.ok("usage" in result);
    assert.equal(result.usage?.cost.total, 0.00006);
  } finally {
    await rm(cwd, { recursive: true });
  }
});
test("internal URLs are refused before judgment", async () => {
  const client: JevClient = {
    clearCache() {},
    async judge() {
      throw Error("must not judge");
    },
  };
  const result = await createAskTool(dependencies(client)).execute(
    "1",
    { ...args, paths: ["agent://Main"] },
    undefined,
    undefined,
    { cwd: "." },
  );
  assert.equal(result.details.result.execution, "refused");
  assert.equal(result.details.result.accounting.httpAttempts, 0);
});

test("reverse choice reports an unsure order-dependent result and total usage", async () => {
  let calls = 0;
  const client: JevClient = {
    clearCache() {},
    async judge(_state, questions, options) {
      calls++;
      options?.beforeRequest?.(Object.keys(questions).length);
      return {
        ok: true,
        calls: 1,
        questions: 1,
        usage: { inputTokens: 20, costUsd: 0.001 },
        answers: {
          q1: {
            type: "choice",
            source: "fresh",
            choice: "a",
            confidence: 0.99,
            probabilities: {
              a: calls === 1 ? 0.7 : 0.5,
              b: calls === 1 ? 0.25 : 0.45,
              other: 0.03,
              cannot_tell: 0.02,
            },
          },
        },
      };
    },
  };
  const result = await createAskTool(dependencies(client)).execute(
    "1",
    {
      state: "two independent behaviors",
      asks: {
        intent: "classify",
        categories: { a: "Validates tokens", b: "Writes logs" },
      },
    },
    undefined,
    undefined,
    { cwd: "." },
  );
  assert.equal(calls, 2);
  const item = result.details.result.items[0];
  assert.equal(item?.treatment, "judged");
  if (item?.treatment === "judged") {
    assert.equal(item.judgment.band, "unsure");
    assert.equal(item.judgment.controls[0]?.kind, "order");
  }
  assert.equal(result.details.calls, 2);
  assert.equal(result.details.usage?.costUsd, 0.002);
});

test("verify missing twin remains visible alongside decide text", async () => {
  const asks = [
    {
      intent: "verify" as const,
      about: "state",
      claims: { c1: "The extension registers a tool" },
    },
    {
      intent: "decide" as const,
      about: "state",
      hypotheses: {
        register: "The module registers an extension tool",
        server: "The module starts an HTTP server",
      },
    },
  ];
  // Answer by compiled-plan role, not positional id, so future control
  // questions do not shift the decide answers.
  const compiled = compileAsks(asks, { surface: "ask" });
  assert.equal(compiled.ok, true);
  if (!compiled.ok) return;
  const answers: Record<string, Answer> = {};
  for (const reading of compiled.readings) {
    if (reading.kind === "verify") {
      answers[reading.id] = {
        type: "choice",
        source: "fresh",
        choice: "holds",
        confidence: 0.99,
        probabilities: {
          holds: 0.98,
          contradicted: 0.01,
          not_addressed: 0.01,
          cannot_tell: 0,
        },
      };
      if (reading.twin)
        answers[reading.twin] = {
          type: "unjudged",
          reason: "simulated missing twin",
        };
      for (const id of Object.values(reading.controls ?? {}))
        answers[id] = { type: "bool", source: "fresh", p: 0.98 };
      if (reading.sameSubject)
        answers[reading.sameSubject] = { type: "bool", source: "fresh", p: 0.98 };
    } else {
      answers[reading.id] = {
        type: "choice",
        source: "fresh",
        choice: "register",
        confidence: 0.99,
        probabilities: {
          register: 0.99,
          server: 0.005,
          other: 0.005,
          cannot_tell: 0,
        },
      };
      for (const [name, id] of Object.entries(reading.controls ?? {}))
        answers[id] = {
          type: "bool",
          source: "fresh",
          p: name === "register" ? 0.99 : 0.01,
        };
    }
  }
  const client: JevClient = {
    clearCache() {},
    async judge() {
      return {
        ok: true,
        calls: 1,
        questions: Object.keys(answers).length,
        answers,
      };
    },
  };
  const result = await createAskTool(dependencies(client)).execute(
    "1",
    {
      state: "An extension registers a tool",
      asks,
    },
    undefined,
    undefined,
    { cwd: "." },
  );
  assert.equal(result.details.result.items[0]?.treatment, "not_judged");
  assert.equal(result.details.result.items[1]?.treatment, "judged");
  assert.equal(result.details.result.execution, "partial");
});
test("invalid UTF-8 is excluded visibly without suppressing other file verdicts", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "jev-ask-utf8-"));
  try {
    await writeFile(join(cwd, "ok.txt"), "valid text");
    await writeFile(join(cwd, "latin.txt"), Buffer.from([0xe9]));
    let observed: State | undefined;
    const client: JevClient = {
      clearCache() {},
      async judge(state) {
        observed = state;
        return judgment;
      },
    };
    const result = await createAskTool(dependencies(client)).execute(
      "utf8",
      {
        paths: ["ok.txt", "latin.txt"],
        asks: {
          intent: "free",
          question: {
            type: "bool",
            instructions: "Does ok.txt contain valid text?",
          },
        },
      },
      undefined,
      undefined,
      { cwd },
    );
    const text = result.content[0]?.text ?? "";
    assert.match(text, /latin\.txt.*not UTF-8 text/);
    assert.equal(result.details.result.items[0]?.treatment, "judged");
    const admitted = result.details.result.items[0];
    if (admitted?.treatment === "judged")
      assert.equal(admitted.judgment.band, "verdict");
    assert.deepEqual(observed?.files, { "ok.txt": "valid text" });
    observed = undefined;
    const excluded = await createAskTool(dependencies(client)).execute(
      "excluded",
      {
        paths: ["latin.txt"],
        asks: {
          intent: "free",
          question: {
            type: "bool",
            instructions: "Does the evidence show valid text?",
          },
        },
      },
      undefined,
      undefined,
      { cwd },
    );
    assert.equal(observed, undefined);
    assert.match(
      excluded.content[0]?.text ?? "",
      /No readable evidence.*latin\.txt.*not UTF-8 text/,
    );
    assert.doesNotMatch(excluded.content[0]?.text ?? "", /= yes/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
test("single-category classify with a low peak issues one request and no reverse question", async () => {
  let calls = 0;
  const seen: string[][] = [];
  const client: JevClient = {
    clearCache() {},
    async judge(_state, questions, options) {
      calls++;
      seen.push(Object.keys(questions));
      options?.beforeRequest?.(Object.keys(questions).length);
      return {
        ok: true,
        calls: 1,
        questions: 1,
        answers: {
          q1: {
            type: "choice",
            source: "fresh",
            choice: "lone",
            confidence: 0.6,
            probabilities: { lone: 0.6, other: 0.3, cannot_tell: 0.1 },
          },
        },
      };
    },
  };
  const result = await createAskTool(dependencies(client)).execute(
    "1",
    {
      state: "one behavior",
      asks: {
        intent: "classify",
        categories: { lone: "The only behavior" },
      },
    },
    undefined,
    undefined,
    { cwd: "." },
  );
  // One substantive option cannot permute, so no twin re-ask is scheduled.
  assert.equal(calls, 1);
  assert.deepEqual(seen, [["q1"]]);
  assert.match(result.content[0]?.text ?? "", /unsure.*lone \(0\.6\)/);
});
test("verify contradiction triggers one same-subject round and holds triggers none", async () => {
  const rounds: { ids: string[]; instructions: string[] }[] = [];
  const client: JevClient = {
    clearCache() {},
    async judge(_state, questions, options) {
      options?.beforeRequest?.(Object.keys(questions).length);
      rounds.push({
        ids: Object.keys(questions),
        instructions: Object.values(questions).map(
          (question) => question.instructions,
        ),
      });
      const isControlRound = Object.values(questions).some((question) =>
        question.instructions.includes("same subject"),
      );
      if (isControlRound)
        return {
          ok: true,
          calls: 1,
          questions: 1,
          answers: Object.fromEntries(
            Object.keys(questions).map((id) => [id, { type: "bool", source: "fresh", p: 0.1 }]),
          ),
        };
      return {
        ok: true,
        calls: 1,
        questions: 3,
        answers: {
          q1: {
            type: "choice",
            source: "fresh",
            choice: "contradicted",
            confidence: 0.95,
            probabilities: {
              holds: 0.02,
              contradicted: 0.93,
              not_addressed: 0.03,
              cannot_tell: 0.02,
            },
          },
          q2: {
            type: "choice",
            source: "fresh",
            choice: "contradicted",
            confidence: 0.95,
            probabilities: {
              holds: 0.02,
              contradicted: 0.93,
              not_addressed: 0.03,
              cannot_tell: 0.02,
            },
          },
          q3: { type: "bool", source: "fresh", p: 0.02 },
        },
      };
    },
  };
  const result = await createAskTool(dependencies(client)).execute(
    "1",
    {
      state: "the file contradicts the claim",
      asks: {
        intent: "verify",
        claims: { c1: "The file validates tokens" },
      },
    },
    undefined,
    undefined,
    { cwd: "." },
  );
  // First round carries issues, twin and exact bool only; the second round
  // carries the same-subject control alone.
  assert.deepEqual(
    rounds.map((round) => round.ids),
    [["q1", "q2", "q3"], ["q4"]],
  );
  assert.ok(
    rounds[1]?.instructions.some((text) => text.includes("same subject")),
  );
  const text = result.content[0]?.text ?? "";
  assert.match(text, /unsure.*contradicted/);
  assert.match(text, /same-subject/);
});
test("verify holds verdict issues no same-subject round", async () => {
  let calls = 0;
  const client: JevClient = {
    clearCache() {},
    async judge(_state, questions, options) {
      calls++;
      options?.beforeRequest?.(Object.keys(questions).length);
      for (const question of Object.values(questions))
        assert.doesNotMatch(question.instructions, /same subject/);
      return {
        ok: true,
        calls: 1,
        questions: 3,
        answers: {
          q1: {
            type: "choice",
            source: "fresh",
            choice: "holds",
            confidence: 0.95,
            probabilities: {
              holds: 0.93,
              contradicted: 0.02,
              not_addressed: 0.03,
              cannot_tell: 0.02,
            },
          },
          q2: {
            type: "choice",
            source: "fresh",
            choice: "holds",
            confidence: 0.95,
            probabilities: {
              holds: 0.93,
              contradicted: 0.02,
              not_addressed: 0.03,
              cannot_tell: 0.02,
            },
          },
          q3: { type: "bool", source: "fresh", p: 0.95 },
        },
      };
    },
  };
  const result = await createAskTool(dependencies(client)).execute(
    "1",
    {
      state: "the file validates tokens",
      asks: {
        intent: "verify",
        claims: { c1: "The file validates tokens" },
      },
    },
    undefined,
    undefined,
    { cwd: "." },
  );
  assert.equal(calls, 1);
  assert.match(result.content[0]?.text ?? "", /= holds \(0\.93\)/);
});

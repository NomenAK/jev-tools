import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { test } from "node:test";
import { createJevClient } from "../src/jev/client.ts";
import type { Answer, Question } from "../src/jev/types.ts";

const apiKey = "test-secret-key";
const state = { text: "hello" };
const usage = { input_tokens: 80, output_tokens: 1, cost: 0.00003 };
const normalizedUsage = { inputTokens: 80, costUsd: 0.00003 };
const model = "served-model";

type CapturedRequest = {
  method: string | undefined;
  headers: IncomingHttpHeaders;
  body: string;
};

async function judgeResponse(
  questions: Record<string, Question>,
  response: unknown,
  status = 200,
) {
  const requests: CapturedRequest[] = [];
  const client = createJevClient(
    { url: "http://simulated", apiKey, model: "requested-model" },
    {
      fetch: async (_url, options) => {
        requests.push({
          method: options?.method,
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
          },
          body: options?.body as string,
        });
        return Response.json(response, { status });
      },
      now: () => 0,
      sleep: (_ms, signal) => {
        const pending = Promise.withResolvers<void>();
        signal?.addEventListener("abort", () => pending.reject(signal.reason), {
          once: true,
        });
        return pending.promise;
      },
    },
  );
  return { judgment: await client.judge(state, questions), requests };
}

const choiceQuestion: Question = {
  type: "choice",
  instructions: "Which greeting?",
  criteria: { hello: "Hello", goodbye: "Goodbye" },
};
const scoreQuestion: Question = {
  type: "score",
  instructions: "Rate the greeting",
  criteria: ["Absent", "Partial", "Complete"],
};

const nominalCases: {
  name: string;
  question: Question;
  wireQuestion: unknown;
  answer: unknown;
  normalized: Answer;
}[] = [
  {
    name: "bool translates to noul with default criteria",
    question: { type: "bool", instructions: "Is this a greeting?" },
    wireQuestion: {
      type: "noul",
      instructions: "Is this a greeting?",
      criteria: { true: "Yes", false: "No" },
    },
    answer: { noul: 0.96 },
    normalized: { type: "bool", p: 0.96 },
  },
  {
    name: "bool preserves custom criteria on the wire",
    question: {
      type: "bool",
      instructions: "Is this a greeting?",
      criteria: { true: "Greeting present", false: "Greeting absent" },
    },
    wireQuestion: {
      type: "noul",
      instructions: "Is this a greeting?",
      criteria: { true: "Greeting present", false: "Greeting absent" },
    },
    answer: { noul: 0 },
    normalized: { type: "bool", p: 0 },
  },
  {
    name: "bool fills only missing criteria",
    question: {
      type: "bool",
      instructions: "Is this a greeting?",
      criteria: { false: "Greeting absent" },
    },
    wireQuestion: {
      type: "noul",
      instructions: "Is this a greeting?",
      criteria: { true: "Yes", false: "Greeting absent" },
    },
    answer: { noul: 1 },
    normalized: { type: "bool", p: 1 },
  },
  {
    name: "choice normalizes its selected criterion and probabilities",
    question: choiceQuestion,
    wireQuestion: {
      type: "choice",
      instructions: "Which greeting?",
      criteria: { hello: "Hello", goodbye: "Goodbye" },
    },
    answer: {
      choice: "hello",
      confidence: 0.9,
      probabilities: { hello: 0.9, goodbye: 0.1 },
    },
    normalized: {
      type: "choice",
      choice: "hello",
      confidence: 0.9,
      probabilities: { hello: 0.9, goodbye: 0.1 },
    },
  },
  ...[0, 1.5, 2].map((score) => ({
    name: `score ${score} normalizes within the inclusive criteria bounds`,
    question: scoreQuestion,
    wireQuestion: {
      type: "score",
      instructions: "Rate the greeting",
      criteria: ["Absent", "Partial", "Complete"],
    },
    answer: {
      score,
      confidence: 0.8,
      legend: { 0: "Absent", 1: "Partial", 2: "Complete" },
      probabilities: { 0: 0.1, 1: 0.2, 2: 0.7 },
    },
    normalized: {
      type: "score" as const,
      score,
      confidence: 0.8,
      legend: { 0: "Absent", 1: "Partial", 2: "Complete" },
      probabilities: { 0: 0.1, 1: 0.2, 2: 0.7 },
    },
  })),
];

for (const scenario of nominalCases) {
  test(scenario.name, async () => {
    const { judgment, requests } = await judgeResponse(
      { q1: scenario.question },
      { model, answers: { q1: scenario.answer }, usage },
    );
    assert.equal(judgment.ok, true);
    if (!judgment.ok) return;
    assert.equal(judgment.model, model);
    assert.deepEqual(judgment.answers, {
      q1: { ...scenario.normalized, source: "fresh" },
    });
    assert.deepEqual(judgment.usage, normalizedUsage);
    assert.equal(requests.length, 1);
    const request = requests[0];
    assert.ok(request);
    assert.equal(request.method, "POST");
    assert.equal(request.headers.authorization, `Bearer ${apiKey}`);
    assert.equal(request.headers["content-type"], "application/json");
    assert.deepEqual(JSON.parse(request.body), {
      model: "requested-model",
      state: { text: "hello" },
      questions: { q1: scenario.wireQuestion },
    });
  });
}

for (const status of [401, 403]) {
  test(`HTTP ${status} masks an echoed key and advises checking its environment variable`, async () => {
    const { judgment } = await judgeResponse(
      { q1: { type: "bool", instructions: "Is this a greeting?" } },
      { error: `Denied ${apiKey}; echoed again: ${apiKey}` },
      status,
    );
    assert.equal(judgment.ok, false);
    assert.match(judgment.error, new RegExp(`HTTP ${status}`));
    assert.equal(judgment.error.includes(apiKey), false);
    assert.match(judgment.error, /\[redacted\]/);
    assert.match(judgment.error, /JEV_TOOLS_API_KEY/);
  });
}

const invalidCases = [
  {
    name: "choice outside criteria",
    question: choiceQuestion,
    answer: {
      choice: "unknown",
      confidence: 0.9,
      probabilities: { hello: 0.9, goodbye: 0.1 },
    },
  },
  ...[-0.1, 2.1].map((score) => ({
    name: `score ${score} outside criteria bounds`,
    question: scoreQuestion,
    answer: {
      score,
      confidence: 0.8,
      legend: { 0: "Absent", 1: "Partial", 2: "Complete" },
      probabilities: { 0: 0.1, 1: 0.2, 2: 0.7 },
    },
  })),
];

for (const scenario of invalidCases) {
  test(`${scenario.name} is unjudged without discarding a valid sibling or metadata`, async () => {
    const { judgment } = await judgeResponse(
      {
        invalid: scenario.question,
        valid: { type: "bool", instructions: "Is this a greeting?" },
      },
      {
        model,
        answers: { invalid: scenario.answer, valid: { noul: 0.96 } },
        usage,
      },
    );
    assert.equal(judgment.ok, true);
    assert.equal(judgment.model, model);
    assert.deepEqual(judgment.usage, normalizedUsage);
    assert.deepEqual(judgment.answers.valid, {
      type: "bool",
      p: 0.96,
      source: "fresh",
    });
    assert.deepEqual(Object.keys(judgment.answers).sort(), [
      "invalid",
      "valid",
    ]);
    assert.ok(judgment.answers.invalid);
    assert.equal(judgment.answers.invalid.type, "unjudged");
  });
}

test("absent usage preserves normalized answers and the served model", async () => {
  const { judgment } = await judgeResponse(
    { q1: { type: "bool", instructions: "Is this a greeting?" } },
    { model, answers: { q1: { noul: 0.96 } } },
  );
  assert.equal(judgment.ok, true);
  assert.deepEqual(judgment.answers, {
    q1: { type: "bool", p: 0.96, source: "fresh" },
  });
  assert.equal(judgment.model, model);
  assert.equal(judgment.usage, undefined);
});

test("nominal request crosses a real HTTP endpoint", async () => {
  let captured = "";
  const server = createServer(async (req, res) => {
    for await (const chunk of req) captured += chunk;
    res.end(JSON.stringify({ answers: { q1: { noul: 0.96 } } }));
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const client = createJevClient({
      url: `http://127.0.0.1:${address.port}`,
      apiKey,
      model: "openjev",
    });
    const result = await client.judge(state, {
      q1: { type: "bool", instructions: "Greeting?" },
    });
    assert.equal(result.ok, true);
    if (result.ok)
      assert.deepEqual(result.answers.q1, {
        type: "bool",
        p: 0.96,
        source: "fresh",
      });
    assert.deepEqual(JSON.parse(captured).state, state);
  } finally {
    const closed = Promise.withResolvers<void>();
    server.close(() => closed.resolve());
    await closed.promise;
  }
});

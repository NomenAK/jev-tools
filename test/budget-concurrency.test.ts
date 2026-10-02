import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createJevClient } from "../src/jev/client.ts";
import type { Question } from "../src/jev/types.ts";
import { Session } from "../src/session.ts";

// Each question is large enough to force its own request batch, so the client
// fans the batches out concurrently through its pool.
const big = "x".repeat(120_000);
const questions: Record<string, Question> = Object.fromEntries(
  ["a", "b", "c", "d", "e", "f"].map((id) => [
    id,
    { type: "bool", instructions: `${id} ${big}` },
  ]),
);

function client(onRequest: () => void) {
  return createJevClient(
    { url: "http://simulated", apiKey: "secret", model: "test" },
    {
      fetch: async (_url, options) => {
        onRequest();
        await delay(20);
        const body = JSON.parse(options?.body as string) as {
          questions: Record<string, unknown>;
        };
        return Response.json({
          answers: Object.fromEntries(
            Object.keys(body.questions).map((id) => [id, { noul: 0.9 }]),
          ),
          usage: { input_tokens: 10, cost: 0.01 },
        });
      },
    },
  );
}

test("JEV_TOOLS_MAX_USD is not overshot by concurrently admitted batches", async () => {
  const session = new Session({ maxUsd: 0.015 });
  let requests = 0;
  const result = await client(() => requests++).judge({}, questions, {
    ...session.requestGate(),
    beforeRequest: (count) => session.admit(count),
    onUsage: (usage) => session.recordUsage(usage),
  });
  // $0.00 and $0.01 spent are both below the $0.015 limit; $0.02 is not.
  assert.equal(requests, 2);
  assert.equal(session.snapshot().calls, 2);
  assert.equal(session.snapshot().costUsd, 0.02);
  assert.equal(result.ok, true);
  const unjudged = Object.values(result.ok ? result.answers : {}).filter(
    (answer) => answer.type === "unjudged",
  );
  assert.equal(unjudged.length, 4);
});

test("without a USD limit batches still run concurrently", async () => {
  const session = new Session({});
  let active = 0;
  let peak = 0;
  const judged = await createJevClient(
    { url: "http://simulated", apiKey: "secret", model: "test" },
    {
      fetch: async (_url, options) => {
        active++;
        peak = Math.max(peak, active);
        await delay(20);
        active--;
        const body = JSON.parse(options?.body as string) as {
          questions: Record<string, unknown>;
        };
        return Response.json({
          answers: Object.fromEntries(
            Object.keys(body.questions).map((id) => [id, { noul: 0.9 }]),
          ),
        });
      },
    },
  ).judge({}, questions, {
    ...session.requestGate(),
    beforeRequest: (count) => session.admit(count),
  });
  assert.equal(judged.ok, true);
  assert.ok(peak > 1, `expected concurrent requests, peak was ${peak}`);
});

test("a request without reported cost still releases the USD gate", async () => {
  const session = new Session({ maxUsd: 1 });
  let requests = 0;
  const judged = await createJevClient(
    { url: "http://simulated", apiKey: "secret", model: "test" },
    {
      fetch: async (_url, options) => {
        requests++;
        const body = JSON.parse(options?.body as string) as {
          questions: Record<string, unknown>;
        };
        return Response.json({
          answers: Object.fromEntries(
            Object.keys(body.questions).map((id) => [id, { noul: 0.9 }]),
          ),
        });
      },
    },
  ).judge({}, questions, {
    ...session.requestGate(),
    beforeRequest: (count) => session.admit(count),
  });
  assert.equal(judged.ok, true);
  assert.equal(requests, 6);
});

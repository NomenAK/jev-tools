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

// Instrumented endpoint: counts requests and the peak number in flight, and
// answers each after `ms` with the given reported cost (or none).
function instrumented(options: {
  ms?: number;
  cost?: number;
  status?: (count: number) => number;
  fail?: (count: number) => boolean;
}) {
  const stats = { requests: 0, active: 0, peak: 0 };
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    stats.requests++;
    const count = stats.requests;
    stats.active++;
    stats.peak = Math.max(stats.peak, stats.active);
    try {
      await delay(options.ms ?? 20);
      if (options.fail?.(count)) throw new Error("connection reset");
      const status = options.status?.(count) ?? 200;
      if (status !== 200) return new Response("busy", { status });
      const body = JSON.parse(init?.body as string) as {
        questions: Record<string, unknown>;
      };
      return Response.json({
        answers: Object.fromEntries(
          Object.keys(body.questions).map((id) => [id, { noul: 0.9 }]),
        ),
        ...(options.cost === undefined
          ? {}
          : { usage: { input_tokens: 10, cost: options.cost } }),
      });
    } finally {
      stats.active--;
    }
  };
  // Real timeouts, but retry back-off is skipped so retries stay fast.
  const sleep = (ms: number, signal?: AbortSignal) =>
    ms === 10_000
      ? new Promise<void>((_resolve, reject) =>
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          }),
        )
      : Promise.resolve();
  return {
    stats,
    client: createJevClient(
      { url: "http://simulated", apiKey: "secret", model: "test" },
      { fetch, sleep, timeoutMs: 10_000 },
    ),
  };
}
const sessionOptions = (session: Session) => ({
  ...session.requestGate(),
  beforeRequest: (count: number) => session.admit(count),
  onUsage: (usage: { costUsd: number }) => session.recordUsage(usage),
});
// A hang is a gate leak; fail fast with a clear message instead.
const within = <T>(promise: Promise<T>, label: string, ms = 5_000) =>
  Promise.race([
    promise,
    delay(ms).then(() => {
      throw new Error(`${label}: still pending after ${ms} ms (gate leaked)`);
    }),
  ]);

test("a USD cap below one request's cost admits exactly one request", async () => {
  // Reviewer's reproduction: cap 0.005, each request reports 0.01. Strict
  // one-at-a-time admission allows the first request only.
  const session = new Session({ maxUsd: 0.005 });
  const { stats, client: jev } = instrumented({ ms: 30, cost: 0.01 });
  const result = await jev.judge({}, questions, sessionOptions(session));
  assert.equal(stats.requests, 1);
  assert.equal(stats.peak, 1);
  assert.equal(session.snapshot().calls, 1);
  assert.equal(session.snapshot().costUsd, 0.01);
  assert.equal(result.ok, true);
});

test("under a USD limit at most one request is ever in flight", async () => {
  const session = new Session({ maxUsd: 1 });
  const { stats, client: jev } = instrumented({ ms: 15, cost: 0.01 });
  const result = await jev.judge({}, questions, sessionOptions(session));
  assert.equal(result.ok, true);
  assert.equal(stats.requests, 6);
  assert.equal(stats.peak, 1);
});

test("the USD gate is shared by concurrent tool calls in one session", async () => {
  // Two tools (or two MCP calls) running at once share the session budget.
  const session = new Session({ maxUsd: 0.005 });
  const { stats, client: jev } = instrumented({ ms: 30, cost: 0.01 });
  await Promise.all([
    jev.judge({ tool: "first" }, questions, sessionOptions(session)),
    jev.judge({ tool: "second" }, questions, sessionOptions(session)),
  ]);
  assert.equal(stats.requests, 1);
  assert.equal(stats.peak, 1);
});

test("refused admission releases the USD gate", async () => {
  // JEV_TOOLS_MAX_CALLS refuses the second batch while the USD gate is held.
  const session = new Session({ maxUsd: 1, maxCalls: 1 });
  const { stats, client: jev } = instrumented({ cost: 0.01 });
  await within(jev.judge({}, questions, sessionOptions(session)), "first");
  assert.equal(stats.requests, 1);
  // A tool-level refusal (max_calls in the tool) must release it as well.
  const other = new Session({ maxUsd: 1 });
  let allowed = 1;
  await within(
    jev.judge({}, questions, {
      ...other.requestGate(),
      beforeRequest: (count) =>
        allowed-- > 0
          ? other.admit(count)
          : { ok: false, error: "max_calls=1 reached" },
    }),
    "tool refusal",
  );
  await within(
    jev.judge({ again: true }, questions, sessionOptions(other)),
    "after refusal",
  );
});

test("failed and retried requests release the USD gate", async () => {
  const session = new Session({ maxUsd: 1 });
  // First attempt of the first request fails at the network, then HTTP 503.
  const { stats, client: jev } = instrumented({
    cost: 0.01,
    fail: (count) => count === 1,
    status: (count) => (count === 2 ? 503 : 200),
  });
  const result = await within(
    jev.judge({}, questions, sessionOptions(session)),
    "retries",
  );
  assert.equal(result.ok, true);
  assert.equal(stats.peak, 1);
  assert.equal(stats.requests, 8);
});

test("aborting while waiting for the USD gate does not leak it", async () => {
  const session = new Session({ maxUsd: 1 });
  const { client: jev } = instrumented({ ms: 100, cost: 0.01 });
  const controller = new AbortController();
  const running = jev.judge({}, questions, {
    ...sessionOptions(session),
    signal: controller.signal,
  });
  await delay(20);
  controller.abort(new Error("cancelled"));
  await within(running, "aborted judge");
  // The session must still admit later work.
  const later = await within(
    jev.judge(
      { later: true },
      { only: questions.a as Question },
      sessionOptions(session),
    ),
    "later judge",
  );
  assert.equal(later.ok, true);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { createJevClient } from "../src/jev/client.ts";
import { type Clock, createPool } from "../src/jev/pool.ts";
import type { Question, State } from "../src/jev/types.ts";

type Request = { state: State; questions: Record<string, Question> };
const q: Question = { type: "bool", instructions: "Present?" };
function harness(
  run: (
    body: Request,
    count: number,
    signal: AbortSignal,
  ) => Response | Promise<Response>,
  timeout = false,
) {
  let now = 0;
  const waits: number[] = [];
  const requests: Request[] = [];
  const clock: Clock = {
    now: () => now,
    sleep(ms, signal) {
      waits.push(ms);
      if (ms === 10_000 && !timeout) {
        const pending = Promise.withResolvers<void>();
        signal?.addEventListener("abort", () => pending.reject(signal.reason), {
          once: true,
        });
        return pending.promise;
      }
      now += ms;
      return Promise.resolve();
    },
  };
  const fetcher: typeof fetch = async (_url, options) => {
    const body = JSON.parse(options?.body as string) as Request;
    requests.push(body);
    return run(body, requests.length, options?.signal as AbortSignal);
  };
  const config = { url: "http://simulated", apiKey: "secret", model: "test" };
  const dependencies = { ...clock, fetch: fetcher, timeoutMs: 10_000 };
  return {
    requests,
    waits,
    clock,
    config,
    dependencies,
    client: createJevClient(config, dependencies),
  };
}
function success(body: Request) {
  return Response.json({
    answers: Object.fromEntries(
      Object.keys(body.questions).map((id) => [id, { noul: 0.9 }]),
    ),
    usage: { input_tokens: 10, cost: 0.01 },
  });
}
for (const status of [408, 429, 500, 503])
  test(`HTTP ${status} retries with exact backoff`, async () => {
    const e = harness((body, count) =>
      count < 3 ? new Response("busy", { status }) : success(body),
    );
    const result = await e.client.judge({}, { q });
    assert.equal(result.ok, true);
    assert.equal(result.calls, 3);
    assert.deepEqual(e.waits, [10_000, 500, 10_000, 1_000, 10_000]);
  });
test("Retry-After is respected and retries are bounded", async () => {
  const e = harness(
    () =>
      new Response("limited", { status: 429, headers: { "Retry-After": "2" } }),
  );
  const result = await e.client.judge({}, { q });
  assert.equal(result.ok, false);
  assert.equal(result.calls, 3);
  assert.deepEqual(e.waits, [10_000, 2_000, 10_000, 2_000, 10_000]);
});
test("long Retry-After returns unjudged immediately without retrying", async () => {
  const e = harness(
    () =>
      new Response("limited", {
        status: 429,
        headers: { "Retry-After": "3600" },
      }),
  );
  const result = await e.client.judge({}, { q });
  assert.equal(result.calls, 1);
  assert.equal(result.ok, false);
  if (!result.ok)
    assert.match(result.error, /Jev HTTP 429, retry after 3600 s/);
  assert.deepEqual(e.waits, [10_000]);
});
test("proxy HTML errors stay short and redact credentials before truncation", async () => {
  const e = harness(
    () => new Response(`secret${"x".repeat(20_000)}`, { status: 502 }),
  );
  const result = await e.client.judge({}, { q });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.error.length < 400);
    assert.ok(!result.error.includes("secret"));
    assert.match(result.error, /redacted/);
  }
});
test("JSON errors retain the message without unrelated response fields", async () => {
  const e = harness(() =>
    Response.json(
      {
        error: { message: "secret denied", code: "invalid" },
        debug: "unrelated state",
      },
      { status: 422 },
    ),
  );
  const result = await e.client.judge({}, { q });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /\[redacted\] denied/);
    assert.ok(!result.error.includes("unrelated state"));
  }
});
for (const status of [400, 401, 403, 422])
  test(`HTTP ${status} is immediate and not cached`, async () => {
    const e = harness(() => new Response("secret denied", { status }));
    for (let i = 0; i < 2; i++) {
      const result = await e.client.judge({}, { q });
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.ok(!result.error.includes("secret"));
        if (status === 401 || status === 403)
          assert.match(result.error, /JEV_TOOLS_API_KEY/);
      }
    }
    assert.equal(e.requests.length, 2);
  });
test("timeout uses the injected clock for exactly three attempts", async () => {
  const e = harness((_body, _count, signal) => {
    const pending = Promise.withResolvers<Response>();
    signal.addEventListener("abort", () => pending.reject(signal.reason), {
      once: true,
    });
    return pending.promise;
  }, true);
  const result = await e.client.judge({}, { q });
  assert.equal(result.ok, false);
  assert.equal(result.calls, 3);
  assert.deepEqual(e.waits, [10_000, 500, 10_000, 1_000, 10_000]);
});
test("caller cancellation never retries", async () => {
  const e = harness(success);
  const controller = new AbortController();
  controller.abort();
  const result = await e.client.judge({}, { q }, { signal: controller.signal });
  assert.equal(result.ok, false);
  assert.equal(e.requests.length, 0);
});
test("admission follows received usage before retry", async () => {
  let spend = 0;
  const e = harness(() =>
    Response.json({ usage: { input_tokens: 12, cost: 0.02 } }, { status: 503 }),
  );
  const result = await e.client.judge(
    {},
    { q },
    {
      beforeRequest: () =>
        spend ? { ok: false, error: "cap reached" } : { ok: true },
      onUsage: (usage) => {
        spend += usage.costUsd;
      },
    },
  );
  assert.equal(result.ok, true);
  if (result.ok)
    assert.deepEqual(result.answers.q, {
      type: "unjudged",
      reason: "cap reached",
    });
  assert.equal(result.calls, 1);
  assert.deepEqual(result.usage, { inputTokens: 12, costUsd: 0.02 });
});
test("cache canonises objects, isolates models, supports bypass and session reset", async () => {
  const e = harness(success);
  await e.client.judge({ a: 1, b: 2 }, { q });
  const hit = await e.client.judge({ b: 2, a: 1 }, { renamed: q });
  assert.equal(hit.calls, 0);
  assert.equal(hit.cacheHits, 1);
  await e.client.judge({ a: 1, b: 2 }, { q }, { cache: false });
  e.client.clearCache();
  await e.client.judge({ a: 1, b: 2 }, { q });
  const other = createJevClient(
    { ...e.config, model: "other" },
    e.dependencies,
  );
  await other.judge({ a: 1, b: 2 }, { q });
  assert.equal(e.requests.length, 4);
});
test("invalid answers are never cached; result mutation cannot alter the cache", async () => {
  const e = harness((body, count) =>
    count === 1 ? Response.json({ answers: {} }) : success(body),
  );
  await e.client.judge({}, { q });
  const next = await e.client.judge({}, { q });
  if (next.ok && next.answers.q?.type === "bool") next.answers.q.p = 0;
  const hit = await e.client.judge({}, { q });
  if (hit.ok) assert.deepEqual(hit.answers.q, { type: "bool", p: 0.9 });
  assert.equal(e.requests.length, 2);
});
test("responses in flight at session reset cannot populate the next cache", async () => {
  const ready = Promise.withResolvers<void>(),
    resume = Promise.withResolvers<void>();
  const e = harness(async (body, count) => {
    if (count === 1) {
      ready.resolve();
      await resume.promise;
    }
    return success(body);
  });
  const first = e.client.judge({}, { q });
  await ready.promise;
  e.client.clearCache();
  resume.resolve();
  await first;
  const second = await e.client.judge({}, { q });
  assert.equal(second.calls, 1);
});
test("cached groups preserve their own divergent witness", async () => {
  const e = harness((body) => {
    const ids = Object.keys(body.questions);
    if (ids.includes("a") && ids.includes("b"))
      return new Response("max_tokens_exceeded", { status: 400 });
    return Response.json({
      answers: Object.fromEntries(
        ids.map((id) => [
          id,
          { noul: id === "w" && ids.includes("a") ? 0.4 : 0.1 },
        ]),
      ),
    });
  });
  const questions = { a: q, b: { ...q, instructions: "Other?" }, w: q };
  await e.client.judge({}, questions, { witnesses: ["w"] });
  const hit = await e.client.judge({}, questions, { witnesses: ["w"] });
  assert.equal(hit.calls, 0);
  assert.deepEqual(
    hit.batches?.find((b) => b.questionIds.includes("a"))?.answers.w,
    { type: "bool", p: 0.4 },
  );
  assert.deepEqual(
    hit.batches?.find((b) => b.questionIds.includes("b"))?.answers.w,
    { type: "bool", p: 0.1 },
  );
});
test("invalid group IDs return errors without sending", async () => {
  const e = harness(success);
  for (const options of [
    { groups: [["absent"]] },
    { groups: [["q"], ["q"]] },
    { witnesses: ["absent"] },
    { groups: [["q"]], witnesses: ["q"] },
  ])
    assert.equal((await e.client.judge({}, { q }, options)).ok, false);
  assert.equal(e.requests.length, 0);
});
test("state-only refusal stops all pending groups after one diagnostic question", async () => {
  for (const grouped of [false, true]) {
    const e = harness(
      () => new Response("max_tokens_exceeded", { status: 400 }),
    );
    const questions: Record<string, Question> = Object.fromEntries(
      Array.from({ length: 56 }, (_, i) => [
        `q${i}`,
        { ...q, instructions: `Question ${i}` },
      ]),
    );
    const result = await e.client.judge(
      { text: "x".repeat(76_758) },
      questions,
      {
        ...(grouped
          ? {
              groups: [
                Object.keys(questions).slice(0, 28),
                Object.keys(questions).slice(28),
              ],
            }
          : {}),
      },
    );
    assert.equal(result.ok, true);
    assert.ok((result.calls ?? 0) <= 2);
    if (!result.ok) continue;
    assert.deepEqual(
      Object.keys(result.answers).sort(),
      Object.keys(questions).sort(),
    );
    for (const answer of Object.values(result.answers)) {
      assert.equal(answer.type, "unjudged");
      if (answer.type === "unjudged")
        assert.match(answer.reason, /state.*single question/i);
    }
  }
});

test("refused singleton is not resent as an identical diagnostic", async () => {
  const e = harness(() => new Response("max_tokens_exceeded", { status: 400 }));
  const result = await e.client.judge({}, { q });
  assert.equal(result.calls, 1);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.answers.q?.type, "unjudged");
});

test("denied diagnostic admission preserves the original indivisible batch", async () => {
  const e = harness(() => new Response("max_tokens_exceeded", { status: 400 }));
  let sent = 0;
  const result = await e.client.judge(
    {},
    { a: q, b: q, w: q },
    {
      groups: [["a", "b"]],
      witnesses: ["w"],
      beforeRequest: () =>
        sent++ === 0
          ? { ok: true }
          : { ok: false, error: "max_calls=1 reached" },
    },
  );
  assert.equal(result.calls, 1);
  assert.equal(result.ok, true);
  assert.equal(result.batches?.length, 1);
  assert.deepEqual(result.batches?.[0]?.questionIds, ["a", "b", "w"]);
  if (result.ok)
    for (const answer of Object.values(result.answers)) {
      assert.equal(answer.type, "unjudged");
      if (answer.type === "unjudged")
        assert.match(answer.reason, /indivisible/);
    }
});

test("planned batches start concurrently without waiting for the first response", async () => {
  const barrier = Promise.withResolvers<void>();
  const starts: number[] = [];
  const e = harness(async (body) => {
    starts.push(performance.now());
    if (starts.length === 2) barrier.resolve();
    await barrier.promise;
    return success(body);
  });
  const result = await e.client.judge(
    {},
    {
      a: { ...q, instructions: "x".repeat(120_000) },
      b: { ...q, instructions: "y".repeat(120_000) },
    },
  );
  assert.equal(result.calls, 2);
  assert.equal(result.ok, true);
  assert.equal(starts.length, 2);
});

test("monotone question-size refusal probes once and preserves accepted siblings", async () => {
  for (const threshold of [20, 80, 150]) {
    const e = harness((body) =>
      Object.values(body.questions).reduce(
        (size, question) => size + question.instructions.length,
        0,
      ) > threshold
        ? new Response("max_tokens_exceeded", { status: 400 })
        : success(body),
    );
    const questions = {
      large: { ...q, instructions: "x".repeat(200) },
      small: { ...q, instructions: "x".repeat(10) },
      medium: { ...q, instructions: "x".repeat(100) },
    };
    const result = await e.client.judge({ proof: "same" }, questions);
    assert.equal(result.ok, true);
    if (!result.ok) continue;
    assert.equal(result.answers.small?.type, "bool");
    assert.equal(result.answers.large?.type, "unjudged");
    assert.equal(
      result.answers.medium?.type,
      threshold >= 100 ? "bool" : "unjudged",
    );
    assert.equal(
      e.requests.filter((r) => Object.keys(r.questions).join() === "small")
        .length,
      2,
    );
    assert.deepEqual(Object.keys(e.requests[1]?.questions ?? {}), ["small"]);
  }
});

test("non-monotone singleton refusal is conservative, never a delivered verdict", async () => {
  const e = harness((body) =>
    body.questions.short
      ? new Response("max_tokens_exceeded", { status: 400 })
      : success(body),
  );
  const questions = {
    short: { ...q, instructions: "x" },
    acceptedAlone: { ...q, instructions: "a longer question" },
  };
  const result = await e.client.judge({ proof: "same" }, questions);
  assert.equal(result.ok, true);
  assert.equal(result.calls, 2);
  if (!result.ok) return;
  for (const answer of Object.values(result.answers)) {
    assert.equal(answer.type, "unjudged");
    if (answer.type === "unjudged")
      assert.match(answer.reason, /state.*single question/i);
  }
  const accepted = await e.client.judge(
    { proof: "same" },
    { acceptedAlone: questions.acceptedAlone },
  );
  assert.equal(accepted.ok, true);
  if (accepted.ok) assert.equal(accepted.answers.acceptedAlone?.type, "bool");
});

test("client subdivision properties hold for constructed pseudo-random thresholds", async () => {
  for (let seed = 1; seed <= 30; seed++) {
    const threshold = 1 + ((seed * 17) % 7);
    const accepted: string[] = [];
    const e = harness((body) => {
      if (Object.keys(body.questions).length === 1) return success(body);
      const ids = Object.keys(body.questions).filter((id) => id !== "w");
      if (ids.length > threshold || ids.includes("g0a"))
        return new Response("nested max_tokens_exceeded", { status: 400 });
      accepted.push(...ids);
      return success(body);
    });
    const groups = Array.from({ length: 1 + (seed % 12) }, (_, i) => [
      `g${i}a`,
      `g${i}b`,
    ]);
    const questions: Record<string, Question> = { w: q };
    for (const id of groups.flat()) questions[id] = { ...q, instructions: id };
    const result = await e.client.judge({ proof: "whole" }, questions, {
      groups,
      witnesses: ["w"],
    });
    assert.equal(result.ok, true);
    if (!result.ok) continue;
    const unjudged = Object.entries(result.answers).filter(
      ([id, a]) => id !== "w" && a.type === "unjudged",
    );
    for (const [, answer] of unjudged)
      if (answer.type === "unjudged")
        assert.match(answer.reason, /indivisible/);
    assert.deepEqual(
      [...accepted, ...unjudged.map(([id]) => id)].sort(),
      groups.flat().sort(),
    );
    for (const request of e.requests) {
      if (Object.keys(request.questions).length === 1) continue;
      assert.ok(request.questions.w);
      assert.equal(request.state.proof, "whole");
      for (const [a, b] of groups)
        assert.equal(
          Boolean(request.questions[a as string]),
          Boolean(request.questions[b as string]),
        );
    }
  }
});
test("heuristic packing never prevents oversized single-group transport", async () => {
  const e = harness(success);
  const questions: Record<string, Question> = {};
  for (let i = 0; i < 10; i++)
    questions[`q${i}`] = { ...q, instructions: "x".repeat(50_000) };
  await e.client.judge({}, questions);
  assert.ok(e.requests.length > 1);
  const result = await e.client.judge({ text: "x".repeat(300_000) }, { q });
  assert.equal(result.ok, true);
  assert.equal(e.requests.at(-1)?.state.text, "x".repeat(300_000));
});
test("fresh pools enforce shared concurrency and exact rolling-window wait", async () => {
  let now = 0;
  const waits: number[] = [];
  const pool = createPool({
    now: () => now,
    sleep: async (ms) => {
      waits.push(ms);
      now += ms;
    },
  });
  const releases = await Promise.all(
    Array.from({ length: 8 }, () => pool.acquire()),
  );
  let acquired = false;
  const ninth = pool.acquire().then((release) => {
    acquired = true;
    return release;
  });
  await Promise.resolve();
  assert.equal(acquired, false);
  releases[0]?.();
  const release = await ninth;
  assert.deepEqual(waits, [1_000]);
  release();
  for (const free of releases) free();
  const fresh = createPool({
    now: () => 0,
    sleep: async () => {
      throw Error("unexpected wait");
    },
  });
  (await fresh.acquire())();
});

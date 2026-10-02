import assert from "node:assert/strict";
import { test } from "node:test";
import { buildEnvelope } from "../src/core/output.ts";
import { readSessionLimits, Session } from "../src/session.ts";

test("human call cap refuses before another request, in same units", () => {
  const session = new Session({ maxCalls: 1 });
  assert.deepEqual(session.admit(2), { ok: true });
  assert.deepEqual(session.admit(1), {
    ok: false,
    error:
      "JEV_TOOLS_MAX_CALLS=1 reached; session total: 1 Jev calls. No Jev call was made; the human sets this limit",
  });
  assert.equal(session.snapshot().questions, 2);
  assert.equal(session.snapshot().refusals, 1);
});
test("USD cap uses actual usage and reset starts a new session", () => {
  const session = new Session({ maxUsd: 0.00006 });
  session.admit(1);
  session.record(
    buildEnvelope({
      answers: [{ label: "a", answer: { type: "bool", p: 0.5 } }],
      yield: {
        calls: 1,
        questions: 1,
        costUsd: 0.00006,
        cacheHits: 2,
        cacheRequests: 3,
        elapsedMs: 0,
      },
    }),
  );
  session.recordUsage({ costUsd: 0.00006 });
  assert.deepEqual(session.admit(1), {
    ok: false,
    error:
      "JEV_TOOLS_MAX_USD=0.00006 reached; session total: $0.00006. No Jev call was made; the human sets this limit",
  });
  assert.equal(session.snapshot().unsure, 1);
  assert.equal(session.snapshot().cacheHits, 2);
  session.reset();
  assert.deepEqual(session.admit(1), { ok: true });
  assert.equal(session.snapshot().costUsd, 0);
});
for (const [variable, values] of [
  ["JEV_TOOLS_MAX_CALLS", ["-1", "1.5", "ten", "NaN", "Infinity"]],
  ["JEV_TOOLS_MAX_USD", ["-1", "ten", "NaN", "Infinity"]],
] as const) {
  for (const value of values)
    test(`${variable} rejects invalid ${value}`, () => {
      const session = new Session(readSessionLimits({ [variable]: value }));
      const admission = session.admit(1);
      assert.equal(admission.ok, false);
      if (!admission.ok) assert.ok(admission.error.includes(variable));
      assert.equal(session.snapshot().calls, 0);
      session.reset();
      assert.equal(session.admit(1).ok, false);
    });
}
test("empty limits are unlimited and fractional USD remains valid", () => {
  const session = new Session(
    readSessionLimits({ JEV_TOOLS_MAX_CALLS: " ", JEV_TOOLS_MAX_USD: "" }),
  );
  assert.equal(session.admit(1).ok, true);
  const cost = new Session(readSessionLimits({ JEV_TOOLS_MAX_USD: "0.5" }));
  assert.equal(cost.admit(1).ok, true);
  cost.recordUsage({ costUsd: 0.5 });
  assert.equal(cost.admit(1).ok, false);
});

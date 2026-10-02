import assert from "node:assert/strict";
import { test } from "node:test";
import { Guide } from "../src/guide.ts";
import { detectHost } from "../src/host.ts";
import type { JevClient } from "../src/jev/types.ts";
import { Session } from "../src/session.ts";
import { createAskTool } from "../src/tools/ask.ts";

const args = {
  state: "hello",
  asks: {
    intent: "free" as const,
    question: { type: "bool" as const, instructions: "Is this a greeting?" },
  },
};
test("max_calls interrupts later requests while preserving obtained verdicts", async () => {
  const host = detectHost({});
  const session = new Session({});
  let requests = 0;
  const client: JevClient = {
    clearCache() {},
    async judge(_state, _questions, options) {
      assert.equal(options?.beforeRequest?.(1).ok, true);
      requests++;
      options?.onUsage?.({ inputTokens: 10, costUsd: 0.01 });
      const second = options?.beforeRequest?.(1);
      assert.equal(second?.ok, false);
      return {
        ok: true,
        calls: 1,
        questions: 1,
        usage: { inputTokens: 10, costUsd: 0.01 },
        answers: {
          q1: { type: "bool", p: 0.98 },
          q2: {
            type: "unjudged",
            reason: second && !second.ok ? second.error : "unexpected",
          },
        },
      };
    },
  };
  const result = await createAskTool({
    client,
    host,
    runtime: { session, guide: new Guide(host) },
    exec: async () => {
      throw new Error("Unexpected host command");
    },
  }).execute(
    "1",
    {
      ...args,
      asks: [
        args.asks,
        {
          intent: "free",
          question: {
            type: "bool",
            instructions: "Does the note contain a farewell?",
          },
        },
      ],
      max_calls: 1,
    },
    undefined,
    undefined,
    {
      cwd: ".",
    },
  );
  assert.equal(requests, 1);
  assert.match(
    result.content[0]?.text ?? "",
    /uncalibrated {2}free1 "Is this a greeting\?" = yes \(0\.98\)/,
  );
  assert.match(result.content[0]?.text ?? "", /unchecked: free2/);
  assert.match(
    result.content[0]?.text ?? "",
    /\[max_calls=1 reached; raise max_calls\]/,
  );
  assert.equal(session.snapshot().costUsd, 0.01);
});
test("session refusal prevents network and guide accompanies refused output", async () => {
  const host = detectHost({ pi: {} });
  const session = new Session({ maxCalls: 0 });
  let network = false;
  let guide = "";
  const client: JevClient = {
    clearCache() {},
    async judge(_state, _questions, options) {
      const admission = options?.beforeRequest?.(1);
      if (admission && !admission.ok) return admission;
      network = true;
      throw Error("unexpected request");
    },
  };
  const result = await createAskTool({
    client,
    host,
    runtime: { session, guide: new Guide(host) },
    exec: async () => {
      throw new Error("Unexpected host command");
    },
  }).execute("1", args, undefined, undefined, {
    cwd: ".",
    addAdditionalContext(text) {
      guide = text;
    },
  });
  assert.equal(network, false);
  assert.match(
    result.content[0]?.text ?? "",
    /JEV_TOOLS_MAX_CALLS=0 reached; session total: 0 Jev calls\. No Jev call was made; the human sets this limit/,
  );
  assert.match(guide, /In your final answer/);
  assert.equal("usage" in result, false);
});

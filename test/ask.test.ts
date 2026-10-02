import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Guide } from "../src/guide.ts";
import { detectHost } from "../src/host.ts";
import type { JevClient, Judgment, State } from "../src/jev/types.ts";
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
    q1: { type: "bool", p: 0.98 },
    q2: {
      type: "choice",
      choice: "yes",
      confidence: 0.3,
      probabilities: { yes: 0.92, no: 0.08 },
    },
    q3: {
      type: "score",
      score: 1.8,
      confidence: 0.2,
      legend: ["low", "medium", "high"],
      probabilities: { low: 0.05, medium: 0.1, high: 0.85 },
    },
    q4: { type: "unjudged", reason: "missing answer" },
  },
};
test("injected client judges assembled files while content hides files and confidence", async () => {
  await mkdir(join(homedir(), ".cache/jev-tools"), { recursive: true });
  const cwd = await mkdtemp(join(homedir(), ".cache/jev-tools/ask-test-"));
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
    assert.deepEqual(captured, {
      request: "review",
      files: { "a.ts": "export const value = 1;\n" },
    });
    const text = result.content[0]?.text ?? "";
    assert.match(text, /free1 .* = yes \(0.98\)/);
    assert.doesNotMatch(text, /confidence|export const value/);
    assert.match(
      text,
      /1 calls · 1 questions · \$0.00006 · cache 0\/1 · \d+\.\d s$/,
    );
    assert.deepEqual(result.details, judgment);
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
  assert.match(
    result.content[0]?.text ?? "",
    /^Internal URLs are not files; use read for agent:\/\/Main\./,
  );
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
  assert.match(
    result.content[0]?.text ?? "",
    /unsure.*a \(0\.6\).*order-dependent/,
  );
  assert.equal(result.details.calls, 2);
  assert.equal(result.details.usage?.costUsd, 0.002);
});

test("verify missing twin remains visible alongside decide text", async () => {
  const client: JevClient = {
    clearCache() {},
    async judge() {
      return {
        ok: true,
        calls: 1,
        questions: 6,
        answers: {
          q1: {
            type: "choice",
            choice: "holds",
            confidence: 0.99,
            probabilities: {
              holds: 0.98,
              contradicted: 0.01,
              not_addressed: 0.01,
              cannot_tell: 0,
            },
          },
          q2: { type: "unjudged", reason: "simulated missing twin" },
          q3: { type: "bool", p: 0.98 },
          q4: {
            type: "choice",
            choice: "register",
            confidence: 0.99,
            probabilities: {
              register: 0.99,
              server: 0.005,
              other: 0.005,
              cannot_tell: 0,
            },
          },
          q5: { type: "bool", p: 0.99 },
          q6: { type: "bool", p: 0.01 },
        },
      };
    },
  };
  const result = await createAskTool(dependencies(client)).execute(
    "1",
    {
      state: "An extension registers a tool",
      asks: [
        {
          intent: "verify",
          about: "state",
          claims: { c1: "The extension registers a tool" },
        },
        {
          intent: "decide",
          about: "state",
          hypotheses: {
            register: "The module registers an extension tool",
            server: "The module starts an HTTP server",
          },
        },
      ],
    },
    undefined,
    undefined,
    { cwd: "." },
  );
  assert.match(
    result.content[0]?.text ?? "",
    /unsure.*c1 "The extension registers a tool".*twin unjudged: simulated missing twin; complete the state note/,
  );
  assert.match(
    result.content[0]?.text ?? "",
    /decide2 "The module registers an extension tool"/,
  );
});
test("invalid UTF-8 is excluded visibly without suppressing other file verdicts", async () => {
  const cwd = await mkdtemp(join(homedir(), ".cache/jev-tools/ask-utf8-"));
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
    assert.match(text, /integrity ok/);
    assert.match(text, /= yes \(0\.98\)/);
    assert.doesNotMatch(text, /unsure.*Does ok\.txt/);
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

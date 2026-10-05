import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { GitExec } from "../src/core/git.ts";
import { validateResultReport } from "../src/core/result-report.ts";
import { Guide } from "../src/guide.ts";
import { detectHost } from "../src/host.ts";
import type { JevClient } from "../src/jev/types.ts";
import { Session } from "../src/session.ts";
import { createAskTool } from "../src/tools/ask.ts";
import { createAskFilesTool } from "../src/tools/ask-files.ts";

const noGit: GitExec = async () => ({
  stdout: "",
  stderr: "not a repository",
  code: 128,
  killed: false,
});
function dependencies(client?: JevClient, exec = noGit) {
  const host = detectHost({});
  return {
    host,
    client,
    exec,
    runtime: { session: new Session({}), guide: new Guide(host) },
  };
}
const boolAsk = {
  intent: "free" as const,
  question: {
    type: "bool" as const,
    instructions: "Does the evidence show a value?",
  },
};

test("ask missing required evidence blocks only its whole group, preserving cached result and unknown cost", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "jev-report-"));
  try {
    const client: JevClient = {
      clearCache() {},
      async judge(_state, questions) {
        return {
          ok: true,
          calls: 0,
          questions: 0,
          cacheHits: 1,
          cacheRequests: 1,
          answers: Object.fromEntries(
            Object.keys(questions).map((id) => [
              id,
              { type: "bool", p: 0.99, source: "cache" },
            ]),
          ),
        };
      },
    };
    const output = await createAskTool(dependencies(client)).execute(
      "report",
      {
        state: "Observed value: 1",
        asks: [boolAsk, { ...boolAsk, about: 'files["missing.ts"]' }],
      },
      undefined,
      undefined,
      { cwd },
    );
    const report = output.details.result;
    assert.equal(report.execution, "partial");
    assert.deepEqual(report.accounting.requestedResults, {
      total: { status: "known", value: 2 },
      fresh: 0,
      cache: 1,
      notJudged: 1,
      static: 0,
    });
    assert.equal(report.items[1]?.treatment, "not_judged");
    assert.ok(report.items[1]);
    assert.equal("judgment" in report.items[1], false);
    assert.equal(report.accounting.costUsd.status, "unknown");
    assert.equal(report.context.command.execution, "not_requested");
    assert.deepEqual(validateResultReport(report), []);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("forbidden explicit references refuse before command or model effects", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "jev-report-"));
  try {
    let shell = 0,
      judgments = 0;
    const exec: GitExec = async (binary, args, options) => {
      if (binary !== "git") shell++;
      return noGit(binary, args, options);
    };
    const client: JevClient = {
      clearCache() {},
      async judge() {
        judgments++;
        return { ok: true, answers: {} };
      },
    };
    const output = await createAskTool(dependencies(client, exec)).execute(
      "report",
      {
        command: "echo side-effect",
        asks: { ...boolAsk, about: 'files["../secret.ts"]' },
      },
      undefined,
      undefined,
      { cwd },
    );
    assert.equal(shell, 0);
    assert.equal(judgments, 0);
    assert.equal(output.details.result.execution, "refused");
    assert.equal(
      output.details.result.context.command.execution,
      "not_started",
    );
    assert.equal(output.details.result.diagnostics[0]?.cause, "forbidden_path");
    assert.deepEqual(validateResultReport(output.details.result), []);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("no configuration still provides requested claims, authority and non-judgment", async () => {
  const output = await createAskTool(dependencies()).execute(
    "report",
    { state: "value", asks: boolAsk },
    undefined,
    undefined,
    { cwd: process.cwd() },
  );
  assert.equal(output.details.result.execution, "not_judged");
  assert.equal(output.details.result.items.length, 1);
  assert.equal(output.details.result.context.authority.status, "known");
  assert.equal(output.details.result.diagnostics[0]?.cause, "not_configured");
  assert.equal(output.details.result.accounting.costUsd.status, "unknown");
});

test("ask-files accounts each file-question, independent of network questions and budget", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "jev-report-"));
  try {
    await writeFile(join(cwd, "a.ts"), "export const value = 1;");
    await writeFile(join(cwd, "b.ts"), "export const value = 2;");
    const client: JevClient = {
      clearCache() {},
      async judge(state, questions) {
        return state.path === "a.ts"
          ? {
              ok: true,
              calls: 0,
              questions: 0,
              answers: Object.fromEntries(
                Object.keys(questions).map((id) => [
                  id,
                  { type: "bool", p: 0.99, source: "cache" },
                ]),
              ),
            }
          : {
              ok: false,
              error: "Chosen budget exhausted",
              failureCause: "call_budget",
              calls: 0,
            };
      },
    };
    const output = await createAskFilesTool(dependencies(client)).execute(
      "report",
      { paths: ["a.ts", "b.ts"], asks: [boolAsk, boolAsk] },
      undefined,
      undefined,
      { cwd },
    );
    const report = output.details.result;
    assert.equal(report.execution, "partial");
    assert.deepEqual(report.accounting.requestedResults, {
      total: { status: "known", value: 4 },
      fresh: 0,
      cache: 2,
      notJudged: 2,
      static: 0,
    });
    assert.equal(report.accounting.httpAttempts, 0);
    assert.equal(
      report.items
        .filter((item) => item.treatment === "not_judged")
        .every((item) => !("judgment" in item)),
      true,
    );
    assert.deepEqual(validateResultReport(report), []);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("missing global note evidence produces one call-scoped cause and no network judgment", async () => {
  let judgments = 0;
  const client: JevClient = {
    clearCache() {},
    async judge() {
      judgments++;
      return { ok: true, answers: {} };
    },
  };
  const output = await createAskTool(dependencies(client)).execute(
    "report",
    {
      state: 'Required evidence files["missing.ts"]',
      asks: [boolAsk, boolAsk],
    },
    undefined,
    undefined,
    { cwd: process.cwd() },
  );
  const report = output.details.result;
  assert.equal(judgments, 0);
  assert.equal(report.execution, "not_judged");
  const missing = report.diagnostics.filter(
    (diagnostic) => diagnostic.cause === "missing_required",
  );
  assert.equal(missing.length, 1);
  const diagnostic = missing[0];
  assert.ok(diagnostic);
  assert.equal(diagnostic.scope.kind, "call");
  assert.equal(
    report.items.every(
      (item) =>
        item.treatment === "not_judged" &&
        item.diagnosticIds.includes(diagnostic.id),
    ),
    true,
  );
});

test("missing required control invalidates a fresh primary without inventing a verdict", async () => {
  const client: JevClient = {
    clearCache() {},
    async judge(_state, questions) {
      return {
        ok: true,
        calls: 1,
        questions: Object.keys(questions).length,
        answers: Object.fromEntries(
          Object.keys(questions).map((id, index) => [
            id,
            index === 0
              ? {
                  type: "choice",
                  source: "fresh",
                  choice: "holds",
                  confidence: 0.99,
                  probabilities: {
                    holds: 0.99,
                    contradicted: 0.01,
                    not_addressed: 0,
                    cannot_tell: 0,
                  },
                }
              : {
                  type: "unjudged",
                  cause: "call_budget",
                  reason: "control not admitted",
                },
          ]),
        ),
      };
    },
  };
  const output = await createAskTool(dependencies(client)).execute(
    "report",
    {
      state: "Observed value",
      asks: { intent: "verify", claims: { value: "A value exists" } },
    },
    undefined,
    undefined,
    { cwd: process.cwd() },
  );
  assert.equal(output.details.result.items[0]?.treatment, "not_judged");
  assert.equal(output.details.result.accounting.requestedResults.fresh, 0);
  assert.equal(output.details.result.accounting.httpAttempts, 1);
  assert.equal(
    output.details.result.accounting.auxiliary.controls.notJudged > 0,
    true,
  );
});

test("unobserved command startup reports started with unknown completion rather than fabricated command completion", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "jev-report-"));
  try {
    const exec: GitExec = async (binary, args, options) => {
      if (binary !== "git")
        throw new Error("host rejected execution without process metadata");
      return noGit(binary, args, options);
    };
    const client: JevClient = {
      clearCache() {},
      async judge() {
        throw new Error("refused capture must not judge");
      },
    };
    const output = await createAskTool(dependencies(client, exec)).execute(
      "report",
      { command: "echo value", asks: boolAsk },
      undefined,
      undefined,
      { cwd },
    );
    assert.equal(output.details.result.execution, "refused");
    assert.equal(output.details.result.context.command.execution, "started");
    assert.equal(
      output.details.result.context.command.exitCode.status,
      "unknown",
    );
    assert.equal(
      output.details.result.context.command.timedOut.status,
      "unknown",
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

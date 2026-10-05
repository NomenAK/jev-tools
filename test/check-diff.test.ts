import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import type { GitExec } from "../src/core/git.ts";
import { Guide } from "../src/guide.ts";
import { detectHost } from "../src/host.ts";
import type { Answer, JevClient, Judgment } from "../src/jev/types.ts";
import { Session } from "../src/session.ts";
import { createCheckDiffTool } from "../src/tools/check-diff.ts";

const execute = promisify(execFile);
const exec: GitExec = async (command, args, options) => {
  try {
    const result = await execute(command, args, options);
    return { ...result, code: 0, killed: false };
  } catch (error) {
    if (
      error instanceof Error &&
      "stdout" in error &&
      "stderr" in error &&
      "code" in error
    )
      return {
        stdout: String(error.stdout),
        stderr: String(error.stderr),
        code: Number(error.code),
        killed: false,
      };
    throw error;
  }
};
function dependencies(client?: JevClient) {
  const host = detectHost({});
  return {
    client,
    host,
    exec,
    runtime: { session: new Session({}), guide: new Guide(host) },
  };
}
test("docs requires configuration and spec requires a path before diff collection", async () => {
  const tool = createCheckDiffTool({
    ...dependencies(),
    exec: async () => {
      throw new Error("unexpected collection");
    },
  });
  const docs = await tool.execute(
    "1",
    { check: "docs" },
    undefined,
    undefined,
    { cwd: "." },
  );
  const spec = await tool.execute(
    "2",
    { check: "spec" },
    undefined,
    undefined,
    { cwd: "." },
  );
  assert.equal(docs.details.ok, false);
  assert.equal(docs.details.envelope.lines[0]?.type, "refusal");
  assert.equal(spec.details.ok, false);
  assert.equal(spec.details.envelope.lines[0]?.type, "refusal");
});
async function repository(run: (cwd: string) => Promise<void>) {
  const cwd = await mkdtemp(join(tmpdir(), "risk-proof-"));
  try {
    await exec("git", ["init", "-q"], { cwd, timeout: 10000 });
    await writeFile(
      join(cwd, "a.ts"),
      "export function first() { return 1; }\nexport function second() { return 2; }\n",
    );
    await exec("git", ["add", "."], { cwd, timeout: 10000 });
    await exec(
      "git",
      [
        "-c",
        "user.name=Proof",
        "-c",
        "user.email=proof@example.invalid",
        "commit",
        "-qm",
        "base",
      ],
      { cwd, timeout: 10000 },
    );
    await writeFile(
      join(cwd, "a.ts"),
      "export function first() { return 9; }\nexport function second() { return 8; }\n",
    );
    await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}
function fakeClient(probability: number, requests: string[]): JevClient {
  return {
    clearCache() {},
    async judge(_state, questions, options) {
      const admitted = options?.beforeRequest?.(Object.keys(questions).length);
      if (admitted && !admitted.ok)
        return {
          ok: true,
          answers: Object.fromEntries(
            Object.keys(questions).map((id) => [
              id,
              {
                type: "unjudged",
                cause: "call_budget",
                reason: admitted.error,
              },
            ]),
          ),
          calls: 0,
        };
      requests.push(Object.values(questions)[0]?.type ?? "empty");
      const answers: Record<string, Answer> = Object.fromEntries(
        Object.entries(questions).map(([id, question]) => [
          id,
          question.type === "score"
            ? {
                type: "score",
                source: "fresh" as const,
                score: 2.8,
                confidence: 0.9,
                legend: [],
                probabilities: { "3": 0.9, "2": 0.1 },
              }
            : { type: "bool", source: "fresh" as const, p: probability },
        ]),
      );
      return {
        ok: true,
        answers,
        calls: 1,
        questions: Object.keys(questions).length,
      };
    },
  };
}
test("matrix can report both units in one dimension and grades each finding", async () =>
  repository(async (cwd) => {
    const requests: string[] = [];
    const result = await createCheckDiffTool(
      dependencies(fakeClient(0.95, requests)),
    ).execute(
      "1",
      { check: "risk", witnesses: "off", only: ["correctness"] },
      undefined,
      undefined,
      { cwd },
    );
    const answers = result.details.envelope.lines.filter(
      (line) => line.type === "answer",
    );
    assert.equal(answers.length, 2);
    assert.ok(
      answers.every(
        (line) =>
          line.type === "answer" &&
          line.band === "verdict" &&
          line.label.includes("severity 2.8/3"),
      ),
    );
    assert.deepEqual(requests, ["bool", "score", "score"]);
  }));
test("severity of several flagged dimensions of one unit rides a single request", async () =>
  repository(async (cwd) => {
    const requests: { scoreQuestions: number }[] = [];
    const client: JevClient = {
      clearCache() {},
      async judge(_state, questions, options) {
        const admitted = options?.beforeRequest?.(
          Object.keys(questions).length,
        );
        if (admitted && !admitted.ok)
          return {
            ok: false,
            error: admitted.error,
            kind: "budget" as const,
          };
        const scoreIds = Object.entries(questions)
          .filter(([, question]) => question.type === "score")
          .map(([id]) => id);
        if (scoreIds.length) {
          requests.push({ scoreQuestions: scoreIds.length });
          return {
            ok: true,
            calls: 1,
            answers: Object.fromEntries(
              scoreIds.map((id, index) => [
                id,
                {
                  type: "score" as const,
                  source: "fresh" as const,
                  score: index + 1,
                  confidence: 0.9,
                  legend: [],
                  probabilities: { "1": 1 },
                },
              ]),
            ),
          };
        }
        return {
          ok: true,
          calls: 1,
          answers: Object.fromEntries(
            Object.keys(questions).map((id) => [
              id,
              { type: "bool" as const, source: "fresh" as const, p: 0.95 },
            ]),
          ),
        };
      },
    };
    const result = await createCheckDiffTool(dependencies(client)).execute(
      "1",
      { check: "risk", witnesses: "off" },
      undefined,
      undefined,
      { cwd },
    );
    // Two units x four dimensions collapse to one severity request per unit.
    assert.deepEqual(requests, [{ scoreQuestions: 4 }, { scoreQuestions: 4 }]);
    const scored = result.details.envelope.lines.filter(
      (line) => line.type === "answer" && /severity \d\.\d\/3/.test(line.label),
    );
    assert.equal(scored.length, 8);
    // Each finding keeps its own grade: the four dimensions of a unit are
    // scored independently, not collapsed onto one shared severity.
    assert.equal(
      new Set(
        scored.map(
          (line) =>
            (line as { label: string }).label.match(/severity \d\.\d\/3/)?.[0],
        ),
      ).size,
      4,
    );
  }));
test("max_calls reserves the matrix and exposes unchecked severity instead of no findings", async () =>
  repository(async (cwd) => {
    const requests: string[] = [];
    const result = await createCheckDiffTool(
      dependencies(fakeClient(0.95, requests)),
    ).execute(
      "1",
      { check: "risk", witnesses: "off", only: ["correctness"], max_calls: 1 },
      undefined,
      undefined,
      { cwd },
    );
    assert.deepEqual(requests, ["bool"]);
    assert.equal(result.details.result.execution, "partial");
    assert.ok(
      result.details.result.items.some(
        (item) => item.treatment === "not_judged",
      ),
    );
    assert.ok(
      result.details.result.diagnostics.some(
        (diagnostic) => diagnostic.cause === "call_budget",
      ),
    );
  }));
test("no findings is emitted only for judged negative matrix cells", async () =>
  repository(async (cwd) => {
    const requests: string[] = [];
    const result = await createCheckDiffTool(
      dependencies(fakeClient(0.1, requests)),
    ).execute(
      "1",
      { check: "risk", witnesses: "off", only: ["correctness"] },
      undefined,
      undefined,
      { cwd },
    );
    assert.equal(result.details.result.execution, "complete");
    assert.ok(
      result.details.result.items.every((item) => item.treatment === "judged"),
    );
    const refused = await createCheckDiffTool(
      dependencies(fakeClient(0.95, requests)),
    ).execute(
      "2",
      { check: "risk", witnesses: "off", only: ["correctness"], max_calls: 0 },
      undefined,
      undefined,
      { cwd },
    );
    assert.equal(refused.details.result.execution, "not_judged");
    assert.ok(
      refused.details.result.items.every(
        (item) => item.treatment === "not_judged",
      ),
    );
  }));

async function cleanRepository(run: (cwd: string) => Promise<void>) {
  const cwd = await mkdtemp(join(tmpdir(), "risk-empty-"));
  try {
    await exec("git", ["init", "-q"], { cwd, timeout: 10000 });
    await writeFile(
      join(cwd, "a.ts"),
      "export function first() { return 1; }\n",
    );
    await exec("git", ["add", "."], { cwd, timeout: 10000 });
    await exec(
      "git",
      [
        "-c",
        "user.name=Proof",
        "-c",
        "user.email=proof@example.invalid",
        "commit",
        "-qm",
        "base",
      ],
      { cwd, timeout: 10000 },
    );
    await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}
test("risk on an empty diff reports nothing judged instead of no findings", async () =>
  cleanRepository(async (cwd) => {
    const requests: string[] = [];
    const result = await createCheckDiffTool(
      dependencies(fakeClient(0.1, requests)),
    ).execute(
      "1",
      { check: "risk", witnesses: "off", only: ["correctness"] },
      undefined,
      undefined,
      { cwd },
    );
    assert.equal(result.details.result.execution, "not_judged");
    assert.equal(result.details.result.items.length, 0);
    assert.ok(
      result.details.result.diagnostics.some(
        (diagnostic) => diagnostic.cause === "no_changed_units",
      ),
    );
    assert.deepEqual(requests, []);
  }));
test("risk on an empty diff names the resolved base", async () =>
  cleanRepository(async (cwd) => {
    await exec("git", ["tag", "v1"], { cwd, timeout: 10000 });
    const sha = (
      await exec("git", ["rev-parse", "HEAD"], { cwd, timeout: 10000 })
    ).stdout.trim();
    const requests: string[] = [];
    const result = await createCheckDiffTool(
      dependencies(fakeClient(0.1, requests)),
    ).execute(
      "1",
      { check: "risk", base: "v1", witnesses: "off", only: ["correctness"] },
      undefined,
      undefined,
      { cwd },
    );
    assert.deepEqual(result.details.result.context.resolvedBase, {
      status: "known",
      value: sha,
    });
    assert.equal(result.details.result.execution, "not_judged");
    assert.ok(
      result.details.result.diagnostics.some(
        (diagnostic) => diagnostic.cause === "no_changed_units",
      ),
    );
    assert.deepEqual(requests, []);
  }));
test("project dimensions stay uncalibrated and have neither severity nor witness questions", async () =>
  repository(async (cwd) => {
    const requests: string[] = [];
    const result = await createCheckDiffTool(
      dependencies(fakeClient(0.9, requests)),
    ).execute(
      "1",
      {
        check: "risk",
        witnesses: "on",
        dimensions: { local_time: "read a date in local time" },
        only: ["local_time"],
      },
      undefined,
      undefined,
      { cwd },
    );
    const findings = result.details.envelope.lines.filter(
      (line) => line.type === "answer",
    );
    assert.equal(findings.length, 2);
    assert.ok(
      findings.every(
        (line) =>
          line.type === "answer" &&
          line.uncalibrated &&
          line.label.includes("local_time") &&
          !line.label.includes("severity"),
      ),
    );
    assert.deepEqual(requests, ["bool"]);
  }));
test("local caller choice has independent bands and retains its proof for severity", async () =>
  repository(async (cwd) => {
    await writeFile(
      join(cwd, "a.ts"),
      "export function deliver(client) { return client.get(); }\n",
    );
    await writeFile(
      join(cwd, "caller.ts"),
      "import { deliver } from './a';\nconst provider = { get() { return 1; } };\nexport function run() { return deliver(provider); }\n",
    );
    await exec("git", ["add", "."], { cwd, timeout: 10000 });
    await exec(
      "git",
      [
        "-c",
        "user.name=Proof",
        "-c",
        "user.email=proof@example.invalid",
        "commit",
        "-qm",
        "caller base",
      ],
      { cwd, timeout: 10000 },
    );
    await writeFile(
      join(cwd, "a.ts"),
      "export function deliver(client) { return client.fetch(); }\n",
    );
    for (const [failure, cannot, band, outcome] of [
      [0.9, 0.01, "verdict", "new_failure"],
      [0.4, 0.1, "unsure", "new_failure"],
      [0.1, 0.8, "abstain", "cannot_tell"],
      [0.1, 0.01, "verdict", "no_new_failure"],
    ] as const) {
      let matrixHasCaller = false;
      let severityHasCaller = false;
      const client: JevClient = {
        clearCache() {},
        async judge(state, questions, options): Promise<Judgment> {
          options?.beforeRequest?.(Object.keys(questions).length);
          if (questions.caller)
            return {
              ok: true,
              calls: 1,
              answers: {
                caller: {
                  type: "choice",
                  source: "fresh" as const,
                  choice: outcome,
                  confidence: 0.9,
                  probabilities: {
                    no_new_failure: 1 - failure - cannot,
                    new_failure: failure,
                    cannot_tell: cannot,
                  },
                },
              },
            };
          const severityIds = Object.entries(questions)
            .filter(([, question]) => question.type === "score")
            .map(([id]) => id);
          if (severityIds.length) {
            severityHasCaller = state.callerEvidence !== undefined;
            return {
              ok: true,
              calls: 1,
              answers: Object.fromEntries(
                severityIds.map((id) => [
                  id,
                  {
                    type: "score",
                    source: "fresh" as const,
                    score: 2,
                    confidence: 0.9,
                    legend: [],
                    probabilities: { "2": 1 },
                  },
                ]),
              ),
            };
          }
          matrixHasCaller = state.callerEvidence !== undefined;
          return {
            ok: true,
            calls: 1,
            answers: Object.fromEntries(
              Object.keys(questions).map((id) => [
                id,
                { type: "bool", source: "fresh" as const, p: 0.05 },
              ]),
            ),
          };
        },
      };
      const result = await createCheckDiffTool(dependencies(client)).execute(
        "1",
        { check: "risk", witnesses: "off", only: ["reliability"] },
        undefined,
        undefined,
        { cwd },
      );
      const caller = result.details.result.items.find((item) =>
        item.id.startsWith("caller:"),
      );
      assert.ok(caller?.treatment === "judged");
      assert.equal(caller.judgment.band, band);
      assert.equal(caller.judgment.result, outcome);
      const probability =
        outcome === "cannot_tell"
          ? cannot
          : outcome === "no_new_failure"
            ? 1 - failure - cannot
            : failure;
      assert.deepEqual(caller.judgment.measure, {
        kind: "probability",
        value: { status: "known", value: probability },
      });
      assert.equal(caller.source, "fresh");
      assert.deepEqual(
        caller.judgment.rawValues.map(({ label, probability }) => [
          label,
          probability,
        ]),
        [
          ["no_new_failure", { status: "known", value: 1 - failure - cannot }],
          ["new_failure", { status: "known", value: failure }],
          ["cannot_tell", { status: "known", value: cannot }],
        ],
      );
      assert.match(caller.label, /a\.ts:\d+-\d+ deliver/);
      assert.match(caller.label, /static code only; .*caller\.ts:/);
      assert.ok(caller.judgment.reason.length > 0);
      const text = result.content[0]?.text ?? "";
      assert.ok(
        text.includes(
          `${band === "verdict" ? "" : `${band}  `}${caller.label} = ${outcome} (probability ${probability}) [fresh]`,
        ),
      );
      const line = result.details.envelope.lines.find(
        (line) => line.type === "answer",
      );
      if (outcome === "no_new_failure") assert.equal(line, undefined);
      else {
        assert.ok(line?.type === "answer");
        assert.equal(line.band, band);
        assert.deepEqual(line.value, { head: outcome, p: probability });
        const proofLabel = line.label.split(" · severity")[0];
        assert.ok(proofLabel);
        assert.ok(caller.label.startsWith(proofLabel));
      }
      if (band === "abstain") {
        const diagnostic = result.details.result.diagnostics.find((entry) =>
          caller.diagnosticIds.includes(entry.id),
        );
        assert.ok(diagnostic);
        assert.equal(diagnostic.cause, "missing_required");
        assert.equal(diagnostic.effect, "reservation");
        assert.match(diagnostic.fact, /actual provider or binding missing/);
        const action = result.details.result.actions.find((entry) =>
          diagnostic.actionIds.includes(entry.id),
        );
        assert.ok(action);
        assert.equal(action.code, "inspect_native");
        assert.equal(action.repeatUnchanged, false);
        assert.match(text, /actual provider or binding missing/);
        assert.match(text, /Inspect the named evidence natively/);
      }
      assert.equal(result.details.callerProofs.length, 1);
      assert.ok(
        result.details.callerProofs[0]?.paths.every(
          (span) => span.start <= span.end,
        ),
      );
      const displayed =
        caller.label.split("static code only; ")[1]?.split(" · severity")[0] ??
        "";
      const spans = displayed.split(" + ");
      assert.equal(new Set(spans).size, spans.length);
      assert.ok(spans.length <= 8);
      assert.equal(matrixHasCaller, false);
      assert.equal(
        severityHasCaller,
        outcome === "new_failure" && band === "verdict",
      );
    }
  }));
test("transport failures and unhealthy witnesses cannot report no findings", async () =>
  repository(async (cwd) => {
    for (const failedTransport of [false, true]) {
      const client: JevClient = {
        clearCache() {},
        async judge(_state, questions) {
          if (failedTransport)
            return { ok: false, error: "Jev HTTP 401: unauthorized" };
          return {
            ok: true,
            calls: 1,
            answers: Object.fromEntries(
              Object.keys(questions).map((id) => [
                id,
                { type: "bool", source: "fresh" as const, p: 0.01 },
              ]),
            ),
          };
        },
      };
      const result = await createCheckDiffTool(dependencies(client)).execute(
        "1",
        { check: "risk", witnesses: "on", only: ["security"] },
        undefined,
        undefined,
        { cwd },
      );
      const text = result.content[0]?.text ?? "";
      assert.doesNotMatch(text, /no findings/);
      if (failedTransport) {
        assert.match(text, /HTTP 401/);
        assert.doesNotMatch(text, /set-up check failed/);
      } else assert.match(text, /set-up check failed/);
    }
  }));

for (const [name, malformed] of [
  ["const initializer", "export const unrelated = ;"],
  ["method", "export const holder = { broken() { const value = ; } };"],
  ["export", 'export type * from "./types";'],
] as const) {
  test(`risk leaves affected callers unchecked for partial ${name} syntax`, async () =>
    repository(async (cwd) => {
      const before = "export function deliver(client) { return client.get(); }";
      const after =
        "export function deliver(client) { return client.fetch(); }";
      const caller = `import { deliver } from './a';\nconst provider = { get() { return 1; } };\nexport function run() { return deliver(provider); }\n${malformed}`;
      await writeFile(join(cwd, "a.ts"), before);
      await writeFile(join(cwd, "caller.ts"), caller);
      await exec("git", ["add", "."], { cwd, timeout: 10000 });
      await exec(
        "git",
        [
          "-c",
          "user.name=Proof",
          "-c",
          "user.email=proof@example.invalid",
          "commit",
          "-qm",
          "caller",
        ],
        { cwd, timeout: 10000 },
      );
      await writeFile(join(cwd, "a.ts"), after);
      const result = await createCheckDiffTool(
        dependencies(fakeClient(0.01, [])),
      ).execute(
        "partial",
        { check: "risk", witnesses: "off" },
        undefined,
        undefined,
        { cwd },
      );
      assert.ok(
        result.details.envelope.lines.some(
          (line) =>
            line.type === "fact" &&
            line.fact.includes("parse_partial") &&
            line.fact.includes("caller.ts"),
        ),
      );
      assert.ok(
        result.details.envelope.lines.some(
          (line) =>
            line.type === "unchecked" &&
            line.items.some((item) =>
              item.includes("u001 local caller caller.ts"),
            ),
        ),
      );
      assert.equal(
        result.details.envelope.lines
          .flatMap((line) => (line.type === "unchecked" ? line.items : []))
          .filter((item) => item.startsWith("u001 local caller")).length,
        1,
      );
    }));
}

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { RUN_END_DOCS_MAX_CALLS } from "../src/constants.ts";
import {
  buildResultReport,
  known,
  uncollectedContext,
  unknown,
} from "../src/core/result-report.ts";
import { Guide } from "../src/guide.ts";
import { detectHost } from "../src/host.ts";
import type { JevClient } from "../src/jev/types.ts";
import { RunEnd, type RunEndHost } from "../src/run-end.ts";
import type { ToolDependencies } from "../src/runtime.ts";
import { Session } from "../src/session.ts";
import { type DocsCheckResult, runDocsCheck } from "../src/tools/docs-check.ts";

const flagged: DocsCheckResult = {
  ok: true,
  status: "completed",
  envelope: { lines: [] },
  judgments: [],
  result: buildResultReport({
    tool: "jev_check_diff",
    context: uncollectedContext({
      authority: unknown("synthetic hook fixture"),
    }),
    items: [
      {
        id: "docs:s1",
        label: "`--legacy` keeps the old format.",
        kind: "section",
        groupId: "docs:s1",
        evidence: [],
        diagnosticIds: [],
        actionIds: [],
        treatment: "static",
        source: "none",
        staticReason: "Synthetic documentation hook finding fixture",
      },
    ],
    diagnostics: [],
    actions: [],
    metrics: {
      calls: 0,
      questions: 0,
      cacheHits: 0,
      cacheRequests: 0,
      elapsedMs: 0,
    },
    auxiliary: {
      controls: { fresh: 0, cache: 0, notJudged: 0, static: 0 },
      passages: { fresh: 0, cache: 0, notJudged: 0 },
    },
    total: known(1),
  }),
  findings: [
    {
      section: { path: "docs/api.md", heading: "Options", start: 1, end: 3 },
      sentence: { id: "s1", text: "`--legacy` keeps the old format." },
      units: [
        {
          id: "u1",
          file: "src/cli.ts",
          name: "parseArgs",
          kind: "function",
          exported: false,
          beforeRange: { start: 1, end: 3 },
          afterRange: { start: 1, end: 3 },
          before: "old",
          after: "new",
        },
      ],
      probability: 0.9,
      band: "verdict",
    },
  ],
};
function assertFlaggedContext(value: unknown): void {
  assert.equal(typeof value, "string");
  const text = value as string;
  assert.ok(text.includes("docs/api.md"));
  assert.ok(text.includes("Options"));
  assert.ok(text.includes("`--legacy` keeps the old format."));
  assert.ok(text.includes("parseArgs"));
  assert.ok(text.includes("src/cli.ts"));
  assert.equal(text.split("`--legacy` keeps the old format.").length - 1, 1);
}

function harness(
  isOmp = false,
  options: ConstructorParameters<typeof RunEnd>[1] = {},
  result = flagged,
) {
  const handlers = new Map<string, Parameters<RunEndHost["on"]>[1]>();
  const host = detectHost(isOmp ? { pi: {} } : {});
  const commands: string[][] = [];
  const deps: ToolDependencies = {
    host,
    client: {} as JevClient,
    runtime: { session: new Session({}), guide: new Guide(host) },
    exec: async (command, args) => {
      commands.push([command, ...args]);
      return { code: 0, killed: false, stdout: " M src/cli.ts\n", stderr: "" };
    },
  };
  let checks = 0;
  const hook = new RunEnd(deps, {
    check: async () => {
      checks++;
      return result;
    },
    env: {},
    ...options,
  });
  hook.attach({
    on: (name, handler) => {
      handlers.set(name, handler);
    },
  });
  return {
    deps,
    commands,
    hook,
    checks: () => checks,
    emit: async (
      name: string,
      event: Parameters<Parameters<RunEndHost["on"]>[1]>[0] = {},
      ctx = { cwd: "/repo", agent: { kind: "main" } },
    ) => handlers.get(name)?.(event, ctx),
  };
}
test("exhausted or invalid session skips git and documentation collection in both hosts", async () => {
  for (const isOmp of [true, false]) {
    for (const limits of [
      { maxCalls: 0 },
      { maxUsd: 0 },
      { configurationError: "Invalid JEV_TOOLS_MAX_CALLS" },
    ]) {
      const h = harness(isOmp);
      h.deps.runtime.session = new Session(limits);
      assert.equal(
        await h.emit(isOmp ? "session_stop" : "agent_before_settle", {
          outcome: "completed",
        }),
        undefined,
      );
      assert.equal(h.commands.length, 0);
      assert.equal(h.checks(), 0);
      assert.equal(h.deps.runtime.session.snapshot().refusals, 0);
    }
  }
});
test("each host checks once per prompt even when no section is flagged", async () => {
  for (const isOmp of [true, false]) {
    const h = harness(isOmp, {}, { ...flagged, findings: [] });
    const event = { outcome: "completed", entries: [] };
    const stop = isOmp ? "session_stop" : "agent_before_settle";
    assert.equal(await h.emit(stop, event), undefined);
    assert.equal(await h.emit(stop, event), undefined);
    await h.emit("agent_start");
    assert.equal(await h.emit(stop, event), undefined);
    assert.equal(h.checks(), 1);
    assert.equal(h.commands.length, 1);
    await h.emit("before_agent_start");
    assert.equal(await h.emit(stop, event), undefined);
    assert.equal(h.checks(), 2);
  }
});

test("omp relaunches once with designated sentences, reset only by a user prompt", async () => {
  const h = harness(true);
  const first = (await h.emit("session_stop")) as {
    continue: boolean;
    additionalContext: string;
  };
  assert.equal(first.continue, true);
  assertFlaggedContext(first.additionalContext);
  assert.equal(await h.emit("session_stop"), undefined);
  await h.emit("agent_start");
  assert.equal(await h.emit("session_stop"), undefined);
  await h.emit("before_agent_start");
  const second = (await h.emit("session_stop")) as {
    continue: boolean;
    additionalContext: string;
  };
  assert.equal(second.continue, true);
  assertFlaggedContext(second.additionalContext);
  assert.equal(h.checks(), 2);
  assert.deepEqual(h.commands[0], [
    "git",
    "--no-optional-locks",
    "status",
    "--porcelain",
    "--untracked-files=normal",
  ]);
});

test("pi preserves entries and relaunches once despite canContinue=false", async () => {
  const h = harness();
  const entries = [
    { type: "custom" as const, customType: "existing", data: 7 },
  ];
  const event = {
    outcome: "completed",
    entries,
    context: { canContinue: false },
  };
  const response = (await h.emit("agent_before_settle", event)) as {
    continue: boolean;
    entries: Array<{
      type: string;
      customType: string;
      content?: string;
      display?: boolean;
      data?: number;
    }>;
  };
  assert.equal(response.continue, true);
  assert.deepEqual(response.entries.slice(0, -1), entries);
  const added = response.entries.at(-1);
  assert.equal(added?.type, "custom_message");
  assert.equal(added?.customType, "jev-check-diff");
  assert.equal(added?.display, false);
  assertFlaggedContext(added?.content);
  assert.equal(await h.emit("agent_before_settle", event), undefined);
  await h.emit("agent_start");
  assert.equal(await h.emit("agent_before_settle", event), undefined);
  await h.emit("before_agent_start");
  const repeated = (await h.emit(
    "agent_before_settle",
    event,
  )) as typeof response;
  assert.equal(repeated.continue, true);
  assert.deepEqual(repeated.entries.slice(0, -1), entries);
  assertFlaggedContext(repeated.entries.at(-1)?.content);
});
test("host guards perform no git or docs work", async () => {
  const omp = harness(true);
  assert.equal(
    await omp.emit("session_stop", { stop_hook_active: true }),
    undefined,
  );
  assert.equal(
    await omp.emit(
      "session_stop",
      {},
      { cwd: "/repo", agent: { kind: "sub" } },
    ),
    undefined,
  );
  assert.equal(
    await omp.emit("agent_before_settle", { outcome: "completed" }),
    undefined,
  );
  const pi = harness();
  for (const outcome of ["aborted", "failed", "error"])
    assert.equal(await pi.emit("agent_before_settle", { outcome }), undefined);
  assert.equal(await pi.emit("session_stop"), undefined);
  assert.deepEqual(omp.commands, []);
  assert.deepEqual(pi.commands, []);
});
test("unconfigured, disabled and clean trees silently skip", async () => {
  const missing = harness(true);
  missing.deps.client = undefined;
  assert.equal(await missing.emit("session_stop"), undefined);
  const disabled = harness(true, { env: { JEV_TOOLS_AUTO_DOCS: "0" } });
  assert.equal(await disabled.emit("session_stop"), undefined);
  assert.deepEqual(missing.commands, []);
  assert.deepEqual(disabled.commands, []);
  const clean = harness(true);
  clean.deps.exec = async () => ({
    code: 0,
    killed: false,
    stdout: "",
    stderr: "",
  });
  assert.equal(await clean.emit("session_stop"), undefined);
  assert.equal(clean.checks(), 0);
});
test("only flagged verdicts with designated sentences enter the message", async () => {
  const finding = flagged.findings[0];
  assert.ok(finding);
  const result: DocsCheckResult = {
    ...flagged,
    findings: [
      finding,
      { ...finding, band: "unsure", probability: 0.99 },
      { ...finding, probability: 0.69 },
      { ...finding, sentence: undefined },
    ],
  };
  const h = harness(true, {}, result);
  const response = (await h.emit("session_stop")) as {
    continue: boolean;
    additionalContext: string;
  };
  assert.equal(response.continue, true);
  assertFlaggedContext(response.additionalContext);
});
test("collection exhaustion without flags and cap refusal are silent", async () => {
  const empty = harness(
    true,
    {},
    { ...flagged, status: "collect_budget_reached", findings: [] },
  );
  assert.equal(await empty.emit("session_stop"), undefined);
  const partial = harness(
    true,
    {},
    { ...flagged, status: "collect_budget_reached" },
  );
  const response = (await partial.emit("session_stop")) as {
    continue: boolean;
    additionalContext: string;
  };
  assert.equal(response.continue, true);
  assertFlaggedContext(response.additionalContext);
  const cap = harness(
    true,
    {},
    {
      ...flagged,
      envelope: {
        lines: [{ type: "refusal", message: "Session cap reached" }],
      },
    },
  );
  assert.equal(await cap.emit("session_stop"), undefined);
});
test("total budget includes git and abandons findings using injected clock", async () => {
  let now = 0;
  let budget: number | undefined;
  let maxCalls: number | undefined;
  const h = harness(true, {
    now: () => now,
    check: async (_deps, input) => {
      budget = input.budgetMs;
      maxCalls = input.maxCalls;
      now = 15_001;
      return flagged;
    },
  });
  h.deps.exec = async () => {
    now = 1_000;
    return { code: 0, killed: false, stdout: "?? src/cli.ts", stderr: "" };
  };
  assert.equal(await h.emit("session_stop"), undefined);
  assert.equal(budget, 14_000);
  assert.equal(maxCalls, RUN_END_DOCS_MAX_CALLS);
  const git = harness(true, { now: () => now });
  now = 0;
  git.deps.exec = async () => {
    now = 15_001;
    return { code: 0, killed: false, stdout: " M src/cli.ts", stderr: "" };
  };
  assert.equal(await git.emit("session_stop"), undefined);
  assert.equal(git.checks(), 0);
  const exceeded = harness(true, {}, { ...flagged, status: "budget_exceeded" });
  assert.equal(await exceeded.emit("session_stop"), undefined);
});

test("real docs checking includes untracked code and shares session caps", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "run-end-"));
  const execute = promisify(execFile);
  const h = harness(true);
  let requests = 0;
  h.deps.exec = async (command, args, options) => ({
    ...(await execute(command, args, options)),
    code: 0,
    killed: false,
  });
  h.deps.client = {
    clearCache() {},
    async judge(_state, questions, options) {
      const admitted = options?.beforeRequest?.(Object.keys(questions).length);
      if (admitted && !admitted.ok)
        return { ok: false, error: admitted.error, kind: "budget" };
      requests++;
      return {
        ok: true,
        calls: 1,
        answers: {
          status: {
            type: "choice",
            source: "fresh" as const,
            choice: "now_false",
            confidence: 1,
            probabilities: { now_false: 1 },
          },
          sentence: {
            type: "choice",
            source: "fresh" as const,
            choice: "s1",
            confidence: 1,
            probabilities: { s1: 1 },
          },
        },
      };
    },
  };
  try {
    await execute("git", ["init", "-q"], { cwd });
    await writeFile(
      join(cwd, "README.md"),
      "# Value\n`value` in `new.ts` returns one.\n",
    );
    await execute("git", ["add", "."], { cwd });
    await execute(
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
      { cwd },
    );
    await execute("git", ["config", "status.showUntrackedFiles", "no"], {
      cwd,
    });
    await writeFile(
      join(cwd, "new.ts"),
      "export function value() { return 2; }\n",
    );
    const hook = new RunEnd(h.deps, { env: {} });
    const flaggedMessage = await hook.onRunEnd({ cwd });
    assert.equal(typeof flaggedMessage, "string");
    assert.ok(flaggedMessage?.includes("README.md"));
    assert.ok(flaggedMessage?.includes("new.ts"));
    assert.equal(h.deps.runtime.session.snapshot().calls, 1);
    assert.equal(requests, 1);
    h.deps.runtime.session = new Session({ maxCalls: 0 });
    assert.equal(
      await new RunEnd(h.deps, { env: {} }).onRunEnd({ cwd }),
      undefined,
    );
    assert.equal(requests, 1);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("the automatic cap bounds docs requests and names the sections it skipped", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "run-end-cap-"));
  const execute = promisify(execFile);
  const h = harness(true);
  let requests = 0;
  h.deps.exec = async (command, args, options) => ({
    ...(await execute(command, args, options)),
    code: 0,
    killed: false,
  });
  const client: JevClient = {
    clearCache() {},
    async judge(state, questions, options) {
      const admitted = options?.beforeRequest?.(Object.keys(questions).length);
      if (admitted && !admitted.ok)
        return { ok: false, error: admitted.error, kind: "budget" };
      requests++;
      // Only the first judged section is reported stale; the rest exist to
      // exhaust the cap, not to produce findings.
      const current = ((state.docs as { path?: string }[] | undefined) ?? [])[0]
        ?.path;
      const stale = current === "README.md";
      return {
        ok: true,
        calls: 1,
        answers: Object.fromEntries(
          Object.keys(questions).map((id) => [
            id,
            {
              type: "choice" as const,
              choice: stale ? "now_false" : "holds",
              confidence: 1,
              probabilities: { now_false: 1, holds: 1, s1: 1 },
            },
          ]),
        ),
      };
    },
  };
  h.deps.client = client;
  try {
    await execute("git", ["init", "-q"], { cwd });
    // More documentation sections than the automatic cap allows.
    const count = RUN_END_DOCS_MAX_CALLS + 6;
    const readme = Array.from(
      { length: count },
      (_, i) =>
        `## Section ${i}\n\`value${i}\` in \`new${i}.ts\` returns one.\n`,
    ).join("\n");
    await writeFile(join(cwd, "README.md"), readme);
    for (let i = 0; i < count; i++)
      await writeFile(
        join(cwd, `new${i}.ts`),
        `export function value${i}() { return 1; }\n`,
      );
    await execute("git", ["add", "."], { cwd });
    await execute(
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
      { cwd },
    );
    await execute("git", ["config", "status.showUntrackedFiles", "no"], {
      cwd,
    });
    for (let i = 0; i < count; i++)
      await writeFile(
        join(cwd, `new${i}.ts`),
        `export function value${i}() { return 2; }\n`,
      );
    let passed: number | undefined;
    let unchecked: readonly string[] = [];
    const hook = new RunEnd(h.deps, {
      env: {},
      check: async (deps, input) => {
        passed = input.maxCalls;
        const result = await runDocsCheck(
          { ...deps, client, exec: deps.exec },
          { cwd, maxCalls: input.maxCalls },
        );
        unchecked = [
          ...(result.unjudged?.sections ?? []),
          ...result.envelope.lines.flatMap((line) =>
            line.type === "unchecked" ? line.items : [],
          ),
        ];
        return result;
      },
    });
    await hook.onRunEnd({ cwd });
    assert.equal(passed, RUN_END_DOCS_MAX_CALLS);
    assert.ok(
      requests <= RUN_END_DOCS_MAX_CALLS,
      `sent ${requests} requests above the automatic cap of ${RUN_END_DOCS_MAX_CALLS}`,
    );
    // Sections past the cap stay visible; they are never dropped silently.
    assert.ok(
      unchecked.length > 0,
      `sections beyond the cap must be reported as unchecked; got ${JSON.stringify(unchecked)}`,
    );
    assert.ok(
      unchecked.some((line) => /max_calls/.test(line)),
      `expected a max_calls limit line, got: ${unchecked.join(" | ")}`,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

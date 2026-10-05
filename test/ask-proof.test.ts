import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import type { GitExec } from "../src/core/git.ts";
import { Guide } from "../src/guide.ts";
import { detectHost } from "../src/host.ts";
import type { JevClient, State } from "../src/jev/types.ts";
import { Session } from "../src/session.ts";
import { createAskTool } from "../src/tools/ask.ts";

const execute = promisify(execFile);
const gitExec: GitExec = async (command, args, options) => {
  try {
    const result = await execute(command, args, options);
    return { ...result, code: 0, killed: false };
  } catch (error) {
    if (
      error instanceof Error &&
      "stdout" in error &&
      "stderr" in error &&
      "code" in error
    ) {
      return {
        stdout: String(error.stdout),
        stderr: String(error.stderr),
        code: Number(error.code),
        killed: false,
      };
    }
    throw error;
  }
};

async function commitBase(cwd: string): Promise<void> {
  await gitExec("git", ["init", "-q"], { cwd, timeout: 10000 });
  await gitExec("git", ["add", "."], { cwd, timeout: 10000 });
  const result = await gitExec(
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
  assert.equal(result.code, 0, result.stderr);
}
for (const moved of [true, false]) {
  test(`attribution ${moved ? "moves away from" : "remains on"} the designated file`, async () => {
    const cwd = await mkdtemp(join(tmpdir(), "jev-ask-proof-"));
    try {
      await writeFile(
        join(cwd, "auth.ts"),
        "export function auth(request) { return request.headers.authorization; }\n",
      );
      await writeFile(
        join(cwd, "logs.ts"),
        "export function log(message) { console.log(message); }\n",
      );
      const observed: State[] = [];
      const client: JevClient = {
        clearCache() {},
        async judge(state, questions, options) {
          options?.beforeRequest?.(Object.keys(questions).length);
          observed.push(state);
          const pick = observed.length === 1 || !moved ? "auth.ts" : "none";
          return {
            ok: true,
            calls: 1,
            questions: 1,
            answers: {
              q1: {
                type: "choice",
                choice: pick,
                confidence: 0.99,
                probabilities: {
                  "auth.ts": pick === "auth.ts" ? 0.99 : 0,
                  "logs.ts": 0,
                  none: pick === "none" ? 0.99 : 0,
                  cannot_tell: 0.01,
                },
              },
            },
          };
        },
      };
      const host = detectHost({});
      const result = await createAskTool({
        client,
        host,
        exec: async () => ({
          code: 1,
          stdout: "",
          stderr: "not a repository",
          killed: false,
        }),
        runtime: { session: new Session({}), guide: new Guide(host) },
      }).execute(
        "proof",
        {
          paths: ["auth.ts", "logs.ts"],
          asks: {
            intent: "locate",
            about: "files",
            target: "reads the Authorization header",
            among: ["auth.ts", "logs.ts"],
            count: "one",
            attribution: true,
          },
        },
        undefined,
        undefined,
        { cwd },
      );
      assert.equal(observed.length, 2);
      assert.deepEqual(observed[1]?.files, {
        "logs.ts": "export function log(message) { console.log(message); }\n",
      });
      assert.match(
        result.content[0]?.text ?? "",
        moved ? /attributed/ : /does not rest on it/,
      );
      assert.equal(result.details.calls, 2);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
}

test("base preserves exact snapshots and adds an orphan before judging", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "jev-ask-base-"));
  try {
    await writeFile(join(cwd, "policy.ts"), "export const days = 7;\n");
    await commitBase(cwd);
    await writeFile(join(cwd, "policy.ts"), "export const days = 14;\n");
    await writeFile(join(cwd, "new.ts"), "export const created = true;\n");
    let captured: State | undefined;
    const client: JevClient = {
      clearCache() {},
      async judge(state, questions) {
        captured = state;
        return {
          ok: true,
          calls: 1,
          questions: Object.keys(questions).length,
          answers: { q1: { type: "bool", p: 0.99 } },
        };
      },
    };
    const host = detectHost({});
    await createAskTool({
      client,
      host,
      exec: gitExec,
      runtime: { session: new Session({}), guide: new Guide(host) },
    }).execute(
      "base",
      {
        paths: ["new.ts"],
        base: "HEAD",
        asks: {
          intent: "free",
          question: {
            type: "bool",
            instructions: "Does policy.ts now set days to 14?",
          },
        },
      },
      undefined,
      undefined,
      { cwd },
    );
    assert.deepEqual(captured?.files, {
      "new.ts": "export const created = true;\n",
      "policy.ts": "export const days = 14;\n",
    });
    assert.deepEqual(captured?.files_before, {
      "new.ts": null,
      "policy.ts": "export const days = 7;\n",
    });
    const revision = await gitExec("git", ["rev-parse", "HEAD"], {
      cwd,
      timeout: 10000,
    });
    assert.equal(captured?.base_sha, revision.stdout.trim());
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("empty cited evidence blocks only its reading", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "jev-ask-empty-"));
  try {
    await writeFile(join(cwd, "empty.md"), "");
    await writeFile(join(cwd, "policy.ts"), "export const days = 14;\n");
    await commitBase(cwd);
    let judged: string[] = [];
    const client: JevClient = {
      clearCache() {},
      async judge(_state, questions) {
        judged = Object.keys(questions);
        return {
          ok: true,
          calls: 1,
          questions: judged.length,
          answers: { q2: { type: "bool", source: "fresh", p: 0.99 } },
        };
      },
    };
    const host = detectHost({});
    const result = await createAskTool({
      client,
      host,
      exec: gitExec,
      runtime: { session: new Session({}), guide: new Guide(host) },
    }).execute(
      "empty",
      {
        paths: ["empty.md", "policy.ts"],
        asks: [
          {
            intent: "free",
            about: 'files["empty.md"]',
            question: {
              type: "bool",
              instructions: "Does empty.md document the policy?",
            },
          },
          {
            intent: "free",
            question: {
              type: "bool",
              instructions: "Does policy.ts set days to 14?",
            },
          },
        ],
      },
      undefined,
      undefined,
      { cwd },
    );
    assert.deepEqual(judged, ["q2"]);
    const report = result.details.result;
    assert.equal(report.execution, "partial");
    assert.equal(report.items[0]?.treatment, "not_judged");
    assert.equal(report.items[1]?.treatment, "judged");
    assert.ok(
      report.diagnostics.some((diagnostic) =>
        diagnostic.fact.includes("empty.md"),
      ),
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("closure excludes unused exports while base retains exact dependency snapshots", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "jev-ask-closure-"));
  try {
    await writeFile(
      join(cwd, "refund.ts"),
      "import { DAYS } from './limits.ts';\nexport function eligible(age) { return age <= DAYS; }\n",
    );
    await writeFile(
      join(cwd, "limits.ts"),
      "export const DAYS = 7;\nexport const UNRELATED = 200;\n",
    );
    await commitBase(cwd);
    await writeFile(
      join(cwd, "limits.ts"),
      "export const DAYS = 14;\nexport const UNRELATED = 200;\n",
    );
    let captured: State | undefined;
    const client: JevClient = {
      clearCache() {},
      async judge(state) {
        captured = state;
        return {
          ok: true,
          calls: 1,
          questions: 1,
          answers: { q1: { type: "bool", p: 0.99 } },
        };
      },
    };
    const host = detectHost({});
    await createAskTool({
      client,
      host,
      exec: gitExec,
      runtime: { session: new Session({}), guide: new Guide(host) },
    }).execute(
      "closure",
      {
        paths: ["refund.ts"],
        base: "HEAD",
        asks: {
          intent: "free",
          question: {
            type: "bool",
            instructions:
              "Does the eligibility window now extend to fourteen days?",
          },
        },
      },
      undefined,
      undefined,
      { cwd },
    );
    assert.deepEqual(captured?.closure, {
      "limits.ts (DAYS)": {
        before: "export const DAYS = 7;",
        after: "export const DAYS = 14;",
      },
    });
    assert.deepEqual(captured?.files_before, {
      "refund.ts":
        "import { DAYS } from './limits.ts';\nexport function eligible(age) { return age <= DAYS; }\n",
      "limits.ts": "export const DAYS = 7;\nexport const UNRELATED = 200;\n",
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("closure reads only reached dependencies and keeps semantic depth one", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "jev-ask-reached-"));
  try {
    await writeFile(
      join(cwd, "main.ts"),
      'import { value } from "./barrel"; export const answer = value();',
    );
    await writeFile(join(cwd, "barrel.ts"), 'export { value } from "./value";');
    await writeFile(
      join(cwd, "value.ts"),
      'import { deeper } from "./deeper"; export function value() { return deeper(); }',
    );
    await writeFile(
      join(cwd, "deeper.ts"),
      'export function deeper() { return "DEPTH_TWO_MARKER"; }',
    );
    await writeFile(
      join(cwd, "unrelated.ts"),
      "BROKEN_UNRELATED_MARKER".repeat(100000),
    );
    await commitBase(cwd);
    let captured: State | undefined;
    const client: JevClient = {
      clearCache() {},
      async judge(state) {
        captured = state;
        return {
          ok: true,
          calls: 1,
          questions: 1,
          answers: { q1: { type: "bool", p: 0.99 } },
        };
      },
    };
    const host = detectHost({});
    const result = await createAskTool({
      client,
      host,
      exec: gitExec,
      runtime: { session: new Session({}), guide: new Guide(host) },
    }).execute(
      "reached",
      {
        paths: ["main.ts"],
        asks: {
          intent: "free",
          question: { type: "bool", instructions: "Does answer call value?" },
        },
      },
      undefined,
      undefined,
      { cwd },
    );
    assert.deepEqual(captured?.closure, {
      "value.ts (value)": "export function value() { return deeper(); }",
    });
    assert.ok(!JSON.stringify(captured).includes("DEPTH_TWO_MARKER"));
    assert.ok(!JSON.stringify(captured).includes("BROKEN_UNRELATED_MARKER"));
    assert.ok(!(result.content[0]?.text ?? "").includes("unrelated.ts"));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("tracked ignored orphan evidence never reaches the judge", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "jev-ask-ignored-"));
  try {
    await writeFile(join(cwd, "safe.ts"), "export const safe = true;");
    await writeFile(join(cwd, ".gitignore"), ".env\n");
    await writeFile(join(cwd, ".env"), "API_KEY=SECRET_MARKER\n");
    await commitBase(cwd);
    const forced = await gitExec("git", ["add", "-f", ".env"], {
      cwd,
      timeout: 10000,
    });
    assert.equal(forced.code, 0);
    let calls = 0;
    const client: JevClient = {
      clearCache() {},
      async judge() {
        calls++;
        throw new Error("Ignored evidence must block the reading");
      },
    };
    const host = detectHost({});
    const result = await createAskTool({
      client,
      host,
      exec: gitExec,
      runtime: { session: new Session({}), guide: new Guide(host) },
    }).execute(
      "ignored",
      {
        paths: ["safe.ts"],
        asks: {
          intent: "free",
          about: 'files[".env"]',
          question: {
            type: "bool",
            instructions: "Does `.env` contain an API key?",
          },
        },
      },
      undefined,
      undefined,
      { cwd },
    );
    assert.equal(calls, 0);
    assert.ok(!JSON.stringify(result).includes("SECRET_MARKER"));
    const report = result.details.result;
    assert.equal(report.execution, "not_judged");
    assert.equal(report.items[0]?.treatment, "not_judged");
    assert.equal(report.items[0]?.source, "none");
    assert.equal(report.accounting.httpAttempts, 0);
    assert.ok(
      report.diagnostics.some(
        (diagnostic) =>
          diagnostic.cause === "missing_required" &&
          diagnostic.target.status === "known" &&
          diagnostic.target.value === ".env",
      ),
    );
    assert.ok(
      report.actions.some((action) => action.code === "provide_evidence"),
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

async function historicalAsk(cwd: string, selectors: string[]) {
  const observed: State[] = [];
  const client: JevClient = {
    clearCache() {},
    async judge(state, questions) {
      observed.push(state);
      return {
        ok: true,
        calls: 1,
        questions: Object.keys(questions).length,
        answers: Object.fromEntries(
          Object.keys(questions).map((id) => [
            id,
            { type: "bool" as const, source: "fresh" as const, p: 0.99 },
          ]),
        ),
      };
    },
  };
  const host = detectHost({});
  const result = await createAskTool({
    client,
    host,
    exec: gitExec,
    runtime: { session: new Session({}), guide: new Guide(host) },
  }).execute(
    "history",
    {
      paths: ["safe.ts"],
      base: "HEAD",
      asks: selectors.map((about) => ({
        intent: "free" as const,
        about,
        question: {
          type: "bool" as const,
          instructions: "Does this evidence contain the marker?",
        },
      })),
    },
    undefined,
    undefined,
    { cwd },
  );
  return { observed, result };
}

test("deleted historical files are admitted, aliases do not copy content, and before-first retains current", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "jev-ask-history-"));
  try {
    await writeFile(join(cwd, "safe.ts"), "export const safe = true;");
    await writeFile(join(cwd, "deleted.ts"), "DELETED_HISTORY_MARKER");
    await writeFile(join(cwd, "changed.ts"), "BEFORE_HISTORY_MARKER");
    await commitBase(cwd);
    await rm(join(cwd, "deleted.ts"));
    await writeFile(join(cwd, "changed.ts"), "CURRENT_HISTORY_MARKER");
    const { observed } = await historicalAsk(cwd, [
      'files_before["deleted.ts"]',
      'files_before["changed.ts"]',
      'files["changed.ts"]',
      'files_before["./deleted.ts"]',
    ]);
    assert.ok(observed.length > 0);
    for (const state of observed) {
      assert.equal(
        (state.files as Record<string, string>)["changed.ts"],
        "CURRENT_HISTORY_MARKER",
      );
      assert.deepEqual(state.files_before, {
        "safe.ts": "export const safe = true;",
        "deleted.ts": "DELETED_HISTORY_MARKER",
        "changed.ts": "BEFORE_HISTORY_MARKER",
      });
      assert.equal(
        JSON.stringify(state.files_before).split("DELETED_HISTORY_MARKER")
          .length - 1,
        1,
      );
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("twenty-one deleted selectors produce material omissions without leaking the extra identity", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "jev-ask-history-limit-"));
  try {
    await writeFile(join(cwd, "safe.ts"), "export const safe = true;");
    const paths = Array.from({ length: 21 }, (_, i) => `deleted${i}.ts`);
    for (const path of paths)
      await writeFile(join(cwd, path), `HISTORY_${path}_MARKER`);
    await commitBase(cwd);
    for (const path of paths) await rm(join(cwd, path));
    const { observed, result } = await historicalAsk(
      cwd,
      paths.map((path) => `files_before[${JSON.stringify(path)}]`),
    );
    assert.ok(observed.length > 0);
    for (const state of observed) {
      const before = state.files_before as Record<string, string | null>;
      assert.equal(Object.keys(before).length, 20);
      assert.ok(!Object.hasOwn(before, "deleted19.ts"));
      assert.ok(!Object.hasOwn(before, "deleted20.ts"));
      assert.ok(!JSON.stringify(state).includes("HISTORY_deleted20.ts_MARKER"));
    }
    assert.ok(
      result.details.result.items.some(
        (item) => item.treatment === "not_judged",
      ),
    );
    assert.ok(
      result.details.result.diagnostics.some((diagnostic) =>
        diagnostic.fact.includes("ASK_MAX_FILES"),
      ),
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

for (const kind of ["ignored", "symlink", "nul"] as const) {
  test(`historical ${kind} evidence is not disclosed to the endpoint`, async () => {
    const cwd = await mkdtemp(join(tmpdir(), "jev-ask-history-reject-"));
    try {
      await writeFile(join(cwd, "safe.ts"), "export const safe = true;");
      const path = kind === "ignored" ? ".env" : "unsafe.ts";
      if (kind === "symlink")
        await symlink("HISTORICAL_SECRET_MARKER", join(cwd, path));
      else
        await writeFile(
          join(cwd, path),
          kind === "nul"
            ? "HISTORICAL_SECRET_MARKER\0binary"
            : "HISTORICAL_SECRET_MARKER",
        );
      await commitBase(cwd);
      if (kind === "ignored")
        await writeFile(join(cwd, ".gitignore"), ".env\n");
      await rm(join(cwd, path));
      const { observed, result } = await historicalAsk(cwd, [
        `files_before[${JSON.stringify(path)}]`,
      ]);
      assert.equal(observed.length, 0);
      assert.equal(result.details.result.accounting.httpAttempts, 0);
      assert.ok(!JSON.stringify(result).includes("HISTORICAL_SECRET_MARKER"));
      assert.ok(
        result.details.result.items.every(
          (item) => item.treatment === "not_judged",
        ),
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
}

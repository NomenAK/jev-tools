import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { checkFileAdmission, collectFiles } from "../src/adapters/files.ts";
import { collectUnits } from "../src/adapters/git.ts";
import { collectTestInventory } from "../src/adapters/test-inventory.ts";
import type { GitExec } from "../src/core/git.ts";
import {
  type ResultReportV1,
  validateResultReport,
} from "../src/core/result-report.ts";
import { isSecretPath } from "../src/core/secret-path.ts";
import { Guide } from "../src/guide.ts";
import { detectHost } from "../src/host.ts";
import type { Answer, JevClient } from "../src/jev/types.ts";
import { isResultReport } from "../src/report-schema.ts";
import { Session } from "../src/session.ts";
import { createAskTool } from "../src/tools/ask.ts";
import { createCheckDiffTool } from "../src/tools/check-diff.ts";
import { runDocsCheck } from "../src/tools/docs-check.ts";
import { createSelectTestsTool } from "../src/tools/select-tests.ts";

const FAKE = "FAKE_SECRET_VALUE_7f3a";
const run = promisify(execFile);
const exec: GitExec = async (command, args, options) => {
  try {
    return { ...(await run(command, args, options)), code: 0, killed: false };
  } catch (error) {
    const value = error as {
      stdout?: string;
      stderr?: string;
      code?: number;
      killed?: boolean;
    };
    return {
      stdout: value.stdout ?? "",
      stderr: value.stderr ?? "",
      code: value.code ?? 1,
      killed: value.killed ?? false,
    };
  }
};

/** Answers every question and records every serialized payload. */
function recordingClient(payloads: string[]): JevClient {
  return {
    clearCache() {},
    async judge(state, questions) {
      payloads.push(JSON.stringify({ state, questions }));
      const answers: Record<string, Answer> = {};
      for (const [id, question] of Object.entries(questions)) {
        if (question.type === "bool")
          answers[id] = { type: "bool", source: "fresh", p: 0.01 };
        else if (question.type === "choice") {
          const keys = Object.keys(question.criteria);
          const choice = keys[0] ?? "";
          answers[id] = {
            type: "choice",
            source: "fresh",
            choice,
            confidence: 0.99,
            probabilities: Object.fromEntries(
              keys.map((key) => [
                key,
                key === choice ? 0.99 : 0.01 / Math.max(1, keys.length - 1),
              ]),
            ),
          };
        } else
          answers[id] = {
            type: "score",
            source: "fresh",
            score: 1,
            confidence: 1,
            probabilities: { "1": 1 },
            legend: {},
          };
      }
      return {
        ok: true,
        answers,
        calls: 1,
        questions: Object.keys(questions).length,
      };
    },
  };
}

function deps(payloads: string[]) {
  const host = detectHost({});
  return {
    client: recordingClient(payloads),
    host,
    exec,
    runtime: { session: new Session({}), guide: new Guide(host) },
  };
}

function report(value: { details: unknown }): ResultReportV1 {
  const details = value.details;
  assert.ok(details && typeof details === "object" && "result" in details);
  const result = details.result;
  assert.ok(isResultReport(result));
  assert.deepEqual(validateResultReport(result), []);
  return result;
}

/** Repository with a tracked change, an untracked `.env` and `.env.example`. */
async function repository(t: TestContext): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "jev-secret-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    exec(
      "git",
      ["-c", "user.name=Test", "-c", "user.email=t@example.invalid", ...args],
      { cwd, timeout: 10_000 },
    );
  await git("init", "-q");
  await writeFile(
    join(cwd, "source.js"),
    "export function value() { return 1; }\n",
  );
  await writeFile(
    join(cwd, "value.test.js"),
    "import { test } from 'node:test'; import { value } from './source.js'; test('value result', () => value());\n",
  );
  await writeFile(join(cwd, "README.md"), "# value\n\n`value` returns one.\n");
  await git("add", ".");
  await git("commit", "-qm", "base");
  await writeFile(
    join(cwd, "source.js"),
    "export function value() { return 2; }\n",
  );
  await writeFile(join(cwd, ".env"), `API_TOKEN=${FAKE}\n`);
  await writeFile(join(cwd, ".env.example"), "API_TOKEN=\n");
  return cwd;
}

test("isSecretPath matches secret base names at any depth, case-insensitively", () => {
  for (const path of [
    ".env",
    "apps/web/.env",
    ".env.local",
    "config/.ENV.production",
    "certs/x.PEM",
    "key.pem",
    "home/id_rsa",
    "keys/id_rsa.pub",
    "store.p12",
    "credentials",
    "aws/credentials.json",
    "config/Secrets.yaml",
    "secrets",
    "a\\b\\.env",
  ])
    assert.equal(isSecretPath(path), true, path);
  for (const path of [
    ".env.example",
    "pkg/.env.sample",
    ".ENV.TEMPLATE",
    "src/env.ts",
    "src/secret.ts",
    "docs/my-credentials.md",
    "pem.txt",
    "environment",
  ])
    assert.equal(isSecretPath(path), false, path);
});

test("admission refuses secret names with secret_pattern before reading content", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "jev-secret-admission-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, "config"));
  await mkdir(join(cwd, "certs"));
  await writeFile(join(cwd, "config", "Secrets.yaml"), `token: ${FAKE}\n`);
  await writeFile(join(cwd, "certs", "x.PEM"), `${FAKE}\n`);
  await writeFile(join(cwd, ".env.example"), "TOKEN=\n");
  for (const path of ["config/Secrets.yaml", "certs/x.PEM"]) {
    const admission = await checkFileAdmission(cwd, path);
    assert.equal(admission.ok, false);
    if (!admission.ok) {
      assert.equal(admission.cause, "secret_pattern");
      assert.match(admission.error, new RegExp(path.replace(".", "\\.")));
    }
    const read = await collectFiles(cwd, [path]);
    assert.equal(read.ok, false);
    if (!read.ok) {
      assert.equal(read.cause, "secret_pattern");
      assert.equal(read.error.includes(FAKE), false);
    }
  }
  const example = await collectFiles(cwd, [".env.example"]);
  assert.equal(example.ok, true);
  if (example.ok) assert.equal(example.files[".env.example"], "TOKEN=\n");
});

test("diff and test-inventory collection name an untracked .env as secret_pattern and admit .env.example", async (t) => {
  const cwd = await repository(t);
  const collected = await collectUnits(exec, { cwd, base: "HEAD" });
  assert.ok(collected.ok);
  const env = collected.files.find((file) => file.path === ".env");
  assert.equal(env?.limitation, "secret_pattern");
  assert.equal(env?.after, null);
  assert.equal(env?.before, null);
  assert.deepEqual(env?.hunks, []);
  assert.ok(
    collected.limits.some(
      (limit) => limit.kind === "secret_pattern" && limit.file === ".env",
    ),
  );
  const example = collected.files.find((file) => file.path === ".env.example");
  assert.equal(example?.after, "API_TOKEN=\n");
  assert.equal(JSON.stringify(collected).includes(FAKE), false);
  const inventory = await collectTestInventory(exec, cwd);
  assert.ok(inventory.ok);
  assert.equal(inventory.paths.includes(".env"), false);
  assert.ok(inventory.paths.includes(".env.example"));
  assert.ok(
    inventory.limits.some(
      (limit) => limit.kind === "secret_pattern" && limit.path === ".env",
    ),
  );
});

test("check_diff, select_tests and the run-end docs check exclude .env by name and never send its value", async (t) => {
  const cwd = await repository(t);
  const payloads: string[] = [];
  const outputs: ResultReportV1[] = [];
  outputs.push(
    report(
      await createCheckDiffTool(deps(payloads)).execute(
        "risk",
        { check: "risk", witnesses: "off" },
        undefined,
        undefined,
        { cwd },
      ),
    ),
    report(
      await createSelectTestsTool(deps(payloads)).execute(
        "select",
        { witnesses: "off" },
        undefined,
        undefined,
        { cwd },
      ),
    ),
  );
  const docs = await runDocsCheck(deps(payloads), { cwd });
  outputs.push(docs.result);
  for (const result of outputs) {
    assert.ok(
      result.diagnostics.some(
        (diagnostic) =>
          diagnostic.cause === "secret_pattern" &&
          diagnostic.target.status === "known" &&
          diagnostic.target.value === ".env",
      ),
      `${result.tool} names .env as secret_pattern`,
    );
    assert.equal(JSON.stringify(result).includes(FAKE), false);
  }
  assert.ok(payloads.length > 0);
  for (const payload of payloads) assert.equal(payload.includes(FAKE), false);
});

test("jev_ask refuses a .env path with secret_pattern before reading it", async (t) => {
  const cwd = await repository(t);
  // Unreadable on POSIX: any read attempt would surface as file_unavailable.
  if (process.platform !== "win32") await chmod(join(cwd, ".env"), 0o000);
  const payloads: string[] = [];
  const result = await createAskTool(deps(payloads)).execute(
    "ask",
    {
      paths: [".env"],
      asks: {
        intent: "free",
        question: { type: "bool", instructions: "Is a token configured?" },
      },
    },
    undefined,
    undefined,
    { cwd },
  );
  const output = report(result);
  assert.equal(output.execution, "refused");
  assert.equal(output.diagnostics[0]?.cause, "secret_pattern");
  assert.match(output.diagnostics[0]?.fact ?? "", /\.env/);
  assert.equal(payloads.length, 0);
  assert.equal(JSON.stringify(result).includes(FAKE), false);
});

test("a jev_ask question that requires .env stays unjudged with secret_pattern", async (t) => {
  const cwd = await repository(t);
  await exec("git", ["add", "source.js"], { cwd, timeout: 10_000 });
  const payloads: string[] = [];
  const result = report(
    await createAskTool(deps(payloads)).execute(
      "ask",
      {
        paths: ["source.js"],
        asks: [
          {
            intent: "free",
            about: 'files[".env"]',
            question: { type: "bool", instructions: "Is a token configured?" },
          },
          {
            intent: "free",
            about: 'files["source.js"]',
            question: { type: "bool", instructions: "Does value return 2?" },
          },
        ],
      },
      undefined,
      undefined,
      { cwd },
    ),
  );
  const blocked = result.items.filter(
    (item) => item.treatment === "not_judged",
  );
  assert.ok(blocked.length > 0);
  assert.ok(
    result.diagnostics.some(
      (diagnostic) => diagnostic.cause === "secret_pattern",
    ),
  );
  for (const payload of payloads) assert.equal(payload.includes(FAKE), false);
  assert.equal(JSON.stringify(result).includes(FAKE), false);
});

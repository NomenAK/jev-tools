import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { execCommand } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/exec.js";
import { captureCommand } from "../src/adapters/command.ts";
import { spawnExec } from "../src/adapters/exec.ts";
import { powershellEnv } from "../src/adapters/private-storage.ts";
import type { GitExec } from "../src/core/git.ts";
import { Guide } from "../src/guide.ts";
import { detectHost } from "../src/host.ts";
import type { JevClient, State } from "../src/jev/types.ts";
import { Session } from "../src/session.ts";
import { createAskTool } from "../src/tools/ask.ts";

const windows = process.platform === "win32";
// Windows has no POSIX signals: process.kill(pid, "SIGTERM") exits with 1.
const posixSignals = windows
  ? { skip: "POSIX signal exit codes do not exist on Windows" }
  : {};
for (const mode of ["failure", "timeout", "missing"] as const)
  test(`command ${mode} is evidence rather than a successful exit`, async () => {
    let paths: string[] = [];
    const exec: GitExec = async (binary, args) => {
      if (binary === "git")
        return { stdout: "", stderr: "not a repo", code: 1, killed: false };
      if (mode === "missing") throw new Error("ENOENT env");
      paths = args.slice(-2);
      await writeFile(
        paths[0] ?? "",
        "AssertionError: expected invoice total\n",
      );
      await writeFile(paths[1] ?? "", "");
      return {
        stdout: "",
        stderr: "",
        code: mode === "timeout" ? 0 : 1,
        killed: mode === "timeout",
      };
    };
    let observed: State | undefined;
    const client: JevClient = {
      clearCache() {},
      async judge(state, questions, options) {
        assert.equal(options?.cache, false);
        observed = state;
        return {
          ok: true,
          answers: Object.fromEntries(
            Object.keys(questions).map((id) => [
              id,
              { type: "bool", source: "fresh", p: 0.99 },
            ]),
          ),
          calls: 1,
          questions: Object.keys(questions).length,
        };
      },
    };
    const host = detectHost({});
    const result = await createAskTool({
      client,
      host,
      exec,
      runtime: { guide: new Guide(host), session: new Session({}) },
    }).execute(
      "command",
      {
        command: "npm test",
        asks: {
          intent: "free",
          question: {
            type: "bool",
            instructions: "Does output show a failure?",
          },
        },
      },
      undefined,
      undefined,
      { cwd: process.cwd() },
    );
    if (mode === "missing") {
      assert.equal(observed, undefined);
      assert.equal(result.details.result.execution, "refused");
      assert.equal(result.details.result.context.command.execution, "started");
      assert.equal(
        result.details.result.context.command.exitCode.status,
        "unknown",
      );
      assert.equal(
        result.details.result.context.command.timedOut.status,
        "unknown",
      );
      assert.equal(result.details.result.accounting.httpAttempts, 0);
    } else {
      assert.equal(typeof observed?.output, "object");
      const output = observed?.output as Record<string, unknown>;
      assert.equal(output.exit_code, mode === "failure" ? 1 : null);
      assert.equal(output.timed_out, mode === "timeout");
      assert.match(result.content[0]?.text ?? "", /not identifiable/);
      assert.equal(result.details.result.context.command.execution, "finished");
    }
    for (const path of paths) await assert.rejects(access(path));
  });
test("real host bash capture preserves CI cwd stdout stderr and failed exit", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "jev-command-test-"));
  try {
    // Git for Windows bash reports $PWD as /c/...; cygpath -w gives C:\...
    const pwd = windows ? '"$(cygpath -w "$PWD")"' : '"$PWD"';
    const output = await captureCommand(
      (binary, args, options) => execCommand(binary, args, cwd, options),
      cwd,
      `printf '%s\\n' "$CI" ${pwd}; printf 'failure\\n' >&2; exit 7`,
    );
    assert.equal(output.ok, true);
    if (!output.ok) return;
    const [ci, reported] = output.output.stdout.split("\n");
    assert.equal(ci, "1");
    assert.equal(realpathSync.native(reported ?? ""), realpathSync.native(cwd));
    assert.equal(output.output.stdout, `${ci}\n${reported}\n`);
    assert.equal(output.output.stderr, "failure\n");
    assert.equal(output.output.exit_code, 7);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
test("command children never inherit JEV_TOOLS_API_KEY", async (t) => {
  const key = "child-env-secret-key";
  const previous = process.env.JEV_TOOLS_API_KEY;
  process.env.JEV_TOOLS_API_KEY = key;
  t.after(() => {
    if (previous === undefined) delete process.env.JEV_TOOLS_API_KEY;
    else process.env.JEV_TOOLS_API_KEY = previous;
  });
  const cwd = await mkdtemp(join(tmpdir(), "jev-command-env-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  for (const exec of [
    spawnExec,
    ((binary, args, options) =>
      execCommand(binary, args, cwd, options)) as GitExec,
  ]) {
    // No secret passed: only the child environment can reveal the key.
    const output = await captureCommand(exec, cwd, "env");
    assert.equal(output.ok, true);
    if (!output.ok) return;
    assert.match(output.output.stdout, /^CI=1$/m);
    assert.doesNotMatch(output.output.stdout, /JEV_TOOLS_API_KEY/);
    assert.equal(output.output.stdout.includes(key), false);
    assert.equal(output.redactions, 0);
  }
  const ps = powershellEnv(
    { Path: "C:\\Windows", jev_tools_api_key: key, PSModulePath: "x" },
    { JEV_PRIVATE_PATH: "C:\\p" },
  );
  assert.deepEqual(ps, { Path: "C:\\Windows", JEV_PRIVATE_PATH: "C:\\p" });
});
test("configured key echoed by a command is redacted before Jev sees the state", async () => {
  const key = "saved-config-secret-key";
  let command = "";
  const exec: GitExec = async (binary, args) => {
    if (binary === "git")
      return { stdout: "", stderr: "not a repo", code: 1, killed: false };
    command = args.join(" ");
    await writeFile(args.at(-2) ?? "", `token=${key}\nagain ${key}\n`);
    await writeFile(args.at(-1) ?? "", `stderr ${key}\n`);
    return { stdout: "", stderr: "", code: 0, killed: false };
  };
  const payloads: string[] = [];
  const client: JevClient = {
    clearCache() {},
    async judge(state, questions) {
      payloads.push(JSON.stringify(state));
      return {
        ok: true,
        answers: Object.fromEntries(
          Object.keys(questions).map((id) => [
            id,
            { type: "bool", source: "fresh", p: 0.99 },
          ]),
        ),
        calls: 1,
        questions: Object.keys(questions).length,
      };
    },
  };
  const host = detectHost({});
  const result = await createAskTool({
    client,
    host,
    exec,
    apiKey: key,
    runtime: { guide: new Guide(host), session: new Session({}) },
  }).execute(
    "redaction",
    {
      command: `echo ${key}`,
      asks: {
        intent: "free",
        question: { type: "bool", instructions: "Does output print a token?" },
      },
    },
    undefined,
    undefined,
    { cwd: process.cwd() },
  );
  assert.ok(command.includes(key), "the command itself still runs as given");
  assert.ok(payloads.length > 0);
  for (const payload of payloads) {
    assert.equal(payload.includes(key), false);
    assert.match(payload, /\[redacted\]/);
  }
  assert.ok(
    result.details.result.diagnostics.some((diagnostic) =>
      diagnostic.fact.includes(
        "4 occurrences of the configured Jev API key replaced with [redacted]",
      ),
    ),
  );
  assert.equal(JSON.stringify(result).includes(key), false);
});
test("oversized real command is refused after execution", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "jev-command-limit-"));
  let capturedPaths: string[] = [];
  try {
    const output = await captureCommand(
      async (binary, args, options) => {
        capturedPaths = args.slice(-2);
        return execCommand(binary, args, cwd, options);
      },
      cwd,
      "node -e 'const fs=require(\"node:fs\"); const block=Buffer.alloc(1024*1024,120); for(let i=0;i<65;i++) fs.writeSync(1,block)'",
      10,
    );
    assert.equal(output.ok, false);
    if (!output.ok)
      assert.match(output.error, /output exceeded 67108864 bytes/);
    for (const path of capturedPaths) await assert.rejects(access(path));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
test("two-stage command selection preserves streams and failure evidence", async () => {
  const lines = Array.from(
    { length: 38 },
    (_, index) =>
      `${String.fromCharCode(65 + Math.floor(index / 26), 65 + (index % 26))} ${"noise ".repeat(390)}`,
  );
  lines[19] = `CRITICAL AssertionError: invoice mismatch ${"details ".repeat(280)}`;
  const exec: GitExec = async (binary, args) => {
    if (binary === "git")
      return { stdout: "", stderr: "not a repo", code: 1, killed: false };
    await writeFile(args.at(-2) ?? "", lines.join("\n"));
    await writeFile(args.at(-1) ?? "", "STDERR: separate diagnostic\n");
    return { stdout: "", stderr: "", code: 1, killed: false };
  };
  let final: State | undefined;
  const client: JevClient = {
    clearCache() {},
    async judge(state, questions, options) {
      assert.equal(options?.cache, false);
      const evidence = state.evidence;
      assert.ok(
        evidence && typeof evidence === "object" && "context" in evidence,
      );
      const context = evidence.context;
      assert.ok(
        context && typeof context === "object" && "effectiveRoot" in context,
      );
      const effectiveRoot = context.effectiveRoot;
      assert.ok(
        effectiveRoot &&
          typeof effectiveRoot === "object" &&
          "path" in effectiveRoot,
      );
      assert.equal(typeof effectiveRoot.path, "string");
      if (Object.hasOwn(questions, "find")) {
        assert.equal(typeof state.output, "string");
        assert.equal(effectiveRoot.path, process.cwd());
      }
      if (!Object.hasOwn(questions, "find")) final = state;
      const p =
        typeof state.output === "string"
          ? state.output.includes("CRITICAL")
            ? 0.99
            : 0.01
          : 0.99;
      return {
        ok: true,
        answers: Object.fromEntries(
          Object.keys(questions).map((id) => [
            id,
            { type: "bool", source: "fresh", p },
          ]),
        ),
        calls: 1,
        questions: Object.keys(questions).length,
      };
    },
  };
  const host = detectHost({});
  const result = await createAskTool({
    client,
    host,
    exec,
    runtime: { guide: new Guide(host), session: new Session({}) },
  }).execute(
    "selection",
    {
      command: "npm test",
      asks: {
        intent: "free",
        question: { type: "bool", instructions: "Does output show a failure?" },
      },
    },
    undefined,
    undefined,
    { cwd: process.cwd() },
  );
  const output = final?.output as Record<string, unknown>;
  assert.equal(output.truncated, true);
  assert.match(
    String(output.stdout),
    /CRITICAL AssertionError: invoice mismatch/,
  );
  assert.match(String(output.stderr), /STDERR: separate diagnostic/);
  assert.doesNotMatch(String(output.stdout), /STDERR/);
  const report = result.details.result;
  assert.equal(report.context.command.execution, "finished");
  assert.deepEqual(report.context.command.exitCode, {
    status: "known",
    value: 1,
  });
  assert.deepEqual(report.context.command.timedOut, {
    status: "known",
    value: false,
  });
  assert.ok(report.accounting.auxiliary.passages.fresh > 0);
  assert.ok(
    report.diagnostics.some((diagnostic) =>
      diagnostic.fact.includes("selected passages"),
    ),
  );
  assert.ok(
    report.actions.some((action) => action.instruction.includes("exact text")),
  );
});
test("command beyond find limit refuses without judgment", async () => {
  const exec: GitExec = async (binary, args) => {
    if (binary === "git")
      return { stdout: "", stderr: "not a repo", code: 1, killed: false };
    await writeFile(
      args.at(-2) ?? "",
      Array.from(
        { length: 50 },
        (_, i) =>
          `${String.fromCharCode(65 + Math.floor(i / 26), 65 + (i % 26))}${"X".repeat(2197)}\n`,
      ).join(""),
    );
    await writeFile(args.at(-1) ?? "", "");
    return { stdout: "", stderr: "", code: 0, killed: false };
  };
  const client: JevClient = {
    clearCache() {},
    async judge() {
      throw new Error("no judgment allowed");
    },
  };
  const host = detectHost({});
  const result = await createAskTool({
    client,
    host,
    exec,
    runtime: { guide: new Guide(host), session: new Session({}) },
  }).execute(
    "limit",
    {
      command: "npm test",
      asks: {
        intent: "free",
        question: { type: "bool", instructions: "Does output show a failure?" },
      },
    },
    undefined,
    undefined,
    { cwd: process.cwd() },
  );
  const report = result.details.result;
  assert.equal(report.execution, "refused");
  assert.equal(report.context.command.execution, "finished");
  assert.deepEqual(report.context.command.exitCode, {
    status: "known",
    value: 0,
  });
  assert.equal(report.accounting.httpAttempts, 0);
  assert.ok(
    report.diagnostics.some(
      (diagnostic) =>
        diagnostic.cause === "evidence_too_large" &&
        diagnostic.fact.includes("find calls") &&
        diagnostic.fact.includes("110000 bytes before"),
    ),
  );
});
test("disabled command is absent from schema and rejected before execution", async () => {
  const previous = process.env.JEV_TOOLS_ALLOW_COMMAND;
  process.env.JEV_TOOLS_ALLOW_COMMAND = "0";
  try {
    const host = detectHost({ pi: {} });
    const client: JevClient = {
      clearCache() {},
      async judge() {
        throw new Error("no judgment allowed");
      },
    };
    const tool = createAskTool({
      client,
      host,
      exec: async () => {
        throw new Error("no execution allowed");
      },
      runtime: { guide: new Guide(host), session: new Session({}) },
    });
    assert.equal(Object.hasOwn(tool.parameters.properties, "command"), false);
    assert.equal(Object.hasOwn(tool.parameters.properties, "timeout_s"), false);
    assert.ok("approval" in tool);
    assert.equal(tool.approval({ command: "npm test", asks: [] }), "exec");
    assert.equal(tool.approval({ asks: [] }), "read");
    const result = await tool.execute(
      "disabled",
      {
        command: "npm test",
        asks: {
          intent: "free",
          question: {
            type: "bool",
            instructions: "Does output show a failure?",
          },
        },
      },
      undefined,
      undefined,
      { cwd: process.cwd() },
    );
    assert.match(result.content[0]?.text ?? "", /command disabled/);
  } finally {
    if (previous === undefined) delete process.env.JEV_TOOLS_ALLOW_COMMAND;
    else process.env.JEV_TOOLS_ALLOW_COMMAND = previous;
  }
});
test("about output command evidence reaches judgment", async () => {
  let calls = 0;
  const client: JevClient = {
    clearCache() {},
    async judge(state, questions, options) {
      calls++;
      assert.equal(options?.cache, false);
      assert.equal((state.output as Record<string, unknown>).exit_code, 7);
      return {
        ok: true,
        answers: Object.fromEntries(
          Object.keys(questions).map((id) => [
            id,
            { type: "bool", source: "fresh", p: 0.99 },
          ]),
        ),
        calls: 1,
        questions: Object.keys(questions).length,
      };
    },
  };
  const exec: GitExec = async (binary, args) => {
    if (binary === "git")
      return { stdout: "", stderr: "not a repo", code: 1, killed: false };
    await writeFile(args.at(-2) ?? "", "failed\n");
    await writeFile(args.at(-1) ?? "", "");
    return { stdout: "", stderr: "", code: 7, killed: false };
  };
  const host = detectHost({});
  await createAskTool({
    client,
    host,
    exec,
    runtime: { guide: new Guide(host), session: new Session({}) },
  }).execute(
    "output",
    {
      command: "exit 7",
      asks: {
        intent: "free",
        about: "output",
        question: {
          type: "bool",
          instructions: "Does output show an unsuccessful exit?",
        },
      },
    },
    undefined,
    undefined,
    { cwd: process.cwd() },
  );
  assert.equal(calls, 1);
});
test("abort during execution propagates without judgment and cleans capture", async () => {
  const controller = new AbortController();
  let paths: string[] = [];
  const exec: GitExec = async (_binary, args) => {
    paths = args.slice(-2);
    controller.abort();
    throw controller.signal.reason;
  };
  await assert.rejects(
    captureCommand(exec, process.cwd(), "sleep 10", 60, controller.signal),
    { name: "AbortError" },
  );
  for (const path of paths) await assert.rejects(access(path));
});
test(
  "signal death is rendered as failed exit instead of success",
  posixSignals,
  async () => {
    const cwd = process.cwd();
    const result = await captureCommand(
      (binary, args, options) => execCommand(binary, args, cwd, options),
      cwd,
      "node -e 'process.kill(process.pid, \"SIGTERM\")'",
    );
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.output.exit_code, 143);
  },
);
test("bounded physical lines preserve Unicode and following diagnostics", async () => {
  const result = await captureCommand(
    async (_binary, args) => {
      await writeFile(
        args.at(-2) ?? "",
        `${"a".repeat(8191)}😀${"b".repeat(100_000)}\nAssertionError: expected total\n`,
      );
      await writeFile(args.at(-1) ?? "", "");
      return { stdout: "", stderr: "", code: 1, killed: false };
    },
    process.cwd(),
    "test",
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.output.truncated, true);
  assert.equal(result.lineOmittedChars, 100002);
  assert.match(
    result.output.stdout,
    /a…\[line truncated at 8192 chars\]\nAssertionError: expected total/,
  );
  assert.doesNotMatch(result.output.stdout, /[\uD800-\uDBFF]/u);
});
test("a genuine exit 153 and a large command artifact are not output overflow", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "jev-command-artifact-"));
  try {
    const result = await captureCommand(
      (binary, args, options) => execCommand(binary, args, cwd, options),
      cwd,
      "truncate -s 70M artifact; printf done; exit 153",
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.output.exit_code, 153);
    assert.equal(result.output.stdout, "done\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
for (const runner of ["node-relative", "node-absolute", "jest", "pytest", "go"])
  test(`${runner} automatically adds only the failing test`, async () => {
    const cwd = await mkdtemp(join(tmpdir(), "jev-command-discovery-"));
    try {
      await execCommand("git", ["init", "-q"], cwd);
      const path =
        runner === "go"
          ? "bill_test.go"
          : runner === "pytest"
            ? "test_bill.py"
            : "bill.mjs";
      const source =
        runner === "go"
          ? 'package bill\nimport "testing"\nfunc TestBroken(t *testing.T) { t.Fatal("broken") }\n'
          : runner === "pytest"
            ? "class TestBill:\n    def test_total(self):\n        assert 5 == 6\n"
            : 'import test from "node:test";\nimport assert from "node:assert/strict";\ntest("bill", () => { assert.equal(5, 6); });\n';
      await writeFile(join(cwd, path), source);
      if (runner === "go") {
        for (const name of ["first", "second"]) {
          await mkdir(join(cwd, name));
          await writeFile(
            join(cwd, name, path),
            `package bill\nimport "testing"\nfunc TestHappy(t *testing.T) { }\n${"// filler\n".repeat(3000)}`,
          );
        }
      }
      const log =
        runner === "go"
          ? "=== RUN   TestHappy\nbill_test.go:3: happy\n--- PASS: TestHappy\n=== RUN   TestBroken\nbill_test.go:3: expected total\n--- FAIL: TestBroken (0.00s)"
          : runner === "pytest"
            ? `FAILED ${path}::TestBill::test_total[param with space] - AssertionError`
            : runner === "jest"
              ? `FAIL ${path}\nAssertionError: expected 5`
              : `✖ bill\n  test at ${runner === "node-absolute" ? pathToFileURL(join(cwd, path)).href : path}:3:1\nAssertionError: expected 5`;
      let observed: State | undefined;
      const client: JevClient = {
        clearCache() {},
        async judge(state, questions, options) {
          observed = state;
          assert.equal(options?.cache, false);
          return {
            ok: true,
            answers: Object.fromEntries(
              Object.keys(questions).map((id) => [
                id,
                { type: "bool", source: "fresh", p: 0.99 },
              ]),
            ),
            calls: 1,
            questions: Object.keys(questions).length,
          };
        },
      };
      const host = detectHost({});
      const result = await createAskTool({
        client,
        host,
        runtime: { guide: new Guide(host), session: new Session({}) },
        exec: async (binary, args, options) => {
          if (binary === "git") return execCommand(binary, args, cwd, options);
          await writeFile(args.at(-2) ?? "", log);
          await writeFile(args.at(-1) ?? "", "");
          return { stdout: "", stderr: "", code: 1, killed: false };
        },
      }).execute(
        "automatic",
        {
          command: "test",
          asks: {
            intent: "free",
            about: "output",
            question: {
              type: "bool",
              instructions: "Does the output show an assertion failure?",
            },
          },
        },
        undefined,
        undefined,
        { cwd },
      );
      assert.deepEqual(observed?.files, { [path]: source });
      assert.doesNotMatch(
        result.content[0]?.text ?? "",
        /not identifiable|abstain/,
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
test("node:test keeps its target when the failing block is past the first window", async () => {
  const passes = Array.from(
    { length: 30 },
    (_, index) => `\u2714 passing test ${index + 1} (0.1ms)`,
  );
  const stdout = [
    "\u2716 collects exactly one file (7.071906ms)",
    ...passes,
    "\u2139 tests 31",
    "\u2139 pass 30",
    "\u2139 fail 1",
    "",
    "\u2716 failing tests:",
    "",
    "test at zz-collect-a.test.mjs:15:1",
    "\u2716 collects exactly one file (7.071906ms)",
    "  AssertionError [ERR_ASSERTION]: boom",
  ].join("\n");
  const result = await captureCommand(
    (async (_binary: string, args: string[]) => {
      await writeFile(args.at(-2) ?? "", `${stdout}\n`);
      await writeFile(args.at(-1) ?? "", "");
      return { stdout: "", stderr: "", code: 1, killed: false };
    }) as GitExec,
    await mkdtemp(join(tmpdir(), "jev-command-late-")),
    "test",
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(
    result.targets.map((target) => target.path),
    ["zz-collect-a.test.mjs"],
  );
});
test("a test-at line printed by a passing test is not a failure target", async () => {
  const lines = Array.from(
    { length: 60 },
    (_, index) => `\u2714 passing test ${index + 1} (0.1ms)`,
  );
  lines[10] = "test at fixtures/sample-a.test.mjs:1:1";
  lines[25] = "test at fixtures/sample-b.test.mjs:1:1";
  lines.splice(
    55,
    0,
    "\u2716 failing tests:",
    "",
    "test at real.test.mjs:15:1",
  );
  const stdout = [
    "\u2716 real failure (7.071906ms)",
    ...lines,
    "\u2716 real failure (7.071906ms)",
    "  AssertionError [ERR_ASSERTION]: boom",
  ].join("\n");
  const result = await captureCommand(
    (async (_binary: string, args: string[]) => {
      await writeFile(args.at(-2) ?? "", `${stdout}\n`);
      await writeFile(args.at(-1) ?? "", "");
      return { stdout: "", stderr: "", code: 1, killed: false };
    }) as GitExec,
    await mkdtemp(join(tmpdir(), "jev-command-decoy-")),
    "test",
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(
    result.targets.map((target) => target.path),
    ["real.test.mjs"],
  );
});
test("explicit exec signal retains its failed exit", posixSignals, async () => {
  const result = await captureCommand(
    (binary, args, options) =>
      execCommand(binary, args, process.cwd(), options),
    process.cwd(),
    "exec node -e 'process.kill(process.pid, \"SIGTERM\")'",
  );
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.output.exit_code, 143);
});
test("line clipping and shape limit are visible without claiming passage selection", async () => {
  const log = `${"x".repeat(9000)}\n${Array.from({ length: 2049 }, (_, index) => index.toString(2).replaceAll("0", "!").replaceAll("1", "?")).join("\n")}`;
  const host = detectHost({});
  const client: JevClient = {
    clearCache() {},
    async judge(_state, questions) {
      return {
        ok: true,
        answers: Object.fromEntries(
          Object.keys(questions).map((id) => [
            id,
            { type: "bool", source: "fresh", p: 0.99 },
          ]),
        ),
        calls: 1,
        questions: Object.keys(questions).length,
      };
    },
  };
  const tool = createAskTool({
    client,
    host,
    runtime: { guide: new Guide(host), session: new Session({}) },
    exec: async (binary, args) => {
      if (binary === "git")
        return { stdout: "", stderr: "not a repo", code: 1, killed: false };
      await writeFile(args.at(-2) ?? "", log);
      await writeFile(args.at(-1) ?? "", "");
      return { stdout: "", stderr: "", code: 0, killed: false };
    },
  });
  const result = await tool.execute(
    "limits",
    {
      command: "test",
      asks: {
        intent: "free",
        about: "output",
        question: {
          type: "bool",
          instructions: "Does output contain punctuation?",
        },
      },
    },
    undefined,
    undefined,
    { cwd: process.cwd() },
  );
  const text = result.content[0]?.text ?? "";
  assert.match(text, /808 line chars omitted/);
  assert.match(
    text,
    /output shape limit exceeded at 2048; rarity grouping disabled/,
  );
  assert.doesNotMatch(text, /selected passages/);
});

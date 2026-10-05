import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { captureCommand } from "../src/adapters/command.ts";
import { spawnExec } from "../src/adapters/exec.ts";
import { resolveShell } from "../src/adapters/shell.ts";
import type { JevClient } from "../src/jev/types.ts";
import { McpServer } from "../src/mcp/protocol.ts";
import { createMcpTools } from "../src/mcp/tools.ts";

// Reviewer's reproduction: the command writes `started`, sleeps inside the
// subshell captureCommand creates, then writes `survived`. Cancelling or
// timing out must stop the whole process tree, not only the bash PID.
// These integration checks cross real Bash/OS process boundaries. Fake Node
// clocks cannot advance descendant sleeps or the operating system's signals.
const noBash = resolveShell().ok ? {} : { skip: "no permitted bash" };
const bashPath = (path: string) => path.replaceAll("\\", "/");
function markerCommand(dir: string, seconds: number): string {
  const started = bashPath(join(dir, "started"));
  const survived = bashPath(join(dir, "survived"));
  return `echo started > '${started}'; sleep ${seconds}; echo survived > '${survived}'`;
}
async function waitFor(path: string, ms = 15_000): Promise<void> {
  const until = Date.now() + ms;
  while (!existsSync(path)) {
    if (Date.now() > until) throw new Error(`${path} never appeared`);
    await delay(25);
  }
}
async function markers(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "jev-tree-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return {
    dir,
    started: join(dir, "started"),
    survived: join(dir, "survived"),
  };
}

test("cancelling a command stops its descendants", noBash, async (t) => {
  const m = await markers(t);
  const controller = new AbortController();
  const running = captureCommand(
    spawnExec,
    m.dir,
    markerCommand(m.dir, 1.5),
    60,
    controller.signal,
  );
  await waitFor(m.started);
  controller.abort(new Error("cancelled"));
  await assert.rejects(running);
  // Well past the point where an orphaned subshell would write the marker.
  await delay(2_500);
  assert.equal(
    existsSync(m.survived),
    false,
    "descendant survived cancellation",
  );
});

test("a command timeout stops its descendants", noBash, async (t) => {
  const m = await markers(t);
  const result = await captureCommand(
    spawnExec,
    m.dir,
    markerCommand(m.dir, 2.5),
    1,
  );
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.output.timed_out, true);
  assert.ok(existsSync(m.started));
  await delay(2_500);
  assert.equal(
    existsSync(m.survived),
    false,
    "descendant survived the timeout",
  );
});

for (const mode of ["cancel", "timeout"] as const) {
  test(
    `a ${mode} stops TERM-ignoring descendants after their parent exits`,
    noBash,
    async (t) => {
      const m = await markers(t);
      const controller = new AbortController();
      const command = `bash -c 'trap "" TERM; echo started > "${bashPath(m.started)}"; sleep 3; echo survived > "${bashPath(m.survived)}"' & wait`;
      const running = captureCommand(
        spawnExec,
        m.dir,
        command,
        mode === "timeout" ? 1 : 30,
        controller.signal,
      );
      await waitFor(m.started);
      if (mode === "cancel") {
        controller.abort(new Error("cancelled"));
        await assert.rejects(running);
      } else {
        const result = await running;
        assert.equal(result.ok && result.output.timed_out, true);
      }
      await delay(3_500);
      assert.equal(
        existsSync(m.survived),
        false,
        "TERM-ignoring descendant survived",
      );
    },
  );
}

test("a command that finishes normally is unaffected", noBash, async (t) => {
  const m = await markers(t);
  const result = await captureCommand(
    spawnExec,
    m.dir,
    markerCommand(m.dir, 0.1),
    30,
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.output.timed_out, false);
    assert.equal(result.output.exit_code, 0);
  }
  assert.ok(existsSync(m.survived));
});

test(
  "MCP notifications/cancelled stops a running jev_ask command tree",
  noBash,
  async (t) => {
    const m = await markers(t);
    const client: JevClient = {
      clearCache() {},
      async judge(_state, questions) {
        return {
          ok: true,
          calls: 1,
          questions: Object.keys(questions).length,
          answers: Object.fromEntries(
            Object.keys(questions).map((id) => [
              id,
              { type: "bool", p: 0.9, source: "fresh" },
            ]),
          ),
        };
      },
    };
    const { tools } = await createMcpTools({
      root: m.dir,
      env: {},
      client,
      configDirectory: join(m.dir, "no-config"),
    });
    const server = new McpServer({ name: "t", version: "1" }, tools);
    const call = server.handle({
      jsonrpc: "2.0",
      id: 41,
      method: "tools/call",
      params: {
        name: "jev_ask",
        arguments: {
          command: markerCommand(m.dir, 1.5),
          asks: {
            intent: "free",
            question: { type: "bool", instructions: "Did the command fail?" },
          },
        },
      },
    });
    await waitFor(m.started);
    await server.handle({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 41 },
    });
    await call;
    await delay(2_500);
    assert.equal(
      existsSync(m.survived),
      false,
      "descendant survived MCP cancel",
    );
  },
);

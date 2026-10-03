import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { resolveShell } from "../src/adapters/shell.ts";

// Real time is required here: a separate Node process and Bash descendant own
// their clocks, so fake timers in this test cannot prove post-shutdown effects.

for (const mode of ["cancel", "stdin", "SIGTERM", "SIGINT"] as const) {
  test(`MCP ${mode} completes termination before a stubborn descendant can write`, {
    skip:
      !resolveShell().ok ||
      (process.platform === "win32" && mode.startsWith("SIG")),
    timeout: 20_000,
  }, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "jev-mcp-shutdown-"));
    const started = join(dir, "started");
    const survived = join(dir, "survived");
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("../src/mcp/main.ts", import.meta.url)),
        "--root",
        dir,
      ],
      {
        env: {
          ...process.env,
          JEV_TOOLS_URL: "http://127.0.0.1:9/judge",
          JEV_TOOLS_API_KEY: "synthetic-shutdown-key",
          JEV_TOOLS_ALLOW_COMMAND: "1",
          JEV_TOOLS_MAX_CALLS: "",
          JEV_TOOLS_MAX_USD: "",
          XDG_CONFIG_HOME: join(dir, "config"),
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const exit = Promise.withResolvers<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>();
    child.once("exit", (code, signal) => exit.resolve({ code, signal }));
    child.once("error", exit.reject);
    child.stderr.resume();
    const responses: number[] = [];
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => responses.push(JSON.parse(line).id));
    t.after(async () => {
      child.kill("SIGKILL");
      lines.close();
      await rm(dir, { recursive: true, force: true });
    });
    const command = `bash -c 'trap "" TERM; echo ready > "${started.replaceAll("\\", "/")}"; sleep 4; echo survived > "${survived.replaceAll("\\", "/")}"' & wait`;
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "jev_ask",
          arguments: {
            command,
            asks: {
              intent: "free",
              question: {
                type: "bool",
                instructions: "Did the command succeed?",
              },
            },
          },
        },
      })}\n`,
    );
    const until = Date.now() + 5_000;
    while (!existsSync(started)) {
      assert.ok(Date.now() < until, "command did not start");
      await delay(25);
    }
    if (mode === "cancel") {
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: 1 },
        })}\n`,
      );
      child.stdin.end();
    } else if (mode === "stdin") child.stdin.end();
    else child.kill(mode);
    const result = await exit.promise;
    assert.equal(result.signal, null, "server exited before graceful shutdown");
    assert.equal(
      result.code,
      mode === "SIGTERM" ? 143 : mode === "SIGINT" ? 130 : 0,
    );
    await delay(4_500);
    assert.equal(
      existsSync(survived),
      false,
      "command wrote after the MCP connection closed",
    );
    assert.equal(
      responses.includes(1),
      false,
      "cancelled tool received a response",
    );
  });
}

test("MCP signal shutdown exits even when its client stops reading stdout", {
  skip: process.platform === "win32",
  timeout: 10_000,
}, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jev-mcp-backpressure-"));
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("../src/mcp/main.ts", import.meta.url)),
      "--root",
      dir,
    ],
    {
      env: {
        ...process.env,
        JEV_TOOLS_URL: "",
        JEV_TOOLS_API_KEY: "",
        XDG_CONFIG_HOME: join(dir, "config"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const exited = Promise.withResolvers<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>();
  child.once("exit", (code, signal) => exited.resolve({ code, signal }));
  child.once("error", exited.reject);
  t.after(async () => {
    child.kill("SIGKILL");
    child.stdin.destroy();
    child.stdout.destroy();
    await rm(dir, { recursive: true, force: true });
  });
  await once(child.stderr, "data");
  child.stderr.resume();
  // Leave stdout unread and queue far more tool metadata than its pipe holds.
  for (let id = 0; id < 500; id++) {
    if (
      !child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list" })}\n`,
      )
    )
      await once(child.stdin, "drain");
  }
  child.kill("SIGTERM");
  assert.deepEqual(await exited.promise, { code: 143, signal: null });
});

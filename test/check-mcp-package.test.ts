import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkServer } from "../scripts/check-mcp-package.ts";

const TOOLS = [
  "jev_ask",
  "jev_ask_files",
  "jev_find_files",
  "jev_locate_in_file",
  "jev_check_diff",
  "jev_select_tests",
];
// A tiny stdio MCP server whose behavior each test chooses.
function fakeServer(options: {
  tools?: readonly string[];
  answerToolsList?: boolean;
  exitOnStdinClose?: boolean;
}): string {
  const tools = JSON.stringify(
    (options.tools ?? TOOLS).map((name) => ({ name })),
  );
  return `
import { createInterface } from "node:readline";
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") reply(message.id, { protocolVersion: "2025-11-25" });
  if (message.method === "tools/list" && ${options.answerToolsList ?? true})
    reply(message.id, { tools: ${tools} });
}).on("close", () => {
  if (${options.exitOnStdinClose ?? true}) process.exit(0);
});
// Keep running like a real server until stdin closes.
setInterval(() => {}, 1 << 30);
`;
}
async function scripts(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "jev-check-server-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return async (name: string, source: string) => {
    const path = join(dir, name);
    await writeFile(path, source);
    return path;
  };
}

test("a correct server passes the check", async (t) => {
  const write = await scripts(t);
  await checkServer(process.execPath, [
    await write("good.mjs", fakeServer({})),
  ]);
});

test("a wrong tool list fails with the names it returned", async (t) => {
  const write = await scripts(t);
  const server = await write("empty.mjs", fakeServer({ tools: [] }));
  await assert.rejects(
    checkServer(process.execPath, [server]),
    /tools\/list returned \[\]/,
  );
  const partial = await write(
    "partial.mjs",
    fakeServer({ tools: ["jev_ask"] }),
  );
  await assert.rejects(
    checkServer(process.execPath, [partial]),
    /tools\/list returned \[jev_ask\]/,
  );
});

test("a server that never answers fails at the reply timeout", async (t) => {
  const write = await scripts(t);
  const server = await write(
    "silent.mjs",
    fakeServer({ answerToolsList: false }),
  );
  const started = Date.now();
  await assert.rejects(
    checkServer(process.execPath, [server], { timeoutMs: 500 }),
    /tools\/list timed out after 500 ms/,
  );
  assert.ok(Date.now() - started < 5_000);
});

test("a server that ignores stdin closing fails at the exit timeout", async (t) => {
  const write = await scripts(t);
  const server = await write(
    "stuck.mjs",
    fakeServer({ exitOnStdinClose: false }),
  );
  await assert.rejects(
    checkServer(process.execPath, [server], { exitTimeoutMs: 500 }),
    /did not exit within 500 ms/,
  );
});

test("a server that crashes fails with its stderr", async (t) => {
  const write = await scripts(t);
  const server = await write(
    "crash.mjs",
    'process.stderr.write("boom: missing module\\n"); process.exit(3);',
  );
  await assert.rejects(
    checkServer(process.execPath, [server], { timeoutMs: 2_000 }),
    /boom: missing module/,
  );
});

test("a missing executable fails instead of hanging", async () => {
  await assert.rejects(
    checkServer(join(tmpdir(), "jev-no-such-server-binary"), [], {
      timeoutMs: 2_000,
    }),
  );
});

// The reviewer's reproduction: the failure was printed, but the process
// stayed alive until an external timeout killed it (exit 124). Run the gate
// in its own process, exactly as CI does, and require a prompt exit 1.
for (const [label, options] of [
  ["wrong tool list", { tools: [] }],
  ["reply timeout", { answerToolsList: false }],
] as const)
  test(`the gate process exits promptly after a failed check: ${label}`, async (t) => {
    const write = await scripts(t);
    const server = await write("fake.mjs", fakeServer(options));
    const module = pathToFileURL(
      fileURLToPath(
        new URL("../scripts/check-mcp-package.ts", import.meta.url),
      ),
    ).href;
    // Mirror main(): report, set exitCode, and rely on the event loop draining.
    const runner = await write(
      "runner.mjs",
      `const { checkServer } = await import(${JSON.stringify(module)});
checkServer(process.execPath, [${JSON.stringify(server)}], { timeoutMs: 500 })
  .then(() => console.log("passed"))
  .catch((error) => { console.error("failed:", error.message); process.exitCode = 1; });`,
    );
    const child = spawn(process.execPath, [runner], { stdio: "pipe" });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    const started = Date.now();
    const code = await new Promise<number | null>((done) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        done(124);
      }, 15_000);
      child.on("exit", (exitCode) => {
        clearTimeout(timer);
        done(exitCode);
      });
    });
    assert.equal(
      code,
      1,
      `exit ${code} after ${Date.now() - started} ms: ${output}`,
    );
    assert.match(output, /failed:/);
    assert.ok(Date.now() - started < 10_000);
  });

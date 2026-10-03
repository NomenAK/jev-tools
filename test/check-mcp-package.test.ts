import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkFunctionalSmoke } from "../scripts/check-mcp-package.ts";

const TOOLS = [
  "jev_ask",
  "jev_ask_files",
  "jev_find_files",
  "jev_locate_in_file",
  "jev_check_diff",
  "jev_select_tests",
];

// A separate OS process owns its clocks: fake timers cannot exercise stdio
// replies, pipe closure or child reaping. Deadlines bound failures, not latency.
function fakeServer(
  options: {
    tools?: readonly string[];
    answerToolsList?: boolean;
    exitOnStdinClose?: boolean;
    versions?: readonly string[];
    obsoleteIdentity?: boolean;
    omitCaching?: boolean;
    echoLegacy?: boolean;
    ask?: "good" | "isError" | "noFooter";
  } = {},
): string {
  return `
import { createInterface } from "node:readline";
const versions = ${JSON.stringify(options.versions ?? ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"])};
const tools = ${JSON.stringify((options.tools ?? TOOLS).map((name) => ({ name, inputSchema: { type: "object" }, annotations: { openWorldHint: true } })))};
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result: { resultType: "complete", ...result } }) + "\\n");
createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "server/discover") reply(message.id, {
    supportedVersions: versions, capabilities: { tools: {} }, ttlMs: 0, cacheScope: "private",
    ...(${options.obsoleteIdentity ?? false} ? { serverInfo: { name: "t", version: "1" } } : { _meta: { "io.modelcontextprotocol/serverInfo": { name: "t", version: "1" } } })
  });
  if (message.method === "initialize") reply(message.id, { protocolVersion: ${options.echoLegacy ?? true} && versions.includes(message.params.protocolVersion) && message.params.protocolVersion !== "2026-07-28" ? message.params.protocolVersion : "2025-11-25" });
  if (message.method === "tools/list" && ${options.answerToolsList ?? true}) reply(message.id, { tools, ...(${options.omitCaching ?? false} ? {} : { ttlMs: 0, cacheScope: "private" }) });
  if (message.method === "tools/call") reply(message.id, {
    content: [{ type: "text", text: ${JSON.stringify(options.ask === "noFooter" ? "free1 = yes (0.96)" : 'free1 "Is synthetic smoke testing working?" = yes (0.96)\n1 calls · 1 questions · $0.00010 · cache 0/1 · 0.1 s')} }],
    isError: ${options.ask === "isError"}
  });
}).on("close", () => { if (${options.exitOnStdinClose ?? true}) process.exit(0); });
setInterval(() => {}, 1 << 30);
`;
}

async function fixture(t: TestContext, source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "jev-package-gate-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "server.mjs");
  await writeFile(file, source);
  return file;
}

const deadlines = { timeoutMs: 2_000, exitTimeoutMs: 2_000 };

test("the gate exercises modern discovery, every legacy version and a tool answer", async (t) => {
  await checkFunctionalSmoke(
    process.execPath,
    [await fixture(t, fakeServer())],
    deadlines,
  );
});

for (const [label, options] of [
  ["missing tools", { tools: ["jev_ask"] }],
  [
    "missing promised legacy version",
    { versions: ["2026-07-28", "2025-11-25"] },
  ],
  ["obsolete discovery identity", { obsoleteIdentity: true }],
  ["missing caching fields", { omitCaching: true }],
  ["legacy version not echoed", { echoLegacy: false }],
  ["tool error", { ask: "isError" }],
  ["tool answer without evidence footer", { ask: "noFooter" }],
] as const) {
  test(`the gate rejects ${label}`, async (t) => {
    await assert.rejects(
      checkFunctionalSmoke(
        process.execPath,
        [await fixture(t, fakeServer(options))],
        deadlines,
      ),
    );
  });
}

test("an unanswered request fails and reaps the child", async (t) => {
  await assert.rejects(
    checkFunctionalSmoke(
      process.execPath,
      [await fixture(t, fakeServer({ answerToolsList: false }))],
      { ...deadlines, timeoutMs: 500 },
    ),
  );
});

test("a server ignoring stdin closure fails and is reaped", async (t) => {
  await assert.rejects(
    checkFunctionalSmoke(
      process.execPath,
      [await fixture(t, fakeServer({ exitOnStdinClose: false }))],
      { ...deadlines, exitTimeoutMs: 500 },
    ),
  );
});

test("a crashed server reports its stderr", async (t) => {
  await assert.rejects(
    checkFunctionalSmoke(
      process.execPath,
      [
        await fixture(
          t,
          'process.stderr.write("boom: missing module\\n"); process.exit(3);',
        ),
      ],
      deadlines,
    ),
    /boom: missing module/,
  );
});

test("a missing executable fails without hanging", async () => {
  await assert.rejects(
    checkFunctionalSmoke(
      join(tmpdir(), "jev-no-such-server-binary"),
      [],
      deadlines,
    ),
  );
});

for (const [label, options] of [
  ["invalid response", { tools: [] }],
  ["reply timeout", { answerToolsList: false }],
] as const) {
  test(`a failed gate process exits promptly: ${label}`, {
    timeout: 20_000,
  }, async (t) => {
    const server = await fixture(t, fakeServer(options));
    const moduleUrl = pathToFileURL(
      fileURLToPath(
        new URL("../scripts/check-mcp-package.ts", import.meta.url),
      ),
    ).href;
    // The generated runner is outside this graph and intentionally loads the
    // actual gate module across its file-URL boundary.
    const runner = await fixture(
      t,
      `import { checkFunctionalSmoke } from ${JSON.stringify(moduleUrl)};
checkFunctionalSmoke(process.execPath, [${JSON.stringify(server)}], { timeoutMs: 500 }).catch(error => { console.error(error.message); process.exitCode = 1; });`,
    );
    const child = spawn(process.execPath, [runner], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
    });
    t.after(() => {
      child.kill("SIGKILL");
    });
    child.stdout.resume();
    child.stderr.resume();
    const exited = Promise.withResolvers<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>();
    child.once("exit", (code, signal) => exited.resolve({ code, signal }));
    child.once("error", exited.reject);
    assert.deepEqual(await exited.promise, { code: 1, signal: null });
  });
}

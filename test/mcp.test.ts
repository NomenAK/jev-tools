import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { windowsStorage } from "../src/adapters/private-storage.ts";
import type { JevClient } from "../src/jev/types.ts";
import {
  INVALID_PARAMS,
  McpServer,
  METHOD_NOT_FOUND,
  UNSUPPORTED_PROTOCOL_VERSION,
} from "../src/mcp/protocol.ts";
import { createMcpTools, loadMcpClient } from "../src/mcp/tools.ts";

const toolNames = [
  "jev_ask",
  "jev_ask_files",
  "jev_find_files",
  "jev_locate_in_file",
  "jev_check_diff",
  "jev_select_tests",
];
const ask = {
  state: "Hello there, nice to meet you.",
  asks: {
    intent: "free",
    question: { type: "bool", instructions: "Is this note a greeting?" },
  },
};
const yesClient: JevClient = {
  clearCache() {},
  async judge(_state, questions, options) {
    const admitted = options?.beforeRequest?.(Object.keys(questions).length);
    if (admitted && !admitted.ok) return admitted;
    return {
      ok: true,
      calls: 1,
      questions: Object.keys(questions).length,
      answers: Object.fromEntries(
        Object.keys(questions).map((id) => [id, { type: "bool", p: 0.97 }]),
      ),
    };
  },
};
// Never read the developer's real ~/.config/jev-agent-tools during tests.
const isolatedConfig = join(tmpdir(), `jev-mcp-no-config-${process.pid}`);
async function server(
  client: JevClient | undefined,
  env: NodeJS.ProcessEnv = {},
) {
  const { tools, instructions } = await createMcpTools({
    root: process.cwd(),
    env,
    configDirectory: isolatedConfig,
    ...(client ? { client } : {}),
  });
  return new McpServer({ name: "t", version: "1", instructions }, tools);
}
const request = (id: number, method: string, params?: unknown) => ({
  jsonrpc: "2.0",
  id,
  method,
  ...(params === undefined ? {} : { params }),
});

test("initialize echoes a supported version and falls back to the latest", async () => {
  const mcp = await server(undefined);
  const chosen = await mcp.handle(
    request(1, "initialize", { protocolVersion: "2025-06-18" }),
  );
  assert.ok(chosen && "result" in chosen);
  assert.equal(chosen.result.protocolVersion, "2025-06-18");
  assert.deepEqual(chosen.result.capabilities, {
    tools: { listChanged: false },
  });
  assert.match(String(chosen.result.instructions), /jev_\* tools/);
  const fallback = await mcp.handle(
    request(2, "initialize", { protocolVersion: "1999-01-01" }),
  );
  assert.ok(fallback && "result" in fallback);
  assert.equal(fallback.result.protocolVersion, "2025-11-25");
});

test("server/discover and per-request version metadata follow 2026-07-28", async () => {
  const mcp = await server(undefined);
  const discovered = await mcp.handle(request(1, "server/discover", {}));
  assert.ok(discovered && "result" in discovered);
  assert.ok(
    (discovered.result.supportedVersions as string[]).includes("2026-07-28"),
  );
  assert.equal(discovered.result.resultType, "complete");
  const refused = await mcp.handle(
    request(2, "tools/list", {
      _meta: { "io.modelcontextprotocol/protocolVersion": "2099-01-01" },
    }),
  );
  assert.ok(refused && "error" in refused);
  assert.equal(refused.error.code, UNSUPPORTED_PROTOCOL_VERSION);
});

test("tools/list exposes the six tools with JSON object schemas", async () => {
  const listed = await (await server(undefined)).handle(
    request(1, "tools/list"),
  );
  assert.ok(listed && "result" in listed);
  const tools = listed.result.tools as {
    name: string;
    inputSchema: { type: string };
    annotations: { readOnlyHint: boolean; openWorldHint: boolean };
    call?: unknown;
  }[];
  assert.deepEqual(
    tools.map((tool) => tool.name),
    toolNames,
  );
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(tool.call, undefined);
    assert.equal(tool.annotations.openWorldHint, true);
  }
  assert.equal(tools[0]?.annotations.readOnlyHint, false);
  assert.equal(tools[1]?.annotations.readOnlyHint, true);
});

test("JEV_TOOLS_ALLOW_COMMAND=0 removes command from the MCP schema", async () => {
  const previous = process.env.JEV_TOOLS_ALLOW_COMMAND;
  process.env.JEV_TOOLS_ALLOW_COMMAND = "0";
  try {
    const listed = await (await server(undefined)).handle(
      request(1, "tools/list"),
    );
    assert.ok(listed && "result" in listed);
    const askTool = (
      listed.result.tools as {
        name: string;
        annotations: { readOnlyHint: boolean };
      }[]
    )[0];
    assert.doesNotMatch(JSON.stringify(askTool), /"command"/);
    assert.equal(askTool?.annotations.readOnlyHint, true);
  } finally {
    if (previous === undefined) delete process.env.JEV_TOOLS_ALLOW_COMMAND;
    else process.env.JEV_TOOLS_ALLOW_COMMAND = previous;
  }
});

test("tools/call runs the shared tool and returns its rendered result", async () => {
  const called = await (await server(yesClient)).handle(
    request(1, "tools/call", { name: "jev_ask", arguments: ask }),
  );
  assert.ok(called && "result" in called);
  assert.equal(called.result.isError, undefined);
  const text = (called.result.content as { text: string }[])[0]?.text ?? "";
  assert.match(text, /Is this note a greeting\?" = yes \(0\.97\)/);
});

test("unconfigured server explains the missing configuration", async () => {
  const called = await (await server(undefined)).handle(
    request(1, "tools/call", { name: "jev_ask", arguments: ask }),
  );
  assert.ok(called && "result" in called);
  assert.match(
    (called.result.content as { text: string }[])[0]?.text ?? "",
    /JEV_TOOLS_URL/,
  );
});

test("schema violations are tool errors; unknown tools and methods are protocol errors", async () => {
  const mcp = await server(yesClient);
  const invalid = await mcp.handle(
    request(1, "tools/call", {
      name: "jev_ask",
      arguments: { ...ask, unexpected: true },
    }),
  );
  assert.ok(invalid && "result" in invalid);
  assert.equal(invalid.result.isError, true);
  assert.match(
    (invalid.result.content as { text: string }[])[0]?.text ?? "",
    /Invalid arguments/,
  );
  const unknown = await mcp.handle(
    request(2, "tools/call", { name: "nope", arguments: {} }),
  );
  assert.ok(unknown && "error" in unknown);
  assert.equal(unknown.error.code, INVALID_PARAMS);
  const missing = await mcp.handle(request(3, "resources/list"));
  assert.ok(missing && "error" in missing);
  assert.equal(missing.error.code, METHOD_NOT_FOUND);
  assert.equal(
    await mcp.handle({ jsonrpc: "2.0", method: "notifications/initialized" }),
    undefined,
  );
});

test("notifications/cancelled aborts the running tool call", async () => {
  let aborted = false;
  const reached = Promise.withResolvers<void>();
  const blocking: JevClient = {
    clearCache() {},
    judge: (_state, _questions, options) =>
      new Promise((resolve) => {
        const stop = () => {
          aborted = true;
          resolve({ ok: false, error: "aborted" });
        };
        if (options?.signal?.aborted) stop();
        else options?.signal?.addEventListener("abort", stop);
        reached.resolve();
      }),
  };
  const mcp = await server(blocking);
  const running = mcp.handle(
    request(7, "tools/call", { name: "jev_ask", arguments: ask }),
  );
  await reached.promise;
  await mcp.handle({
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: { requestId: 7 },
  });
  const response = await running;
  assert.equal(aborted, true);
  assert.ok(response && "result" in response);
});

test("MCP uses configuration saved by /jev-setup and survives unusable storage", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "jev-mcp-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await chmod(directory, 0o700);
  // mkdtemp's mode is ignored on Windows; restrict the ACL like a real save.
  if (process.platform === "win32")
    await windowsStorage.restrictDirectory(directory);
  const file = join(directory, "config.json");
  await writeFile(
    file,
    JSON.stringify({ url: "http://127.0.0.1:9/judge", apiKey: "saved-key" }),
    { mode: 0o600 },
  );
  await chmod(file, 0o600);
  const saved = await loadMcpClient({}, directory);
  assert.ok(saved.client);
  assert.equal(saved.warning, undefined);
  // Environment variables still apply when saved storage is unusable.
  await writeFile(file, "not json", { mode: 0o600 });
  const fromEnv = await loadMcpClient(
    { JEV_TOOLS_URL: "http://127.0.0.1:9/judge", JEV_TOOLS_API_KEY: "env" },
    directory,
  );
  assert.ok(fromEnv.client);
  assert.match(fromEnv.warning ?? "", /Cannot read or save Jev configuration/);
  // An invalid environment URL is reported instead of crashing the server.
  const invalid = await loadMcpClient(
    { JEV_TOOLS_URL: "not a url", JEV_TOOLS_API_KEY: "env" },
    join(directory, "absent"),
  );
  assert.equal(invalid.client, undefined);
  assert.match(invalid.warning ?? "", /full HTTP\(S\) URL/);
});

// End to end: a real stdio server process talking to a local fake Jev endpoint.
async function fakeJev(): Promise<{
  url: string;
  server: Server;
  seen: unknown[];
}> {
  const seen: unknown[] = [];
  const http = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const parsed = JSON.parse(body) as { questions: Record<string, unknown> };
      seen.push({ authorization: req.headers.authorization, ...parsed });
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          answers: Object.fromEntries(
            Object.keys(parsed.questions).map((id) => [id, { noul: 0.96 }]),
          ),
          usage: { input_tokens: 42, cost: 0.0001 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  assert.ok(address && typeof address === "object");
  return { url: `http://127.0.0.1:${address.port}/judge`, server: http, seen };
}
function client(child: ChildProcess) {
  const responses = new Map<number, (value: Record<string, unknown>) => void>();
  assert.ok(child.stdout && child.stdin);
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line) as { id: number };
    responses.get(message.id)?.(message);
  });
  let next = 0;
  return (method: string, params?: unknown) =>
    new Promise<Record<string, unknown>>((resolve) => {
      const id = ++next;
      responses.set(id, resolve);
      child.stdin?.write(`${JSON.stringify(request(id, method, params))}\n`);
    });
}

test("stdio server answers a real jev_ask over a repository file", async (t) => {
  const jev = await fakeJev();
  const root = await mkdtemp(join(tmpdir(), "jev-mcp-e2e-"));
  t.after(async () => {
    jev.server.close();
    await rm(root, { recursive: true, force: true });
  });
  execFileSync("git", ["init", "-q"], { cwd: root });
  await writeFile(
    join(root, "refund.ts"),
    "export function eligible(age: number) { return age <= 14; }\n",
  );
  const main = fileURLToPath(new URL("../src/mcp/main.ts", import.meta.url));
  const child = spawn(process.execPath, [main, "--root", root], {
    env: {
      ...process.env,
      JEV_TOOLS_URL: jev.url,
      JEV_TOOLS_API_KEY: "e2e-secret",
      JEV_TOOLS_MAX_CALLS: "",
      JEV_TOOLS_MAX_USD: "",
      // Keep the developer's saved configuration out of the subprocess.
      XDG_CONFIG_HOME: isolatedConfig,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => child.kill());
  const call = client(child);
  const init = await call("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "e2e", version: "1" },
  });
  assert.equal(
    (init.result as { protocolVersion: string }).protocolVersion,
    "2025-11-25",
  );
  child.stdin?.write(
    `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
  );
  const listed = await call("tools/list");
  assert.equal((listed.result as { tools: unknown[] }).tools.length, 6);
  const answered = await call("tools/call", {
    name: "jev_ask",
    arguments: {
      paths: ["refund.ts"],
      asks: {
        intent: "free",
        question: {
          type: "bool",
          instructions: "Does eligible accept an age of fourteen days?",
        },
      },
    },
  });
  const result = answered.result as {
    content: { text: string }[];
    isError?: boolean;
  };
  assert.equal(result.isError, undefined);
  assert.match(result.content[0]?.text ?? "", /= yes \(0\.96\)/);
  assert.ok(jev.seen.length >= 1);
  const first = jev.seen[0] as {
    authorization: string;
    state: { files?: Record<string, string> };
  };
  assert.equal(first.authorization, "Bearer e2e-secret");
  assert.match(first.state.files?.["refund.ts"] ?? "", /age <= 14/);
  child.stdin?.end();
  const code = await new Promise<number | null>((resolve) =>
    child.on("exit", resolve),
  );
  assert.equal(code, 0);
});

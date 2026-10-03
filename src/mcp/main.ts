#!/usr/bin/env node
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { canonicalPath } from "../adapters/canonical-path.ts";
import { MCP_SHUTDOWN_FLUSH_TIMEOUT_MS } from "../constants.ts";
import { type JsonRpcResponse, McpServer, PARSE_ERROR } from "./protocol.ts";
import { createMcpTools } from "./tools.ts";

const usage = `jev-agent-tools-mcp - MCP stdio server for the six jev_* tools

Usage: jev-agent-tools-mcp [--root <repository-directory>]

The repository directory is --root, else JEV_TOOLS_ROOT, else the current
directory. Configuration uses the same JEV_TOOLS_* environment variables as
the pi and omp extension. Protocol messages use stdout; diagnostics stderr.`;

function packageVersion(): string {
  try {
    // src/mcp/main.ts and dist/mcp/main.js both sit two levels below the root.
    const text = readFileSync(
      new URL("../../package.json", import.meta.url),
      "utf8",
    );
    const parsed = JSON.parse(text) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function parseArgs(argv: readonly string[]): { root?: string; exit?: string } {
  let root: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") return { exit: usage };
    if (arg === "--version") return { exit: packageVersion() };
    if (arg === "--root") {
      root = argv[++index];
      if (!root) throw new Error("--root requires a directory");
    } else if (arg?.startsWith("--root=")) root = arg.slice("--root=".length);
    else throw new Error(`Unknown argument: ${arg}\n\n${usage}`);
  }
  return { root };
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.exit !== undefined) {
    process.stdout.write(`${parsed.exit}\n`);
    return;
  }
  const root = await canonicalPath(
    resolve(parsed.root ?? process.env.JEV_TOOLS_ROOT ?? process.cwd()),
  );
  if (!statSync(root, { throwIfNoEntry: false })?.isDirectory())
    throw new Error(`Repository directory not found: ${root}`);
  const { tools, instructions, configured, warning } = await createMcpTools({
    root,
  });
  const server = new McpServer(
    { name: "jev-agent-tools", version: packageVersion(), instructions },
    tools,
  );
  if (warning) process.stderr.write(`jev-agent-tools MCP: ${warning}\n`);
  process.stderr.write(
    `jev-agent-tools MCP server ready (root ${root}; ${configured ? "endpoint configured" : "no endpoint: set JEV_TOOLS_URL and JEV_TOOLS_API_KEY, or save them with /jev-setup in pi or omp"})\n`,
  );
  let closing = false;
  const send = (response: JsonRpcResponse | JsonRpcResponse[] | undefined) => {
    if (
      closing ||
      response === undefined ||
      (Array.isArray(response) && !response.length)
    )
      return;
    // Newline-delimited JSON; JSON.stringify never emits raw newlines.
    process.stdout.write(`${JSON.stringify(response)}\n`);
  };
  const pending = new Set<Promise<void>>();
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const shutdown = async (code: number) => {
    if (closing) return;
    closing = true;
    lines.close();
    process.stdin.destroy();
    server.abortAll();
    // Tool promises include bounded process-tree escalation. Do not exit when
    // only the direct shell has closed: descendants may still need SIGKILL.
    await Promise.allSettled(pending);
    if (process.stdout.destroyed) process.exit(code);
    // A client may leave its stdout pipe open without draining it. Cleanup
    // is already complete; never let that client's backpressure hold us alive.
    setTimeout(() => process.exit(code), MCP_SHUTDOWN_FLUSH_TIMEOUT_MS);
    process.stdout.end(() => process.exit(code));
  };
  process.on("SIGTERM", () => void shutdown(143));
  process.on("SIGINT", () => void shutdown(130));
  process.stdout.on("error", () => void shutdown(1));
  lines.on("line", (line) => {
    if (closing || !line.trim()) return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      send(server.error(null, PARSE_ERROR, "Parse error: invalid JSON."));
      return;
    }
    const work = (async () => {
      if (Array.isArray(message)) {
        // JSON-RPC batches (protocol 2025-03-26) answer as one array.
        const responses = await Promise.all(
          message.map((item) => server.handle(item)),
        );
        send(
          responses.filter(
            (item): item is JsonRpcResponse => item !== undefined,
          ),
        );
      } else send(await server.handle(message));
    })().catch((error: unknown) => {
      process.stderr.write(`jev-agent-tools MCP: ${String(error)}\n`);
    });
    pending.add(work);
    void work.finally(() => pending.delete(work));
  });
  lines.on("close", () => void shutdown(0));
}

main().catch((error: unknown) => {
  process.stderr.write(
    `jev-agent-tools MCP: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});

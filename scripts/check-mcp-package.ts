// Release gate for the MCP server: checks a packed tarball before it is
// published to npm and announced to the MCP Registry.
//
// Usage: node scripts/check-mcp-package.ts <path-to-tarball>
//
// 1. server.json and package.json agree (name/mcpName, versions, npm id).
// 2. The tarball ships the compiled server and declares its bin.
// 3. The packed server, installed into an empty directory, answers
//    initialize and lists the six tools over stdio.
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

interface ServerJson {
  name: string;
  version: string;
  packages: { registryType: string; identifier: string; version: string }[];
}
interface PackageJson {
  name: string;
  version: string;
  mcpName?: string;
  bin?: Record<string, string>;
}
const BIN = "jev-agent-tools-mcp";
const TOOLS = [
  "jev_ask",
  "jev_ask_files",
  "jev_find_files",
  "jev_locate_in_file",
  "jev_check_diff",
  "jev_select_tests",
];

/** Problems that would make the registry entry disagree with the package. */
export function metadataProblems(
  pkg: PackageJson,
  server: ServerJson,
): string[] {
  const problems: string[] = [];
  if (pkg.mcpName !== server.name)
    problems.push(
      `package.json mcpName ${pkg.mcpName} must equal server.json name ${server.name}`,
    );
  if (server.version !== pkg.version)
    problems.push(
      `server.json version ${server.version} must equal package.json ${pkg.version}`,
    );
  const npm = server.packages.filter((entry) => entry.registryType === "npm");
  if (npm.length !== 1)
    problems.push("server.json needs exactly one npm package");
  for (const entry of npm) {
    if (entry.identifier !== pkg.name)
      problems.push(
        `server.json npm identifier ${entry.identifier} must equal ${pkg.name}`,
      );
    if (entry.version !== pkg.version)
      problems.push(
        `server.json npm version ${entry.version} must equal ${pkg.version}`,
      );
  }
  if (pkg.bin?.[BIN] !== "dist/mcp/main.js")
    problems.push(`package.json bin ${BIN} must point to dist/mcp/main.js`);
  return problems;
}

export interface ServerCheckOptions {
  /** Per-request reply timeout. */
  timeoutMs?: number;
  /** How long the server may take to exit once stdin is closed. */
  exitTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

/**
 * Start an MCP server over stdio, check `initialize` and that `tools/list`
 * returns exactly the six tools, then close stdin and require a clean exit.
 *
 * Every path, success or failure, ends with the same cleanup: timers
 * cleared, the line reader and pipes closed, and the child terminated and
 * reaped. Without that, a failed check left the child and its pipes open,
 * which kept Node alive and hung the CI/release gate instead of failing it.
 */
export async function checkServer(
  command: string,
  args: readonly string[],
  options: ServerCheckOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const exitTimeoutMs = options.exitTimeoutMs ?? 10_000;
  const child = spawn(command, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: options.env ?? {
      ...process.env,
      JEV_TOOLS_URL: "",
      JEV_TOOLS_API_KEY: "",
    },
    windowsHide: true,
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-2_000);
  });
  // Ignore EPIPE if the server dies while a request is being written.
  child.stdin.on("error", () => {});
  const exited = new Promise<number | null>((done) => {
    child.on("exit", (code, signal) => done(signal ? null : code));
  });
  const spawnFailed = new Promise<never>((_done, fail) => {
    child.on("error", (error) => fail(error));
  });
  const timers = new Set<NodeJS.Timeout>();
  const replies = new Map<number, (value: Record<string, unknown>) => void>();
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let message: { id?: number };
    try {
      message = JSON.parse(line) as { id?: number };
    } catch {
      return; // Not ours to judge here; the awaited reply will time out.
    }
    if (typeof message.id === "number")
      replies.get(message.id)?.(message as Record<string, unknown>);
  });
  const call = (id: number, method: string, params: unknown) =>
    Promise.race([
      spawnFailed,
      new Promise<Record<string, unknown>>((done, fail) => {
        const timer = setTimeout(() => {
          timers.delete(timer);
          fail(new Error(`${method} timed out after ${timeoutMs} ms`));
        }, timeoutMs);
        timers.add(timer);
        replies.set(id, (value) => {
          clearTimeout(timer);
          timers.delete(timer);
          replies.delete(id);
          done(value);
        });
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
        );
      }),
    ]);
  try {
    const init = (await call(1, "initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "release-check", version: "1" },
    })) as { result?: { protocolVersion?: string } };
    if (init.result?.protocolVersion !== "2025-11-25")
      throw new Error(`initialize failed: ${JSON.stringify(init)}`);
    const listed = (await call(2, "tools/list", {})) as {
      result?: { tools?: { name: string }[] };
    };
    const names = listed.result?.tools?.map((tool) => tool.name) ?? [];
    if (JSON.stringify(names) !== JSON.stringify(TOOLS))
      throw new Error(`tools/list returned [${names.join(", ")}]`);
    // Graceful shutdown: the server must exit cleanly when stdin closes.
    child.stdin.end();
    let timer: NodeJS.Timeout | undefined;
    const code = await Promise.race([
      exited,
      new Promise<never>((_done, fail) => {
        timer = setTimeout(
          () =>
            fail(
              new Error(
                `server did not exit within ${exitTimeoutMs} ms of stdin closing`,
              ),
            ),
          exitTimeoutMs,
        );
      }),
    ]).finally(() => clearTimeout(timer));
    if (code !== 0) throw new Error(`server exited with ${code}`);
  } catch (error) {
    const detail = stderr.trim() ? `\nserver stderr: ${stderr.trim()}` : "";
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}${detail}`,
    );
  } finally {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    replies.clear();
    lines.close();
    child.stdin.destroy();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      // Reap it, but never wait forever on a process that will not die.
      await Promise.race([
        exited,
        new Promise((done) => setTimeout(done, 2_000).unref()),
      ]);
    }
    child.stdout.destroy();
    child.stderr.destroy();
  }
}

async function smoke(tarball: string): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "jev-mcp-package-"));
  try {
    writeFileSync(join(directory, "package.json"), '{"private":true}\n');
    // Optional native parsers are not needed to answer the handshake.
    // npm is a .cmd script on Windows, which Node only starts through cmd.
    const install = [
      "install",
      "--no-audit",
      "--no-fund",
      "--omit=optional",
      tarball,
    ];
    // Bounded, so a stalled install fails the gate instead of hanging it.
    const installOptions = {
      cwd: directory,
      stdio: "ignore" as const,
      timeout: 300_000,
    };
    if (process.platform === "win32")
      execFileSync("cmd", ["/c", "npm", ...install], installOptions);
    else execFileSync("npm", install, installOptions);
    const main = join(
      directory,
      "node_modules",
      "jev-agent-tools",
      "dist",
      "mcp",
      "main.js",
    );
    await checkServer(process.execPath, [main, "--root", directory]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const tarball = process.argv[2];
  if (!tarball)
    throw new Error("Usage: node scripts/check-mcp-package.ts <tarball>");
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as PackageJson;
  const server = JSON.parse(readFileSync("server.json", "utf8")) as ServerJson;
  const problems = metadataProblems(pkg, server);
  const listing = execFileSync("tar", ["-tzf", resolve(tarball)], {
    encoding: "utf8",
  }).split(/\r?\n/);
  for (const file of [
    "package/dist/mcp/main.js",
    "package/dist/mcp/protocol.js",
    "package/dist/mcp/tools.js",
  ])
    if (!listing.includes(file)) problems.push(`tarball is missing ${file}`);
  if (problems.length) throw new Error(problems.join("\n"));
  await smoke(resolve(tarball));
  console.log(
    `MCP package check passed: ${server.name}@${server.version}, six tools over stdio.`,
  );
}

// Run only as a script, not when the test imports metadataProblems.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error: unknown) => {
    console.error(
      `MCP package check failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });

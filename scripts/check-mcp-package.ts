// Release gate for the MCP server: checks a packed tarball before it is
// published to npm and announced to the MCP Registry.
//
// Usage: node scripts/check-mcp-package.ts <path-to-tarball>
//
// 1. server.json and package.json agree (name/mcpName, versions, npm id).
// 2. The tarball ships the compiled server and declares its bin.
// 3. The packed server, installed into an empty directory, answers
//    server/discover, every advertised legacy initialize, tools/list with
//    object schemas and conservative caching fields, and a real jev_ask
//    through a local synthetic Jev fixture (no live key or service).
//    The registry gate separately binds its artifact copy to the tarball's
//    embedded server.json before any lookup.
import { execFileSync, spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import {
  MCP_PACKAGE_EXIT_TIMEOUT_MS,
  MCP_PACKAGE_INSTALL_TIMEOUT_MS,
  MCP_PACKAGE_KILL_TIMEOUT_MS,
  MCP_PACKAGE_REPLY_TIMEOUT_MS,
  MCP_PACKAGE_STDERR_MAX_CHARS,
} from "../src/constants.ts";
import { validateResultReport } from "../src/core/result-report.ts";
import { isMcpStructuredResult } from "../src/report-schema.ts";
import { isRecord } from "../src/result.ts";

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
] as const;
const LEGACY_VERSIONS = [
  "2024-11-05",
  "2025-03-26",
  "2025-06-18",
  "2025-11-25",
] as const;
const MODERN_VERSION = "2026-07-28";
const LATEST_INITIALIZE_VERSION = "2025-11-25";
const VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";
const SERVER_INFO_META_KEY = "io.modelcontextprotocol/serverInfo";
const CLIENT_CAPABILITIES_KEY = "io.modelcontextprotocol/clientCapabilities";
const SYNTHETIC_MODEL = "smoke-requested-model";
const SYNTHETIC_KEY = "synthetic-smoke-key";
const FIXTURE_NOUL = 0.96;

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

// Type-guard seam: narrows the tools/discover string lists the gate reads.
function isStringList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item): item is string => typeof item === "string")
  );
}

function messageResult(message: unknown): Record<string, unknown> {
  if (!isRecord(message)) throw new Error(`invalid reply: ${String(message)}`);
  if ("error" in message)
    throw new Error(`server error: ${JSON.stringify(message)}`);
  const result = message.result;
  if (!isRecord(result))
    throw new Error(`missing result: ${JSON.stringify(message)}`);
  return result;
}

function requireComplete(
  result: Record<string, unknown>,
  method: string,
): void {
  const resultType = result.resultType;
  if (resultType !== "complete")
    throw new Error(
      `${method} missing resultType complete: ${JSON.stringify(result)}`,
    );
}

/**
 * Modern discovery: supported versions, conservative caching, and identity
 * only from result._meta[serverInfo]. Top-level serverInfo is obsolete and
 * never read here.
 */
export function assertDiscoverResult(result: unknown): {
  supportedVersions: string[];
  serverName: string;
  serverVersion: string;
} {
  if (!isRecord(result))
    throw new Error(`server/discover failed: ${JSON.stringify(result)}`);
  requireComplete(result, "server/discover");
  const supported = result.supportedVersions;
  if (!isStringList(supported) || supported.length === 0)
    throw new Error(
      `server/discover missing supportedVersions: ${JSON.stringify(result)}`,
    );
  for (const version of LEGACY_VERSIONS)
    if (!supported.includes(version))
      throw new Error(
        `server/discover missing legacy ${version}: ${supported.join(", ")}`,
      );
  if (!supported.includes(MODERN_VERSION))
    throw new Error(
      `server/discover missing modern ${MODERN_VERSION}: ${supported.join(", ")}`,
    );
  if (result.ttlMs !== 0)
    throw new Error(
      `server/discover missing ttlMs 0: ${JSON.stringify(result)}`,
    );
  if (result.cacheScope !== "private")
    throw new Error(
      `server/discover missing cacheScope private: ${JSON.stringify(result)}`,
    );
  const meta = result._meta;
  if (!isRecord(meta))
    throw new Error(`server/discover missing _meta: ${JSON.stringify(result)}`);
  const info = meta[SERVER_INFO_META_KEY];
  if (!isRecord(info))
    throw new Error(
      `server/discover missing _meta serverInfo: ${JSON.stringify(result)}`,
    );
  const name = info.name;
  const version = info.version;
  if (typeof name !== "string" || typeof version !== "string")
    throw new Error(
      `server/discover serverInfo needs name and version strings: ${JSON.stringify(result)}`,
    );
  return {
    supportedVersions: [...supported],
    serverName: name,
    serverVersion: version,
  };
}

function assertToolEntry(tool: unknown): void {
  if (!isRecord(tool))
    throw new Error(`tool entry not an object: ${JSON.stringify(tool)}`);
  const schema = tool.inputSchema;
  if (!isRecord(schema) || schema.type !== "object") {
    const name = tool.name;
    throw new Error(
      `tool ${typeof name === "string" ? name : "?"} needs an object inputSchema: ${JSON.stringify(tool)}`,
    );
  }
  const annotations = tool.annotations;
  if (!isRecord(annotations) || annotations.openWorldHint !== true) {
    const name = tool.name;
    throw new Error(
      `tool ${typeof name === "string" ? name : "?"} missing openWorldHint: ${JSON.stringify(tool)}`,
    );
  }
}

/** Version-aware tool discovery: six names and supported schema fields. */
export function assertToolsListResult(
  result: unknown,
  version = MODERN_VERSION,
): void {
  if (!isRecord(result))
    throw new Error(`tools/list failed: ${JSON.stringify(result)}`);
  if (version === MODERN_VERSION) {
    requireComplete(result, "tools/list");
    if (result.ttlMs !== 0 || result.cacheScope !== "private")
      throw new Error(
        `tools/list missing conservative caching: ${JSON.stringify(result)}`,
      );
  }
  const tools = result.tools;
  if (!Array.isArray(tools))
    throw new Error(
      `tools/list missing tools array: ${JSON.stringify(result)}`,
    );
  const names: string[] = [];
  for (const tool of tools) {
    if (!isRecord(tool) || typeof tool.name !== "string")
      throw new Error(`tools/list entry missing name: ${JSON.stringify(tool)}`);
    names.push(tool.name);
    assertToolEntry(tool);
    const structured = version !== "2024-11-05" && version !== "2025-03-26";
    if (
      structured
        ? !isRecord(tool.outputSchema)
        : Object.hasOwn(tool, "outputSchema")
    )
      throw new Error(`tools/list outputSchema incompatible with ${version}`);
  }
  const expected = [...TOOLS];
  if (JSON.stringify(names) !== JSON.stringify(expected))
    throw new Error(`tools/list returned [${names.join(", ")}]`);
}

/** Real jev_ask: inspect structured outcomes, never parse prose for a verdict. */
export function assertJevAskResult(
  result: unknown,
  version = LATEST_INITIALIZE_VERSION,
): string {
  if (!isRecord(result))
    throw new Error(`jev_ask failed: ${JSON.stringify(result)}`);
  if (version === MODERN_VERSION) requireComplete(result, "tools/call jev_ask");
  if (result.isError === true)
    throw new Error(`jev_ask isError: ${JSON.stringify(result)}`);
  const content = result.content;
  if (!Array.isArray(content) || content.length === 0)
    throw new Error(`jev_ask missing content: ${JSON.stringify(result)}`);
  const first = content[0];
  if (
    !isRecord(first) ||
    first.type !== "text" ||
    typeof first.text !== "string"
  )
    throw new Error(`jev_ask content not text: ${JSON.stringify(result)}`);
  const text = first.text;
  if (!isMcpStructuredResult(result.structuredContent))
    throw new Error(
      "jev_ask structured result does not match its public schema",
    );
  const report = result.structuredContent.result;
  const problems = validateResultReport(report);
  if (problems.length)
    throw new Error(`jev_ask invalid report: ${problems.join("; ")}`);
  if (
    !report.items.some(
      (item) =>
        item.treatment === "judged" &&
        item.judgment.band === "verdict" &&
        (item.judgment.result === true || item.judgment.result === "yes") &&
        item.judgment.measure.value.status === "known" &&
        item.judgment.measure.value.value === FIXTURE_NOUL,
    )
  )
    throw new Error("jev_ask did not return the fixture judgment");
  if (
    report.accounting.httpAttempts < 1 ||
    report.accounting.questionsSent < 1 ||
    report.accounting.costUsd.status !== "known"
  )
    throw new Error("jev_ask lacks observed HTTP/question/cost accounting");
  return text;
}

/** Fixture side: the endpoint saw the requested model and synthetic bearer. */
export function assertJevRequest(
  seen: unknown,
  expectedModel: string,
  expectedAuth: string,
): void {
  if (!isRecord(seen)) throw new Error("Jev fixture saw no request");
  if (seen.authorization !== expectedAuth)
    throw new Error("Jev fixture authorization mismatch");
  if (seen.model !== expectedModel) {
    const model = seen.model;
    throw new Error(
      `Jev fixture model ${typeof model === "string" ? model : "?"} must equal ${expectedModel}`,
    );
  }
  const questions = seen.questions;
  if (!isRecord(questions) || Object.keys(questions).length === 0)
    throw new Error("Jev fixture saw no questions");
}

export interface ServerCheckOptions {
  /** Per-request reply timeout. */
  timeoutMs?: number;
  /** How long the server may take to exit once stdin is closed. */
  exitTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

const SMOKE_ASK = {
  state: "synthetic smoke note",
  asks: {
    intent: "free",
    question: {
      type: "bool",
      instructions: "Is synthetic smoke testing working?",
    },
  },
};

interface StdioConnection {
  call: (
    id: number,
    method: string,
    params: unknown,
  ) => Promise<Record<string, unknown>>;
  closeAndExit: () => Promise<void>;
  // Called exactly once per session by checkServer/checkFunctionalSmoke.
  stderr: string;
  finish: () => Promise<void>;
}

function connectStdio(
  command: string,
  args: readonly string[],
  options: ServerCheckOptions,
  timeoutMs: number,
  exitTimeoutMs: number,
): StdioConnection {
  const child = spawn(command, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: options.env ?? {
      ...process.env,
      JEV_TOOLS_URL: "",
      JEV_TOOLS_API_KEY: "",
    },
    windowsHide: true,
  });
  const captured = { text: "" };
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    captured.text = (captured.text + chunk).slice(
      -MCP_PACKAGE_STDERR_MAX_CHARS,
    );
  });
  // Ignore EPIPE if the server dies while a request is being written.
  child.stdin.on("error", () => {});
  const exitResolvers = Promise.withResolvers<number | null>();
  child.on("exit", (code, signal) =>
    exitResolvers.resolve(signal ? null : code),
  );
  const spawnResolvers = Promise.withResolvers<never>();
  child.on("error", (error) => spawnResolvers.reject(error));
  const exited = exitResolvers.promise;
  const spawnFailed = spawnResolvers.promise;
  // Prevent a never-settling spawn failure from keeping the loop alive.
  spawnFailed.catch(() => {});
  const timers = new Set<NodeJS.Timeout>();
  const replies = new Map<number, (value: Record<string, unknown>) => void>();
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return; // Not ours to judge here; the awaited reply will time out.
    }
    if (!isRecord(parsed)) return;
    const id = parsed.id;
    if (typeof id !== "number") return;
    const handler = replies.get(id);
    if (handler) handler(parsed);
  });
  const call = (
    id: number,
    method: string,
    params: unknown,
  ): Promise<Record<string, unknown>> => {
    const replyResolvers = Promise.withResolvers<Record<string, unknown>>();
    const timer = setTimeout(() => {
      timers.delete(timer);
      replies.delete(id);
      replyResolvers.reject(
        new Error(`${method} timed out after ${timeoutMs} ms`),
      );
    }, timeoutMs);
    timers.add(timer);
    replies.set(id, (value) => {
      clearTimeout(timer);
      timers.delete(timer);
      replies.delete(id);
      replyResolvers.resolve(value);
    });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
    );
    return Promise.race([spawnFailed, replyResolvers.promise]);
  };
  const closeAndExit = async (): Promise<void> => {
    // Graceful shutdown: the server must exit cleanly when stdin closes.
    child.stdin.end();
    const exitTimerResolvers = Promise.withResolvers<never>();
    const exitTimer = setTimeout(() => {
      exitTimerResolvers.reject(
        new Error(
          `server did not exit within ${exitTimeoutMs} ms of stdin closing`,
        ),
      );
    }, exitTimeoutMs);
    try {
      const code = await Promise.race([exited, exitTimerResolvers.promise]);
      if (code !== 0) throw new Error(`server exited with ${code}`);
    } finally {
      clearTimeout(exitTimer);
    }
  };
  const finish = async (): Promise<void> => {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    replies.clear();
    lines.close();
    child.stdin.destroy();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      // Reap it, but never wait forever on a process that will not die.
      const reapResolvers = Promise.withResolvers<void>();
      const reapTimer = setTimeout(
        () => reapResolvers.resolve(),
        MCP_PACKAGE_KILL_TIMEOUT_MS,
      );
      reapTimer.unref();
      await Promise.race([exited, reapResolvers.promise]);
      clearTimeout(reapTimer);
    }
    child.stdout.destroy();
    child.stderr.destroy();
  };
  return {
    call,
    closeAndExit,
    get stderr() {
      return captured.text.trim();
    },
    finish,
  };
}

/**
 * Installed functional smoke over one stdio session: modern discover, every
 * advertised legacy initialize plus the modern fallback, tools/list with
 * object schemas and caching fields on both eras, and a real jev_ask whose
 * verdict and footer prove the installed code judged through HTTP.
 */
export async function checkFunctionalSmoke(
  command: string,
  args: readonly string[],
  options: ServerCheckOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? MCP_PACKAGE_REPLY_TIMEOUT_MS;
  const exitTimeoutMs = options.exitTimeoutMs ?? MCP_PACKAGE_EXIT_TIMEOUT_MS;
  const connection = connectStdio(
    command,
    args,
    options,
    timeoutMs,
    exitTimeoutMs,
  );
  try {
    const discoverMessage = await connection.call(1, "server/discover", {
      _meta: {
        [VERSION_META_KEY]: MODERN_VERSION,
        [CLIENT_CAPABILITIES_KEY]: {},
      },
    });
    assertDiscoverResult(messageResult(discoverMessage));
    let nextId = 2;
    for (const version of LEGACY_VERSIONS) {
      const echoMessage = await connection.call(nextId++, "initialize", {
        protocolVersion: version,
        capabilities: {},
        clientInfo: { name: "release-check", version: "1" },
      });
      const echo = messageResult(echoMessage);
      const echoed = echo.protocolVersion;
      if (echoed !== version)
        throw new Error(
          `initialize ${version} echoed ${typeof echoed === "string" ? echoed : JSON.stringify(echoMessage)}`,
        );
      const listed = messageResult(
        await connection.call(nextId++, "tools/list", {}),
      );
      assertToolsListResult(listed, version);
    }
    const fallbackMessage = await connection.call(nextId++, "initialize", {
      protocolVersion: MODERN_VERSION,
      capabilities: {},
      clientInfo: { name: "release-check", version: "1" },
    });
    const fallback = messageResult(fallbackMessage);
    if (fallback.protocolVersion !== LATEST_INITIALIZE_VERSION)
      throw new Error(
        `initialize ${MODERN_VERSION} must fall back to ${LATEST_INITIALIZE_VERSION}: ${JSON.stringify(fallbackMessage)}`,
      );
    const legacyListMessage = await connection.call(nextId++, "tools/list", {});
    assertToolsListResult(
      messageResult(legacyListMessage),
      LATEST_INITIALIZE_VERSION,
    );
    const modernListMessage = await connection.call(nextId++, "tools/list", {
      _meta: {
        [VERSION_META_KEY]: MODERN_VERSION,
        [CLIENT_CAPABILITIES_KEY]: {},
      },
    });
    assertToolsListResult(messageResult(modernListMessage));
    const askMessage = await connection.call(nextId++, "tools/call", {
      name: "jev_ask",
      arguments: SMOKE_ASK,
    });
    assertJevAskResult(messageResult(askMessage));
    await connection.closeAndExit();
  } catch (error) {
    const detail = connection.stderr
      ? `\nserver stderr: ${connection.stderr}`
      : "";
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}${detail}`,
    );
  } finally {
    await connection.finish();
  }
}

function parsePackageBin(bin: unknown): Record<string, string> | undefined {
  if (!isRecord(bin)) return undefined;
  const entries: Record<string, string> = {};
  for (const [key, value] of Object.entries(bin)) {
    if (typeof value !== "string") return undefined;
    entries[key] = value;
  }
  return entries;
}

function parsePackageJson(value: unknown): PackageJson {
  if (
    !isRecord(value) ||
    typeof value.name !== "string" ||
    typeof value.version !== "string"
  )
    throw new Error("package.json needs string name and version");
  const name = value.name;
  const version = value.version;
  const mcpName = value.mcpName;
  const parsed: PackageJson = { name, version };
  if (typeof mcpName === "string") parsed.mcpName = mcpName;
  const bin = parsePackageBin(value.bin);
  if (bin) parsed.bin = bin;
  return parsed;
}

function parseServerJson(value: unknown): ServerJson {
  if (
    !isRecord(value) ||
    typeof value.name !== "string" ||
    typeof value.version !== "string"
  )
    throw new Error("server.json needs string name and version");
  const packages = value.packages;
  if (!Array.isArray(packages))
    throw new Error("server.json needs a packages array");
  const entries: ServerJson["packages"] = [];
  for (const entry of packages) {
    if (
      !isRecord(entry) ||
      typeof entry.registryType !== "string" ||
      typeof entry.identifier !== "string" ||
      typeof entry.version !== "string"
    )
      throw new Error(
        "server.json package entry needs registryType, identifier and version strings",
      );
    entries.push({
      registryType: entry.registryType,
      identifier: entry.identifier,
      version: entry.version,
    });
  }
  return { name: value.name, version: value.version, packages: entries };
}

async function smoke(tarball: string): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "jev-mcp-package-"));
  const seen: Record<string, unknown>[] = [];
  const fixture = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = {};
      }
      const record: Record<string, unknown> = {
        authorization: request.headers.authorization,
      };
      if (isRecord(parsed))
        for (const [key, value] of Object.entries(parsed)) record[key] = value;
      seen.push(record);
      const questions =
        isRecord(parsed) && isRecord(parsed.questions) ? parsed.questions : {};
      const answers: Record<string, unknown> = {};
      for (const id of Object.keys(questions))
        answers[id] = { noul: FIXTURE_NOUL };
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          answers,
          usage: { input_tokens: 42, cost: 0.0001 },
        }),
      );
    });
  });
  const listening = Promise.withResolvers<void>();
  fixture.on("error", (error) => listening.reject(error));
  fixture.listen(0, "127.0.0.1", () => listening.resolve());
  try {
    await listening.promise;
    const address = fixture.address();
    if (
      address === null ||
      typeof address === "string" ||
      !("port" in address) ||
      typeof address.port !== "number"
    )
      throw new Error("synthetic Jev fixture did not listen");
    const fixtureUrl = `http://127.0.0.1:${address.port}/judge`;
    writeFileSync(join(directory, "package.json"), '{"private":true}\n');
    // Optional native parsers are not needed for the smoke question.
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
      timeout: MCP_PACKAGE_INSTALL_TIMEOUT_MS,
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
    const isolatedConfig = join(directory, "smoke-config");
    mkdirSync(isolatedConfig, { recursive: true });
    // Explicit synthetic endpoint, key, model and isolated saved-config dir:
    // developer JEV_TOOLS_* credentials never reach the installed server.
    const env = {
      ...process.env,
      JEV_TOOLS_URL: fixtureUrl,
      JEV_TOOLS_API_KEY: SYNTHETIC_KEY,
      JEV_TOOLS_MODEL: SYNTHETIC_MODEL,
      JEV_TOOLS_MAX_CALLS: "",
      JEV_TOOLS_MAX_USD: "",
      XDG_CONFIG_HOME: isolatedConfig,
    };
    await checkFunctionalSmoke(process.execPath, [main, "--root", directory], {
      env,
    });
    assertJevRequest(seen[0], SYNTHETIC_MODEL, `Bearer ${SYNTHETIC_KEY}`);
  } finally {
    const closed = Promise.withResolvers<void>();
    fixture.closeAllConnections();
    fixture.close(() => closed.resolve());
    const closeTimer = setTimeout(
      () => closed.resolve(),
      MCP_PACKAGE_KILL_TIMEOUT_MS,
    );
    closeTimer.unref();
    await closed.promise;
    clearTimeout(closeTimer);
    rmSync(directory, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const tarball = process.argv[2];
  if (!tarball)
    throw new Error("Usage: node scripts/check-mcp-package.ts <tarball>");
  const pkg = parsePackageJson(
    JSON.parse(readFileSync("package.json", "utf8")),
  );
  const server = parseServerJson(
    JSON.parse(readFileSync("server.json", "utf8")),
  );
  // Absolute archive split into cwd + basename: GNU tar under Git Bash parses
  // "C:..." as host "C", and BSD tar agrees on the relative form. Array args
  // stay space-safe; member checks and fail-closed throws are unchanged.
  const problems = metadataProblems(pkg, server);
  const archive = resolve(tarball);
  const listing = execFileSync("tar", ["-tzf", basename(archive)], {
    cwd: dirname(archive),
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
    `MCP package check passed: ${server.name}@${server.version}, discover plus six tools plus jev_ask over stdio.`,
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

// Release gate for the MCP Registry entry: checks the approved artifact before
// anything is published to the official MCP Registry.
//
// Usage: node scripts/check-mcp-registry.ts <server.json> <tarball>
//   MCP_REGISTRY env selects the registry (default: the official one).
//   GITHUB_OUTPUT env receives exists=true|false for the publish step.
//
// 1. release-artifact/server.json (the reviewed copy this exact script file
//    travels with) must equal package/server.json embedded in the approved
//    tarball. No fallback to another copy, no integrity bypass.
// 2. The registry lookup for name@version reports skip only when HTTP 200
//    carries the official { server, _meta } envelope whose server definition
//    equals the reviewed one. Object key order and the response-level _meta
//    (registry-managed status/publishedAt/updatedAt/isLatest) are ignored;
//    every other difference fails, including arrays, env, args, version and
//    transport. 404 means absent; any other status, invalid JSON, or a missing
//    server envelope fails instead of assuming absence.
//
// Native Node APIs only; no retry, no telemetry. Self-contained (no src/
// imports) so the mcp-registry job can run the copy packed into
// release-artifact/ without a checkout.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface RegistryCheckOptions {
  /** Registry lookup timeout. */
  timeoutMs?: number;
}

export interface RegistryCheckResult {
  /** True when the registry already holds this exact definition (skip). */
  exists: boolean;
}

/**
 * Canonical JSON-object guard for this standalone gate script. The script is
 * intentionally self-contained (no src/ imports) so the mcp-registry job can
 * run the copy packed into release-artifact/ without a checkout, so the
 * boundary check for registry envelopes and reviewed definitions lives here
 * instead of a shared module.
 */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Differences between the reviewed definition and the registry's server
 * envelope that must fail publication. Objects compare by key, so key order
 * never matters; arrays compare in order, so reordered or changed entries
 * fail like any other functional difference.
 */
export function registryProblems(expected: unknown, actual: unknown): string[] {
  const problems: string[] = [];
  collectRegistryProblems(expected, actual, "$", problems);
  return problems;
}

function collectRegistryProblems(
  expected: unknown,
  actual: unknown,
  path: string,
  problems: string[],
): void {
  if (isJsonObject(expected) && isJsonObject(actual)) {
    for (const key of Object.keys(expected)) {
      if (!Object.hasOwn(actual, key))
        problems.push(`${path}.${key}: missing in the MCP Registry entry`);
      else
        collectRegistryProblems(
          expected[key],
          actual[key],
          `${path}.${key}`,
          problems,
        );
    }
    for (const key of Object.keys(actual)) {
      if (!Object.hasOwn(expected, key))
        problems.push(
          `${path}.${key}: unexpected in the MCP Registry entry: ${JSON.stringify(actual[key]) ?? String(actual[key])}`,
        );
    }
    return;
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length)
      problems.push(
        `${path}: expected ${expected.length} items but the registry has ${actual.length}`,
      );
    const shared = Math.min(expected.length, actual.length);
    for (let index = 0; index < shared; index++)
      collectRegistryProblems(
        expected[index],
        actual[index],
        `${path}[${index}]`,
        problems,
      );
    return;
  }
  if (!Object.is(expected, actual))
    problems.push(
      `${path}: expected ${JSON.stringify(expected) ?? String(expected)} but the registry has ${JSON.stringify(actual) ?? String(actual)}`,
    );
}

/**
 * Look up one name@version in the registry API. HTTP 200 with the same server
 * envelope means the entry exists; HTTP 404 means it is absent. Every other
 * outcome throws, so inconclusive lookups fail the gate instead of skipping
 * or publishing blind.
 */
export async function checkRegistryEntry(
  registryBaseUrl: string,
  expected: unknown,
  options: RegistryCheckOptions = {},
): Promise<RegistryCheckResult> {
  // Matches the previous inline workflow lookup; plain fetch, no retry.
  // 30 s matches the timeout the workflow used before this helper existed.
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (
    !isJsonObject(expected) ||
    typeof expected.name !== "string" ||
    typeof expected.version !== "string"
  )
    throw new Error("reviewed server.json must have string name and version");
  const label = `${expected.name}@${expected.version}`;
  const url = `${registryBaseUrl.replace(/\/+$/, "")}/v0.1/servers/${encodeURIComponent(expected.name)}/versions/${encodeURIComponent(expected.version)}`;
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new Error(
      `MCP Registry lookup failed for ${label}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (response.status === 404) return { exists: false };
  if (response.status !== 200)
    throw new Error(
      `MCP Registry lookup for ${label} returned HTTP ${response.status}; absence is not established`,
    );
  let body: unknown;
  try {
    body = JSON.parse(await response.text());
  } catch {
    throw new Error(`MCP Registry returned invalid JSON for ${label}`);
  }
  if (!isJsonObject(body) || !isJsonObject(body.server))
    throw new Error(
      `MCP Registry returned HTTP 200 for ${label} without a server envelope`,
    );
  if (body._meta !== undefined) {
    if (!isJsonObject(body._meta))
      throw new Error(`MCP Registry returned invalid metadata for ${label}`);
    const official = body._meta["io.modelcontextprotocol.registry/official"];
    if (official !== undefined) {
      if (!isJsonObject(official))
        throw new Error(
          `MCP Registry returned invalid official metadata for ${label}`,
        );
      for (const [key, value] of Object.entries(official)) {
        const valid =
          key === "isLatest"
            ? typeof value === "boolean"
            : key === "status"
              ? value === "active" ||
                value === "deprecated" ||
                value === "deleted"
              : key === "statusMessage"
                ? typeof value === "string" && value.length <= 500
                : ["statusChangedAt", "publishedAt", "updatedAt"].includes(key)
                  ? typeof value === "string" &&
                    Number.isFinite(Date.parse(value))
                  : false;
        if (!valid)
          throw new Error(
            `MCP Registry returned invalid official metadata ${key} for ${label}`,
          );
      }
    }
  }
  if (
    typeof body.server.name !== "string" ||
    typeof body.server.version !== "string"
  )
    throw new Error(
      `MCP Registry returned HTTP 200 for ${label} without name and version in the server envelope`,
    );
  const problems = registryProblems(expected, body.server);
  if (problems.length > 0)
    throw new Error(
      `MCP Registry entry for ${label} differs from the reviewed definition:\n${problems.join("\n")}`,
    );
  return { exists: true };
}

/**
 * Require the approved artifact copy to equal the server.json embedded in the
 * approved tarball. Throws on divergence, on a missing embedded file, and on
 * an unreadable or invalid artifact copy; there is no fallback copy.
 */
export function verifyArtifactTarball(
  serverJsonPath: string,
  tarballPath: string,
): void {
  let approved: string;
  try {
    approved = readFileSync(serverJsonPath, "utf8");
  } catch {
    throw new Error(
      `approved ${serverJsonPath} is unreadable; refusing to publish without the reviewed copy`,
    );
  }
  try {
    JSON.parse(approved);
  } catch {
    throw new Error(`approved ${serverJsonPath} is not valid JSON`);
  }
  let embedded: string;
  try {
    embedded = execFileSync(
      "tar",
      ["-xzOf", resolve(tarballPath), "package/server.json"],
      { encoding: "utf8" },
    );
  } catch {
    throw new Error(
      `approved tarball ${tarballPath} has no package/server.json; refusing to publish`,
    );
  }
  if (embedded !== approved)
    throw new Error(
      "release-artifact/server.json differs from server.json embedded in the approved tarball; refusing to publish",
    );
}

async function main(): Promise<void> {
  const [serverJsonPath, tarballPath] = process.argv.slice(2);
  if (!serverJsonPath || !tarballPath || process.argv.length > 4)
    throw new Error(
      "Usage: node scripts/check-mcp-registry.ts <server.json> <tarball>",
    );
  verifyArtifactTarball(serverJsonPath, tarballPath);
  const expected: unknown = JSON.parse(readFileSync(serverJsonPath, "utf8"));
  if (
    !isJsonObject(expected) ||
    typeof expected.name !== "string" ||
    typeof expected.version !== "string"
  )
    throw new Error(
      `reviewed ${serverJsonPath} must have string name and version`,
    );
  const label = `${expected.name}@${expected.version}`;
  const registry =
    process.env.MCP_REGISTRY ?? "https://registry.modelcontextprotocol.io";
  const result = await checkRegistryEntry(registry, expected);
  if (result.exists) {
    console.log(
      `${label} matches the MCP Registry entry; skipping publication.`,
    );
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(process.env.GITHUB_OUTPUT, "exists=true\n");
  } else {
    console.log(`MCP Registry returned 404: ${label} is absent.`);
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(process.env.GITHUB_OUTPUT, "exists=false\n");
  }
}

// Run only as a script, not when the test imports the helpers.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error: unknown) => {
    console.error(
      `MCP registry check failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });

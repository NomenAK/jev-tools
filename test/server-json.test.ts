import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { metadataProblems } from "../scripts/check-mcp-package.ts";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const server = JSON.parse(readFileSync("server.json", "utf8"));

test("server.json stays in step with package.json for the MCP Registry", () => {
  assert.deepEqual(metadataProblems(pkg, server), []);
});

test("version drift between package.json and server.json is caught", () => {
  const bumped = { ...pkg, version: "9.9.9" };
  const problems = metadataProblems(bumped, server);
  assert.equal(problems.length, 2);
  assert.match(problems.join("\n"), /server\.json version/);
  assert.match(problems.join("\n"), /npm version/);
  assert.match(
    metadataProblems({ ...pkg, mcpName: "io.github.other/x" }, server)[0] ?? "",
    /mcpName/,
  );
});

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  INTERNAL_ERROR,
  McpServer,
  SUPPORTED_VERSIONS,
} from "../src/mcp/protocol.ts";

const versionKey = "io.modelcontextprotocol/protocolVersion";
const request = (
  id: number,
  method: string,
  params: Record<string, unknown> = {},
) => ({ jsonrpc: "2.0", id, method, params });

function server(delay?: () => Promise<void>) {
  return new McpServer({ name: "version-fixture", version: "1" }, [
    {
      name: "sample",
      description: "Version projection fixture",
      inputSchema: { type: "object" },
      outputSchema: {
        type: "object",
        properties: { state: { type: "string" } },
      },
      async call() {
        await delay?.();
        return {
          content: [
            { type: "text" as const, text: "partial: evidence is missing" },
          ],
          structuredContent: { state: "partial" },
        };
      },
    },
  ]);
}

for (const version of SUPPORTED_VERSIONS) {
  test(`MCP ${version} exposes only supported result fields`, async () => {
    const mcp = server();
    const meta = { [versionKey]: version };
    if (version !== "2026-07-28") {
      await mcp.handle(request(1, "initialize", { protocolVersion: version }));
    }
    const params = version === "2026-07-28" ? { _meta: meta } : {};
    const list = await mcp.handle(request(2, "tools/list", params));
    const call = await mcp.handle(
      request(3, "tools/call", { ...params, name: "sample" }),
    );
    assert.ok(list && "result" in list && call && "result" in call);
    const supports = !["2024-11-05", "2025-03-26"].includes(version);
    const tools = list.result.tools;
    assert.ok(Array.isArray(tools) && tools[0] && typeof tools[0] === "object");
    assert.equal(Object.hasOwn(tools[0], "outputSchema"), supports);
    assert.equal(Object.hasOwn(call.result, "structuredContent"), supports);
    assert.equal(
      Object.hasOwn(call.result, "resultType"),
      version === "2026-07-28",
    );
    assert.deepEqual(call.result.content, [
      { type: "text", text: "partial: evidence is missing" },
    ]);
    if (supports)
      assert.deepEqual(call.result.structuredContent, { state: "partial" });
  });
}

test("per-request versions cannot contaminate concurrent calls or negotiated defaults", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const mcp = server(() => gate);
  await mcp.handle(request(1, "initialize", { protocolVersion: "2024-11-05" }));
  const modern = mcp.handle(
    request(2, "tools/call", {
      name: "sample",
      _meta: { [versionKey]: "2026-07-28" },
    }),
  );
  const legacy = mcp.handle(request(3, "tools/call", { name: "sample" }));
  release();
  const [a, b] = await Promise.all([modern, legacy]);
  assert.ok(a && "result" in a && b && "result" in b);
  assert.equal(a.result.resultType, "complete");
  assert.deepEqual(a.result.structuredContent, { state: "partial" });
  assert.equal(Object.hasOwn(b.result, "structuredContent"), false);
  assert.equal(Object.hasOwn(b.result, "resultType"), false);
  const later = await mcp.handle(request(4, "tools/list"));
  assert.ok(later && "result" in later);
  const tools = later.result.tools;
  assert.ok(Array.isArray(tools) && tools[0] && typeof tools[0] === "object");
  assert.equal(Object.hasOwn(tools[0], "outputSchema"), false);
});

test("an unexpected execution exception does not fabricate a zero-work report", async () => {
  const mcp = new McpServer({ name: "fault-fixture", version: "1" }, [
    {
      name: "broken",
      description: "Throws before returning observable state",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      async call() {
        throw new Error("unexpected producer failure");
      },
    },
  ]);
  const failed = await mcp.handle(request(1, "tools/call", { name: "broken" }));
  assert.ok(failed && "error" in failed);
  assert.equal(failed.error.code, INTERNAL_ERROR);
  assert.equal("result" in failed, false);
});

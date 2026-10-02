# 0010 - MCP server as a thin host over the same tools

Status: Accepted

## Context

The tools were usable only inside pi and omp. Other agents (Claude Code, Claude Desktop, Kiro, Cursor, VS Code, Codex) integrate external tools through the Model Context Protocol. A separate implementation per client would duplicate evidence collection, judgment and budgets, and drift from the pi and omp behavior.

## Decision

Add `src/mcp/` as one more host, alongside the pi/omp entry point in `src/index.ts`:

- `protocol.ts` implements JSON-RPC 2.0 dispatch for the tools capability only, with no I/O.
- `tools.ts` calls the six existing tool factories unchanged and adapts their results, with the same `ToolDependencies`, session limits, HTTP client and configuration precedence ([ADR 0002](0002-one-http-protocol-across-hosts.md)).
- `main.ts` is the stdio transport and the `jev-agent-tools-mcp` binary.

Write the protocol by hand instead of depending on an MCP SDK, so the package keeps its single runtime dependency. Ship the binary as JavaScript compiled from `src/mcp/main.ts` into `dist/`, because Node refuses to strip TypeScript types under `node_modules`. pi and omp keep loading `src/` directly.

Host-specific behavior stays out of the tools: MCP uses a generic host (`mcpHost()`), a host-neutral process runner and annotations that mark `jev_ask` as not read-only while commands are enabled. The run-end documentation check stays a pi/omp hook; MCP users call `jev_check_diff` with `check: "docs"`.

## Consequences

Every tool change reaches all hosts at once, and MCP tests exercise the real factories. The server must follow MCP protocol revisions itself; it supports the initialize-based versions and `server/discover`, and offers no resources or prompts. Clients decide approval and may ignore server `instructions`, so projects add [agent instructions](../agent-instructions.md) to their own instruction files. The build step is required before packing, enforced by `prepack`.

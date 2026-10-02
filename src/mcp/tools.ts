import type { TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { spawnExec } from "../adapters/exec.ts";
import type { GitExec } from "../core/git.ts";
import { Guide } from "../guide.ts";
import { mcpHost } from "../host.ts";
import { createJevClient, readConfig } from "../jev/client.ts";
import type { JevClient } from "../jev/types.ts";
import type { ToolDependencies } from "../runtime.ts";
import { readSessionLimits, Session } from "../session.ts";
import { createAskTool } from "../tools/ask.ts";
import { createAskFilesTool } from "../tools/ask-files.ts";
import { createCheckDiffTool } from "../tools/check-diff.ts";
import { createFindFilesTool } from "../tools/find.ts";
import { createLocateTool } from "../tools/locate.ts";
import { createSelectTestsTool } from "../tools/select-tests.ts";
import type { McpTool } from "./protocol.ts";

/** The shape every tool factory already returns for pi/omp. */
interface HarnessTool {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
  promptGuidelines?: string[];
  execute(
    id: string,
    args: never,
    signal: AbortSignal | undefined,
    update: unknown,
    ctx: { cwd: string },
  ): Promise<{ content: { type: "text"; text: string }[] }>;
}

export interface McpToolOptions {
  /** Repository directory the tools operate in. */
  root: string;
  env?: NodeJS.ProcessEnv;
  /** Test seams; production uses the configured HTTP client and spawn. */
  client?: JevClient;
  exec?: GitExec;
}

function validationError(schema: TSchema, value: unknown): string | undefined {
  if (Value.Check(schema, value)) return undefined;
  const problems = [...Value.Errors(schema, value)]
    .slice(0, 5)
    .map((error) => `${error.path || "/"}: ${error.message}`);
  return `Invalid arguments. ${problems.join("; ")}`;
}

/**
 * Reuse the six harness tool factories unchanged. One MCP server process is
 * one session: limits, cache and counters live as long as the connection.
 */
export function createMcpTools(options: McpToolOptions): {
  tools: McpTool[];
  instructions: string;
  configured: boolean;
} {
  const env = options.env ?? process.env;
  const host = mcpHost();
  const config = readConfig(env);
  const client =
    options.client ?? (config ? createJevClient(config) : undefined);
  const dependencies: ToolDependencies = {
    client,
    host,
    runtime: {
      session: new Session(readSessionLimits(env)),
      guide: new Guide(host),
    },
    exec: options.exec ?? spawnExec,
  };
  const harness = [
    createAskTool(dependencies),
    createAskFilesTool(dependencies),
    createFindFilesTool(dependencies),
    createLocateTool(dependencies),
    createCheckDiffTool(dependencies),
    createSelectTestsTool(dependencies),
  ] as unknown as HarnessTool[];
  let id = 0;
  const tools = harness.map((tool): McpTool => {
    const runsCommands =
      tool.name === "jev_ask" &&
      JSON.stringify(tool.parameters).includes('"command"');
    return {
      name: tool.name,
      title: tool.label,
      description: tool.description,
      inputSchema: JSON.parse(
        JSON.stringify(tool.parameters),
      ) as McpTool["inputSchema"],
      annotations: {
        title: tool.label,
        // Evidence is read-only unless jev_ask may run a shell command.
        readOnlyHint: !runsCommands,
        destructiveHint: runsCommands,
        idempotentHint: false,
        // Evidence is sent to the configured judgment endpoint.
        openWorldHint: true,
      },
      async call(args, signal) {
        const invalid = validationError(tool.parameters, args);
        if (invalid)
          return { content: [{ type: "text", text: invalid }], isError: true };
        const result = await tool.execute(
          `mcp-${++id}`,
          args as never,
          signal,
          undefined,
          { cwd: options.root },
        );
        return { content: result.content };
      },
    };
  });
  const guidelines = harness.flatMap((tool) => tool.promptGuidelines ?? []);
  const instructions = [dependencies.runtime.guide.text, ...guidelines].join(
    "\n\n",
  );
  return { tools, instructions, configured: client !== undefined };
}

import type { TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { spawnExec } from "../adapters/exec.ts";
import { ConfigController } from "../configuration.ts";
import { MCP_VALIDATION_MAX_ERRORS } from "../constants.ts";
import type { GitExec } from "../core/git.ts";
import { type ResultReportV1, resultIsError } from "../core/result-report.ts";
import { Guide } from "../guide.ts";
import { mcpHost } from "../host.ts";
import type { JevClient } from "../jev/types.ts";
import { mcpStructuredResultSchema } from "../report-schema.ts";
import type { ToolDependencies } from "../runtime.ts";
import { readSessionLimits, Session } from "../session.ts";
import { renderAgentInstructions } from "../texts/instructions.ts";
import { createAskTool } from "../tools/ask.ts";
import { createAskFilesTool } from "../tools/ask-files.ts";
import { createCheckDiffTool } from "../tools/check-diff.ts";
import { createFindFilesTool } from "../tools/find.ts";
import { createLocateTool } from "../tools/locate.ts";
import { createSelectTestsTool } from "../tools/select-tests.ts";
import { McpInvalidParams, type McpTool } from "./protocol.ts";

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
  ): Promise<{
    content: { type: "text"; text: string }[];
    details: { result: ResultReportV1 };
  }>;
}

export interface McpToolOptions {
  /** Repository directory the tools operate in. */
  root: string;
  env?: NodeJS.ProcessEnv;
  /** Test seams; production uses the configured HTTP client and spawn. */
  client?: JevClient;
  exec?: GitExec;
  /** Saved-configuration directory; defaults to the pi/omp setup location. */
  configDirectory?: string;
}

function validationError(schema: TSchema, value: unknown): string | undefined {
  if (Value.Check(schema, value)) return undefined;
  const problems: string[] = [];
  for (const error of Value.Errors(schema, value)) {
    problems.push(`${error.path || "/"}: ${error.message}`);
    if (problems.length === MCP_VALIDATION_MAX_ERRORS) break;
  }
  return `Invalid arguments. ${problems.join("; ")}`;
}

/**
 * Effective Jev client for MCP, with the same precedence as pi/omp minus the
 * interactive layers: environment variables, then the configuration saved by
 * `/jev-setup` in pi or omp. Storage problems never stop the server; the tools
 * then explain the missing configuration and `warning` says why.
 */
export async function loadMcpClient(
  env: NodeJS.ProcessEnv,
  configDirectory?: string,
): Promise<{ client?: JevClient; apiKey?: string; warning?: string }> {
  try {
    const controller = new ConfigController({
      env,
      ...(configDirectory ? { directory: configDirectory } : {}),
    });
    const configured = () =>
      controller.client
        ? { client: controller.client, apiKey: controller.values().apiKey }
        : {};
    try {
      await controller.initialize({});
    } catch (error) {
      // Saved storage unusable: environment configuration (if any) still applies.
      return {
        ...configured(),
        warning: error instanceof Error ? error.message : String(error),
      };
    }
    return configured();
  } catch (error) {
    return { warning: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Reuse the six harness tool factories unchanged. One MCP server process is
 * one session: limits, cache and counters live as long as the connection.
 */
export async function createMcpTools(options: McpToolOptions): Promise<{
  tools: McpTool[];
  instructions: string;
  configured: boolean;
  warning?: string;
}> {
  const env = options.env ?? process.env;
  const host = mcpHost();
  const loaded = options.client
    ? { client: options.client, apiKey: env.JEV_TOOLS_API_KEY }
    : await loadMcpClient(env, options.configDirectory);
  const client = loaded.client;
  const dependencies: ToolDependencies = {
    client,
    apiKey: loaded.apiKey,
    host,
    evidenceOrigin: "server",
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
      outputSchema: mcpStructuredResultSchema as McpTool["inputSchema"],
      async call(args, signal) {
        const invalid = validationError(tool.parameters, args);
        if (invalid) throw new McpInvalidParams(invalid);
        const result = await tool.execute(
          `mcp-${++id}`,
          args as never,
          signal,
          undefined,
          { cwd: options.root },
        );
        return {
          content: result.content,
          structuredContent: { result: result.details.result },
          ...(resultIsError(result.details.result) ? { isError: true } : {}),
        };
      },
    };
  });
  const instructions = renderAgentInstructions("mcp", host.names);
  return {
    tools,
    instructions,
    configured: client !== undefined,
    ...(loaded.warning ? { warning: loaded.warning } : {}),
  };
}

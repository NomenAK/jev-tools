/**
 * Minimal MCP (Model Context Protocol) server core: JSON-RPC 2.0 dispatch for
 * the tools capability only. No I/O here; the stdio transport feeds it parsed
 * messages and writes back whatever it returns.
 *
 * Supports the initialize-based protocol versions and the 2026-07-28
 * `server/discover` entry point with per-request version metadata.
 */

export const SUPPORTED_VERSIONS = [
  "2026-07-28",
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
] as const;
const LATEST_INITIALIZE_VERSION = "2025-11-25";
const VERSION_META = "io.modelcontextprotocol/protocolVersion";

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;
export const UNSUPPORTED_PROTOCOL_VERSION = -32022;

export interface McpContent {
  type: "text";
  text: string;
}
export interface McpCallResult {
  content: McpContent[];
  isError?: boolean;
}
export interface McpTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: { type: "object"; [key: string]: unknown };
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  call(
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<McpCallResult>;
}
export interface McpServerInfo {
  name: string;
  version: string;
  instructions?: string;
}

type Id = string | number;
export type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: Id | null; result: Record<string, unknown> }
  | {
      jsonrpc: "2.0";
      id: Id | null;
      error: { code: number; message: string; data?: unknown };
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isId(value: unknown): value is Id {
  return (
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

export class McpServer {
  private readonly tools: Map<string, McpTool>;
  private readonly info: McpServerInfo;
  private readonly inFlight = new Map<Id, AbortController>();

  constructor(info: McpServerInfo, tools: readonly McpTool[]) {
    this.info = info;
    this.tools = new Map(tools.map((tool) => [tool.name, tool]));
  }

  /** Abort every running tool call, e.g. when stdin closes. */
  abortAll(): void {
    for (const controller of this.inFlight.values()) controller.abort();
    this.inFlight.clear();
  }

  /** Handle one decoded JSON-RPC message; notifications return undefined. */
  async handle(message: unknown): Promise<JsonRpcResponse | undefined> {
    if (!isRecord(message) || message.jsonrpc !== "2.0")
      return this.error(
        isRecord(message) && isId(message.id) ? message.id : null,
        INVALID_REQUEST,
        "Invalid JSON-RPC 2.0 message.",
      );
    const { method, id } = message;
    const params = isRecord(message.params) ? message.params : {};
    // Responses to server-initiated requests: this server sends none.
    if (method === undefined && ("result" in message || "error" in message))
      return undefined;
    if (typeof method !== "string")
      return this.error(
        isId(id) ? id : null,
        INVALID_REQUEST,
        "Missing method.",
      );
    if (id === undefined) {
      this.notify(method, params);
      return undefined;
    }
    if (!isId(id))
      return this.error(
        null,
        INVALID_REQUEST,
        "Request id must be a string or number.",
      );
    const meta = isRecord(params._meta) ? params._meta : {};
    const requested = meta[VERSION_META];
    if (
      typeof requested === "string" &&
      !(SUPPORTED_VERSIONS as readonly string[]).includes(requested)
    )
      return this.error(
        id,
        UNSUPPORTED_PROTOCOL_VERSION,
        "Unsupported protocol version.",
        {
          supported: [...SUPPORTED_VERSIONS],
          requested,
        },
      );
    try {
      switch (method) {
        case "initialize":
          return this.result(id, this.initialize(params));
        case "server/discover":
          return this.result(id, {
            supportedVersions: [...SUPPORTED_VERSIONS],
            capabilities: { tools: { listChanged: false } },
            _meta: {
              "io.modelcontextprotocol/serverInfo": {
                name: this.info.name,
                version: this.info.version,
              },
            },
            ...(this.info.instructions
              ? { instructions: this.info.instructions }
              : {}),
            ttlMs: 0,
            cacheScope: "private",
          });
        case "ping":
          return this.result(id, {});
        case "tools/list":
          return this.result(id, {
            tools: [...this.tools.values()].map(
              ({ call: _call, ...tool }) => tool,
            ),
            // CacheableResult requires these from 2026-07-28; 0/private is
            // conservative (immediately stale, same authorization context)
            // and ignored by earlier clients via the open result shape.
            ttlMs: 0,
            cacheScope: "private",
          });
        case "tools/call":
          return await this.callTool(id, params);
        default:
          return this.error(
            id,
            METHOD_NOT_FOUND,
            `Method not found: ${method}`,
          );
      }
    } catch (error) {
      return this.error(
        id,
        INTERNAL_ERROR,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private initialize(params: Record<string, unknown>): Record<string, unknown> {
    const requested = params.protocolVersion;
    // Echo a supported initialize-era version, else offer our latest one.
    const protocolVersion =
      typeof requested === "string" &&
      requested !== "2026-07-28" &&
      (SUPPORTED_VERSIONS as readonly string[]).includes(requested)
        ? requested
        : LATEST_INITIALIZE_VERSION;
    return {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: this.info.name, version: this.info.version },
      ...(this.info.instructions
        ? { instructions: this.info.instructions }
        : {}),
    };
  }

  private notify(method: string, params: Record<string, unknown>): void {
    if (method === "notifications/cancelled" && isId(params.requestId)) {
      this.inFlight.get(params.requestId)?.abort();
      this.inFlight.delete(params.requestId);
    }
    // notifications/initialized and unknown notifications need no action.
  }

  private async callTool(
    id: Id,
    params: Record<string, unknown>,
  ): Promise<JsonRpcResponse | undefined> {
    const tool =
      typeof params.name === "string" ? this.tools.get(params.name) : undefined;
    if (!tool)
      return this.error(
        id,
        INVALID_PARAMS,
        `Unknown tool: ${String(params.name)}`,
      );
    if (params.arguments !== undefined && !isRecord(params.arguments))
      return this.error(
        id,
        INVALID_PARAMS,
        "Tool arguments must be an object.",
      );
    const controller = new AbortController();
    this.inFlight.set(id, controller);
    // A cancelled request gets no response on any path: 2025-11-25 says
    // receivers SHOULD NOT respond, and the 2026-07-28 stdio transport says
    // servers MUST NOT send further messages for it. The signal stays aborted
    // after the notification removes the entry, so the check is race-free.
    const cancelled = () => controller.signal.aborted;
    try {
      const result = await tool.call(params.arguments ?? {}, controller.signal);
      if (cancelled()) return undefined;
      return this.result(id, { ...result });
    } catch (error) {
      if (cancelled()) return undefined;
      // Tool execution failures are results the model can read, not protocol errors.
      return this.result(id, {
        content: [
          {
            type: "text",
            text: `${tool.name} failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      });
    } finally {
      this.inFlight.delete(id);
    }
  }

  private result(id: Id, result: Record<string, unknown>): JsonRpcResponse {
    // resultType is required from 2026-07-28 and ignored by earlier clients.
    return {
      jsonrpc: "2.0",
      id,
      result: { resultType: "complete", ...result },
    };
  }

  error(
    id: Id | null,
    code: number,
    message: string,
    data?: unknown,
  ): JsonRpcResponse {
    return {
      jsonrpc: "2.0",
      id,
      error: { code, message, ...(data === undefined ? {} : { data }) },
    };
  }
}

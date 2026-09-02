import {
  McpConnectionClient,
  type McpCredentialProvider,
  type McpEndpoint,
} from "../mcp/client.js";
import type { FlaryMcpConnection, FlaryMcpSource } from "./types.js";

export interface FlaryMcpRuntimeOptions {
  readonly fetch?: typeof fetch;
  readonly credentials?: McpCredentialProvider;
  readonly allowInsecureHttp?: boolean;
  /** Stable UUID used for MCP tools that accept a `session_id` argument. */
  readonly sessionId?: string;
}

/** Build a safe MCP connection for an explicit HTTPS source URL. */
export function createMcpConnection(
  source: FlaryMcpSource,
  options: FlaryMcpRuntimeOptions = {},
): FlaryMcpConnection {
  if (!source.url) {
    throw new Error(
      `MCP source '${source.namespace}' needs a URL or an application connection resolver.`,
    );
  }
  const endpoint: McpEndpoint = {
    connectionId: source.connection ?? source.namespace,
    name: source.namespace,
    url: source.url,
    transport: source.transport ?? "streamable-http",
  };
  const client = new McpConnectionClient(endpoint, {
    fetch: options.fetch,
    allowInsecureHttp: options.allowInsecureHttp,
  });
  return {
    name: source.namespace,
    fetchTools: async () =>
      (await client.listTools(options.credentials)).map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
      })),
    client: {
      callTool: async (input) => {
        const argumentsInput =
          source.session === "run" && options.sessionId
            ? { ...input.arguments, session_id: options.sessionId }
            : (input.arguments ?? {});
        const result = await client.call(input.name, argumentsInput, options.credentials);
        return { toolResult: result.content, isError: result.isError };
      },
    },
  };
}

/** Build a stable, non-secret UUID for one Flary run or submitted turn. */
export async function mcpSessionUuid(seed?: string): Promise<string> {
  if (!seed) return crypto.randomUUID();
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed)),
  );
  const bytes = digest.slice(0, 16);
  // UUID version 8 permits application-defined bytes while keeping the RFC
  // variant bits. The seed stays private and cannot be recovered from this ID.
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

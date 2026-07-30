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
        const result = await client.call(
          input.name,
          input.arguments ?? {},
          options.credentials,
        );
        return { toolResult: result.content, isError: result.isError };
      },
    },
  };
}

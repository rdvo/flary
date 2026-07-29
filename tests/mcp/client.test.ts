import assert from "node:assert/strict";
import test from "node:test";

import {
  McpConnectionClient,
  McpSecurityError,
  assertSafeMcpUrl,
} from "../../src/harness/mcp/client.js";

test("MCP rejects local and insecure remote endpoints", () => {
  assert.throws(
    () => assertSafeMcpUrl("http://example.com/mcp"),
    McpSecurityError,
  );
  assert.throws(
    () => assertSafeMcpUrl("https://127.0.0.1/mcp"),
    /private|local/i,
  );
  assert.throws(
    () => assertSafeMcpUrl("https://user:pass@example.com/mcp"),
    /user information/i,
  );
});

test("MCP discovers redacted schemas and only adds credentials on invocation", async () => {
  const requests: Array<{ body: any; headers: Headers }> = [];
  const client = new McpConnectionClient(
    {
      connectionId: "connection_1",
      name: "Docs MCP",
      url: "https://mcp.example.com/api",
      transport: "streamable-http",
    },
    {
      fetch: async (_input, init) => {
        const headers = new Headers(init?.headers);
        const body = JSON.parse(String(init?.body));
        requests.push({ body, headers });
        const result = body.method === "initialize"
          ? { protocolVersion: "2025-03-26" }
          : body.method === "tools/list"
            ? { tools: [{ name: "search", description: "Search docs", inputSchema: { type: "object" } }] }
            : { content: [{ type: "text", text: "ok" }], isError: false };
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
          headers: { "content-type": "application/json", "mcp-session-id": "session_1" },
        });
      },
    },
  );

  const tools = await client.listTools();
  assert.equal(tools[0]?.name, "search");
  assert.equal(requests[0]?.headers.get("authorization"), null);

  const result = await client.call(
    "search",
    { query: "durable" },
    { get: async () => ({ kind: "bearer", value: "secret-value" }) },
  );
  assert.equal((result.content as { content: unknown[] }).content.length, 1);
  assert.equal(requests.at(-1)?.headers.get("authorization"), "Bearer secret-value");
});

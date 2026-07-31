import assert from "node:assert/strict";
import test from "node:test";

import { resolveAgentMode } from "../../src/harness/contracts/modes.js";
import type { ToolLifecycleEvent } from "../../src/harness/contracts/tools.js";
import { InMemoryToolExecutionJournal } from "../../src/harness/execution/tool-journal.js";
import {
  McpTenantIsolationError,
  createMcpTools,
} from "../../src/harness/mcp/tools.js";
import { McpToolCache } from "../../src/harness/mcp/client.js";

const endpoint = {
  organizationId: "org_1",
  appId: "app_1",
  connectionId: "connection_1",
  name: "Tickets MCP",
  url: "https://mcp.example.com/api",
  transport: "streamable-http" as const,
};

function createMcpFetch() {
  const requests: Array<{ body: any; headers: Headers }> = [];
  let toolCalls = 0;
  const fetcher: typeof fetch = async (_input, init) => {
    const headers = new Headers(init?.headers);
    const body = JSON.parse(String(init?.body));
    requests.push({ body, headers });

    if (body.method === "notifications/initialized") {
      return new Response(null, { status: 204 });
    }
    const result =
      body.method === "initialize"
        ? { protocolVersion: "2025-03-26" }
        : body.method === "tools/list"
          ? {
              tools: [
                {
                  name: "tickets.create",
                  description: "Create one support ticket",
                  inputSchema: {
                    type: "object",
                    properties: {
                      title: { type: "string", minLength: 1 },
                    },
                    required: ["title"],
                    additionalProperties: false,
                  },
                },
                {
                  name: "tickets.internal",
                  description: "An unapproved private tool",
                  inputSchema: { type: "object" },
                },
              ],
            }
          : (() => {
              toolCalls += 1;
              return {
                content: [{ type: "text", text: "ticket_1" }],
                isError: false,
              };
            })();
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: body.id, result }),
      {
        headers: {
          "content-type": "application/json",
          "mcp-session-id": "session_1",
        },
      },
    );
  };
  return {
    fetcher,
    requests,
    toolCalls: () => toolCalls,
  };
}

function findTool(
  tools: Awaited<ReturnType<typeof createMcpTools>>,
  name: string,
) {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `Expected Flue tool ${name}`);
  return tool;
}

test("MCP descriptors stay lazy and durable calls do not expose credentials", async () => {
  const remote = createMcpFetch();
  const journal = new InMemoryToolExecutionJournal();
  const events: ToolLifecycleEvent[] = [];
  let approvals = 0;
  const tools = await createMcpTools({
    scope: {
      organizationId: "org_1",
      appId: "app_1",
      userId: "user_1",
    },
    endpoints: [endpoint],
    credentials: async ({ scope, endpoint: authorized }) => {
      assert.equal(scope.organizationId, "org_1");
      assert.equal(authorized.connectionId, "connection_1");
      return { kind: "bearer", value: "top-secret-token" };
    },
    permissions: ({ tool }) =>
      tool.name === "tickets.create"
        ? {
            operation: "write",
            capabilities: ["tickets.write"],
            requiresApproval: true,
          }
        : false,
    clientOptions: { fetch: remote.fetcher },
    mode: {
      ...resolveAgentMode("build"),
      allowedCapabilities: ["tickets.write"],
    },
    runId: "run_1",
    journal,
    approve: async () => {
      approvals += 1;
    },
    onEvent: async (event) => {
      events.push(event);
    },
  });

  const search = (await findTool(tools, "tool_search").run({
    input: { query: "ticket", maxResults: 5 },
  })) as any[];
  assert.equal(search.length, 1);
  assert.equal(search[0]?.name, "tickets.create");
  assert.equal("inputSchema" in search[0], false);

  const described = (await findTool(tools, "tool_describe").run({
    input: { id: search[0].id },
  })) as any;
  assert.equal(described.tool.inputSchema.properties.title.type, "string");
  assert.equal(
    JSON.stringify(described).includes("top-secret-token"),
    false,
  );

  const invocation = {
    id: search[0].id,
    arguments: { title: "Login is unavailable" },
    callId: "call_1",
    idempotencyKey: "ticket_create_1",
  };
  const first = (await findTool(tools, "tool_call").run({
    input: invocation,
  })) as any;
  const replay = (await findTool(tools, "tool_call").run({
    input: invocation,
  })) as any;

  assert.equal(first.status, "fulfilled");
  assert.equal(replay.status, "fulfilled");
  assert.equal(replay.deduplicated, true);
  assert.equal(remote.toolCalls(), 1);
  assert.equal(approvals, 1);
  assert.equal(
    remote.requests.every(
      (request) =>
        request.headers.get("authorization") === "Bearer top-secret-token",
    ),
    true,
  );
  assert.deepEqual(
    events.map((event) => event.type),
    ["tool.started", "tool.completed", "tool.completed"],
  );
  assert.equal(JSON.stringify(events).includes("top-secret-token"), false);
  assert.equal(JSON.stringify(events).includes("Login is unavailable"), false);
  assert.equal(
    events.every(
      (event) =>
        typeof event.metadata?.connectionRef === "string" &&
        event.metadata.connectionRef.length === 24,
    ),
    true,
  );
  assert.equal(JSON.stringify(events).includes("connection_1"), false);
});

test("MCP validates the discovered JSON schema before a remote call", async () => {
  const remote = createMcpFetch();
  const tools = await createMcpTools({
    scope: { organizationId: "org_1", appId: "app_1" },
    endpoints: [endpoint],
    credentials: async () => undefined,
    permissions: ({ tool }) =>
      tool.name === "tickets.create"
        ? { operation: "read", capabilities: ["tickets.read"] }
        : false,
    clientOptions: { fetch: remote.fetcher },
    mode: {
      ...resolveAgentMode("ask"),
      allowedCapabilities: ["tickets.read"],
    },
    runId: "run_2",
    journal: new InMemoryToolExecutionJournal(),
  });
  const search = (await findTool(tools, "tool_search").run({
    input: { query: "ticket" },
  })) as any[];
  const result = (await findTool(tools, "tool_call").run({
    input: {
      id: search[0].id,
      arguments: {},
      callId: "call_invalid",
    },
  })) as any;

  assert.equal(result.status, "rejected");
  assert.equal(result.error.code, "mcp_tool_input_invalid");
  assert.equal(remote.toolCalls(), 0);
});

test("MCP rejects a cross-tenant endpoint before credential or network access", async () => {
  let credentialReads = 0;
  let fetches = 0;
  await assert.rejects(
    createMcpTools({
      scope: { organizationId: "org_1", appId: "app_1" },
      endpoints: [{ ...endpoint, organizationId: "org_2" }],
      credentials: async () => {
        credentialReads += 1;
        return { kind: "bearer", value: "secret" };
      },
      permissions: () => ({ operation: "read" }),
      clientOptions: {
        fetch: async () => {
          fetches += 1;
          return new Response();
        },
      },
      mode: resolveAgentMode("ask"),
      runId: "run_3",
      journal: new InMemoryToolExecutionJournal(),
    }),
    McpTenantIsolationError,
  );
  assert.equal(credentialReads, 0);
  assert.equal(fetches, 0);
});

test("one failed MCP discovery does not block another connection", async () => {
  const remote = createMcpFetch();
  const failures: string[] = [];
  const tools = await createMcpTools({
    scope: { organizationId: "org_1", appId: "app_1" },
    endpoints: [
      { ...endpoint, connectionId: "broken", url: "https://broken.example.com" },
      endpoint,
    ],
    credentials: async () => undefined,
    permissions: ({ tool }) =>
      tool.name === "tickets.create"
        ? { operation: "read", capabilities: ["tickets.read"] }
        : false,
    clientOptions: {
      fetch: async (input, init) => {
        if (String(input).includes("broken")) {
          throw new Error("The endpoint is offline and secret detail follows");
        }
        return remote.fetcher(input, init);
      },
    },
    onDiscoveryError: async (failure) => {
      failures.push(`${failure.endpoint.connectionId}:${failure.error.message}`);
    },
    mode: {
      ...resolveAgentMode("ask"),
      allowedCapabilities: ["tickets.read"],
    },
    runId: "run_4",
    journal: new InMemoryToolExecutionJournal(),
  });

  assert.equal(tools.length, 4);
  assert.deepEqual(failures, ["broken:MCP tool discovery failed"]);
});

test("MCP authenticated sessions are isolated between users", async () => {
  const remote = createMcpFetch();
  let initializeCalls = 0;
  const cache = new McpToolCache({
    fetch: async (input, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.method === "initialize") initializeCalls += 1;
      return remote.fetcher(input, init);
    },
  });
  const createForUser = (userId: string, token: string) =>
    createMcpTools({
      scope: { organizationId: "org_1", appId: "app_1", userId },
      endpoints: [endpoint],
      credentials: async () => ({ kind: "bearer", value: token }),
      permissions: ({ tool }) =>
        tool.name === "tickets.create"
          ? { operation: "read", capabilities: ["tickets.read"] }
          : false,
      cache,
      mode: {
        ...resolveAgentMode("ask"),
        allowedCapabilities: ["tickets.read"],
      },
      runId: `run_${userId}`,
      journal: new InMemoryToolExecutionJournal(),
    });

  await createForUser("user_a", "token-a");
  await createForUser("user_b", "token-b");

  assert.equal(initializeCalls, 2);
  assert.equal(
    remote.requests.some(
      (request) => request.headers.get("authorization") === "Bearer token-a",
    ),
    true,
  );
  assert.equal(
    remote.requests.some(
      (request) => request.headers.get("authorization") === "Bearer token-b",
    ),
    true,
  );
});

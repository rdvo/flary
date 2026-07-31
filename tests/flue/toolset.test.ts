import assert from "node:assert/strict";
import test from "node:test";

import {
  createFlaryToolset,
  defineFlaryAgent,
  type FlaryToolScope,
  type FlaryWorkspaceTargetResolver,
} from "../../src/harness/flue/index.js";
import {
  ProjectFileEntrySchema,
  ProjectFileReadResponseSchema,
} from "../../src/harness/contracts/filesystem.js";
import type { WorkspaceToolTarget } from "../../src/harness/tools/workspace.js";
import { createCloudflareWorkspaceTarget } from "../../src/harness/cloudflare/workspace.js";

const entry = ProjectFileEntrySchema.parse({
  path: "src/index.ts",
  size: 24,
  sha256: "a".repeat(64),
  mediaType: "text/typescript",
  storage: "inline",
  createdAt: "2026-07-30T00:00:00.000Z",
  updatedAt: "2026-07-30T00:00:00.000Z",
});

function workspaceTarget() {
  let writes = 0;
  const target: WorkspaceToolTarget = {
    async read() {
      return ProjectFileReadResponseSchema.parse({
        file: entry,
        content: "export const ready = true;",
        encoding: "utf8",
      });
    },
    async write() {
      writes += 1;
      return { file: entry };
    },
    async edit() {
      writes += 1;
      return { file: entry, replacementCount: 1 };
    },
    async delete() {
      writes += 1;
      return { deleted: [entry.path] };
    },
    async move() {
      writes += 1;
      return { file: entry };
    },
    async list() {
      return { files: [entry] };
    },
    async stat() {
      return entry;
    },
    async glob() {
      return { paths: [entry.path] };
    },
    async grep() {
      return { files: [] };
    },
    async diff() {
      return { path: entry.path, diff: "" };
    },
    async batchEdit() {
      writes += 1;
      return { results: [], totalReplacementCount: 0 };
    },
  };
  return { target, writes: () => writes };
}

const scope: FlaryToolScope = {
  tenantId: "org_acme",
  appId: "host",
  projectId: "project_1",
  workspaceId: "workspace_1",
  branch: "main",
  userId: "user_1",
  runId: "run_1",
};

function flueTool(
  tools: Awaited<ReturnType<typeof createFlaryToolset>>["tools"],
  name: string,
) {
  const tool = tools.find((value) => value.name === name);
  assert.ok(tool, `Missing Flue tool: ${name}`);
  return tool;
}

test("host-neutral toolset keeps workspace schemas lazy and enforces read-only admission", async () => {
  const workspace = workspaceTarget();
  let resolvedScope: unknown;
  const resolver: FlaryWorkspaceTargetResolver = {
    resolve(input) {
      resolvedScope = input;
      return workspace.target;
    },
  };
  const toolset = await createFlaryToolset({
    scope,
    capabilities: ["workspace.read"],
    workspace: resolver,
  });

  assert.deepEqual(resolvedScope, {
    tenantId: "org_acme",
    appId: "host",
    projectId: "project_1",
    workspaceId: "workspace_1",
    branch: "main",
  });
  const search = await flueTool(toolset.tools, "tool_search").run({
    input: { query: "workspace file", maxResults: 20 },
  }) as Array<Record<string, unknown>>;
  assert.ok(search.some((item) => item.id === "workspace.file.read"));
  assert.equal(search.some((item) => item.id === "workspace.file.write"), false);
  assert.equal(search.some((item) => "inputSchema" in item), false);

  await assert.rejects(
    () =>
      flueTool(toolset.tools, "tool_call").run({
        input: {
          id: "workspace.file.write",
          arguments: { path: "src/index.ts", content: "changed" },
        },
      }),
    /not available/i,
  );
  assert.equal(workspace.writes(), 0);
});

test("workspace writes need approval and replay from the journal", async () => {
  const workspace = workspaceTarget();
  let approvals = 0;
  const toolset = await createFlaryToolset({
    scope,
    capabilities: ["workspace.read", "workspace.write"],
    workspace: {
      target: workspace.target,
      requireApprovalForWrites: true,
    },
    approvals: {
      approve: async () => {
        approvals += 1;
      },
    },
  });
  const call = {
    id: "workspace.file.write",
    arguments: { path: "src/index.ts", content: "changed" },
    callId: "write_1",
    idempotencyKey: "write_key_1",
  };
  const first = await flueTool(toolset.tools, "tool_call").run({
    input: call,
  }) as Record<string, unknown>;
  const replay = await flueTool(toolset.tools, "tool_call").run({
    input: call,
  }) as Record<string, unknown>;

  assert.equal(first.status, "fulfilled");
  assert.equal(replay.deduplicated, true);
  assert.equal(workspace.writes(), 1);
  assert.equal(approvals, 1);
});

test("Code Mode exposes one execute tool and can use the private lazy catalog", async () => {
  const workspace = workspaceTarget();
  const toolset = await createFlaryToolset({
    scope,
    capabilities: ["workspace.read", "code.execute"],
    workspace: workspace.target,
    codeMode: {
      enabled: true,
      async execute({ tools }) {
        const matches = await tools.search("read workspace file") as Array<{
          id: string;
        }>;
        return tools.call(matches[0]!.id, {
          path: "src/index.ts",
          encoding: "utf8",
        });
      },
    },
    sandbox: { enabled: false },
  });

  assert.deepEqual(toolset.tools.map((tool) => tool.name), ["execute"]);
  const result = await flueTool(toolset.tools, "execute").run({
    input: { code: "return tools.search('workspace')" },
  }) as Record<string, unknown>;
  assert.equal(result.status, "fulfilled");
  assert.equal(JSON.stringify(result).includes("ready = true"), true);
});

test("Code Mode assigns stable call ordinals so a recovered write runs once", async () => {
  const workspace = workspaceTarget();
  const toolset = await createFlaryToolset({
    scope,
    capabilities: ["workspace.write", "code.execute"],
    workspace: workspace.target,
    approvals: { approve: async () => undefined },
    codeMode: {
      enabled: true,
      async execute({ tools }) {
        return tools.call("workspace.file.write", {
          path: "src/index.ts",
          content: "changed",
        });
      },
    },
  });
  const execute = flueTool(toolset.tools, "execute");
  const first = await execute.run({
    input: { code: "return tools.call('workspace.file.write', input)" },
  }) as Record<string, unknown>;
  const replay = await execute.run({
    input: { code: "return tools.call('workspace.file.write', input)" },
  }) as Record<string, unknown>;

  assert.equal(first.status, "fulfilled");
  assert.equal(replay.deduplicated, true);
  assert.equal(workspace.writes(), 1);
});

test("host extensions share the same catalog and capability checks", async () => {
  const toolset = await createFlaryToolset({
    scope,
    capabilities: ["api.call"],
    extend(catalog) {
      catalog.register({
        definition: {
          id: "orders.lookup",
          name: "Look up order",
          kind: "function",
          inputSchema: {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
            additionalProperties: false,
          },
          operation: "read",
          capabilities: ["api.call"],
          tags: ["orders"],
        },
        execute: (input) => ({ found: true, input }),
      });
    },
  });
  const search = await flueTool(toolset.tools, "tool_search").run({
    input: { query: "order" },
  }) as Array<{ id: string }>;
  assert.deepEqual(search.map((item) => item.id), ["orders.lookup"]);
});

test("Cloudflare workspace adapter passes the full immutable scope to a host binding", async () => {
  let resolved: unknown;
  const workspace = workspaceTarget();
  const target = createCloudflareWorkspaceTarget({
    binding: {
      resolve(input) {
        resolved = input;
        return workspace.target;
      },
    },
  });
  const value = await target.resolve({
    tenantId: "org_1",
    appId: "app_1",
    projectId: "project_1",
    workspaceId: "workspace_1",
    branch: "feature/a",
  });
  await value.read({ path: "src/index.ts", encoding: "utf8" });

  assert.deepEqual(resolved, {
    organizationId: "org_1",
    appId: "app_1",
    projectId: "project_1",
    workspaceId: "workspace_1",
    branch: "feature/a",
  });
});

test("Cloudflare workspace namespaces isolate tenant, project, and branch object IDs", async () => {
  const objectNames: string[] = [];
  const target = createCloudflareWorkspaceTarget({
    binding: {
      idFromName(name) {
        objectNames.push(name);
        return { toString: () => name };
      },
      get() {
        return {
          async fetch(request: Request) {
            const body = await request.json() as {
              scope: { branch: string };
            };
            return Response.json({
              output: ProjectFileReadResponseSchema.parse({
                file: entry,
                content: body.scope.branch,
                encoding: "utf8",
              }),
            });
          },
        };
      },
    },
  });
  const main = await target.resolve({
    tenantId: "org_1",
    appId: "app_1",
    projectId: "project_1",
    workspaceId: "workspace_1",
    branch: "main",
  });
  const feature = await target.resolve({
    tenantId: "org_1",
    appId: "app_1",
    projectId: "project_1",
    workspaceId: "workspace_1",
    branch: "feature/a",
  });
  const otherProject = await target.resolve({
    tenantId: "org_1",
    appId: "app_1",
    projectId: "project_2",
    workspaceId: "workspace_1",
    branch: "main",
  });

  assert.equal(
    (await main.read({ path: entry.path, encoding: "utf8" })).content,
    "main",
  );
  assert.equal(
    (await feature.read({ path: entry.path, encoding: "utf8" })).content,
    "feature/a",
  );
  await otherProject.read({ path: entry.path, encoding: "utf8" });
  assert.equal(new Set(objectNames).size, 3);
  assert.equal(objectNames.every((name) => /^workspace_[0-9a-f]{64}$/.test(name)), true);
});

test("Sandbox fails closed without both capability and an explicit adapter", async () => {
  await assert.rejects(
    () =>
      createFlaryToolset({
        scope,
        capabilities: [],
        sandbox: { enabled: true },
      }),
    /not admitted/i,
  );
  await assert.rejects(
    () =>
      createFlaryToolset({
        scope,
        capabilities: ["sandbox.execute"],
        sandbox: { enabled: true },
      }),
    /explicit adapter and binding/i,
  );
});

test("MCP authorization stays scoped and a missing credential fails closed", async () => {
  let credentialAvailable = true;
  const requests: Array<{ body: Record<string, unknown>; authorization: string | null }> = [];
  const fetcher: typeof fetch = async (_request, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push({
      body,
      authorization: new Headers(init?.headers).get("authorization"),
    });
    if (body.method === "notifications/initialized") {
      return new Response(null, { status: 204 });
    }
    const result =
      body.method === "initialize"
        ? { protocolVersion: "2025-03-26" }
        : body.method === "tools/list"
          ? {
              tools: [{
                name: "docs.search",
                description: "Search approved documentation",
                inputSchema: {
                  type: "object",
                  properties: { query: { type: "string" } },
                  required: ["query"],
                  additionalProperties: false,
                },
                annotations: { readOnlyHint: true },
              }],
            }
          : {
              content: [{ type: "text", text: "result" }],
              isError: false,
            };
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
  const toolset = await createFlaryToolset({
    scope,
    capabilities: ["mcp.call"],
    connections: {
      ids: ["connection_docs"],
      revisions: { connection_docs: "revision_1" },
      resolve: ({ id, scope: trusted }) => {
        assert.equal(id, "connection_docs");
        assert.equal(trusted.tenantId, "org_acme");
        return {
          kind: "mcp",
          id,
          revision: "revision_1",
          endpoint: {
            name: "Docs MCP",
            url: "https://mcp.example.com",
            transport: "streamable-http",
          },
          credentials: async ({ scope: credentialScope }) => {
            assert.equal(credentialScope.organizationId, "org_acme");
            return credentialAvailable
              ? { kind: "bearer", value: "private-token" }
              : undefined;
          },
          clientOptions: { fetch: fetcher },
        };
      },
    },
  });
  const search = await flueTool(toolset.tools, "tool_search").run({
    input: { query: "documentation" },
  }) as Array<{ id: string }>;
  assert.equal(search.length, 1);
  assert.equal(JSON.stringify(search).includes("private-token"), false);
  assert.equal(JSON.stringify(search).includes("connection_docs"), false);

  credentialAvailable = false;
  const result = await flueTool(toolset.tools, "tool_call").run({
    input: {
      id: search[0]!.id,
      arguments: { query: "install" },
      callId: "mcp_read_1",
    },
  }) as Record<string, unknown>;
  assert.equal(result.status, "rejected");
  assert.equal(JSON.stringify(result).includes("private-token"), false);
  assert.equal(
    requests.every(
      (request) =>
        request.authorization === "Bearer private-token" ||
        request.authorization === null,
    ),
    true,
  );
});

test("API connections validate inputs and outputs in the shared runtime", async () => {
  let calls = 0;
  const toolset = await createFlaryToolset({
    scope,
    capabilities: ["api.call"],
    connections: {
      ids: ["connection_orders"],
      revisions: { connection_orders: "orders_v1" },
      resolve: ({ id }) => ({
        kind: "api",
        id,
        revision: "orders_v1",
        discover: () => [{
          id: "orders.get",
          description: "Get one order",
          operation: "read",
          inputSchema: {
            type: "object",
            properties: { orderId: { type: "string", minLength: 1 } },
            required: ["orderId"],
            additionalProperties: false,
          },
          outputSchema: {
            type: "object",
            properties: { status: { type: "string" } },
            required: ["status"],
            additionalProperties: false,
          },
        }],
        async call() {
          calls += 1;
          return { status: "ready" };
        },
      }),
    },
  });
  const search = await flueTool(toolset.tools, "tool_search").run({
    input: { query: "order" },
  }) as Array<{ id: string }>;
  assert.equal(search.length, 1);
  assert.equal(JSON.stringify(search).includes("connection_orders"), false);

  const invalid = await flueTool(toolset.tools, "tool_call").run({
    input: {
      id: search[0]!.id,
      arguments: {},
      callId: "api_invalid_1",
    },
  }) as Record<string, unknown>;
  assert.equal(invalid.status, "rejected");
  assert.equal(calls, 0);

  const result = await flueTool(toolset.tools, "tool_call").run({
    input: {
      id: search[0]!.id,
      arguments: { orderId: "order_1" },
      callId: "api_valid_1",
    },
  }) as Record<string, unknown>;
  assert.equal(result.status, "fulfilled");
  assert.equal(calls, 1);
});

test("defineFlaryAgent keeps the toolset approval continuation", async () => {
  const continuation = {
    inspect: async () => "waiting" as const,
    resume: async () => ({ content: "continued" }),
  };
  const toolset = await createFlaryToolset({
    scope,
    capabilities: [],
    approvals: { continuation },
  });
  const agent = defineFlaryAgent({
    resolveContext: () => ({
      tenantId: "org_acme",
      applicationId: "host",
      projectId: "project_1",
      agentId: "agent_1",
      identity: { id: "user_1", kind: "user" as const },
      roles: [],
      scopes: [],
    }),
    resolveAgent: () => ({
      agentId: "agent_1",
      instructions: "Test the continuation.",
      model: { provider: "openai", model: "gpt-5" },
    }),
    resolveModel: () => "openai:gpt-5",
    resolveTools: () => toolset.tools,
  }) as unknown as {
    initialize(input: { env: object; id: string }): Promise<{
      approvalContinuation?: typeof continuation;
    }>;
  };
  const configured = await agent.initialize({ env: {}, id: "run_1" });

  assert.ok(configured.approvalContinuation);
  assert.equal(
    await configured.approvalContinuation.inspect({
      toolCallId: "tool_1",
      toolName: "execute",
      arguments: {},
    }),
    "waiting",
  );
});

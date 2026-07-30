import * as v from "valibot";
import { and, eq, inArray } from "drizzle-orm";
import { defineTool } from "@flue/runtime";
import { getCloudflareContext } from "@flue/runtime/cloudflare";
import {
  CodeModeInputSchema,
  SandboxInputSchema,
  FlaryThreadMetadataStore,
  InMemoryToolCatalog,
  LazyToolRuntime,
  registerWorkspaceTools,
  resolveAgentMode,
  modeAllowsCapability,
  type WorkspaceToolTarget,
} from "flary";
import {
  createFlueLazyTools,
  createFlueRequestUserInputTool,
} from "flary/flue";
import type { ThreadBinding } from "flary/contracts";
import { ThreadBindingSchema } from "flary/contracts";
import type { ThreadRef, StorageScope } from "flary/contracts";
import { threadName } from "flary/storage";
import type { Env } from "../worker/env";
import { createDb } from "../worker/db";
import { createCloudExecutionRouter } from "../worker/execution";
import { flaryConnection, secretEnvelope } from "../worker/db/schema";
import {
  connectionSecretAssociatedData,
  decryptToken,
} from "../worker/security/tokens";
import {
  McpEndpointSchema,
  McpToolCache,
  type McpCredentialProvider,
  type McpEndpoint,
} from "flary/mcp";
import {
  openThreadRecall,
  searchThreadRecall,
  ThreadRecallOpenInputSchema,
  ThreadRecallSearchInputSchema,
} from "../worker/recall";

type JsonInput = Record<string, unknown>;

function scopeFor(binding: ThreadBinding): StorageScope {
  return {
    organizationId: binding.workspace.organizationId,
    appId: binding.workspace.appId,
    projectId: binding.workspace.projectId,
    workspaceId: binding.workspace.workspaceId,
    branch: binding.workspace.branch,
  };
}

function workspaceTarget(env: Env, binding: ThreadBinding): WorkspaceToolTarget {
  const scope = scopeFor(binding);
  if (!env.PROJECT_WORKSPACES) {
    throw new Error("The workspace Durable Object binding is not configured");
  }
  const name = [
    scope.organizationId,
    scope.appId,
    scope.projectId,
    scope.workspaceId,
    ...(scope.branch === "main" ? [] : [scope.branch]),
  ].join(":");
  const stub = env.PROJECT_WORKSPACES.get(env.PROJECT_WORKSPACES.idFromName(name));

  async function call(operation: string, input: JsonInput): Promise<any> {
    const response = await stub.fetch(
      new Request(`https://workspace-filesystem/${operation}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-flary-organization-id": scope.organizationId,
          "x-flary-app-id": scope.appId,
          "x-flary-project-id": scope.projectId,
          "x-flary-workspace-id": scope.workspaceId,
          "x-flary-branch": scope.branch,
        },
        body: JSON.stringify(input),
      }),
    );
    const body = await response.json().catch(() => undefined);
    if (!response.ok) {
      throw new Error(
        typeof body === "object" && body && "error" in body
          ? String((body as { error: unknown }).error)
          : `Workspace ${operation} failed (${response.status})`,
      );
    }
    return body;
  }

  return {
    read: (input) => call("read", input as unknown as JsonInput),
    write: (input) => call("write", input as unknown as JsonInput),
    edit: (input) => call("edit", input as unknown as JsonInput),
    delete: (input) => call("delete", input as unknown as JsonInput),
    move: (input) => call("move", input as unknown as JsonInput),
    list: (input) => call("list", input as unknown as JsonInput),
    stat: async (path) => {
      const result = await call("stat", { path });
      return result.file;
    },
    glob: (input) => call("glob", input as unknown as JsonInput),
    grep: (input) => call("grep", input as unknown as JsonInput),
    diff: (input) => call("diff", input as unknown as JsonInput),
    batchEdit: (input) => call("batch-edit", input as unknown as JsonInput),
  };
}

type McpConnectionRow = typeof flaryConnection.$inferSelect;

async function loadMcpEndpoints(
  env: Env,
  binding: ThreadBinding,
): Promise<McpConnectionRow[]> {
  if (binding.connectionIds.length === 0) return [];
  const rows = await createDb(env.DB)
    .select()
    .from(flaryConnection)
    .where(
      and(
        eq(flaryConnection.organizationId, binding.thread.organizationId),
        eq(flaryConnection.appId, binding.thread.appId),
        inArray(flaryConnection.id, binding.connectionIds),
      ),
    );
  return rows.filter(
    (row) => row.type === "mcp" && Boolean(row.baseUrl) && row.status !== "disabled",
  );
}

function endpointFor(row: McpConnectionRow): McpEndpoint {
  return McpEndpointSchema.parse({
    connectionId: row.id,
    name: row.name,
    url: row.baseUrl,
    transport: row.protocol === "sse" ? "sse" : "streamable-http",
  });
}

function credentialProvider(
  env: Env,
  rows: readonly McpConnectionRow[],
): McpCredentialProvider {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return {
    async get(connectionId) {
      const connection = byId.get(connectionId);
      if (!connection || connection.authType === "none") return undefined;
      if (!env.FLARY_TOKEN_ENCRYPTION_KEY_B64) return undefined;
      const secret = await createDb(env.DB)
        .select()
        .from(secretEnvelope)
        .where(eq(secretEnvelope.connectionId, connectionId))
        .limit(1);
      const row = secret[0];
      if (!row) return undefined;
      const value = await decryptToken(
        { ciphertext: row.ciphertext, iv: row.iv },
        env.FLARY_TOKEN_ENCRYPTION_KEY_B64,
        connectionSecretAssociatedData(connection.organizationId, connectionId, row.name),
      );
      if (connection.authType === "bearer") return { kind: "bearer", value };
      return {
        kind: "api_key",
        value,
        ...(connection.authHeader ? { header: connection.authHeader } : {}),
      };
    },
  };
}

/**
 * Convert Flary's Zod-owned catalog into Flue tools. Flue requires Valibot at
 * its model boundary, so this adapter keeps Zod validation in the private
 * capability closures and exposes only a bounded object schema to Flue.
 */
export async function createThreadTools(
  env: Env,
  bindingInput: ThreadBinding,
): Promise<ReturnType<typeof defineTool>[]> {
  const binding = ThreadBindingSchema.parse(bindingInput);
  const mode = resolveAgentMode(binding.defaultMode);
  const catalog = new InMemoryToolCatalog();
  const workspace = workspaceTarget(env, binding);
  registerWorkspaceTools(catalog, workspace, {
    requireApprovalForWrites: true,
  });

  let metadata: FlaryThreadMetadataStore | undefined;
  try {
    const context = getCloudflareContext();
    metadata = new FlaryThreadMetadataStore(
      context.storage.sql,
      binding.thread,
    );
  } catch {
    // Tests can create a catalog without a Durable Object context.
  }

  const mcpRows = await loadMcpEndpoints(env, binding);
  const mcpEndpoints = new Map(mcpRows.map((row) => [row.id, endpointFor(row)]));
  const mcpCache = new McpToolCache({
    allowInsecureHttp: env.APP_ENV !== "production",
  });
  const mcpCredentials = credentialProvider(env, mcpRows);
  catalog.register({
    definition: {
      id: "mcp.discover",
      name: "Discover MCP tools",
      description: "Discover tools from an approved remote MCP connection without exposing its credential.",
      kind: "mcp",
      operation: "read",
      capabilities: ["connection.mcp.read"],
      tags: ["mcp", "connection", "search"],
      inputSchema: {
        type: "object",
        properties: { connectionId: { type: "string" } },
        required: ["connectionId"],
        additionalProperties: false,
      },
    },
    async execute(raw) {
      const input = v.parse(v.object({ connectionId: v.string() }), raw);
      const endpoint = mcpEndpoints.get(input.connectionId);
      if (!endpoint) throw new Error("MCP connection is not authorized for this thread");
      return JSON.parse(JSON.stringify(await mcpCache.discover(endpoint)));
    },
  });
  catalog.register({
    definition: {
      id: "mcp.call",
      name: "Call MCP tool",
      description: "Call one tool from an approved remote MCP connection.",
      kind: "mcp",
      operation: "write",
      capabilities: ["connection.mcp.call"],
      tags: ["mcp", "connection"],
      requiresApproval: true,
      inputSchema: {
        type: "object",
        properties: {
          connectionId: { type: "string" },
          toolName: { type: "string" },
          arguments: { type: "object" },
        },
        required: ["connectionId", "toolName"],
        additionalProperties: false,
      },
    },
    resourceKey: (raw) =>
      typeof raw === "object" && raw && "connectionId" in raw
        ? `mcp:${String(raw.connectionId)}`
        : "mcp",
    async execute(raw) {
      const input = v.parse(v.object({
        connectionId: v.string(),
        toolName: v.string(),
        arguments: v.optional(v.record(v.string(), v.unknown())),
      }), raw);
      const endpoint = mcpEndpoints.get(input.connectionId);
      if (!endpoint) throw new Error("MCP connection is not authorized for this thread");
      const result = await mcpCache.client(endpoint).call(
        input.toolName,
        input.arguments ?? {},
        mcpCredentials,
      );
      return JSON.parse(JSON.stringify(result));
    },
  });

  catalog.register({
    definition: {
      id: "recall.search",
      name: "Search history",
      description: "Search this thread's authorized project history. Results are short and scoped.",
      kind: "native",
      operation: "read",
      capabilities: ["recall.search"],
      tags: ["recall", "history", "search"],
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          mode: { enum: ["exact", "semantic", "hybrid"] },
          kinds: { type: "array", items: { type: "string" } },
          limit: { type: "number" },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    async execute(raw) {
      const input = ThreadRecallSearchInputSchema.parse(raw);
      return JSON.parse(JSON.stringify(await searchThreadRecall(
        env,
        binding,
        input,
      )));
    },
  });
  catalog.register({
    definition: {
      id: "recall.open",
      name: "Open history result",
      description: "Open one scoped Recall result when the short result is not enough.",
      kind: "native",
      operation: "read",
      capabilities: ["recall.open"],
      tags: ["recall", "history"],
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          reference: { type: "object" },
        },
        additionalProperties: false,
      },
    },
    async execute(input) {
      const document = await openThreadRecall(
        env,
        binding,
        ThreadRecallOpenInputSchema.parse(input),
      );
      if (!document) throw new Error("Recall document not found");
      return JSON.parse(JSON.stringify(document));
    },
  });

  catalog.register({
    definition: {
      id: "artifact.plan.write",
      name: "Write plan artifact",
      description: "Write a Markdown plan under plans/ in the bound workspace.",
      kind: "native",
      operation: "write",
      capabilities: ["artifact.plan.write"],
      tags: ["plan", "artifact", "write"],
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
    resourceKey: (raw) =>
      typeof raw === "object" && raw && "path" in raw
        ? String(raw.path)
        : "plans/",
    async execute(raw) {
      const input = v.parse(v.object({ path: v.string(), content: v.string() }), raw);
      if (!input.path.startsWith("plans/")) {
        throw new Error("Plan artifacts must stay under plans/");
      }
      return workspace.write({
        path: input.path,
        content: input.content,
        encoding: "utf8",
        mediaType: "text/markdown",
      });
    },
  });

  const runtime = new LazyToolRuntime({
    catalog,
    mode,
    maxConcurrency: 8,
    readParallelism: 8,
    runId: `flue_${binding.thread.threadId}`,
    async approve(tool) {
      if (!metadata) throw new Error(`Approval required for ${tool.id}`);
      if (metadata.hasApprovedTool(tool.id)) {
        metadata.issueToolLease(tool.id);
        return;
      }
      const request = metadata.createToolApproval({
        runId: `flue_${binding.thread.threadId}`,
        toolId: tool.id,
        reason: `The ${mode.id} mode requires approval for ${tool.id}.`,
        requestedBy: { id: binding.thread.agentId, kind: "agent", version: "1" },
      });
      throw new Error(`Approval required. Resolve approval ${request.id} before retrying.`);
    },
  });
  const tools = createFlueLazyTools(runtime) as ReturnType<typeof defineTool>[];

  if (modeAllowsCapability(mode, "interaction.user_input")) {
    tools.push(
      createFlueRequestUserInputTool({
        threadKey: threadName(binding.thread),
        createRequest({ questions }) {
          if (!metadata) throw new Error("User input requires a thread Durable Object");
          return metadata.createUserInputRequest({
            questions,
            requestedBy: { id: binding.thread.agentId, kind: "agent", version: "1" },
            expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
          });
        },
      }),
    );
  }

  if (env.CODE_MODE_ENABLED === "true" && modeAllowsCapability(mode, "execution.codemode")) {
    const codeTools = {
      search: async (query: unknown, maxResults?: unknown) =>
        runtime.search({
          query: String(query ?? ""),
          limit: typeof maxResults === "number" ? Math.min(20, maxResults) : 5,
        }),
      describe: async (id: unknown) => runtime.describe(String(id)),
      call: async (id: unknown, args?: unknown) => {
        const loaded = await runtime.describe(String(id));
        if (!loaded) throw new Error(`Tool not found: ${String(id)}`);
        if (loaded.tool.operation === "write") {
          throw new Error("Code Mode can compose read tools only. Use tool_call for writes.");
        }
        return runtime.call({
          id: loaded.tool.id,
          arguments:
            typeof args === "object" && args !== null
              ? args as Record<string, unknown>
              : {},
        });
      },
    };
    const codeMode = defineTool({
      name: "flary__code_mode",
      description: "Run bounded JavaScript in a network-isolated Dynamic Worker using read-only tool handles.",
      input: v.object({ code: v.string() }),
      async run({ input }) {
        if (!metadata) throw new Error("Code Mode requires a thread Durable Object");
        const request = CodeModeInputSchema.parse(input);
        const router = createCloudExecutionRouter(env, binding.thread.organizationId);
        const result = await router.execute({
          executionId: `exec_${crypto.randomUUID().replaceAll("-", "")}`,
          runId: `flue_${binding.thread.threadId}`,
          engine: "dynamic-worker",
          runtime: "isolate",
          operation: "code.plan",
          input: request,
          limits: { timeoutMs: 60_000, maxOutputBytes: 512 * 1024 },
          metadata: { threadId: binding.thread.threadId },
        }, {
          toolNamespaces: [{ name: "tools", tools: codeTools }],
        });
        return JSON.parse(JSON.stringify(result));
      },
    });
    tools.push(codeMode);
  }

  if (env.FLARY_SANDBOX && modeAllowsCapability(mode, "execution.sandbox")) {
    const sandboxJob = defineTool({
      name: "flary__sandbox_job",
      description: "Run an explicitly approved build, test, notebook, or deploy command in the isolated Sandbox.",
      input: v.object({
        sandboxId: v.string(),
        command: v.string(),
        files: v.optional(v.array(v.object({ path: v.string(), content: v.string(), encoding: v.optional(v.string()) }))),
        cwd: v.optional(v.string()),
        destroyAfter: v.optional(v.boolean()),
      }),
      async run({ input }) {
        if (!metadata) throw new Error("Sandbox jobs require a thread Durable Object");
        if (!metadata.hasApprovedTool("execution.sandbox")) {
          const request = metadata.createToolApproval({
            runId: `flue_${binding.thread.threadId}`,
            toolId: "execution.sandbox",
            reason: "Sandbox jobs can build, test, or deploy code outside the workspace Durable Object.",
            requestedBy: { id: binding.thread.agentId, kind: "agent", version: "1" },
          });
          throw new Error(`Approval required. Resolve approval ${request.id} before retrying.`);
        }
        metadata.issueToolLease("execution.sandbox");
        const request = SandboxInputSchema.parse(input);
        const router = createCloudExecutionRouter(env, binding.thread.organizationId);
        const result = await router.execute({
          executionId: `exec_${crypto.randomUUID().replaceAll("-", "")}`,
          runId: `flue_${binding.thread.threadId}`,
          engine: "sandbox",
          runtime: "linux",
          operation: "sandbox.command",
          input: request,
          limits: { timeoutMs: 15 * 60_000, maxOutputBytes: 1024 * 1024 },
          metadata: { threadId: binding.thread.threadId, sandboxId: request.sandboxId },
        });
        return JSON.parse(JSON.stringify(result));
      },
    });
    tools.push(sandboxJob);
  }

  return tools;
}

export function threadReference(binding: ThreadBinding): ThreadRef {
  return binding.thread;
}

export function threadInstanceName(binding: ThreadBinding): string {
  return threadName(binding.thread);
}

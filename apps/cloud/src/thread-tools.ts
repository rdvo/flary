import * as v from "valibot";
import { and, eq, inArray } from "drizzle-orm";
import { defineTool } from "@flue/runtime";
import { getCloudflareContext } from "@flue/runtime/cloudflare";
import {
  CodeModeInputSchema,
  SandboxInputSchema,
  FlaryThreadMetadataStore,
  InMemoryToolCatalog,
  registerWorkspaceTools,
  resolveAgentMode,
  modeAllowsCapability,
  modeRequiresApproval,
  type WorkspaceToolTarget,
} from "flary";
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

function isWriteTool(capabilities: readonly string[]): boolean {
  return capabilities.some(
    (capability) =>
      capability.endsWith(".write") ||
      capability.endsWith(".delete") ||
      capability.includes("commit") ||
      capability.includes("merge"),
  );
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

  const toolSearch = defineTool({
    name: "flary__tool_search",
    description: "Search the approved Flary tool catalog before using a tool.",
    input: v.object({ query: v.optional(v.string()) }),
    async run({ input }) {
      const response = await catalog.search({ query: input.query, limit: 20 });
      return response.results.map((result) => ({
        id: result.tool.id,
        name: result.tool.name,
        ...(result.tool.description
          ? { description: result.tool.description }
          : {}),
        capabilities: result.tool.capabilities,
        requiresApproval: result.tool.requiresApproval ?? false,
      }));
    },
  });

  const mcpRows = await loadMcpEndpoints(env, binding);
  const mcpEndpoints = new Map(mcpRows.map((row) => [row.id, endpointFor(row)]));
  const mcpCache = new McpToolCache({
    allowInsecureHttp: env.APP_ENV !== "production",
  });
  const mcpCredentials = credentialProvider(env, mcpRows);
  const mcpDiscover = defineTool({
    name: "flary__mcp_discover",
    description: "Discover tools from an approved remote MCP connection without exposing its credential.",
    input: v.object({ connectionId: v.string() }),
    async run({ input }) {
      const endpoint = mcpEndpoints.get(input.connectionId);
      if (!endpoint) throw new Error("MCP connection is not authorized for this thread");
      return JSON.parse(JSON.stringify(await mcpCache.discover(endpoint)));
    },
  });
  const mcpCall = defineTool({
    name: "flary__mcp_call",
    description: "Call one tool from an approved remote MCP connection. The call requires approval.",
    input: v.object({
      connectionId: v.string(),
      toolName: v.string(),
      arguments: v.optional(v.record(v.string(), v.unknown())),
    }),
    async run({ input }) {
      const endpoint = mcpEndpoints.get(input.connectionId);
      if (!endpoint) throw new Error("MCP connection is not authorized for this thread");
      const toolId = `mcp:${input.connectionId}:${input.toolName}`;
      if (!metadata?.hasApprovedTool(toolId)) {
        if (!metadata) throw new Error(`Approval required for ${toolId}`);
        const request = metadata.createToolApproval({
          runId: `flue_${binding.thread.threadId}`,
          toolId,
          reason: `The remote MCP tool ${input.toolName} can change external state.`,
          requestedBy: { id: binding.thread.agentId, kind: "agent", version: "1" },
        });
        throw new Error(`Approval required. Resolve approval ${request.id} before retrying.`);
      }
      metadata.issueToolLease(toolId);
      const result = await mcpCache.client(endpoint).call(
        input.toolName,
        input.arguments ?? {},
        mcpCredentials,
      );
      return JSON.parse(JSON.stringify(result));
    },
  });

  const results = await catalog.search({ limit: 100 });
  const tools = [toolSearch] as ReturnType<typeof defineTool>[];
  if (modeAllowsCapability(mode, "connection.mcp.read")) tools.push(mcpDiscover);
  if (modeAllowsCapability(mode, "connection.mcp.call")) tools.push(mcpCall);
  let metadata: FlaryThreadMetadataStore | undefined;
  try {
    const context = getCloudflareContext();
    metadata = new FlaryThreadMetadataStore(
      context.storage.sql,
      binding.thread,
    );
  } catch {
    // Tests and local catalog consumers can use the tools without DO context.
  }

  const recallSearch = defineTool({
    name: "flary__recall_search",
    description: "Search this thread's authorized project history. Results are short and scoped.",
    input: v.object({
      query: v.string(),
      mode: v.optional(v.string()),
      kinds: v.optional(v.array(v.string())),
      limit: v.optional(v.number()),
    }),
    async run({ input }) {
      return JSON.parse(JSON.stringify(await searchThreadRecall(
        env,
        binding,
        ThreadRecallSearchInputSchema.parse(input),
      )));
    },
  });
  const recallOpen = defineTool({
    name: "flary__recall_open",
    description: "Open one scoped Recall result when the short result is not enough.",
    input: v.object({
      id: v.optional(v.string()),
      reference: v.optional(v.record(v.string(), v.unknown())),
    }),
    async run({ input }) {
      const document = await openThreadRecall(env, binding, input);
      if (!document) throw new Error("Recall document not found");
      return JSON.parse(JSON.stringify(document));
    },
  });
  if (modeAllowsCapability(mode, "recall.search")) tools.push(recallSearch);
  if (modeAllowsCapability(mode, "recall.open")) tools.push(recallOpen);

  if (modeAllowsCapability(mode, "artifact.plan.write")) {
    tools.push(
      defineTool({
        name: "flary__plan_write",
        description: "Write a plan artifact under plans/ in the bound workspace.",
        input: v.object({
          path: v.string(),
          content: v.string(),
        }),
        async run({ input }) {
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
      }),
    );
  }

  if (env.CODE_MODE_ENABLED === "true" && modeAllowsCapability(mode, "execution.codemode")) {
    const readOnlyCodeTools: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
    for (const result of results.results) {
      if (isWriteTool(result.tool.capabilities)) continue;
      const handle = await catalog.loadHandle({ id: result.tool.id });
      if (!handle) continue;
      readOnlyCodeTools[result.tool.id] = (input) => handle.invoke(input);
    }
    const codeMode = defineTool({
      name: "flary__code_mode",
      description: "Run bounded JavaScript in a network-isolated Dynamic Worker using approved read-only tool handles.",
      input: v.object({ code: v.string() }),
      async run({ input }) {
        if (!metadata) throw new Error("Code Mode requires a thread Durable Object");
        if (!metadata.hasApprovedTool("execution.codemode")) {
          const request = metadata.createToolApproval({
            runId: `flue_${binding.thread.threadId}`,
            toolId: "execution.codemode",
            reason: "Code Mode executes model-written JavaScript in an isolated runtime.",
            requestedBy: { id: binding.thread.agentId, kind: "agent", version: "1" },
          });
          throw new Error(`Approval required. Resolve approval ${request.id} before retrying.`);
        }
        metadata.issueToolLease("execution.codemode");
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
          toolNamespaces: [{ name: "workspace", tools: readOnlyCodeTools }],
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

  for (const result of results.results) {
    const tool = result.tool;
    const allowed = tool.capabilities.some((capability) =>
      modeAllowsCapability(mode, capability),
    );
    if (!allowed) continue;
    const handle = await catalog.loadHandle({ id: tool.id });
    if (!handle) continue;
    const write = isWriteTool(tool.capabilities);
    const requiresApproval =
      Boolean(tool.requiresApproval) ||
      modeRequiresApproval(mode, {
        capability: tool.capabilities.find((capability) => write && capability) ??
          tool.capabilities[0] ??
          "workspace.read",
        operation: write ? "write" : "read",
        resource: tool.id,
        toolId: tool.id,
      });

    tools.push(
      defineTool({
        name: `flary__${tool.id.replaceAll(".", "__").replaceAll("-", "_")}`,
        description: `${tool.description ?? tool.name} Tool id: ${tool.id}.`,
        input: v.record(v.string(), v.unknown()),
        async run({ input }) {
          if (requiresApproval && !metadata?.hasApprovedTool(tool.id)) {
            if (!metadata) throw new Error(`Approval required for ${tool.id}`);
            const request = metadata.createToolApproval({
              runId: `flue_${binding.thread.threadId}`,
              toolId: tool.id,
              reason: `The ${mode.id} mode requires approval for ${tool.id}.`,
              requestedBy: { id: binding.thread.agentId, kind: "agent", version: "1" },
            });
            throw new Error(`Approval required. Resolve approval ${request.id} before retrying.`);
          }
          if (requiresApproval) metadata?.issueToolLease(tool.id);
          return handle.invoke(input);
        },
      }),
    );
  }
  return tools;
}

export function threadReference(binding: ThreadBinding): ThreadRef {
  return binding.thread;
}

export function threadInstanceName(binding: ThreadBinding): string {
  return threadName(binding.thread);
}

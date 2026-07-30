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
import type { DurableToolCallSnapshot } from "flary/execution";
import type {
  ApprovalContinuation,
  ApprovalRecoveryCall,
  ApprovalRecoveryState,
} from "flary/execution";
import { redactErrorMessage, redactSecrets } from "flary/execution";
import {
  SqliteMcpDescriptorCache,
  SqliteToolExecutionJournal,
} from "flary/cloudflare";
import {
  createFlueLazyTools,
  createFlueRequestUserInputTool,
} from "flary/flue";
import type { JsonObject, JsonValue, ThreadBinding } from "flary/contracts";
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
  ScopedMcpEndpointSchema,
  createMcpToolset,
  type ScopedMcpCredentialResolver,
  type ScopedMcpEndpoint,
} from "flary/mcp";
import {
  openThreadRecall,
  searchThreadRecall,
  ThreadRecallOpenInputSchema,
  ThreadRecallSearchInputSchema,
} from "../worker/recall";

type JsonInput = Record<string, unknown>;

export interface ThreadToolset {
  tools: ReturnType<typeof defineTool>[];
  approvalContinuation?: ApprovalContinuation;
}

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

function endpointFor(row: McpConnectionRow): ScopedMcpEndpoint {
  return ScopedMcpEndpointSchema.parse({
    organizationId: row.organizationId,
    appId: row.appId,
    credentialVersion: String(row.updatedAt.getTime()),
    connectionId: row.id,
    name: row.name,
    url: row.baseUrl,
    transport: row.protocol === "sse" ? "sse" : "streamable-http",
  });
}

function credentialProvider(
  env: Env,
  rows: readonly McpConnectionRow[],
): ScopedMcpCredentialResolver {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return async ({ scope, endpoint }) => {
    const connection = byId.get(endpoint.connectionId);
    if (
      !connection ||
      connection.organizationId !== scope.organizationId ||
      connection.appId !== scope.appId
    ) {
      throw new Error("MCP connection is not authorized for this tenant");
    }
    if (connection.authType === "none") return undefined;
    if (!env.FLARY_TOKEN_ENCRYPTION_KEY_B64) return undefined;
    const secret = await createDb(env.DB)
      .select()
      .from(secretEnvelope)
      .where(eq(secretEnvelope.connectionId, endpoint.connectionId))
      .limit(1);
    const row = secret[0];
    if (!row) return undefined;
    const value = await decryptToken(
      { ciphertext: row.ciphertext, iv: row.iv },
      env.FLARY_TOKEN_ENCRYPTION_KEY_B64,
      connectionSecretAssociatedData(
        connection.organizationId,
        endpoint.connectionId,
        row.name,
      ),
    );
    if (connection.authType === "bearer") return { kind: "bearer", value };
    return {
      kind: "api_key",
      value,
      ...(connection.authHeader ? { header: connection.authHeader } : {}),
    };
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
): Promise<ThreadToolset> {
  const binding = ThreadBindingSchema.parse(bindingInput);
  const mode = resolveAgentMode(binding.defaultMode);
  const catalog = new InMemoryToolCatalog();
  const workspace = workspaceTarget(env, binding);
  registerWorkspaceTools(catalog, workspace, {
    requireApprovalForWrites: true,
  });

  let metadata: FlaryThreadMetadataStore | undefined;
  let toolJournal: SqliteToolExecutionJournal | undefined;
  let mcpDescriptorCache: SqliteMcpDescriptorCache | undefined;
  try {
    const context = getCloudflareContext();
    metadata = new FlaryThreadMetadataStore(
      context.storage.sql,
      binding.thread,
    );
    toolJournal = new SqliteToolExecutionJournal(context.storage.sql);
    mcpDescriptorCache = new SqliteMcpDescriptorCache(context.storage.sql);
  } catch {
    // Tests can create a catalog without a Durable Object context.
  }

  const mcpRows = await loadMcpEndpoints(env, binding);
  const mcpTools = await createMcpToolset({
    scope: {
      organizationId: binding.thread.organizationId,
      appId: binding.thread.appId,
      userId: binding.createdBy.id,
    },
    endpoints: mcpRows.map(endpointFor),
    credentials: credentialProvider(env, mcpRows),
    permissions: () => ({
      operation: "write",
      capabilities: ["connection.mcp.call"],
      requiresApproval: true,
    }),
    clientOptions: {
      allowInsecureHttp: env.APP_ENV !== "production",
    },
    descriptorCache: mcpDescriptorCache,
  });
  mcpTools.register(catalog);

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

  const executeSandbox = async (raw: unknown) => {
    const request = SandboxInputSchema.parse(raw);
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
    return JSON.parse(JSON.stringify(result)) as JsonValue;
  };
  if (env.FLARY_SANDBOX && modeAllowsCapability(mode, "execution.sandbox")) {
    catalog.register({
      definition: {
        id: "execution.sandbox",
        name: "Run sandbox job",
        description: "Run an approved build, test, notebook, or deploy command in the isolated Sandbox.",
        kind: "native",
        operation: "write",
        capabilities: ["execution.sandbox"],
        requiresApproval: true,
        inputSchema: {
          type: "object",
          properties: {
            sandboxId: { type: "string" },
            command: { type: "string" },
            files: { type: "array" },
            cwd: { type: "string" },
            destroyAfter: { type: "boolean" },
          },
          required: ["sandboxId", "command"],
          additionalProperties: false,
        },
      },
      resourceKey: (raw) =>
        typeof raw === "object" && raw && "sandboxId" in raw
          ? `sandbox:${String(raw.sandboxId)}`
          : "sandbox",
      execute: executeSandbox,
    });
  }

  const runtime = new LazyToolRuntime({
    catalog,
    mode,
    maxConcurrency: 8,
    readParallelism: 8,
    runId: `flue_${binding.thread.threadId}`,
    toolJournal,
    onToolEvent: metadata
      ? async (event) => metadata!.recordToolEvent(event)
      : undefined,
    async approve(tool, _input, context) {
      if (!metadata) throw new Error(`Approval required for ${tool.id}`);
      const toolCall: DurableToolCallSnapshot = {
        runId: context.runId,
        callId: context.callId,
        toolId: context.toolId,
        arguments: context.arguments as JsonObject,
        operation: context.operation,
        ...(context.resourceKey ? { resourceKey: context.resourceKey } : {}),
        ...(context.idempotencyKey
          ? { idempotencyKey: context.idempotencyKey }
          : {}),
      };
      const existing = metadata.getToolApproval(toolCall);
      const request = existing?.request ?? metadata.createToolApproval({
        runId: `flue_${binding.thread.threadId}`,
        toolId: tool.id,
        reason: `The ${mode.id} mode requires approval for ${tool.id}.`,
        requestedBy: { id: binding.thread.agentId, kind: "agent", version: "1" },
        toolCall,
      });
      const decision = existing?.decision;
      const resolved = decision ?? await metadata.waitForToolApproval(request.id);
      if (resolved.status === "approved") {
        metadata.issueCapabilityLease(request.id, tool.id);
        return;
      }
      throw new Error(
        resolved.status === "expired"
          ? "The tool approval expired."
          : "The tool approval was not granted.",
      );
    },
  });
  const tools = createFlueLazyTools(runtime) as ReturnType<typeof defineTool>[];
  const approvalContinuation: ApprovalContinuation | undefined = metadata
    ? {
        async inspect(input): Promise<ApprovalRecoveryState> {
          const calls = continuationCalls(input);
          if (calls.length === 0) return "none";
          let found = false;
          for (const call of calls) {
            const loaded = await runtime.describe(call.id);
            if (!loaded) continue;
            const record = metadata!.findToolApproval({
              runId: `flue_${binding.thread.threadId}`,
              toolId: call.id,
              arguments: call.arguments,
              ...(call.callId ? { callId: call.callId } : {}),
              ...(call.idempotencyKey
                ? { idempotencyKey: call.idempotencyKey }
                : {}),
              operation: loaded.tool.operation,
            });
            if (!record) continue;
            found = true;
            if (!record.decision) {
              if (
                record.request.expiresAt &&
                Date.parse(record.request.expiresAt) <= Date.now()
              ) {
                metadata!.expireApproval(record.request.id);
              } else {
                return "waiting";
              }
            }
          }
          return found ? "ready" : "none";
        },
        async resume(input): Promise<{ content: string; isError?: boolean }> {
          try {
            if (input.toolName === "tool_call") {
              const call = continuationCalls(input)[0];
              if (!call) return { content: "{}", isError: true };
              const restored = restoreContinuationCall(call, metadata!, binding);
              const result = await runtime.call(restored);
              return {
                content: JSON.stringify(redactSecrets(result)),
              };
            }
            if (input.toolName === "tool_batch") {
              const calls = continuationCalls(input);
              if (calls.length === 0) return { content: "{}", isError: true };
              const restored = calls.map((call) =>
                restoreContinuationCall(call, metadata!, binding),
              );
              const result = await runtime.batch({ calls: restored });
              return {
                content: JSON.stringify(redactSecrets(result)),
              };
            }
            if (input.toolName === "flary__sandbox_job") {
              const call = continuationCalls(input)[0];
              if (!call) return { content: "{}", isError: true };
              const restored = restoreContinuationCall(call, metadata!, binding);
              const result = await runtime.call(restored);
              if (result.status !== "fulfilled") {
                return {
                  content: JSON.stringify(redactSecrets(result)),
                  isError: true,
                };
              }
              return {
                content: JSON.stringify(redactSecrets(result.value)),
              };
            }
            return { content: "{}", isError: true };
          } catch (error) {
            return {
              content: JSON.stringify({
                error: redactErrorMessage(
                  error,
                  "The approved tool call did not complete.",
                ),
              }),
              isError: true,
            };
          }
        },
      }
    : undefined;

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
        const result = await runtime.call({
          id: "execution.sandbox",
          arguments: SandboxInputSchema.parse(input) as unknown as Record<string, unknown>,
        });
        if (result.status !== "fulfilled") {
          throw new Error(result.error?.message ?? result.reason ?? "Sandbox job failed");
        }
        return result.value as JsonValue;
      },
    });
    tools.push(sandboxJob);
  }

  return { tools, approvalContinuation };
}

type ContinuationCall = {
  id: string;
  arguments: Record<string, unknown>;
  callId?: string;
  idempotencyKey?: string;
  dependsOn?: string[];
};

function continuationCalls(input: ApprovalRecoveryCall): ContinuationCall[] {
  const args = input.arguments;
  if (input.toolName === "flary__sandbox_job") {
    return [{ id: "execution.sandbox", arguments: args }];
  }
  if (input.toolName === "tool_call" && typeof args.id === "string") {
    return [parseContinuationCall(args)];
  }
  if (input.toolName !== "tool_batch" || !Array.isArray(args.calls)) return [];
  return args.calls
    .filter((call): call is Record<string, unknown> =>
      Boolean(call && typeof call === "object" && !Array.isArray(call)),
    )
    .filter((call) => typeof call.id === "string")
    .map(parseContinuationCall);
}

function parseContinuationCall(input: Record<string, unknown>): ContinuationCall {
  const args =
    input.arguments && typeof input.arguments === "object" && !Array.isArray(input.arguments)
      ? input.arguments as Record<string, unknown>
      : {};
  return {
    id: String(input.id),
    arguments: args,
    ...(typeof input.callId === "string" ? { callId: input.callId } : {}),
    ...(typeof input.idempotencyKey === "string"
      ? { idempotencyKey: input.idempotencyKey }
      : {}),
    ...(Array.isArray(input.dependsOn)
      ? {
          dependsOn: input.dependsOn.filter(
            (dependency): dependency is string => typeof dependency === "string",
          ),
        }
      : {}),
  };
}

function restoreContinuationCall(
  call: ContinuationCall,
  metadata: FlaryThreadMetadataStore,
  binding: ThreadBinding,
) {
  const runId = `flue_${binding.thread.threadId}`;
  const record = metadata.findToolApproval({
    runId,
    toolId: call.id,
    arguments: call.arguments,
    ...(call.callId ? { callId: call.callId } : {}),
    ...(call.idempotencyKey ? { idempotencyKey: call.idempotencyKey } : {}),
  });
  return {
    id: call.id,
    arguments: call.arguments,
    ...(call.dependsOn ? { dependsOn: call.dependsOn } : {}),
    ...(record?.toolCall.callId ?? call.callId
      ? { callId: record?.toolCall.callId ?? call.callId }
      : {}),
    ...(record?.toolCall.idempotencyKey ?? call.idempotencyKey
      ? { idempotencyKey: record?.toolCall.idempotencyKey ?? call.idempotencyKey }
      : {}),
  };
}

export function threadReference(binding: ThreadBinding): ThreadRef {
  return binding.thread;
}

export function threadInstanceName(binding: ThreadBinding): string {
  return threadName(binding.thread);
}

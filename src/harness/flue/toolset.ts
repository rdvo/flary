import { defineTool, type ToolDefinition } from "@flue/runtime";
import {
  Validator,
  type Schema as JsonSchema,
} from "@cfworker/json-schema";
import * as v from "valibot";
import { z } from "zod";

import {
  CodeModeInputSchema,
  IdentifierSchema,
  JsonObjectSchema,
  RecallKindSchema,
  RecallOpenRequestSchema,
  RecallSearchModeSchema,
  RecallSearchRequestSchema,
  StorageIdentifierSchema,
  WorkspaceRefSchema,
  type AgentMode,
  type JsonObject,
  type ToolLifecycleEvent,
} from "../contracts/index.js";
import type { ApprovalContinuation } from "../execution/approval-continuation.js";
import {
  CodeExecutionRouter,
  type CodeExecutionAdapter,
} from "../execution/adapters.js";
import type { ToolExecutionJournal } from "../execution/tool-journal.js";
import { InMemoryToolExecutionJournal } from "../execution/tool-journal.js";
import type { ExecutionLimitsInput } from "../execution/types.js";
import { redactSecrets } from "../execution/redaction.js";
import {
  createMcpToolset,
  type McpDescriptorCache,
  type McpToolGrantInput,
  type McpToolPermissionResolver,
  type ScopedMcpCredentialResolver,
  type ScopedMcpEndpointInput,
} from "../mcp/tools.js";
import type { McpClientOptions, McpToolCache } from "../mcp/client.js";
import { McpSecurityError } from "../mcp/client.js";
import type { RecallIndex } from "../recall/index.js";
import {
  InMemoryToolCatalog,
  type ToolCatalog,
  type ToolCatalogRegistration,
  type ToolSecretProvider,
} from "../tools/catalog.js";
import type { FlaryToolset } from "../tools/sdk.js";
import {
  LazyToolRuntime,
  type LazyToolRuntimeOptions,
} from "../tools/runtime.js";
import {
  registerWorkspaceTools,
  type WorkspaceToolTarget,
} from "../tools/workspace.js";
import { createFlueLazyTools } from "./tools.js";

export const FlaryToolScopeSchema = z
  .object({
    tenantId: StorageIdentifierSchema,
    appId: StorageIdentifierSchema,
    projectId: StorageIdentifierSchema,
    workspaceId: StorageIdentifierSchema,
    branch: WorkspaceRefSchema.shape.branch,
    userId: StorageIdentifierSchema.optional(),
    runId: IdentifierSchema.optional(),
    threadId: IdentifierSchema.optional(),
  })
  .strict();

export interface FlaryToolScope {
  readonly tenantId: string;
  readonly appId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly branch?: string;
  readonly userId?: string;
  readonly runId?: string;
  readonly threadId?: string;
}

export const FLARY_TOOL_CAPABILITIES = [
  "workspace.read",
  "workspace.write",
  "workspace.delete",
  "workspace.git",
  "mcp.search",
  "mcp.call",
  "api.call",
  "recall.search",
  "code.execute",
  "sandbox.execute",
] as const;

export type FlaryToolCapability =
  (typeof FLARY_TOOL_CAPABILITIES)[number];

export const FlaryToolCapabilitySchema = z.enum(FLARY_TOOL_CAPABILITIES);

export interface FlaryWorkspaceTargetResolver {
  resolve(scope: Required<Pick<FlaryToolScope, "tenantId" | "appId" | "projectId" | "workspaceId" | "branch">>):
    | WorkspaceToolTarget
    | Promise<WorkspaceToolTarget>;
}

export interface FlaryWorkspaceNamespaceBinding {
  idFromName(name: string): { toString(): string };
  get(id: { toString(): string }): { fetch(request: Request): Promise<Response> };
}

export type FlaryWorkspaceBindingSource =
  | WorkspaceToolTarget
  | FlaryWorkspaceTargetResolver
  | FlaryWorkspaceNamespaceBinding
  | { readonly storage: { readonly sql: unknown } }
  | { readonly sql: unknown };

export interface FlaryWorkspaceToolsetOptions {
  readonly target: FlaryWorkspaceBindingSource;
  readonly requireApprovalForWrites?: boolean;
}

export interface FlaryResolvedMcpConnection {
  readonly kind: "mcp";
  readonly id: string;
  readonly revision?: string;
  readonly endpoint: Omit<
    ScopedMcpEndpointInput,
    | "connectionId"
    | "organizationId"
    | "appId"
    | "credentialVersion"
  >;
  readonly credentials: ScopedMcpCredentialResolver;
  readonly permissions?: McpToolPermissionResolver;
  readonly descriptorCache?: McpDescriptorCache;
  readonly clientOptions?: McpClientOptions;
  readonly cache?: McpToolCache;
}

export interface FlaryApiToolDescriptor {
  readonly id: string;
  readonly name?: string;
  readonly description?: string;
  readonly inputSchema: JsonObject;
  readonly outputSchema?: JsonObject;
  readonly operation?: "read" | "write";
  readonly requiresApproval?: boolean;
  readonly tags?: readonly string[];
}

export interface FlaryResolvedApiConnection {
  readonly kind: "api";
  readonly id: string;
  readonly revision?: string;
  discover(): Promise<readonly FlaryApiToolDescriptor[]> | readonly FlaryApiToolDescriptor[];
  call(toolId: string, input: JsonObject): Promise<unknown>;
}

export type FlaryResolvedConnection =
  | FlaryResolvedMcpConnection
  | FlaryResolvedApiConnection;

export interface FlaryConnectionResolverOptions {
  readonly ids: readonly string[];
  readonly revisions?: Readonly<Record<string, string>>;
  resolve(input: {
    readonly id: string;
    readonly scope: z.output<typeof FlaryToolScopeSchema>;
  }): Promise<FlaryResolvedConnection | undefined> | FlaryResolvedConnection | undefined;
}

export interface FlaryRecallToolsetOptions {
  readonly index: RecallIndex;
}

export interface FlaryExecutionToolOptions {
  readonly enabled: boolean;
  readonly adapter?: CodeExecutionAdapter;
  readonly execute?: (
    input: {
      readonly code: string;
      readonly scope: z.output<typeof FlaryToolScopeSchema>;
      readonly tools: {
        search(query: string): Promise<unknown>;
        describe(id: string): Promise<unknown>;
        call(id: string, input: JsonObject): Promise<unknown>;
        batch(calls: readonly {
          id: string;
          arguments?: JsonObject;
          callId?: string;
          idempotencyKey?: string;
        }[]): Promise<unknown>;
      };
    },
  ) => Promise<unknown>;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export interface FlarySandboxToolsetOptions {
  readonly enabled: boolean;
  readonly adapter?: CodeExecutionAdapter;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export interface CreateFlaryToolsetOptions {
  readonly scope: FlaryToolScope;
  readonly capabilities: readonly FlaryToolCapability[];
  readonly workspace?:
    | FlaryWorkspaceBindingSource
    | FlaryWorkspaceToolsetOptions;
  /** R2 binding used by the Cloudflare workspace convenience form. */
  readonly blobs?: unknown;
  readonly connections?: FlaryConnectionResolverOptions;
  readonly recall?: FlaryRecallToolsetOptions;
  readonly codeMode?: FlaryExecutionToolOptions;
  readonly sandbox?: FlarySandboxToolsetOptions;
  readonly appTools?: FlaryToolset | readonly ToolCatalogRegistration[];
  readonly journal?: ToolExecutionJournal;
  readonly approvals?: {
    readonly approve?: LazyToolRuntimeOptions["approve"];
    readonly continuation?: ApprovalContinuation;
  };
  readonly secretProvider?: ToolSecretProvider;
  readonly limits?: ExecutionLimitsInput;
  readonly maxConcurrency?: number;
  readonly readParallelism?: number;
  readonly onEvent?: (
    event: ToolLifecycleEvent,
  ) => void | Promise<void>;
  readonly onAudit?: LazyToolRuntimeOptions["onAudit"];
  readonly extend?: (catalog: ToolCatalog) => void | Promise<void>;
}

export interface FlaryToolsetResult {
  readonly tools: ToolDefinition[];
  readonly catalog: ToolCatalog;
  readonly approvalContinuation?: ApprovalContinuation;
  readonly dispose?: () => Promise<void>;
}

const toolApprovalContinuations = new WeakMap<
  ToolDefinition[],
  ApprovalContinuation
>();

/** Read the continuation that belongs to a returned Flue tool array. */
export function approvalContinuationForFlaryTools(
  tools: ToolDefinition[],
): ApprovalContinuation | undefined {
  return toolApprovalContinuations.get(tools);
}

/**
 * Build one private tool catalog and expose a small Flue tool surface.
 *
 * The host supplies trusted identity, policy, bindings, and credential
 * resolvers. Flary owns schemas, capability checks, approvals, journaling,
 * lazy loading, validation, redaction, and execution order.
 */
export async function createFlaryToolset(
  options: CreateFlaryToolsetOptions,
): Promise<FlaryToolsetResult> {
  const scope = FlaryToolScopeSchema.parse(options.scope);
  const capabilities = new Set(
    z.array(FlaryToolCapabilitySchema).max(128).parse(options.capabilities),
  );
  const catalog = new InMemoryToolCatalog({
    secretProvider: options.secretProvider,
  });

  if (
    options.workspace &&
    [...capabilities].some((capability) =>
      capability.startsWith("workspace."),
    )
  ) {
    const workspace = normalizeWorkspaceOptions(options.workspace);
    const target = await resolveWorkspaceTarget(
      workspace.target,
      scope,
      options.blobs,
    );
    registerWorkspaceTools(catalog, target, {
      requireApprovalForWrites:
        workspace.requireApprovalForWrites ?? true,
    });
  }

  if (options.connections) {
    await registerConnections(catalog, scope, capabilities, options.connections);
  }

  if (options.recall && capabilities.has("recall.search")) {
    registerRecallTools(catalog, scope, options.recall.index);
  }

  if (options.appTools) {
    if (Array.isArray(options.appTools)) {
      for (const registration of options.appTools) catalog.register(registration);
    } else {
      (options.appTools as FlaryToolset).register(catalog);
    }
  }
  await options.extend?.(catalog);

  const journal = options.journal ?? (await defaultJournal());
  const runtime = new LazyToolRuntime({
    catalog,
    mode: capabilityMode(capabilities),
    runId: scope.runId ?? scope.threadId ?? `workspace_${scope.workspaceId}`,
    toolJournal: journal,
    limits: options.limits,
    maxConcurrency: options.maxConcurrency ?? 8,
    readParallelism: options.readParallelism ?? 8,
    approve: options.approvals?.approve,
    onToolEvent: options.onEvent,
    onAudit: options.onAudit,
  });

  const codeMode = await resolveCodeMode(options.codeMode);
  const tools = codeMode?.enabled
    ? [
        createCodeModeTool({
          options: codeMode,
          runtime,
          scope,
          admitted: capabilities.has("code.execute"),
        }),
      ]
    : createFlueLazyTools(runtime);

  if (options.sandbox?.enabled) {
    if (!capabilities.has("sandbox.execute")) {
      throw new Error("Sandbox execution was not admitted");
    }
    if (!options.sandbox.adapter) {
      throw new Error("Sandbox execution needs an explicit adapter and binding");
    }
    registerSandboxTool(catalog, scope, options.sandbox);
  }

  if (options.approvals?.continuation) {
    toolApprovalContinuations.set(
      tools,
      options.approvals.continuation,
    );
  }
  return {
    tools,
    catalog,
    ...(options.approvals?.continuation
      ? { approvalContinuation: options.approvals.continuation }
      : {}),
  };
}

async function resolveCodeMode(
  options: FlaryExecutionToolOptions | undefined,
): Promise<FlaryExecutionToolOptions | undefined> {
  if (
    !options?.enabled ||
    options.adapter ||
    options.execute
  ) {
    return options;
  }
  try {
    const cloudflare = await import("@flue/runtime/cloudflare");
    const current = cloudflare.getCloudflareContext();
    const loader = current.env.LOADER ?? current.env.WORKER_LOADER;
    if (!loader) throw new Error("Worker Loader binding is missing");
    const { createCloudflareCodeMode } = await import(
      "../cloudflare/dynamic-worker.js"
    );
    return createCloudflareCodeMode({
      loader: loader as never,
      timeoutMs: options.timeoutMs,
    });
  } catch {
    throw new Error(
      "Code Mode needs a Dynamic Worker adapter or a Cloudflare LOADER binding",
    );
  }
}

function normalizeWorkspaceOptions(
  value:
    | FlaryWorkspaceBindingSource
    | FlaryWorkspaceToolsetOptions,
): FlaryWorkspaceToolsetOptions {
  return "target" in value ? value : { target: value };
}

async function resolveWorkspaceTarget(
  target: FlaryWorkspaceBindingSource,
  scope: z.output<typeof FlaryToolScopeSchema>,
  blobs?: unknown,
): Promise<WorkspaceToolTarget> {
  if ("resolve" in target && typeof target.resolve === "function") {
    return target.resolve({
      tenantId: scope.tenantId,
      appId: scope.appId,
      projectId: scope.projectId,
      workspaceId: scope.workspaceId,
      branch: scope.branch,
    });
  }
  if ("read" in target && typeof target.read === "function") {
    return target as WorkspaceToolTarget;
  }
  const { createCloudflareWorkspaceTarget } = await import(
    "../cloudflare/workspace.js"
  );
  return createCloudflareWorkspaceTarget({
    binding: target as never,
    ...(blobs ? { blobs } : {}),
  }).resolve({
    tenantId: scope.tenantId,
    appId: scope.appId,
    projectId: scope.projectId,
    workspaceId: scope.workspaceId,
    branch: scope.branch,
  });
}

function capabilityMode(
  capabilities: ReadonlySet<FlaryToolCapability>,
): AgentMode {
  return {
    id: "flary-toolset",
    name: "Flary toolset",
    prompt: "Use only tools admitted by the host application.",
    allowedCapabilities: [...capabilities],
    deniedCapabilities: [],
    writableScopes: ["*"],
    approvalPolicy: {
      requireForWrites: false,
      requiredCapabilities: [],
      requiredTools: [],
    },
  };
}

async function registerConnections(
  catalog: ToolCatalog,
  scope: z.output<typeof FlaryToolScopeSchema>,
  capabilities: ReadonlySet<FlaryToolCapability>,
  options: FlaryConnectionResolverOptions,
): Promise<void> {
  const ids = z.array(IdentifierSchema).max(128).parse(options.ids);
  if (new Set(ids).size !== ids.length) {
    throw new Error("Connection IDs must be unique");
  }
  for (const id of ids) {
    const connection = await options.resolve({ id, scope });
    if (!connection || connection.id !== id) {
      throw new Error(`Authorized connection is not available: ${id}`);
    }
    const pinnedRevision = options.revisions?.[id];
    if (pinnedRevision && connection.revision !== pinnedRevision) {
      throw new Error(`Authorized connection revision changed: ${id}`);
    }
    if (connection.kind === "mcp") {
      if (
        !capabilities.has("mcp.call") &&
        !capabilities.has("mcp.search")
      ) {
        continue;
      }
      const endpoint: ScopedMcpEndpointInput = {
        ...connection.endpoint,
        connectionId: id,
        organizationId: scope.tenantId,
        appId: scope.appId,
        ...(connection.revision
          ? { credentialVersion: connection.revision }
          : {}),
      };
      const toolset = await createMcpToolset({
        scope: {
          organizationId: scope.tenantId,
          appId: scope.appId,
          ...(scope.userId ? { userId: scope.userId } : {}),
        },
        endpoints: [endpoint],
        credentials: requiredMcpCredentials(connection.credentials),
        permissions:
          connection.permissions ??
          defaultMcpPermissions(capabilities),
        descriptorCache: connection.descriptorCache,
        clientOptions: connection.clientOptions,
        cache: connection.cache,
        onDiscoveryError: ({ error }) => {
          throw new Error(`${error.message}: ${id}`);
        },
      });
      toolset.register(catalog);
      continue;
    }
    if (!capabilities.has("api.call")) continue;
    await registerApiConnection(catalog, connection);
  }
}

function requiredMcpCredentials(
  resolver: ScopedMcpCredentialResolver,
): ScopedMcpCredentialResolver {
  return async (request) => {
    const value =
      typeof resolver === "function"
        ? await resolver(request)
        : await resolver.get(request);
    if (!value) {
      throw new McpSecurityError(
        "The authorized MCP credential is not available",
      );
    }
    return value;
  };
}

function defaultMcpPermissions(
  capabilities: ReadonlySet<FlaryToolCapability>,
): McpToolPermissionResolver {
  return ({ tool }): McpToolGrantInput | false => {
    const canCall = capabilities.has("mcp.call");
    const canSearch = capabilities.has("mcp.search");
    if (!canCall && (!canSearch || !tool.annotations?.readOnlyHint)) {
      return false;
    }
    const operation = tool.annotations?.readOnlyHint ? "read" : "write";
    return {
      operation,
      capabilities: [canCall ? "mcp.call" : "mcp.search"],
      requiresApproval:
        operation === "write" || Boolean(tool.annotations?.destructiveHint),
    };
  };
}

async function registerApiConnection(
  catalog: ToolCatalog,
  connection: FlaryResolvedApiConnection,
): Promise<void> {
  const connectionRef = await hashedReference(
    `${connection.id}\u0000${connection.revision ?? "current"}`,
  );
  const descriptors = await connection.discover();
  const ids = new Set<string>();
  for (const descriptor of descriptors) {
    if (ids.has(descriptor.id)) {
      throw new Error(`Duplicate API tool: ${descriptor.id}`);
    }
    ids.add(descriptor.id);
    const operation = descriptor.operation ?? "write";
    const inputValidator = new Validator(
      descriptor.inputSchema as JsonSchema,
    );
    const outputValidator = descriptor.outputSchema
      ? new Validator(descriptor.outputSchema as JsonSchema)
      : undefined;
    catalog.register({
      definition: {
        id: `api.${safeId(descriptor.id)}.${connectionRef.slice(0, 16)}`,
        name: descriptor.name ?? descriptor.id,
        description:
          descriptor.description ?? "Call an authorized API operation.",
        kind: "http",
        inputSchema: JsonObjectSchema.parse(descriptor.inputSchema),
        ...(descriptor.outputSchema
          ? { outputSchema: JsonObjectSchema.parse(descriptor.outputSchema) }
          : {}),
        operation,
        capabilities: ["api.call"],
        tags: ["api", "connection", ...(descriptor.tags ?? [])],
        requiresApproval:
          descriptor.requiresApproval ?? operation === "write",
        concurrencyKey: `api_${safeId(connectionRef)}`,
        metadata: {
          connectionRef,
          ...(connection.revision ? { sourceRevision: connection.revision } : {}),
        },
      },
      resourceKey: `api:${connectionRef}`,
      async execute(input) {
        const parsedInput = JsonObjectSchema.parse(input ?? {});
        if (!inputValidator.validate(parsedInput).valid) {
          throw new Error("The API tool input is invalid");
        }
        const output = await connection.call(descriptor.id, parsedInput);
        if (outputValidator && !outputValidator.validate(output).valid) {
          throw new Error("The API tool output is invalid");
        }
        return output;
      },
    });
  }
}

function registerRecallTools(
  catalog: ToolCatalog,
  scope: z.output<typeof FlaryToolScopeSchema>,
  index: RecallIndex,
): void {
  const recallScope = {
    kind: scope.threadId ? "session" as const : "project" as const,
    organizationId: scope.tenantId,
    appId: scope.appId,
    projectId: scope.projectId,
    ...(scope.threadId ? { sessionId: scope.threadId } : {}),
  };
  const searchInput = z.object({
    query: z.string().trim().min(1).max(20_000),
    mode: RecallSearchModeSchema.default("hybrid"),
    kinds: z.array(RecallKindSchema).min(1).max(8).optional(),
    limit: z.number().int().positive().max(100).default(10),
    cursor: z.string().trim().max(500).optional(),
    includeContent: z.boolean().default(true),
  }).strict();
  catalog.register({
    definition: {
      id: "recall.search",
      name: "Search recall",
      description: "Search trusted history in the current project or thread.",
      kind: "function",
      inputSchema: z.toJSONSchema(searchInput) as JsonObject,
      operation: "read",
      capabilities: ["recall.search"],
      tags: ["recall", "history"],
    },
    execute: (input) =>
      index.search(
        RecallSearchRequestSchema.parse({
          ...searchInput.parse(input),
          scope: recallScope,
        }),
      ),
  });
  const openInput = z.object({ id: IdentifierSchema }).strict();
  catalog.register({
    definition: {
      id: "recall.open",
      name: "Open recall record",
      description: "Open one trusted recall record in the current scope.",
      kind: "function",
      inputSchema: z.toJSONSchema(openInput) as JsonObject,
      operation: "read",
      capabilities: ["recall.search"],
      tags: ["recall", "history"],
    },
    execute: (input) =>
      index.open(
        RecallOpenRequestSchema.parse({
          ...openInput.parse(input),
          scope: recallScope,
        }),
      ),
  });
}

function createCodeModeTool(input: {
  options: FlaryExecutionToolOptions;
  runtime: LazyToolRuntime;
  scope: z.output<typeof FlaryToolScopeSchema>;
  admitted: boolean;
}): ToolDefinition {
  if (!input.admitted) throw new Error("Code Mode was not admitted");
  if (!input.options.adapter && !input.options.execute) {
    throw new Error("Code Mode needs a Dynamic Worker adapter or executor");
  }
  return defineTool({
    name: "execute",
    description:
      "Run bounded code in Flary's isolated tool runtime. Use tools.search, tools.describe, tools.call, and tools.batch.",
    input: v.object({ code: v.string() }),
    async run({ input: request }) {
      const parsed = CodeModeInputSchema.parse(request);
      const executionKey = await codeExecutionKey(
        input.scope,
        parsed.code,
      );
      const tools = runtimeBridges(input.runtime, executionKey);
      if (input.options.execute) {
        return toJson(await input.options.execute({
          code: parsed.code,
          scope: input.scope,
          tools,
        }));
      }
      const router = new CodeExecutionRouter({
        adapters: [input.options.adapter!],
      });
      const result = await router.execute(
        {
          executionId: `code_${crypto.randomUUID().replaceAll("-", "")}`,
          runId:
            input.scope.runId ??
            input.scope.threadId ??
            `workspace_${input.scope.workspaceId}`,
          engine: input.options.adapter!.engine,
          runtime: "isolate",
          operation: "code.execute",
          input: parsed,
          limits: {
            timeoutMs: input.options.timeoutMs ?? 60_000,
            maxOutputBytes: input.options.maxOutputBytes ?? 512 * 1024,
          },
        },
        {
          toolNamespaces: [{
            name: "tools",
            tools: {
              search: (query) => tools.search(String(query)),
              describe: (id) => tools.describe(String(id)),
              call: (id, value) =>
                tools.call(String(id), JsonObjectSchema.parse(value ?? {})),
              batch: (calls) =>
                tools.batch(
                  z.array(z.object({
                    id: z.string(),
                    arguments: JsonObjectSchema.optional(),
                    callId: z.string().optional(),
                    idempotencyKey: z.string().optional(),
                  })).parse(calls),
                ),
            },
          }],
        },
      );
      if (result.status === "failed") {
        throw new Error(result.error?.message ?? "Code Mode execution failed");
      }
      return toJson(result.output ?? null);
    },
  });
}

function runtimeBridges(
  runtime: LazyToolRuntime,
  executionKey: string,
) {
  let ordinal = 0;
  const nextCallId = () => `${executionKey}_${++ordinal}`;
  return {
    search: async (query: string) =>
      toJson(await runtime.search({ query, limit: 10 })),
    describe: async (id: string) =>
      toJson(await runtime.describe(id)),
    call: async (id: string, input: JsonObject) =>
      toJson(await runtime.call({
        id,
        arguments: input,
        callId: nextCallId(),
      })),
    batch: (
      calls: readonly {
        id: string;
        arguments?: JsonObject;
        callId?: string;
        idempotencyKey?: string;
      }[],
    ) =>
      runtime.batch({
        calls: calls.map((call) => ({
          id: call.id,
          arguments: call.arguments ?? {},
          callId: nextCallId(),
          ...(call.idempotencyKey
            ? { idempotencyKey: call.idempotencyKey }
            : {}),
          dependsOn: [],
        })),
      }).then(toJson),
  };
}

async function codeExecutionKey(
  scope: z.output<typeof FlaryToolScopeSchema>,
  code: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      [
        scope.runId ?? scope.threadId ?? scope.workspaceId,
        code,
      ].join("\u0000"),
    ),
  );
  return `code_${[...new Uint8Array(digest)]
    .slice(0, 12)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

function registerSandboxTool(
  catalog: ToolCatalog,
  scope: z.output<typeof FlaryToolScopeSchema>,
  options: FlarySandboxToolsetOptions,
): void {
  const inputSchema = z.object({
    sandboxId: IdentifierSchema.optional(),
    command: z.string().trim().min(1).max(100_000),
    files: z.array(z.object({
      path: z.string(),
      content: z.string(),
      encoding: z.enum(["utf8", "base64"]).default("utf8"),
    }).strict()).max(2_000).default([]),
    cwd: z.string().default("/workspace"),
    destroyAfter: z.boolean().default(false),
  }).strict();
  catalog.register({
    definition: {
      id: "sandbox.execute",
      name: "Run sandbox command",
      description: "Run a command in an explicitly configured Linux sandbox.",
      kind: "function",
      inputSchema: z.toJSONSchema(inputSchema) as JsonObject,
      operation: "write",
      capabilities: ["sandbox.execute"],
      tags: ["sandbox", "linux"],
      requiresApproval: true,
      concurrencyKey: "sandbox_execute",
    },
    resourceKey: `sandbox:${scope.workspaceId}`,
    execute: async (value) => {
      const request = inputSchema.parse(value);
      const router = new CodeExecutionRouter({ adapters: [options.adapter!] });
      const result = await router.execute({
        executionId: `sandbox_${crypto.randomUUID().replaceAll("-", "")}`,
        runId: scope.runId ?? scope.threadId ?? `workspace_${scope.workspaceId}`,
        engine: options.adapter!.engine,
        runtime: "linux",
        operation: "sandbox.execute",
        input: {
          ...request,
          sandboxId: request.sandboxId ?? scope.workspaceId,
        },
        limits: {
          timeoutMs: options.timeoutMs ?? 60_000,
          maxOutputBytes: options.maxOutputBytes ?? 512 * 1024,
        },
      });
      if (result.status === "failed") {
        throw new Error(result.error?.message ?? "Sandbox execution failed");
      }
      return result.output ?? null;
    },
  });
}

async function defaultJournal(): Promise<ToolExecutionJournal> {
  try {
    const cloudflare = await import("@flue/runtime/cloudflare");
    const current = cloudflare.getCloudflareContext();
    const storage = current.storage as { readonly sql?: unknown };
    if (storage.sql) {
      const { SqliteToolExecutionJournal } = await import(
        "../cloudflare/tool-journal.js"
      );
      return new SqliteToolExecutionJournal(storage.sql);
    }
  } catch {
    // Local and non-Flue hosts use the process-local journal.
  }
  return new InMemoryToolExecutionJournal();
}

async function hashedReference(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .slice(0, 12)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:/-]+/g, "_");
}

function toJson(value: unknown): JsonObject | unknown {
  return JSON.parse(JSON.stringify(redactSecrets(value))) as unknown;
}

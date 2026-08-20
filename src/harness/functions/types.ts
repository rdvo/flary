import { z } from "zod";

import type {
  ApprovalRequest,
  RunEvent,
  UserInputAnswerRequest,
  UserInputRecord,
} from "../contracts/index.js";
import type {
  FlaryRunService,
  TrustedRunContext,
} from "../host/runs.js";
import type { FlaryThreadHostService } from "../host/types.js";
import type { ModelAdapter, ProviderAdapterRegistry } from "../providers/index.js";
import type { ApprovalContinuation } from "../execution/approval-continuation.js";
import type { FlaryCodemodeApprovalBridge } from "./codemode.js";
import type {
  ModelInput,
  ModelSelection,
  ResolvedModelPin,
} from "../contracts/provider.js";
import type { ModelOperationHandlers } from "../providers/operations.js";

export type FlarySchema = z.ZodType;

export type FlaryInput<TSchema extends FlarySchema> = z.input<TSchema>;
export type FlaryOutput<TSchema extends FlarySchema> = z.output<TSchema>;

export type FlaryFunctionMode = "prompt" | "run";

export interface FlaryIdentity {
  readonly tenantId: string;
  readonly userId?: string;
  readonly applicationId?: string;
  readonly projectId?: string;
  readonly roles?: readonly string[];
  readonly scopes?: readonly string[];
  readonly [key: string]: unknown;
}

export interface FlaryAuthContext<TBindings = unknown> {
  readonly request?: Request;
  readonly bindings: TBindings;
}

export type FlaryAuthResolver<TBindings = unknown> = (
  input: FlaryAuthContext<TBindings>,
) => FlaryIdentity | undefined | Promise<FlaryIdentity | undefined>;

/** Resolve a tenant-scoped model grant without returning a credential value. */
export type FlaryModelGrantResolver = (input: {
  readonly tenantId: string;
  readonly userId: string;
  readonly applicationId: string;
  readonly agentId: string;
  readonly threadId: string;
  readonly connectionIds: readonly string[];
  readonly selection: ModelSelection;
}) =>
  | Partial<ResolvedModelPin>
  | void
  | Promise<Partial<ResolvedModelPin> | void>;

export interface FlaryStepContext<TBindings = unknown> {
  readonly bindings: TBindings;
  readonly identity?: FlaryIdentity;
  readonly signal: AbortSignal;
  readonly runId?: string;
  /** Stable key for an external write made by this tool invocation. */
  readonly idempotencyKey?: string;
  step<TInput, TOutput>(
    name: string,
    fn: FlaryCallableLike<TInput, TOutput>,
    input: TInput,
  ): Promise<TOutput>;
  readonly log: {
    info(message: string, attributes?: Record<string, unknown>): void;
    warn(message: string, attributes?: Record<string, unknown>): void;
    error(message: string, attributes?: Record<string, unknown>): void;
  };
}

export interface FlaryFunctionBaseOptions<
  TInput extends FlarySchema,
  TOutput extends FlarySchema,
  TBindings = unknown,
> {
  readonly name?: string;
  readonly description?: string;
  readonly input: TInput;
  readonly output: TOutput;
  readonly model?: string;
  readonly thinking?: string;
  readonly mode?: string;
  readonly tools?: FlaryToolRegistry;
  readonly eagerTools?: readonly string[];
  readonly policy?: FlaryToolPolicy;
  readonly subagents?: Readonly<Record<string, FlaryCallableLike<unknown, unknown>>>;
  readonly delegation?: FlaryDelegationPolicy;
  readonly durable?: FlaryDurability;
  readonly limits?: FlaryLimits;
  readonly _bindings?: TBindings;
}

export interface FlaryPromptFunctionOptions<
  TInput extends FlarySchema,
  TOutput extends FlarySchema,
  TBindings = unknown,
> extends FlaryFunctionBaseOptions<TInput, TOutput, TBindings> {
  readonly prompt: string | ((input: FlaryOutput<TInput>, context: FlaryStepContext<TBindings>) => string | Promise<string>);
  readonly run?: never;
}

export interface FlaryRunFunctionOptions<
  TInput extends FlarySchema,
  TOutput extends FlarySchema,
  TBindings = unknown,
> extends FlaryFunctionBaseOptions<TInput, TOutput, TBindings> {
  readonly run: (
    input: FlaryOutput<TInput>,
    context: FlaryStepContext<TBindings>,
  ) => FlaryOutput<TOutput> | Promise<FlaryOutput<TOutput>>;
  readonly prompt?: never;
}

export type FlaryFunctionOptions<
  TInput extends FlarySchema,
  TOutput extends FlarySchema,
  TBindings = unknown,
> =
  | FlaryPromptFunctionOptions<TInput, TOutput, TBindings>
  | FlaryRunFunctionOptions<TInput, TOutput, TBindings>;

export interface FlaryToolPolicy {
  readonly operation?: "read" | "write";
  readonly capabilities?: readonly string[];
  readonly requiresApproval?: boolean;
  readonly concurrencyKey?: string;
  readonly replay?: "log" | "reexecute";
}

export interface FlaryDelegationPolicy {
  readonly mode?: "disabled" | "explicit" | "auto";
  readonly maxConcurrent?: number;
  readonly maxTotal?: number;
  readonly maxDepth?: number;
  /** Let durable children in the same root thread exchange mailbox messages. */
  readonly allowPeerMessaging?: boolean;
}

export interface FlaryDurability {
  readonly timeout?: number | string;
  readonly maxAttempts?: number;
}

export interface FlaryLimits {
  readonly steps?: number;
  readonly toolCalls?: number;
  readonly costUsd?: number;
  readonly timeoutMs?: number;
}

export interface FlaryRunOptions {
  readonly requestId?: string;
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
  readonly metadata?: Record<string, unknown>;
}

export interface FlaryApprovalDecisionOptions {
  readonly comment?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface FlarySendInputOptions {
  readonly idempotencyKey?: string;
  readonly metadata?: Record<string, unknown>;
}

export type FlaryEvent<Output = unknown> =
  | {
      readonly type: "queued" | "started";
      readonly runId: string;
      readonly occurredAt: string;
    }
  | {
      readonly type: "output";
      readonly runId: string;
      readonly output: Output;
      readonly occurredAt: string;
    }
  | {
      readonly type: "failed";
      readonly runId: string;
      readonly error: { readonly code: string; readonly message: string };
      readonly occurredAt: string;
    }
  | {
      readonly type: "cancelled";
      readonly runId: string;
      readonly occurredAt: string;
    }
  | {
      readonly type: "paused";
      readonly runId: string;
      readonly reason: string;
      readonly approvalId?: string;
      readonly occurredAt: string;
    }
  | {
      readonly type: "progress";
      readonly runId: string;
      readonly event: RunEvent;
      readonly occurredAt: string;
    };

export interface FlaryRun<Output = unknown> {
  readonly runId: string;
  readonly status: "queued" | "running" | "paused" | "completed" | "failed" | "cancelled";
  result(): Promise<Output>;
  stream(options?: { readonly signal?: AbortSignal }): AsyncIterable<FlaryEvent<Output>>;
  cancel(reason?: string): Promise<void>;
  approvals(): Promise<readonly ApprovalRequest[]>;
  approve(
    approvalId: string,
    options?: FlaryApprovalDecisionOptions,
  ): Promise<void>;
  reject(
    approvalId: string,
    options?: FlaryApprovalDecisionOptions,
  ): Promise<void>;
  userInput(): Promise<readonly UserInputRecord[]>;
  respond(
    requestId: string,
    input: UserInputAnswerRequest,
  ): Promise<void>;
  sendInput(input: unknown, options?: FlarySendInputOptions): Promise<void>;
}

export interface FlaryCallableLike<Input = unknown, Output = unknown> {
  (input: Input): Promise<Output>;
  readonly start?: (input: Input, options?: FlaryRunOptions) => Promise<FlaryRun<Output>>;
}

export interface FlaryFunction<
  TInput extends FlarySchema,
  TOutput extends FlarySchema,
  TBindings = unknown,
> extends FlaryCallableLike<FlaryInput<TInput>, FlaryOutput<TOutput>> {
  (input: FlaryInput<TInput>): Promise<FlaryOutput<TOutput>>;
  readonly input: TInput;
  readonly output: TOutput;
  readonly mode: FlaryFunctionMode;
  readonly definition: FlaryFunctionOptions<TInput, TOutput, TBindings>;
  start(
    input: FlaryInput<TInput>,
    options?: FlaryRunOptions,
  ): Promise<FlaryRun<FlaryOutput<TOutput>>>;
  stream(
    input: FlaryInput<TInput>,
    options?: FlaryRunOptions,
  ): AsyncIterable<FlaryEvent<FlaryOutput<TOutput>>>;
}

export interface FlarySkill {
  readonly kind: "skill";
  readonly name: string;
  readonly description?: string;
  /** Immutable revision used by admission records and lazy discovery. */
  readonly revision: string;
  readonly instructions: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface FlaryCompactionPolicy {
  readonly mode?: "auto" | "manual" | "disabled";
  readonly reserveTokens?: number;
  readonly thresholdTokens?: number;
}

/** Provider switching policy for one persistent agent. */
export interface FlaryModelPolicy {
  /** Exact allow-list. A selected model must match provider and model. */
  readonly allow: readonly ModelInput[];
  readonly switching?: "user" | "disabled";
  readonly fallback?: "none";
  readonly compactionModel?: ModelInput;
}

export interface FlaryAgentOptions<TBindings = unknown> {
  readonly name: string;
  readonly description?: string;
  readonly instructions?: string;
  readonly model?: string;
  readonly models?: FlaryModelPolicy;
  readonly thinking?: string;
  readonly mode?: string;
  readonly tools?: FlaryToolRegistry;
  readonly skills?: readonly FlarySkill[];
  readonly subagents?: Readonly<Record<string, FlaryAgent<any>>>;
  readonly delegation?: FlaryDelegationPolicy;
  readonly compaction?: FlaryCompactionPolicy;
  readonly limits?: FlaryLimits;
  readonly _bindings?: TBindings;
}

/** Persistent interactive agent definition. Flue owns each thread transcript. */
export interface FlaryAgent<TBindings = unknown> {
  readonly kind: "agent";
  readonly name: string;
  readonly definition: FlaryAgentOptions<TBindings>;
  readonly revision: string;
}

export type FlaryModelSelection = ModelSelection;

export type FlaryApplicationExport =
  | FlaryFunction<any, any, any>
  | FlaryAgent<any>;

export interface FlaryMcpSource {
  readonly kind: "mcp";
  readonly namespace: string;
  readonly connection?: string;
  readonly url?: string;
  readonly transport?: "streamable-http" | "sse";
}

export interface FlaryOpenApiSource {
  readonly kind: "openapi";
  readonly namespace: string;
  readonly spec: string | Record<string, unknown>;
  readonly connection?: string;
  readonly baseUrl?: string;
}

export interface FlaryWorkspaceSource {
  readonly kind: "workspace";
  readonly options: FlaryWorkspaceOptions;
}

/** Options for the durable workspace tool source. */
export interface FlaryWorkspaceOptions {
  /** Draft work is isolated and does not need approval for file writes. */
  readonly mode?: "draft";
  /** Create a durable checkpoint when the owning turn finishes. */
  readonly checkpoint?: "turn";
  readonly appId?: string;
  readonly projectId?: string;
  readonly workspaceId?: string;
  readonly branch?: string;
  readonly r2Binding?: string;
  readonly requireR2ForLargeFiles?: boolean;
  readonly tools?: readonly string[];
  /** Hide trusted host metadata from model-visible workspace tools. */
  readonly hiddenPaths?: readonly string[];
}

/** Tenant-scoped object storage exposed as lazy file tools. */
export interface FlaryR2Source {
  readonly kind: "r2";
  readonly namespace: string;
  /** Worker binding name for an R2 bucket, resolved only in the trusted host. */
  readonly binding?: string;
  /** Host-owned connection name for S3-compatible or remote object storage. */
  readonly connection?: string;
  /** Fixed prefix. Use `{tenantId}` for the authenticated tenant. */
  readonly prefix?: string;
  readonly access?: "read" | "read-write";
}

export interface FlarySandboxSource {
  readonly kind: "sandbox";
  readonly options: Record<string, unknown>;
}

export interface FlaryBrowserSource {
  readonly kind: "browser";
  readonly options: {
    readonly profile?: "thread" | "ephemeral";
    readonly siteAccess?: "approval" | "allow";
    readonly sensitiveActions?: "approval" | "allow";
    readonly uploads?: "disabled" | "approval";
    readonly binding?: string;
    readonly keepAliveMs?: number;
  };
}

/** Host-side tool connection used by workspace and sandbox sources. */
export interface FlaryToolConnection {
  readonly descriptors: readonly {
    readonly name: string;
    readonly description?: string;
    readonly inputSchema?: Record<string, unknown>;
    readonly outputSchema?: Record<string, unknown>;
    readonly requiresApproval?: boolean;
    readonly operation?: "read" | "write";
  }[];
  call(name: string, input: unknown): Promise<unknown>;
}

/** Safe host-side MCP boundary. Credentials belong in the resolver closure. */
export interface FlaryMcpConnection {
  readonly name?: string;
  readonly instructions?: string;
  /** Host-pinned connection or descriptor revision. */
  readonly revision?: string;
  readonly tools?: readonly {
    readonly name: string;
    readonly description?: string;
    readonly inputSchema: Record<string, unknown>;
    readonly outputSchema?: Record<string, unknown>;
    readonly annotations?: {
      readonly readOnlyHint?: boolean;
      readonly destructiveHint?: boolean;
    };
    readonly [key: string]: unknown;
  }[];
  readonly fetchTools?: () => Promise<readonly {
    readonly name: string;
    readonly description?: string;
    readonly inputSchema: Record<string, unknown>;
    readonly outputSchema?: Record<string, unknown>;
    readonly annotations?: {
      readonly readOnlyHint?: boolean;
      readonly destructiveHint?: boolean;
    };
    readonly [key: string]: unknown;
  }[]>;
  readonly client: {
    callTool(input: {
      readonly name: string;
      readonly arguments?: Record<string, unknown>;
    }): Promise<{
      readonly toolResult?: unknown;
      readonly isError?: boolean;
      readonly structuredContent?: unknown;
      readonly content?: readonly { readonly type: string; readonly text?: string }[];
    }>;
  };
}

export interface FlaryOpenApiRuntime {
  readonly spec: Record<string, unknown>;
  readonly revision?: string;
  request(input: {
    readonly path: string;
    readonly method?: string;
    readonly params?: Record<string, unknown>;
    readonly body?: unknown;
    readonly headers?: Record<string, string>;
  }): Promise<unknown>;
}

export type FlaryToolSource =
  | FlaryFunction<any, any, any>
  | FlaryMcpSource
  | FlaryOpenApiSource
  | FlaryWorkspaceSource
  | FlaryR2Source
  | FlarySandboxSource
  | FlaryBrowserSource;

export interface FlaryToolRegistry {
  readonly kind: "tools";
  readonly entries: Readonly<Record<string, FlaryToolSource>>;
  readonly names: readonly string[];
  /** Host-visible descriptors. Schemas are still loaded lazily by code mode. */
  readonly descriptors?: readonly FlaryToolDescriptor[];
}

/** Stable metadata for one source in a Flary tool registry. */
export interface FlaryToolDescriptor {
  readonly id: string;
  readonly namespace: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly inputSchema?: Record<string, unknown>;
  readonly outputSchema?: Record<string, unknown>;
  readonly operation: "read" | "write";
  readonly capabilities: readonly string[];
  readonly requiresApproval: boolean;
  readonly connection?: string;
  readonly sourceRevision?: string;
  readonly concurrencyKey?: string;
  readonly idempotency?: "required" | "optional";
}

/** Canonical source name used by integrations that build registries. */
export type ToolSource = FlaryToolSource;

/** Immutable function and dependency selection pinned when a run is admitted. */
export interface FlaryFunctionRevision {
  readonly functionId: string;
  readonly buildHash: string;
  readonly promptHash?: string;
  readonly inputSchemaHash: string;
  readonly outputSchemaHash: string;
  readonly toolRegistryRevision?: string;
  readonly sourceRevisions: Readonly<Record<string, string>>;
  readonly model?: string;
  readonly thinking?: string;
  readonly mode?: string;
  readonly connectionGrants: readonly string[];
}

export interface ResolveFlaryFunctionRunContextInput<TBindings> {
  readonly bindings: TBindings;
  readonly request?: Request;
  readonly identity?: FlaryIdentity;
  readonly functionId: string;
  readonly revision: FlaryFunctionRevision;
  /** Present when the host resolves context for an existing durable run. */
  readonly runId?: string;
}

export type ResolveFlaryFunctionRunContext<TBindings> = (
  input: ResolveFlaryFunctionRunContextInput<TBindings>,
) => TrustedRunContext | Promise<TrustedRunContext>;

export interface FlaryRunServiceResolverInput<TBindings> {
  readonly bindings: TBindings;
  readonly request?: Request;
  readonly waitUntil?: (work: Promise<unknown>) => void;
}

export type FlaryRunServiceResolver<TBindings> =
  | FlaryRunService
  | ((
      input: FlaryRunServiceResolverInput<TBindings>,
    ) => FlaryRunService);

export interface FlaryPromptRequest {
  readonly model: string;
  readonly prompt: string;
  readonly output: FlarySchema;
  readonly tools?: FlaryToolRegistry;
  readonly context: FlaryStepContext<unknown>;
}

export interface FlaryAppOptions<TBindings = unknown> {
  /** Optional application name used in manifests and run ids. */
  readonly name?: string;
  /** Stable application id stored with every durable Flue admission. */
  readonly applicationId?: string;
  /** Optional project scope stored with every durable Flue admission. */
  readonly projectId?: string;
  readonly model?: string;
  readonly bindings?: z.ZodType<TBindings>;
  /** Bindings used by direct server-side calls (HTTP calls use the request env). */
  readonly defaultBindings?: TBindings;
  readonly auth?: FlaryAuthResolver<TBindings>;
  /** Resolve an authenticated provider connection for interactive turns. */
  readonly resolveModel?: FlaryModelGrantResolver;
  /**
   * Register thread-unique trusted provider aliases inside an interactive
   * agent isolate before Flue resolves its runtime model.
   */
  readonly prepareThreadRuntime?: (input: {
    readonly bindings: TBindings;
    readonly runId: string;
  }) => void | Promise<void>;
  /** Identity used only for trusted server-side calls with no HTTP request. */
  readonly defaultIdentity?: FlaryIdentity;
  /**
   * Select how `.start()` runs when no durable host is attached. Durable is
   * the safe default. Ephemeral execution is for tests and short-lived local
   * development only.
   */
  readonly runs?: {
    readonly mode?: "durable" | "ephemeral";
  };
  /** @deprecated Use `runs: { mode: "ephemeral" }` for local tests. */
  readonly runtime?: "durable" | "local";
  /** Existing Flue-backed run service. Production function runs use this. */
  readonly runService?: FlaryRunServiceResolver<TBindings>;
  /**
   * Durable thread service used by `app.agent()` HTTP routes.
   * Production hosts normally attach this through generated Cloudflare code.
   */
  readonly threadService?:
    | FlaryThreadHostService
    | ((input: FlaryRunServiceResolverInput<TBindings>) => FlaryThreadHostService);
  /** Optional host override for the trusted context stored at admission. */
  readonly resolveRunContext?: ResolveFlaryFunctionRunContext<TBindings>;
  readonly provider?: ModelAdapter;
  readonly providers?: ProviderAdapterRegistry;
  /** Host-owned handlers for text, media, embedding, ranking, and moderation. */
  readonly operations?: ModelOperationHandlers<TBindings>;
  readonly prompt?: (
    request: FlaryPromptRequest,
  ) => Promise<unknown>;
  readonly code?: FlaryCodeExecutor<TBindings>;
  readonly resolveMcp?: (
    source: FlaryMcpSource,
    input: { readonly bindings: TBindings; readonly context: FlaryStepContext<TBindings> },
  ) => FlaryMcpConnection | Promise<FlaryMcpConnection>;
  readonly resolveOpenApi?: (
    source: FlaryOpenApiSource,
    input: { readonly bindings: TBindings; readonly context: FlaryStepContext<TBindings> },
  ) => FlaryOpenApiRuntime | Promise<FlaryOpenApiRuntime>;
  readonly resolveWorkspace?: (
    source: FlaryWorkspaceSource,
    input: { readonly bindings: TBindings; readonly context: FlaryStepContext<TBindings> },
  ) => FlaryToolConnection | Promise<FlaryToolConnection>;
  readonly resolveR2?: (
    source: FlaryR2Source,
    input: { readonly bindings: TBindings; readonly context: FlaryStepContext<TBindings> },
  ) => FlaryToolConnection | Promise<FlaryToolConnection>;
  readonly resolveSandbox?: (
    source: FlarySandboxSource,
    input: {
      readonly bindings: TBindings;
      readonly context: FlaryStepContext<TBindings>;
      /** Durable Object SQLite used for process replay and controls. */
      readonly storage?: unknown;
    },
  ) => FlaryToolConnection | Promise<FlaryToolConnection>;
  readonly resolveBrowser?: (
    source: FlaryBrowserSource,
    input: {
      readonly bindings: TBindings;
      readonly context: FlaryStepContext<TBindings>;
      readonly storage?: unknown;
    },
  ) => FlaryToolConnection | Promise<FlaryToolConnection>;
  readonly runStore?: FlaryRunStore;
  /** Durable Object storage used by the default high-level run store. */
  readonly runStorage?: FlaryRunStorage;
  /** Optional Durable Object-backed named-step store. */
  readonly stepStore?: FlaryStepStore;
  /** Maximum provider turns for a prompt-backed function. */
  readonly maxPromptSteps?: number;
}

export interface FlaryCodeExecutor<TBindings = unknown> {
  execute(input: {
    readonly code: string;
    readonly bindings: TBindings;
    readonly tools: FlaryToolRegistry;
    readonly context: FlaryStepContext<TBindings>;
    readonly limits?: FlaryLimits;
  }): Promise<unknown>;
  /** Optional Flue recovery hook for Codemode approval pauses. */
  approvalContinuation?(input: {
    readonly bindings: TBindings;
    readonly tools: FlaryToolRegistry;
    readonly context: FlaryStepContext<TBindings>;
  }): ApprovalContinuation | Promise<ApprovalContinuation | undefined> | undefined;
  /** Host bridge used by a protected agent route to list and decide actions. */
  approvalBridge?(input: {
    readonly bindings: TBindings;
    readonly tools: FlaryToolRegistry;
    readonly context: FlaryStepContext<TBindings>;
  }): FlaryCodemodeApprovalBridge | Promise<FlaryCodemodeApprovalBridge | undefined> | undefined;
}

export interface FlaryRunStore {
  get?(runId: string): FlaryRun | Promise<FlaryRun | undefined> | undefined;
  create<T>(input: {
    readonly runId: string;
    readonly execute: (signal: AbortSignal) => Promise<T>;
  }): Promise<FlaryRun<T>>;
}

/** Durable storage for parsed named-step results. */
export interface FlaryStepStore {
  get(input: {
    readonly runId: string;
    readonly name: string;
  }): Promise<{ readonly inputHash: string; readonly value: unknown } | undefined>;
  put(input: {
    readonly runId: string;
    readonly name: string;
    readonly inputHash: string;
    readonly value: unknown;
  }): Promise<void>;
}

export interface FlaryStepStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T = unknown>(key: string, value: T): Promise<void>;
}

export interface FlaryRunStorage extends FlaryStepStorage {}

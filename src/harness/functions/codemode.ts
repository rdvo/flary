import { z } from "zod";
import type {
  DynamicWorkerExecutorOptions,
  ConnectorTools,
  CodemodeConnector,
  ConnectorTool,
} from "@cloudflare/codemode";
import type {
  ApprovalDecision,
  ApprovalRequest,
} from "../contracts/index.js";
import type {
  ApprovalContinuation,
  ApprovalRecoveryCall,
  ApprovalRecoveryResult,
} from "../execution/approval-continuation.js";
import type {
  FlaryCodeExecutor as CodeExecutor,
  FlaryBrowserSource,
  FlaryMcpConnection,
  FlaryMcpSource,
  FlaryOpenApiRuntime,
  FlaryOpenApiSource,
  FlaryR2Source,
  FlarySandboxSource,
  FlaryStepContext,
  FlaryToolConnection,
  FlaryToolRegistry,
  FlaryWorkspaceSource,
} from "./types.js";
import { ApprovalRequestSchema } from "../contracts/index.js";
import { JsonObjectSchema } from "../contracts/common.js";
import { redactErrorMessage, redactSecrets, redactText } from "../execution/redaction.js";
import { createMcpConnection } from "./mcp.js";
import { createOpenApiRuntime } from "./openapi.js";
import { getFunctionState } from "./app.js";
import { parseThreadName } from "../storage/scopes.js";
import { normalizeFlaryCatalogCalls } from "./code-syntax.js";
import { createR2FileConnection } from "./r2.js";
import {
  catalogBatchInputSchema,
  catalogCallInputSchema,
  normalizeCatalogCall,
} from "./code-contract.js";

/** Structural type so the public package does not import Cloudflare-only modules. */
export interface FlaryDurableObjectState {
  readonly storage: unknown;
  readonly blockConcurrencyWhile?: (...args: unknown[]) => unknown;
}

/** Options for the Flary-owned Cloudflare Dynamic Worker executor. */
export interface FlaryCodemodeExecutorOptions<TBindings = unknown> {
  readonly loader: DynamicWorkerExecutorOptions["loader"];
  /** Durable Object state for replay and approval continuation. */
  readonly ctx?: FlaryDurableObjectState | (() => FlaryDurableObjectState);
  /** Optional Worker environment passed to user connectors. */
  readonly env?: unknown;
  readonly timeoutMs?: number;
  readonly maxCodeBytes?: number;
  readonly maxOutputBytes?: number;
  readonly maxToolCalls?: number;
  /** Maximum calls admitted by one tools.batch request. Defaults to 16. */
  readonly maxBatchCalls?: number;
  /** Maximum concurrent calls inside one tools.batch request. Defaults to 6. */
  readonly maxParallelToolCalls?: number;
  readonly redactResult?: (value: unknown) => unknown | Promise<unknown>;
  /** Defaults to null. The generated Worker cannot use fetch or connect. */
  readonly globalOutbound?: DynamicWorkerExecutorOptions["globalOutbound"];
  readonly modules?: Record<string, string>;
  readonly bindings?: Record<string, unknown>;
  readonly name?: string;
  readonly maxExecutions?: number;
  readonly connectors?: (
    input: {
      readonly bindings: TBindings;
      readonly context: FlaryStepContext<TBindings>;
      readonly tools: FlaryToolRegistry;
    },
  ) =>
    | readonly CodemodeConnector[]
    | Promise<readonly CodemodeConnector[]>;
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
}

export class FlaryCodeExecutionError extends Error {
  readonly code:
    | "flary_code_execution_failed"
    | "flary_code_execution_paused"
    | "approval_pending";
  readonly executionId?: string;
  readonly pending?: readonly unknown[];

  constructor(
    message: string,
    details: {
      executionId?: string;
      pending?: readonly unknown[];
      code?:
        | "flary_code_execution_failed"
        | "flary_code_execution_paused"
        | "approval_pending";
    } = {},
  ) {
    super(message);
    this.name = "FlaryCodeExecutionError";
    this.code = details.code ?? "flary_code_execution_failed";
    this.executionId = details.executionId;
    this.pending = details.pending;
  }
}

/**
 * Create a code executor backed by Cloudflare Dynamic Workers.
 *
 * The package is loaded lazily because `@cloudflare/codemode` contains
 * Cloudflare-only modules. This keeps local tests and Node clients usable.
 * When `ctx` is supplied, Codemode's Durable Object runtime provides replay,
 * approval pauses, and idempotent tool writes. Without `ctx`, the same
 * isolated Worker is used with a process-local execution.
 */
export function createFlaryCodemodeExecutor<TBindings = unknown>(
  options: FlaryCodemodeExecutorOptions<TBindings>,
): CodeExecutor<TBindings> & {
  readonly options: FlaryCodemodeExecutorOptions<TBindings>;
} {
  return new FlaryCodemodeExecutor(options);
}

class FlaryCodemodeExecutor<TBindings> implements CodeExecutor<TBindings> {
  readonly options: FlaryCodemodeExecutorOptions<TBindings>;
  readonly #executor: Promise<import("@cloudflare/codemode").Executor>;

  constructor(options: FlaryCodemodeExecutorOptions<TBindings>) {
    this.options = options;
    this.#executor = import("@cloudflare/codemode").then(
      ({ DynamicWorkerExecutor }) =>
        new DynamicWorkerExecutor({
          loader: options.loader,
          timeout: options.timeoutMs ?? 60_000,
          globalOutbound: options.globalOutbound ?? null,
          modules: options.modules,
          bindings: options.bindings,
        }),
    );
  }

  async execute(input: {
    readonly code: string;
    readonly bindings: TBindings;
    readonly tools: FlaryToolRegistry;
    readonly context: FlaryStepContext<TBindings>;
    readonly limits?: { readonly toolCalls?: number };
  }): Promise<unknown> {
    const codeBytes = new TextEncoder().encode(input.code).byteLength;
    if (codeBytes > (this.options.maxCodeBytes ?? 256 * 1024)) {
      throw new FlaryCodeExecutionError("The generated code exceeds the Flary code size limit.");
    }
    const codemode = await import("@cloudflare/codemode");
    const executor = await this.#executor;
    const extra = [
      ...((await this.options.connectors?.(input)) ?? []),
    ];
    const ctx = typeof this.options.ctx === "function" ? this.options.ctx() : this.options.ctx;

    const maxToolCalls = input.limits?.toolCalls ?? this.options.maxToolCalls;
    const callCounter = { count: 0, max: maxToolCalls };
    if (!ctx) {
      const hasExternal = input.tools.names.some((name) => {
        const source = input.tools.entries[name]!;
        return typeof source !== "function" &&
          (source.kind === "mcp" || source.kind === "openapi" || source.kind === "r2");
      });
      if (extra.length > 0 || hasExternal) {
        throw new FlaryCodeExecutionError(
          "External Flary connectors need a Durable Object state for host execution.",
        );
      }
      const result = await executor.execute(normalizeFlaryCatalogCalls(input.code), [
        {
          name: "tools",
          fns: localProviders(input.tools, callCounter, false),
        },
      ]);
      if (result.error) {
        throw new FlaryCodeExecutionError(result.error);
      }
      return this.boundResult(result.result);
    }
    const activity = createInteractiveCodeModeActivity(
      input.context,
      input.code,
      maxToolCalls,
    );
    const startedAt = Date.now();
    await activity?.record("codemode.started", 0, {
      codeBytes,
      ...(maxToolCalls !== undefined ? { maxToolCalls } : {}),
    });
    try {
      const sourceConnectors = await createSourceConnectors(
        codemode,
        input,
        this.options,
        ctx,
      );
      const local = await createLocalConnector(
        codemode,
        input,
        this.options,
        ctx,
        callCounter,
        sourceConnectors,
        activity,
      );
      const runtime = codemode.createCodemodeRuntime({
        ctx: ctx as never,
        executor,
        // All Flary-owned sources use the one `tools` catalog. Custom
        // low-level connectors remain available as additional namespaces.
        connectors: [local, ...extra],
        name: this.options.name ?? "flary",
        maxExecutions: this.options.maxExecutions,
        ...(this.options.redactResult
          ? { transformResult: this.options.redactResult }
          : {}),
      });
      const result = await runtime.execute({
        code: normalizeFlaryCatalogCalls(input.code),
      });
      if (result.status === "completed") {
        const bounded = await this.boundResult(result.result);
        await activity?.record("codemode.completed", 0, {
          durationMs: Date.now() - startedAt,
          usage: activity.usage(callCounter.count, encodedSize(bounded)),
        });
        return bounded;
      }
      if (result.status === "paused") {
        await activity?.record("codemode.paused", 0, {
          durationMs: Date.now() - startedAt,
          usage: activity.usage(callCounter.count, 0),
        });
        throw new FlaryCodeExecutionError(
          "Tool approval is required before the code can continue.",
          {
            executionId: result.executionId,
            pending: result.pending,
            // Flue treats this code as a durable waiting state. The previous
            // code-only error made the parent agent fail instead of waiting.
            code: "approval_pending",
          },
        );
      }
      throw new FlaryCodeExecutionError(result.error ?? "The Dynamic Worker execution failed.");
    } catch (error) {
      if (!(error instanceof FlaryCodeExecutionError && error.code === "approval_pending")) {
        await activity?.record("codemode.failed", 0, {
          durationMs: Date.now() - startedAt,
          usage: activity.usage(callCounter.count, 0),
          error: redactErrorMessage(error, "The Code Mode execution failed."),
        }).catch(() => undefined);
      }
      throw error;
    }
  }

  approvalContinuation(input: {
    readonly bindings: TBindings;
    readonly tools: FlaryToolRegistry;
    readonly context: FlaryStepContext<TBindings>;
  }): ApprovalContinuation | undefined {
    const ctx = typeof this.options.ctx === "function" ? this.options.ctx() : this.options.ctx;
    if (!ctx) return undefined;
    return this.createApprovalBridge(input, ctx)?.continuation;
  }

  approvalBridge(input: {
    readonly bindings: TBindings;
    readonly tools: FlaryToolRegistry;
    readonly context: FlaryStepContext<TBindings>;
  }): Promise<FlaryCodemodeApprovalBridge | undefined> {
    const ctx = typeof this.options.ctx === "function" ? this.options.ctx() : this.options.ctx;
    if (!ctx) return Promise.resolve(undefined);
    return Promise.resolve(this.createApprovalBridge(input, ctx));
  }

  private createApprovalBridge(
    input: {
      readonly bindings: TBindings;
      readonly tools: FlaryToolRegistry;
      readonly context: FlaryStepContext<TBindings>;
    },
    ctx: FlaryDurableObjectState,
  ): FlaryCodemodeApprovalBridge | undefined {
    const runtime = async (): Promise<FlaryCodemodeApprovalRuntime> => {
      const codemode = await import("@cloudflare/codemode");
      const executor = await this.#executor;
      const extra = [...((await this.options.connectors?.(input)) ?? [])];
      const sourceConnectors = await createSourceConnectors(
        codemode,
        input,
        this.options,
        ctx,
      );
      const local = await createLocalConnector(
        codemode,
        input,
        this.options,
        ctx,
        { count: 0, max: this.options.maxToolCalls },
        sourceConnectors,
      );
      return codemode.createCodemodeRuntime({
        ctx: ctx as never,
        executor,
        connectors: [local, ...extra],
        name: this.options.name ?? "flary",
        maxExecutions: this.options.maxExecutions,
      }) as unknown as FlaryCodemodeApprovalRuntime;
    };
    return createFlaryCodemodeApprovalBridge({
      runtime,
      runId: input.context.runId ?? "flary",
    });
  }

  private async boundResult(value: unknown): Promise<unknown> {
    const redacted = this.options.redactResult
      ? await this.options.redactResult(value)
      : redactSecrets(value);
    let serialized: string;
    try {
      serialized = JSON.stringify(redacted) ?? "null";
    } catch {
      throw new FlaryCodeExecutionError("The code result is not serializable.");
    }
    if (new TextEncoder().encode(serialized).byteLength > (this.options.maxOutputBytes ?? 512 * 1024)) {
      throw new FlaryCodeExecutionError("The code result exceeds the Flary output size limit.");
    }
    return redacted;
  }
}

/** Minimal runtime surface needed by the Flue approval bridge. */
export interface FlaryCodemodeApprovalRuntime {
  pending(executionId?: string): Promise<readonly {
    readonly executionId: string;
    readonly seq: number;
    readonly connector: string;
    readonly method: string;
    readonly args: unknown;
  }[]>;
  approve(input: { readonly executionId: string }): Promise<unknown>;
  reject(input: { readonly executionId: string; readonly seq: number }): Promise<boolean>;
  executions(limit?: number): Promise<readonly {
    readonly id: string;
    readonly status: string;
    readonly result?: unknown;
    readonly error?: string;
    /** Epoch milliseconds when the execution was admitted. */
    readonly createdAt?: number;
  }[]>;
}

export interface FlaryCodemodeApprovalBridgeOptions {
  readonly runtime:
    | FlaryCodemodeApprovalRuntime
    | (() => FlaryCodemodeApprovalRuntime | Promise<FlaryCodemodeApprovalRuntime>);
  readonly runId: string;
  readonly requestedBy?: ApprovalRequest["requestedBy"];
}

export interface FlaryCodemodeApprovalBridge {
  readonly continuation: ApprovalContinuation;
  list(): Promise<ApprovalRequest[]>;
  decide(decision: ApprovalDecision): Promise<void>;
}

/**
 * Adapt Codemode's durable pending actions to Flary's approval contracts and
 * Flue's approvalContinuation hook. Codemode keeps the action log in its
 * Durable Object facet, so the bridge does not keep approval state in memory.
 */
export function createFlaryCodemodeApprovalBridge(
  options: FlaryCodemodeApprovalBridgeOptions,
): FlaryCodemodeApprovalBridge {
  const pendingId = (executionId: string, seq: number) =>
    `codemode_${executionId}_${seq}`;
  const parsePendingId = (value: string): { executionId: string; seq: number } => {
    const match = /^codemode_(.+)_([0-9]+)$/.exec(value);
    if (!match) throw new Error("Invalid Codemode approval id");
    return { executionId: match[1]!, seq: Number(match[2]) };
  };
  const runtimeFor = async (): Promise<FlaryCodemodeApprovalRuntime> =>
    typeof options.runtime === "function"
      ? options.runtime()
      : options.runtime;
  const pending = async () => (await runtimeFor()).pending();
  // Codemode's pending action does not include a timestamp. Keep the first
  // observed value stable for the public approval record, and prefer the
  // durable execution admission timestamp when the runtime exposes it.
  const requestedAtByAction = new Map<string, string>();

  const list = async (): Promise<ApprovalRequest[]> => {
    const runtime = await runtimeFor();
    const values = await runtime.pending();
    const executions = await runtime.executions(100);
    const createdAtByExecution = new Map(
      executions
        .filter((execution) => typeof execution.createdAt === "number")
        .map((execution) => [execution.id, new Date(execution.createdAt!).toISOString()]),
    );
    return values.map((action) => ApprovalRequestSchema.parse({
      id: pendingId(action.executionId, action.seq),
      runId: options.runId,
      action: "tool-call",
      reason: `Approval is required for ${action.connector}.${action.method}`,
      requestedBy: options.requestedBy ?? {
        id: "flary",
        kind: "agent",
        version: "1",
      },
      toolCallId: pendingId(action.executionId, action.seq),
      requestedAt: requestedAtByAction.get(pendingId(action.executionId, action.seq)) ??
        createdAtByExecution.get(action.executionId) ??
        (() => {
          const value = new Date().toISOString();
          requestedAtByAction.set(pendingId(action.executionId, action.seq), value);
          return value;
        })(),
      context: JsonObjectSchema.parse({
        connector: action.connector,
        method: action.method,
        arguments: jsonObject(action.args),
      }),
    }));
  };

  const decide = async (decision: ApprovalDecision): Promise<void> => {
    const { executionId, seq } = parsePendingId(decision.requestId);
    const runtime = await runtimeFor();
    if (decision.status === "approved") {
      await runtime.approve({ executionId });
      return;
    }
    await runtime.reject({ executionId, seq });
  };

  const findExecution = async (): Promise<{
    readonly executionId: string;
    readonly pending: boolean;
  } | undefined> => {
    const actions = await pending();
    if (actions.length > 0) return {
      executionId: actions[0]!.executionId,
      pending: true,
    };
    const executions = await (await runtimeFor()).executions(10);
    const latest = executions[0];
    return latest ? { executionId: latest.id, pending: false } : undefined;
  };

  const continuation: ApprovalContinuation = {
    async inspect(_input: ApprovalRecoveryCall) {
      return (await findExecution())?.pending ? "waiting" : "ready";
    },
    async resume(_input: ApprovalRecoveryCall): Promise<ApprovalRecoveryResult> {
      const execution = await findExecution();
      if (!execution) {
        return { content: "Codemode approval execution is unavailable.", isError: true };
      }
      // The public decision endpoint performs approve/reject. Recovery only
      // reads the durable terminal result and returns it to Flue.
      const state = (await runtimeFor()).executions(10);
      const latest = (await state)[0];
      if (latest?.status === "completed") {
        return {
          content: JSON.stringify(latest.result ?? null),
          output: latest.result,
        };
      }
      return {
        content: latest?.error ?? "Codemode approval was rejected.",
        isError: true,
      };
    },
  };

  return { continuation, list, decide };
}

async function createLocalConnector<TBindings>(
  codemode: typeof import("@cloudflare/codemode"),
  input: {
    readonly bindings: TBindings;
    readonly context: FlaryStepContext<TBindings>;
    readonly tools: FlaryToolRegistry;
  },
  options: FlaryCodemodeExecutorOptions<TBindings>,
  ctx: FlaryDurableObjectState,
  callCounter: { count: number; max?: number },
  sourceConnectors: readonly import("@cloudflare/codemode").CodemodeConnector[],
  activity?: InteractiveCodeModeActivity,
): Promise<import("@cloudflare/codemode").CodemodeConnector> {
  const { CodemodeConnector } = codemode;
  class LocalConnector extends CodemodeConnector<unknown, unknown> {
    name(): string {
      return "tools";
    }

    protected instructions(): string {
      return "Use known catalog IDs directly. Search only for an unknown capability. Batch independent read calls. Issue writes sequentially.";
    }

    protected async tools(): Promise<ConnectorTools> {
      const descriptors = [
        ...describeRegistry(input.tools).filter((item) =>
          typeof input.tools.entries[item.id] === "function",
        ),
        ...(await sourceDescriptors(sourceConnectors)),
      ];
      const sourceTargets = await sourceTargetMap(sourceConnectors);
      const requiresApproval = (args: unknown): boolean => {
        const calls = Array.isArray(args)
          ? args
          : Array.isArray((args as { calls?: unknown } | null)?.calls)
            ? (args as { calls: unknown[] }).calls
            : [args];
        return calls.some((call) => {
          const normalized = normalizeCatalogCall(call);
          const id = normalized && typeof normalized === "object"
            ? (normalized as { id?: unknown }).id
            : undefined;
          return typeof id === "string" &&
            descriptors.some((item) => item.id === id && item.requiresApproval);
        });
      };
      return {
        search: {
          description: "Find tools by intent. Schemas are not loaded until describe is called.",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
            additionalProperties: false,
          },
          outputSchema: {
            type: "object",
            properties: { items: { type: "array" } },
            required: ["items"],
            additionalProperties: false,
          },
          execute: async (args) => {
            const ordinal = activity?.claim("search") ?? 0;
            const startedAt = Date.now();
            const queryValue = typeof args === "string"
              ? args
              : (args as { query?: unknown })?.query;
            const query = typeof queryValue === "string"
              ? queryValue.toLowerCase()
              : "";
            const items = descriptors
              .map((item) => ({
                ...item,
                score: scoreDescriptor(item, query),
              }))
              .filter((item) => !query || item.score > 0)
              .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
              .map(({ score: _score, ...item }) => summarizeDescriptor(item));
            await activity?.record("tool.search", ordinal, {
              query,
              resultCount: items.length,
              resultIds: items.map((item) => item.id),
              durationMs: Date.now() - startedAt,
            });
            return { items };
          },
        },
        describe: {
          description: "Load one selected tool's input and output schema.",
          inputSchema: {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
            additionalProperties: false,
          },
          execute: async (args) => {
            const ordinal = activity?.claim("describe") ?? 0;
            const startedAt = Date.now();
            const id = typeof args === "string"
              ? args
              : (args as { id?: unknown })?.id;
            const descriptor = descriptors.find((item) => item.id === id);
            await activity?.record("tool.describe", ordinal, {
              toolId: String(id),
              found: Boolean(descriptor),
              ...(descriptor
                ? {
                    operation: descriptor.operation,
                    requiresApproval: descriptor.requiresApproval,
                    schemaBytes: encodedSize({
                      inputSchema: descriptor.inputSchema,
                      outputSchema: descriptor.outputSchema,
                    }),
                  }
                : {}),
              durationMs: Date.now() - startedAt,
            });
            if (!descriptor) throw new Error(`Tool is not available: ${String(id)}`);
            return descriptor;
          },
        },
        call: {
          description: "Call one selected tool with { id: item.id, input: {...} }. Keep calls sequential when approval or replay can occur.",
          inputSchema: catalogCallInputSchema(),
          // The selected catalog item, not another item in the lazy catalog,
          // decides if this call pauses.
          requiresApproval,
          execute: async (args) => {
            const ordinal = claimToolCallOrdinal(callCounter);
            return invokeCatalogTool(
              input.tools,
              args,
              input.context,
              ordinal,
              sourceTargets,
            );
          },
        },
        batch: {
          description: "Run independent reads concurrently with { calls: [{ id: item.id, input: {...} }] }. Keep call order stable. Do not batch writes.",
          inputSchema: catalogBatchInputSchema(options.maxBatchCalls ?? 16),
          execute: async (args) => {
            const batchOrdinal = activity?.claim("batch") ?? 0;
            const startedAt = Date.now();
            try {
              const calls = Array.isArray(args)
                ? args
                : (args as { calls?: unknown })?.calls;
              if (!Array.isArray(calls)) {
                throw new Error("tools.batch needs { calls: [{ id, input }] }");
              }
              if (calls.length === 0) {
                throw new Error("tools.batch needs at least one call");
              }
              if (calls.length > (options.maxBatchCalls ?? 16)) {
                throw new Error(`A tools.batch request can contain at most ${options.maxBatchCalls ?? 16} calls.`);
              }

              const normalizedCalls = calls.map((call, index) => {
                const normalized = normalizeCatalogCall(call);
                if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) {
                  throw new Error(`tools.batch calls[${index}] must be { id, input }`);
                }
                const suppliedId = (normalized as { id?: unknown }).id;
                if (typeof suppliedId !== "string" || !suppliedId.trim()) {
                  throw new Error(`tools.batch calls[${index}] needs a string id from item.id`);
                }
                const exact = descriptors.find((item) => item.id === suppliedId);
                const named = exact
                  ? []
                  : descriptors.filter((item) => item.name === suppliedId);
                const descriptor = exact ?? (named.length === 1 ? named[0] : undefined);
                if (!descriptor) {
                  throw new Error(
                    named.length > 1
                      ? `Tool name '${suppliedId}' is ambiguous. Use the exact catalog item.id.`
                      : `Tool is not available: ${suppliedId}`,
                  );
                }
                if (descriptor.operation !== "read" || descriptor.requiresApproval) {
                  throw new Error(`tools.batch only accepts read tools. Call '${descriptor.id}' sequentially.`);
                }
                const toolInput = (normalized as { input?: unknown }).input;
                if (!toolInput || typeof toolInput !== "object" || Array.isArray(toolInput)) {
                  throw new Error(`tools.batch calls[${index}].input must be an object`);
                }
                return { id: descriptor.id, input: toolInput };
              });
              const admitted = normalizedCalls.map((call) => ({
                call,
                ordinal: claimToolCallOrdinal(callCounter),
              }));
              const result = await concurrentMap(
                admitted,
                options.maxParallelToolCalls ?? 6,
                ({ call, ordinal }) => invokeCatalogTool(
                    input.tools,
                    call,
                    input.context,
                    ordinal,
                    sourceTargets,
                  ),
              );
              await activity?.record("tool.batch", batchOrdinal, {
                callCount: normalizedCalls.length,
                maxParallel: options.maxParallelToolCalls ?? 6,
                durationMs: Date.now() - startedAt,
                state: "completed",
              });
              return result;
            } catch (error) {
              await activity?.record("tool.batch", batchOrdinal, {
                callCount: Array.isArray((args as { calls?: unknown })?.calls)
                  ? ((args as { calls: unknown[] }).calls.length)
                  : Array.isArray(args) ? args.length : 0,
                maxParallel: options.maxParallelToolCalls ?? 6,
                durationMs: Date.now() - startedAt,
                state: "failed",
                error: redactErrorMessage(error, "The tool batch failed."),
              }).catch(() => undefined);
              throw error;
            }
          },
        },
      };
    }
  }

  return new LocalConnector(ctx, options.env);
}

async function createSourceConnectors<TBindings>(
  codemode: typeof import("@cloudflare/codemode"),
  input: {
    readonly bindings: TBindings;
    readonly context: FlaryStepContext<TBindings>;
    readonly tools: FlaryToolRegistry;
  },
  options: FlaryCodemodeExecutorOptions<TBindings>,
  ctx: FlaryDurableObjectState,
): Promise<import("@cloudflare/codemode").CodemodeConnector[]> {
  const connectors: import("@cloudflare/codemode").CodemodeConnector[] = [];
  const { McpConnector, OpenApiConnector } = codemode;

  for (const name of input.tools.names) {
    const source = input.tools.entries[name]!;
    if (typeof source === "function") continue;
    if (source.kind === "mcp" && (options.resolveMcp || source.url)) {
      const mcpSource = source;
      class RuntimeMcpConnector extends McpConnector<unknown, unknown> {
        name(): string {
          return mcpSource.namespace;
        }

        protected async createConnection(): Promise<import("@cloudflare/codemode").McpConnectionLike> {
          const connection = options.resolveMcp
            ? await options.resolveMcp(mcpSource, {
                bindings: input.bindings,
                context: input.context,
              })
            : createMcpConnection(mcpSource);
          return connection as unknown as import("@cloudflare/codemode").McpConnectionLike;
        }

        protected async tools(): Promise<ConnectorTools> {
          const discovered = await this.fetchTools();
          const generated = await super.tools();
          const byName = new Map(
            discovered.map((tool) => [this.toolName(tool), tool]),
          );
          return Object.fromEntries(
            Object.entries(generated).map(([name, tool]) => {
              const metadata = byName.get(name) as
                | { annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }
                | undefined;
              const requiresApproval =
                metadata?.annotations?.destructiveHint === true ||
                metadata?.annotations?.readOnlyHint !== true;
              return [
                name,
                requiresApproval ? { ...tool, requiresApproval: true } : tool,
              ];
            }),
          );
        }
      }
      connectors.push(new RuntimeMcpConnector(ctx, options.env));
    }
    if (source.kind === "openapi" && (options.resolveOpenApi || typeof source.spec === "object" || typeof source.spec === "string")) {
      const openApiSource = source;
      class RuntimeOpenApiConnector extends OpenApiConnector<unknown, unknown> {
        readonly #writeMethods = new Set<string>();

        name(): string {
          return openApiSource.namespace;
        }

        protected async spec(): Promise<Record<string, unknown>> {
          const runtime = options.resolveOpenApi
            ? await options.resolveOpenApi(openApiSource, {
                bindings: input.bindings,
                context: input.context,
              })
            : await createOpenApiRuntime(openApiSource);
          for (const name of openApiWriteMethods(runtime.spec)) this.#writeMethods.add(name);
          return runtime.spec;
        }

        protected tool(name: string, tool: ConnectorTool): ConnectorTool {
          return name === "request" || this.#writeMethods.has(name)
            ? { ...tool, requiresApproval: true }
            : tool;
        }

        protected async request(request: {
          path: string;
          method?: string;
          params?: Record<string, unknown>;
          body?: unknown;
          headers?: Record<string, string>;
        }): Promise<unknown> {
          const runtime = options.resolveOpenApi
            ? await options.resolveOpenApi(openApiSource, {
                bindings: input.bindings,
                context: input.context,
              })
            : await createOpenApiRuntime(openApiSource);
          return runtime.request(request);
        }
      }
      connectors.push(new RuntimeOpenApiConnector(ctx, options.env));
    }
    if (source.kind === "workspace" && options.resolveWorkspace) {
      const workspace = await options.resolveWorkspace(source, {
        bindings: input.bindings,
        context: input.context,
      });
      connectors.push(createHostToolConnector(
        codemode,
        ctx,
        options.env,
        name,
        workspace,
      ));
    }
    if (source.kind === "r2" && (options.resolveR2 || source.binding || source.connection)) {
      const r2Source = source;
      const connection = options.resolveR2
        ? await options.resolveR2(r2Source, {
            bindings: input.bindings,
            context: input.context,
          })
        : await createR2FileConnection(r2Source, input.bindings, input.context);
      connectors.push(createHostToolConnector(
        codemode,
        ctx,
        options.env,
        name,
        connection,
      ));
    }
    if (source.kind === "sandbox" && options.resolveSandbox) {
      const sandbox = await options.resolveSandbox(source, {
        bindings: input.bindings,
        context: input.context,
        storage: (
          ctx.storage as { readonly sql?: unknown }
        ).sql,
      });
      connectors.push(createHostToolConnector(
        codemode,
        ctx,
        options.env,
        name,
        sandbox,
      ));
    }
    if (source.kind === "browser" && options.resolveBrowser) {
      const browser = await options.resolveBrowser(source, {
        bindings: input.bindings,
        context: input.context,
        storage: (ctx.storage as { readonly sql?: unknown }).sql,
      });
      connectors.push(createHostToolConnector(
        codemode,
        ctx,
        options.env,
        name,
        browser,
      ));
    }
  }
  return connectors;
}

/** Adapt an application-owned workspace or sandbox to a Codemode connector. */
function createHostToolConnector(
  codemode: typeof import("@cloudflare/codemode"),
  ctx: FlaryDurableObjectState,
  env: unknown,
  namespace: string,
  connection: FlaryToolConnection,
): import("@cloudflare/codemode").CodemodeConnector {
  const { CodemodeConnector } = codemode;
  class HostConnector extends CodemodeConnector<unknown, unknown> {
    name(): string {
      return namespace;
    }

    protected instructions(): string {
      return "Use the workspace or sandbox tools only after searching the Flary catalog.";
    }

    protected async tools(): Promise<ConnectorTools> {
      return Object.fromEntries(connection.descriptors.map((descriptor) => {
        const requiresApproval = descriptor.requiresApproval ?? descriptor.operation === "write";
        return [descriptor.name, {
          ...(descriptor.description ? { description: descriptor.description } : {}),
          ...(descriptor.inputSchema ? { inputSchema: descriptor.inputSchema as never } : {}),
          ...(descriptor.outputSchema ? { outputSchema: descriptor.outputSchema as never } : {}),
          ...(requiresApproval ? { requiresApproval: true } : {}),
          execute: (args: unknown) => connection.call(descriptor.name, args),
        } satisfies ConnectorTool];
      }));
    }
  }
  const connector = new HostConnector(ctx, env);
  hostConnectorOperations.set(
    connector,
    new Map(connection.descriptors.map((descriptor) => [
      descriptor.name,
      descriptor.operation ?? "read",
    ])),
  );
  return connector;
}

const hostConnectorOperations = new WeakMap<
  object,
  ReadonlyMap<string, "read" | "write">
>();

interface SourceTarget {
  readonly id: string;
  readonly method: string;
  readonly operation: "read" | "write";
  readonly connector: {
    name(): string;
    executeTool(method: string, args: unknown): Promise<unknown>;
  };
}

async function sourceDescriptors(
  connectors: readonly import("@cloudflare/codemode").CodemodeConnector[],
): Promise<RegistryDescriptor[]> {
  const values: RegistryDescriptor[] = [];
  for (const connector of connectors) {
    const description = await connector.describe();
    for (const [method, descriptor] of Object.entries(description.descriptors)) {
      const id = `${description.name}.${method}`;
      const requiresApproval = Boolean(description.annotations?.[method]?.requiresApproval);
      values.push({
        id,
        name: id,
        ...(descriptor.description ? { description: descriptor.description } : {}),
        operation: requiresApproval ? "write" : "read",
        requiresApproval,
        inputSchema: descriptor.inputSchema as Record<string, unknown>,
        ...(descriptor.outputSchema
          ? { outputSchema: descriptor.outputSchema as Record<string, unknown> }
          : {}),
        tags: ["tool", description.name],
        capabilities: [`${description.name}.${method}`],
        ...(requiresApproval ? { idempotency: "required" as const } : {}),
      });
    }
  }
  return values;
}

async function sourceTargetMap(
  connectors: readonly import("@cloudflare/codemode").CodemodeConnector[],
): Promise<ReadonlyMap<string, SourceTarget>> {
  const targets = new Map<string, SourceTarget>();
  for (const connector of connectors) {
    const description = await connector.describe();
    const operations = hostConnectorOperations.get(connector);
    for (const method of Object.keys(description.descriptors)) {
      const id = `${description.name}.${method}`;
      targets.set(id, {
        id,
        method,
        operation: operations?.get(method) ??
          (description.annotations?.[method]?.requiresApproval ? "write" : "read"),
        connector,
      });
    }
  }
  return targets;
}

function localProviders(
  registry: FlaryToolRegistry,
  callCounter: { count: number; max?: number },
  allowWrites: boolean,
): Record<string, (...args: unknown[]) => Promise<unknown>> {
  return {
    search: async (value: unknown) => {
      const queryValue = typeof value === "string"
        ? value
        : (value as { query?: unknown } | null)?.query;
      const query = typeof queryValue === "string" ? queryValue : "";
      return {
        items: describeRegistry(registry)
          .filter((item) =>
            !query || item.id.toLowerCase().includes(query.toLowerCase()) ||
              item.description?.toLowerCase().includes(query.toLowerCase()),
          )
          .map(summarizeDescriptor),
      };
    },
    describe: async (value: unknown) => {
      const id = typeof value === "string"
        ? value
        : (value as { id?: unknown } | null)?.id;
      const descriptor = describeRegistry(registry).find((item) => item.id === id);
      if (!descriptor) throw new Error(`Tool is not available: ${String(id)}`);
      return descriptor;
    },
    call: async (...args: unknown[]) =>
      invokeRegistryTool(registry, normalizeCatalogCall(args[0], args[1]), undefined, callCounter, allowWrites),
    batch: async (...args: unknown[]) => {
      const value = args[0];
      const calls = Array.isArray(value)
        ? value
        : (value as { calls?: unknown })?.calls;
      if (!Array.isArray(calls)) throw new Error("calls must be an array");
      return Promise.all(calls.map((call) => invokeRegistryTool(registry, normalizeCatalogCall(call), undefined, callCounter, allowWrites)));
    },
  };
}

interface RegistryDescriptor {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly operation: "read" | "write";
  readonly requiresApproval: boolean;
  readonly inputSchema?: Record<string, unknown>;
  readonly outputSchema?: Record<string, unknown>;
  readonly tags?: readonly string[];
  readonly capabilities?: readonly string[];
  readonly concurrencyKey?: string;
  readonly idempotency?: "required" | "optional";
}

function describeRegistry(registry: FlaryToolRegistry): RegistryDescriptor[] {
  return registry.names.map((name) => {
    const source = registry.entries[name]!;
    if (typeof source === "function") {
      const definition = source.definition;
      return {
        id: name,
        name: definition.name ?? name,
        ...(definition.description ? { description: definition.description } : {}),
        operation: definition.policy?.operation ?? "read",
        requiresApproval:
          definition.policy?.requiresApproval ?? definition.policy?.operation === "write",
        inputSchema: toSchema(definition.input),
        outputSchema: toSchema(definition.output),
        capabilities: definition.policy?.capabilities ?? [],
        ...(definition.policy?.concurrencyKey
          ? { concurrencyKey: definition.policy.concurrencyKey }
          : {}),
        ...(definition.policy?.operation === "write"
          ? { idempotency: "required" as const }
          : {}),
      };
    }
    const namespace = "namespace" in source ? source.namespace : name;
    return {
      id: namespace,
      name: namespace,
      description: `${source.kind} tools`,
        operation:
          source.kind === "sandbox" || source.kind === "workspace" || source.kind === "browser" ||
          (source.kind === "r2" && source.access !== "read")
            ? "write"
            : "read",
      requiresApproval: source.kind !== "mcp",
      tags: [source.kind],
      capabilities: [],
      ...(source.kind === "workspace" || source.kind === "sandbox" || source.kind === "browser" ||
      (source.kind === "r2" && source.access !== "read")
        ? { idempotency: "required" as const }
        : {}),
    };
  });
}

async function invokeRegistryTool(
  registry: FlaryToolRegistry,
  value: unknown,
  context: FlaryStepContext<unknown> | undefined,
  callCounter?: { count: number; max?: number },
  allowWrites = true,
): Promise<unknown> {
  if (!value || typeof value !== "object") throw new Error("A tool call must be an object");
  const id = (value as { id?: unknown }).id;
  const input = (value as { input?: unknown }).input;
  if (typeof id !== "string") throw new Error("A tool call needs an id");
  if (callCounter) {
    callCounter.count += 1;
    if (callCounter.max !== undefined && callCounter.count > callCounter.max) {
      throw new Error("The Flary tool-call limit was exceeded.");
    }
  }
  const source = registry.entries[id];
  if (source === undefined) {
    throw new Error(
      `Tool is not available: '${id}'. Use tools.search and pass the selected item's id value.`,
    );
  }
  if (typeof source === "function") {
    if (
      !allowWrites &&
      (source.definition.policy?.operation === "write" ||
        source.definition.policy?.requiresApproval)
    ) {
      throw new Error(`Approval is required before calling write tool '${id}'.`);
    }
    // Preserve the authenticated invocation context when a local function is
    // called from an isolated Worker. The public callable remains available
    // for custom function implementations that do not expose internal state.
    const state = getFunctionState(source);
    if (state && context) {
      return state.invoke(input, {
        bindings: context.bindings,
        identity: context.identity,
        signal: context.signal,
        runId: context.runId,
        idempotencyKey: (context.idempotencyKey ?? context.runId)
          ? `flary_${context.idempotencyKey ?? context.runId}_${id}_${shortHash(stableJson(input))}`
          : undefined,
      });
    }
    return source(input);
  }
  throw new Error(
    `Tool source '${id}' needs a host connector. Configure connectors on the Flary code executor.`,
  );
}

async function invokeCatalogTool(
  registry: FlaryToolRegistry,
  value: unknown,
  context: FlaryStepContext<unknown> | undefined,
  ordinal: number,
  sourceTargets: ReadonlyMap<string, SourceTarget>,
): Promise<unknown> {
  const normalized = normalizeCatalogCall(value);
  if (!normalized || typeof normalized !== "object") {
    throw new Error("A tool call must be an object");
  }
  const id = (normalized as { id?: unknown }).id;
  const input = (normalized as { input?: unknown }).input;
  if (typeof id !== "string") throw new Error("A tool call needs an id");
  const reservation = await reserveInteractiveToolCall(
    context,
    id,
    input,
    ordinal,
  );
  const source = sourceTargets.get(id);
  const registrySource = registry.entries[id];
  const operation = source?.operation ??
    (typeof registrySource === "function"
      ? registrySource.definition.policy?.operation ?? "read"
      : undefined);
  let result: unknown;
  try {
    if (source) {
      result = await source.connector.executeTool(source.method, input ?? {});
    } else {
      result = await invokeRegistryTool(registry, normalized, context);
    }
  } catch (error) {
    if (interactiveToolFailureState(operation) === "outcome_unknown") {
      await reservation?.unknown(error).catch(() => undefined);
    } else {
      await reservation?.fail(error).catch(() => undefined);
    }
    throw error;
  }
  // Settle outside the execution catch. If audit storage is unavailable after
  // a known result, do not rewrite that known result as an uncertain tool call.
  await reservation?.settle(result);
  return result;
}

function claimToolCallOrdinal(counter: { count: number; max?: number }): number {
  if (counter.max !== undefined && counter.count + 1 > counter.max) {
    throw new Error("The Flary tool-call limit was exceeded.");
  }
  counter.count += 1;
  return counter.count;
}

type CodeModeActivityRecordType =
  | "tool.search"
  | "tool.describe"
  | "tool.batch"
  | "codemode.started"
  | "codemode.paused"
  | "codemode.completed"
  | "codemode.failed";

interface InteractiveCodeModeActivity {
  readonly executionId: string;
  claim(kind: "search" | "describe" | "batch"): number;
  record(
    recordType: CodeModeActivityRecordType,
    ordinal: number,
    payload: Record<string, unknown>,
  ): Promise<void>;
  usage(toolCalls: number, resultBytes: number): Record<string, number>;
}

function createInteractiveCodeModeActivity(
  context: FlaryStepContext<unknown> | undefined,
  code: string,
  maxToolCalls: number | undefined,
): InteractiveCodeModeActivity | undefined {
  const client = interactiveThreadControlClient(context);
  if (!client) return undefined;
  const codeBytes = encodedSize(code);
  const executionId = `code_${shortHash(
    `${context?.idempotencyKey ?? context?.runId}:${shortHash(code)}`,
  )}`;
  const counters = { search: 0, describe: 0, batch: 0 };
  return {
    executionId,
    claim(kind) {
      counters[kind] += 1;
      return counters[kind];
    },
    async record(recordType, ordinal, payload) {
      await client.call("recordRuntimeActivity", {
        activityId: `${executionId}:${recordType}:${ordinal}`,
        recordType,
        payload: {
          executionId,
          ...payload,
        },
      });
    },
    usage(toolCalls, resultBytes) {
      return {
        toolCalls,
        searches: counters.search,
        describes: counters.describe,
        batches: counters.batch,
        codeBytes,
        resultBytes,
        ...(maxToolCalls !== undefined ? { maxToolCalls } : {}),
      };
    },
  };
}

function interactiveThreadControlClient(
  context: FlaryStepContext<unknown> | undefined,
): {
  call(method: string, extra?: Record<string, unknown>): Promise<void>;
} | undefined {
  if (!context?.runId || !context.bindings || typeof context.bindings !== "object") {
    return undefined;
  }
  let ref: ReturnType<typeof parseThreadName>;
  try {
    ref = parseThreadName(context.runId);
  } catch {
    return undefined;
  }
  const namespace = (context.bindings as Record<string, unknown>)
    .FLARY_THREAD_CONTROL as {
      idFromName(name: string): unknown;
      get(id: unknown): { fetch(request: Request): Promise<Response> };
    } | undefined;
  if (!namespace) return undefined;
  const name = `thread:${ref.organizationId}:${ref.appId}:${ref.threadId}`;
  return {
    async call(method, extra = {}) {
      const response = await namespace.get(namespace.idFromName(name)).fetch(
        new Request("https://flary.internal/usage-reservation", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            method,
            tenantId: ref.organizationId,
            applicationId: ref.appId,
            ...extra,
          }),
        }),
      );
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(
          typeof (body as { error?: unknown }).error === "string"
            ? String((body as { error: string }).error)
            : "The thread activity update failed",
        );
      }
    },
  };
}

function encodedSize(value: unknown): number {
  try {
    const encoded = typeof value === "string" ? value : JSON.stringify(value) ?? "null";
    return new TextEncoder().encode(encoded).byteLength;
  } catch {
    return 0;
  }
}

async function concurrentMap<T, R>(
  values: readonly T[],
  concurrency: number,
  run: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const limit = Math.max(1, Math.min(values.length || 1, Math.floor(concurrency)));
  const results = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await run(values[index]!, index);
    }
  }));
  return results;
}

export function interactiveToolFailureState(
  operation: "read" | "write" | undefined,
): "failed" | "outcome_unknown" {
  return operation === "write" ? "outcome_unknown" : "failed";
}

async function reserveInteractiveToolCall(
  context: FlaryStepContext<unknown> | undefined,
  toolId: string,
  input: unknown,
  ordinal: number,
): Promise<{
  settle(result?: unknown): Promise<void>;
  fail(error: unknown): Promise<void>;
  unknown(error: unknown): Promise<void>;
} | undefined> {
  const client = interactiveThreadControlClient(context);
  if (!client) return undefined;
  const reservationId = `tool_${shortHash(
    `${context?.idempotencyKey ?? context?.runId}:${ordinal}:${toolId}:${stableJson(input)}`,
  )}`;
  const call = async (
    method: "reserveUsage" | "settleUsage" | "unknownUsage" | "recordToolActivity",
    extra: Record<string, unknown> = {},
  ): Promise<void> => {
    await client.call(method, { reservationId, ...extra });
  };
  await call("reserveUsage", {
    kind: "tool-call",
    delta: {
      steps: 0,
      toolCalls: 1,
      tokens: 0,
      costUsd: 0,
      sandboxSeconds: 0,
      browserSeconds: 0,
    },
  });
  await call("recordToolActivity", {
    state: "started",
    toolCallId: reservationId,
    toolId,
    ordinal,
    inputSummary: projectPublicToolActivityInput(input, toolId),
  });
  const startedAt = Date.now();
  return {
    settle: async (result) => {
      await call("settleUsage", {
        actual: {
          steps: 0,
          toolCalls: 1,
          tokens: 0,
          costUsd: 0,
          sandboxSeconds: 0,
          browserSeconds: 0,
        },
      });
      await call("recordToolActivity", {
        state: "completed",
        toolCallId: reservationId,
        toolId,
        ordinal,
        outputSummary: projectPublicToolActivityResult(result),
        durationMs: Date.now() - startedAt,
      });
    },
    fail: async (error) => {
      await call("settleUsage", {
        actual: {
          steps: 0,
          toolCalls: 1,
          tokens: 0,
          costUsd: 0,
          sandboxSeconds: 0,
          browserSeconds: 0,
        },
      });
      await call("recordToolActivity", {
        state: "failed",
        outcome: "failed",
        toolCallId: reservationId,
        toolId,
        ordinal,
        durationMs: Date.now() - startedAt,
        error: redactErrorMessage(error, "The tool call failed.").slice(0, 1_000),
      });
    },
    unknown: async (error) => {
      await call("unknownUsage");
      await call("recordToolActivity", {
        state: "failed",
        outcome: "outcome_unknown",
        toolCallId: reservationId,
        toolId,
        ordinal,
        durationMs: Date.now() - startedAt,
        error: redactErrorMessage(error, "The write outcome is unknown.").slice(0, 1_000),
      });
    },
  };
}

export function projectPublicToolActivityInput(value: unknown, toolId: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of ["path", "file", "target", "range", "campaign", "site", "dimension"]) {
    const candidate = source[key];
    if (typeof candidate === "string") output[key] = redactText(candidate).slice(0, 200);
    else if (typeof candidate === "number" || typeof candidate === "boolean") output[key] = candidate;
  }
  // UI artifact tools are an explicit public-display boundary. This strict
  // allowlist runs before tool execution, so untrusted model input cannot put
  // arbitrary fields into the public session projection.
  if (/(?:^|[._-])draw[_-]?canvas$/i.test(toolId)) {
    const artifact = publicCanvasArtifact(source);
    const encoded = JSON.stringify(artifact ?? {});
    if (artifact && encoded.length <= 64_000) {
      output.canvas = artifact;
    }
  }
  return output;
}

/**
 * Keep a small, redacted result in the public activity ledger so clients can
 * inspect a completed tool call. Large results remain available through the
 * encrypted audit path and are not copied into the live event stream.
 */
export function projectPublicToolActivityResult(value: unknown): unknown {
  const redacted = redactSecrets(value);
  let encoded: string;
  try {
    encoded = JSON.stringify(redacted) ?? "null";
  } catch {
    return { summary: "The tool returned a non-serializable result." };
  }
  const sizeBytes = new TextEncoder().encode(encoded).byteLength;
  if (sizeBytes <= 16 * 1024) return redacted;
  return {
    summary: "The tool result is too large for the live activity stream.",
    sizeBytes,
  };
}

function publicCanvasArtifact(source: Record<string, unknown>): Record<string, unknown> | undefined {
  const text = (value: unknown, max: number) => typeof value === "string" && value.trim()
    ? value.trim().slice(0, max)
    : undefined;
  const title = text(source.title, 120);
  if (!title) return undefined;
  const artifact: Record<string, unknown> = { title };
  for (const [key, max] of [["id", 80], ["subtitle", 240], ["eyebrow", 60], ["insight", 500], ["source", 160]] as const) {
    const value = text(source[key], max);
    if (value) artifact[key] = value;
  }
  const html = text(source.html, 60_000);
  if (html) {
    artifact.html = html;
    artifact.height = typeof source.height === "number" && Number.isInteger(source.height)
      ? Math.min(720, Math.max(240, source.height))
      : 420;
    return redactSecrets(artifact) as Record<string, unknown>;
  }
  artifact.metrics = Array.isArray(source.metrics) ? source.metrics.slice(0, 8).flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const metric = value as Record<string, unknown>;
    const label = text(metric.label, 80);
    const metricValue = text(metric.value, 80);
    if (!label || !metricValue) return [];
    return [{
      label,
      value: metricValue,
      ...(text(metric.detail, 120) ? { detail: text(metric.detail, 120) } : {}),
      ...(typeof metric.change === "number" && Number.isFinite(metric.change) ? { change: metric.change } : {}),
      ...(["neutral", "blue", "green", "amber", "red", "violet"].includes(String(metric.tone)) ? { tone: metric.tone } : {}),
    }];
  }) : [];
  if (source.chart && typeof source.chart === "object" && !Array.isArray(source.chart)) {
    const chart = source.chart as Record<string, unknown>;
    const points = Array.isArray(chart.points) ? chart.points.slice(0, 120).flatMap((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const point = value as Record<string, unknown>;
      const label = text(point.label, 80);
      if (!label || typeof point.value !== "number" || !Number.isFinite(point.value)) return [];
      return [{
        label,
        value: point.value,
        ...(typeof point.secondary === "number" && Number.isFinite(point.secondary) ? { secondary: point.secondary } : {}),
      }];
    }) : [];
    if (points.length >= 2) artifact.chart = {
      type: ["line", "area", "bar"].includes(String(chart.type)) ? chart.type : "line",
      ...(text(chart.title, 120) ? { title: text(chart.title, 120) } : {}),
      primaryLabel: text(chart.primaryLabel, 60) ?? "Current",
      ...(text(chart.secondaryLabel, 60) ? { secondaryLabel: text(chart.secondaryLabel, 60) } : {}),
      valueFormat: ["number", "currency", "percent"].includes(String(chart.valueFormat)) ? chart.valueFormat : "number",
      points,
    };
  }
  if (source.table && typeof source.table === "object" && !Array.isArray(source.table)) {
    const table = source.table as Record<string, unknown>;
    const columns = Array.isArray(table.columns) ? table.columns.slice(0, 8).flatMap((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const column = value as Record<string, unknown>;
      const key = text(column.key, 40);
      const label = text(column.label, 60);
      return key && label ? [{ key, label }] : [];
    }) : [];
    if (columns.length > 0) artifact.table = {
      ...(text(table.title, 120) ? { title: text(table.title, 120) } : {}),
      columns,
      rows: Array.isArray(table.rows) ? table.rows.slice(0, 30).flatMap((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return [];
        const row = value as Record<string, unknown>;
        return [Object.fromEntries(columns.map(({ key }) => {
          const cell = row[key];
          return [key, typeof cell === "string" ? cell.slice(0, 160) : typeof cell === "number" || typeof cell === "boolean" || cell === null ? cell : ""];
        }))];
      }) : [],
    };
  }
  return redactSecrets(artifact) as Record<string, unknown>;
}

function toSchema(schema: unknown): Record<string, unknown> | undefined {
  try {
    return schema ? JsonObjectSchema.parse(z.toJSONSchema(schema as never)) : undefined;
  } catch {
    return undefined;
  }
}

function scoreDescriptor(item: RegistryDescriptor, query: string): number {
  if (!query) return 1;
  const haystack = [item.id, item.name, item.description, ...(item.tags ?? [])]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (haystack === query) return 1;
  if (haystack.includes(query)) return 0.9;
  const tokens = query.split(/\s+/).filter(Boolean);
  const matched = tokens.filter((token) => haystack.includes(token)).length;
  return tokens.length > 0 ? matched / tokens.length : 0;
}

function summarizeDescriptor(item: RegistryDescriptor): Omit<RegistryDescriptor, "inputSchema" | "outputSchema"> {
  const { inputSchema: _inputSchema, outputSchema: _outputSchema, ...summary } = item;
  return summary;
}

function stableJson(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, item: unknown) =>
      item && typeof item === "object" && !Array.isArray(item)
        ? Object.fromEntries(
            Object.entries(item as Record<string, unknown>).sort(([left], [right]) =>
              left.localeCompare(right),
            ),
          )
        : item,
    ) ?? "";
  } catch {
    return String(value);
  }
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return redactSecrets(value) as Record<string, unknown>;
  }
  return { value: redactSecrets(value) };
}

function shortHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function openApiWriteMethods(spec: Record<string, unknown>): string[] {
  const methods = new Set(["post", "put", "patch", "delete"]);
  const names: string[] = [];
  const paths = spec.paths;
  if (!paths || typeof paths !== "object" || Array.isArray(paths)) return names;
  for (const [path, rawPath] of Object.entries(paths)) {
    if (!rawPath || typeof rawPath !== "object" || Array.isArray(rawPath)) continue;
    for (const [method, rawOperation] of Object.entries(rawPath)) {
      if (!methods.has(method.toLowerCase())) continue;
      const operation = rawOperation as { operationId?: unknown };
      if (typeof operation.operationId === "string") names.push(sanitizeTypeName(operation.operationId));
      names.push(sanitizeTypeName(`${method}_${path}`));
    }
  }
  return names;
}

function sanitizeTypeName(value: string): string {
  return value
    .replace(/[{}]/g, "")
    .replace(/[^A-Za-z0-9_$]+/g, "_")
    .replace(/^([0-9])/, "_$1");
}

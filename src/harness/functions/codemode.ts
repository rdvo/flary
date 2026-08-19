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
import { redactSecrets } from "../execution/redaction.js";
import { createMcpConnection } from "./mcp.js";
import { createOpenApiRuntime } from "./openapi.js";
import { getFunctionState } from "./app.js";
import { parseThreadName } from "../storage/scopes.js";
import { normalizeFlaryCatalogCalls } from "./code-syntax.js";
import { createR2FileConnection } from "./r2.js";

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
    if (new TextEncoder().encode(input.code).byteLength > (this.options.maxCodeBytes ?? 256 * 1024)) {
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
      const result = await executor.execute(input.code, [
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
    if (result.status === "completed") return this.boundResult(result.result);
    if (result.status === "paused") {
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
): Promise<import("@cloudflare/codemode").CodemodeConnector> {
  const { CodemodeConnector } = codemode;
  class LocalConnector extends CodemodeConnector<unknown, unknown> {
    name(): string {
      return "tools";
    }

    protected instructions(): string {
      return "Search the Flary catalog before you describe or call a tool.";
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
          const normalized = normalizeCall(call);
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
            const id = typeof args === "string"
              ? args
              : (args as { id?: unknown })?.id;
            const descriptor = descriptors.find((item) => item.id === id);
            if (!descriptor) throw new Error(`Tool is not available: ${String(id)}`);
            return descriptor;
          },
        },
        call: {
          description: "Call one selected tool after describe has loaded its schema.",
          inputSchema: {
            type: "object",
            properties: {
              id: { type: "string" },
              input: { type: "object" },
            },
            required: ["id", "input"],
            additionalProperties: false,
          },
          // The selected catalog item, not another item in the lazy catalog,
          // decides if this call pauses.
          requiresApproval,
          execute: async (args) =>
            invokeCatalogTool(
              input.tools,
              args,
              input.context,
              callCounter,
              sourceTargets,
            ),
        },
        batch: {
          description: "Call several selected tools with one bounded request.",
          inputSchema: {
            type: "object",
            properties: { calls: { type: "array" } },
            required: ["calls"],
            additionalProperties: false,
          },
          requiresApproval,
          execute: async (args) => {
            const calls = Array.isArray(args)
              ? args
              : (args as { calls?: unknown })?.calls;
            if (!Array.isArray(calls)) throw new Error("calls must be an array");
            return Promise.all(
              calls.map((call) =>
                invokeCatalogTool(
                  input.tools,
                  call,
                  input.context,
                  callCounter,
                  sourceTargets,
                ),
              ),
            );
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
  return new HostConnector(ctx, env);
}

interface SourceTarget {
  readonly id: string;
  readonly method: string;
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
    for (const method of Object.keys(description.descriptors)) {
      const id = `${description.name}.${method}`;
      targets.set(id, { id, method, connector });
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
    search: async (query: unknown) => ({
      items: describeRegistry(registry)
        .filter((item) =>
          !query || item.id.toLowerCase().includes(String(query).toLowerCase()) ||
            item.description?.toLowerCase().includes(String(query).toLowerCase()),
        )
        .map(summarizeDescriptor),
    }),
    describe: async (id: unknown) => {
      const descriptor = describeRegistry(registry).find((item) => item.id === id);
      if (!descriptor) throw new Error(`Tool is not available: ${String(id)}`);
      return descriptor;
    },
    call: async (...args: unknown[]) =>
      invokeRegistryTool(registry, normalizeCall(args[0], args[1]), undefined, callCounter, allowWrites),
    batch: async (...args: unknown[]) => {
      const value = args[0];
      const calls = Array.isArray(value)
        ? value
        : (value as { calls?: unknown })?.calls;
      if (!Array.isArray(calls)) throw new Error("calls must be an array");
      return Promise.all(calls.map((call) => invokeRegistryTool(registry, normalizeCall(call), undefined, callCounter, allowWrites)));
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
        idempotencyKey: context.runId
          ? `flary_${context.runId}_${id}_${shortHash(stableJson(input))}`
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
  callCounter: { count: number; max?: number },
  sourceTargets: ReadonlyMap<string, SourceTarget>,
): Promise<unknown> {
  const normalized = normalizeCall(value);
  if (!normalized || typeof normalized !== "object") {
    throw new Error("A tool call must be an object");
  }
  const id = (normalized as { id?: unknown }).id;
  const input = (normalized as { input?: unknown }).input;
  if (typeof id !== "string") throw new Error("A tool call needs an id");
  if (
    callCounter.max !== undefined &&
    callCounter.count + 1 > callCounter.max
  ) {
    throw new Error("The Flary tool-call limit was exceeded.");
  }
  const reservation = await reserveInteractiveToolCall(
    context,
    id,
    input,
    callCounter.count + 1,
  );
  try {
    const source = sourceTargets.get(id);
    if (source) {
      callCounter.count += 1;
      const result = await source.connector.executeTool(source.method, input ?? {});
      await reservation?.settle();
      return result;
    }
    const result = await invokeRegistryTool(registry, normalized, context, callCounter);
    await reservation?.settle();
    return result;
  } catch (error) {
    await reservation?.unknown().catch(() => undefined);
    throw error;
  }
}

async function reserveInteractiveToolCall(
  context: FlaryStepContext<unknown> | undefined,
  toolId: string,
  input: unknown,
  ordinal: number,
): Promise<{
  settle(): Promise<void>;
  unknown(): Promise<void>;
} | undefined> {
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
  const reservationId = `tool_${shortHash(
    `${context.idempotencyKey ?? context.runId}:${ordinal}:${toolId}:${stableJson(input)}`,
  )}`;
  const name = `thread:${ref.organizationId}:${ref.appId}:${ref.threadId}`;
  const call = async (
    method: "reserveUsage" | "settleUsage" | "unknownUsage" | "recordToolActivity",
    extra: Record<string, unknown> = {},
  ): Promise<void> => {
    const response = await namespace.get(namespace.idFromName(name)).fetch(
      new Request("https://flary.internal/usage-reservation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          method,
          tenantId: ref.organizationId,
          applicationId: ref.appId,
          reservationId,
          ...extra,
        }),
      }),
    );
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(
        typeof (body as { error?: unknown }).error === "string"
          ? String((body as { error: string }).error)
          : "The root tool-call limit reservation failed",
      );
    }
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
  return {
    settle: async () => {
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
      });
    },
    unknown: async () => {
      await call("unknownUsage");
      await call("recordToolActivity", {
        state: "failed",
        toolCallId: reservationId,
        toolId,
        ordinal,
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
    if (typeof candidate === "string") output[key] = candidate.slice(0, 200);
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

function normalizeCall(value: unknown, input?: unknown): unknown {
  if (typeof value === "string") return { id: value, input: input ?? {} };
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if ("arguments" in record && !("input" in record)) {
      return { ...record, input: record.arguments };
    }
  }
  return value;
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

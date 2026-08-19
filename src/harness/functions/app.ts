import { Hono } from "hono";
import {
  z,
  ZodError,
  type ZodType,
} from "zod";

import {
  CreateRunRequestSchema,
  IdentifierSchema,
  JsonObjectSchema as ContractJsonObjectSchema,
} from "../contracts/index.js";
import {
  TrustedRunContextSchema,
  type FlaryRunService,
  type TrustedRunContext,
} from "../host/runs.js";
import { FlaryHostError } from "../host/errors.js";
import { createFlaryHostRouter } from "../host/router.js";
import type {
  FlaryThreadHostService,
  FlaryThreadTarget,
} from "../host/types.js";
import {
  OpenAICompatibleAdapter,
  AnthropicMessagesAdapter,
  CloudflareWorkersAIAdapter,
  parseFlueModelSpecifier,
  type ModelAdapter,
} from "../providers/index.js";
import type {
  NormalizedModelRequest,
  ProviderMessage,
} from "../providers/contracts.js";
import {
  ModelSelectionSchema,
  normalizeModelInput,
  ReasoningEffortSchema,
} from "../contracts/provider.js";
import {
  createAdapterOperationHandlers,
  createModelOperations,
  type AudioResult,
  type EmbedRequest,
  type EmbedResult,
  type GenerateAudioRequest,
  type GenerateImageRequest,
  type GenerateObjectRequest,
  type GenerateTextRequest,
  type GenerateTextResult,
  type GenerateVideoRequest,
  type ImageResult,
  type ModelOperationContext,
  type ModelOperations,
  type ModerateRequest,
  type ModerationResult,
  type RerankRequest,
  type RerankResult,
  type TranscribeRequest,
  type TranscriptionResult,
  type VideoResult,
} from "../providers/operations.js";
import { JsonObjectSchema } from "../contracts/common.js";
import {
  createFlueBackedFlaryRun,
  DurableObjectFlaryFunctionRunStore,
  DurableObjectFlaryStepStore,
  InMemoryFlaryFunctionRunStore,
  SqliteFlaryStepStore,
  runId as makeRunId,
} from "./runs.js";
import type {
  FlaryAppOptions,
  FlaryAgent,
  FlaryAgentOptions,
  FlaryApplicationExport,
  FlaryBrowserSource,
  FlaryCallableLike,
  FlaryEvent,
  FlaryFunction,
  FlaryFunctionRevision,
  FlaryFunctionOptions,
  FlaryFunctionMode,
  FlaryCodeExecutor,
  FlaryInput,
  FlaryMcpSource,
  FlaryOpenApiSource,
  FlaryPromptRequest,
  FlaryR2Source,
  FlaryRun,
  FlaryRunOptions,
  FlarySandboxSource,
  FlarySchema,
  FlaryStepStore,
  FlaryStepContext,
  FlaryToolRegistry,
  FlaryToolDescriptor,
  FlaryToolSource,
  FlaryWorkspaceSource,
  FlaryWorkspaceOptions,
  FlaryIdentity,
  FlarySkill,
} from "./types.js";
import {
  createFlaryCodemodeExecutor,
  type FlaryCodemodeExecutorOptions,
  type FlaryCodemodeApprovalBridge,
  type FlaryDurableObjectState,
} from "./codemode.js";
import {
  createOpenApiRuntime,
  openApiRevision,
} from "./openapi.js";
import { createMcpConnection } from "./mcp.js";
import type { ApprovalContinuation } from "../execution/approval-continuation.js";
import {
  DurableSandboxProcessRuntime,
} from "../cloudflare/sandbox-process-runtime.js";
import {
  SqliteSandboxProcessRegistry,
  hashSandboxEnvironment,
} from "../cloudflare/sandbox-process-registry.js";
import { createCloudflareWorkspaceConnection } from "../cloudflare/workspace.js";
import { executeToolDescription } from "./tool-guidance.js";
import { CloudflareSandboxWorkspaceBackend } from "../cloudflare/workspace-execution.js";
import { parseThreadName } from "../storage/scopes.js";
import { createCloudflareBrowserConnection } from "./browser.js";
import { createR2FileConnection } from "./r2.js";

const FUNCTION_STATE = Symbol("flary.function.state");
const AGENT_STATE = Symbol("flary.agent.state");

type AnyFunction = FlaryFunction<any, any, any>;
type AnyAgent = FlaryAgent<any>;

interface Invocation<TBindings> {
  readonly bindings: TBindings;
  readonly identity?: FlaryIdentity;
  readonly request?: Request;
  readonly signal: AbortSignal;
  readonly runId?: string;
  readonly idempotencyKey?: string;
  readonly waitUntil?: (work: Promise<unknown>) => void;
  readonly stepStore?: FlaryStepStore;
  readonly stepCache: Map<string, { input: string; value: Promise<unknown> }>;
}

interface FunctionState {
  readonly app: FlaryApplication<any>;
  readonly definition: FlaryFunctionOptions<any, any, any>;
  readonly mode: FlaryFunctionMode;
  functionId?: string;
  invoke(input: unknown, invocation?: Partial<Invocation<any>>): Promise<unknown>;
}

interface AgentState {
  readonly app: FlaryApplication<any>;
  readonly definition: FlaryAgentOptions<any>;
}

export interface FlaryWorkflowInvocation {
  readonly input: unknown;
  readonly runId: string;
  readonly bindings: unknown;
  readonly signal?: AbortSignal;
}

export interface FlaryServeOptions {
  /** URL prefix used by the generated client. The host may also mount the app. */
  readonly prefix?: string;
}

/** Error returned by the function HTTP adapter. */
export class FlaryFunctionError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 500) {
    super(message);
    this.name = "FlaryFunctionError";
    this.code = code;
    this.status = status;
  }
}

/**
 * A function-first Flary application.
 *
 * The application owns schema validation, provider calls, tool registries,
 * authentication, and the small HTTP surface. Low-level Flary APIs remain
 * available for hosts that need more control.
 */
export class FlaryApplication<TBindings extends object = Record<string, unknown>> {
  readonly options: FlaryAppOptions<TBindings>;
  readonly runStore;
  readonly stepStore;
  #runServiceOverride: FlaryAppOptions<TBindings>["runService"];
  #threadServiceOverride: FlaryAppOptions<TBindings>["threadService"];

  constructor(options: FlaryAppOptions<TBindings> = {}) {
    this.options = options;
    this.#runServiceOverride = options.runService;
    this.#threadServiceOverride = options.threadService;
    this.runStore = options.runStore ??
      (options.runStorage
        ? new DurableObjectFlaryFunctionRunStore(options.runStorage)
        : new InMemoryFlaryFunctionRunStore());
    this.stepStore = options.stepStore;
  }

  /**
   * Run a provider-neutral text operation. A host handler may replace the
   * built-in chat adapter path when it needs a managed provider gateway.
   */
  generateText(
    request: GenerateTextRequest,
    context?: Partial<ModelOperationContext<TBindings>>,
  ): Promise<GenerateTextResult> {
    return this.modelOperations().generateText(request, context);
  }

  /** Generate and validate one structured object with a Zod schema. */
  generateObject<TSchema extends FlarySchema>(
    request: GenerateObjectRequest<TSchema>,
    context?: Partial<ModelOperationContext<TBindings>>,
  ): Promise<z.output<TSchema>> {
    return this.modelOperations().generateObject(request, context);
  }

  /** Generate embeddings through a host-owned provider operation. */
  embed(
    request: EmbedRequest,
    context?: Partial<ModelOperationContext<TBindings>>,
  ): Promise<EmbedResult> {
    return this.modelOperations().embed(request, context);
  }

  generateImage(
    request: GenerateImageRequest,
    context?: Partial<ModelOperationContext<TBindings>>,
  ): Promise<ImageResult> {
    return this.modelOperations().generateImage(request, context);
  }

  transcribe(
    request: TranscribeRequest,
    context?: Partial<ModelOperationContext<TBindings>>,
  ): Promise<TranscriptionResult> {
    return this.modelOperations().transcribe(request, context);
  }

  generateAudio(
    request: GenerateAudioRequest,
    context?: Partial<ModelOperationContext<TBindings>>,
  ): Promise<AudioResult> {
    return this.modelOperations().generateAudio(request, context);
  }

  generateVideo(
    request: GenerateVideoRequest,
    context?: Partial<ModelOperationContext<TBindings>>,
  ): Promise<VideoResult> {
    return this.modelOperations().generateVideo(request, context);
  }

  rerank(
    request: RerankRequest,
    context?: Partial<ModelOperationContext<TBindings>>,
  ): Promise<RerankResult> {
    return this.modelOperations().rerank(request, context);
  }

  moderate(
    request: ModerateRequest,
    context?: Partial<ModelOperationContext<TBindings>>,
  ): Promise<ModerationResult> {
    return this.modelOperations().moderate(request, context);
  }

  private modelOperations(): ModelOperations<TBindings> {
    const fallback = createAdapterOperationHandlers<TBindings>({
      defaultModel: this.options.model,
      resolveAdapter: (selection, bindings) =>
        this.resolveAdapter(selection.provider, bindings),
    });
    return createModelOperations<TBindings>({
      handlers: {
        ...fallback,
        ...(this.options.operations ?? {}),
      },
      defaults: this.options.model ? { model: this.options.model } : undefined,
      // Do not parse an empty binding object here. Hosts often require a
      // secret-bearing binding schema; the request-scoped context supplies it.
      bindings: this.options.defaultBindings,
      identity: this.options.defaultIdentity,
    });
  }

  /**
   * Attach the generated Flue host to an authored application.
   *
   * The Vite integration uses this hook in the Worker entry. Keeping the
   * host attachment separate from the authoring file lets normal TypeScript
   * files stay free of Durable Object and Wrangler code.
   */
  attachRunService(
    runService: NonNullable<FlaryAppOptions<TBindings>["runService"]>,
  ): this {
    this.#runServiceOverride = runService;
    return this;
  }

  /** Attach the generated durable thread control service. */
  attachThreadService(
    threadService: NonNullable<FlaryAppOptions<TBindings>["threadService"]>,
  ): this {
    this.#threadServiceOverride = threadService;
    return this;
  }

  /** Run one durable coordination action for a model-visible agent tool. */
  async agentSubagentAction(
    root: FlaryAgent<TBindings>,
    current: FlaryAgent<TBindings>,
    input: {
      readonly bindings: TBindings;
      readonly runId: string;
      readonly action: string;
      readonly value?: Readonly<Record<string, unknown>>;
    },
  ): Promise<unknown> {
    const configured = this.#threadServiceOverride;
    if (!configured) {
      throw new FlaryFunctionError(
        "thread_service_missing",
        "Durable subagent coordination needs the generated thread service.",
        500,
      );
    }
    const service = resolveThreadService(configured, {
      bindings: input.bindings,
    });
    if (!service.subagentAction) {
      throw new FlaryFunctionError(
        "subagents_unavailable",
        "The durable thread host does not support subagents.",
        501,
      );
    }
    const ref = parseThreadName(input.runId);
    const currentTarget: FlaryThreadTarget = {
      authorization: {
        organizationId: ref.organizationId,
        actor: { id: "flary-agent", kind: "service" },
      },
      appId: ref.appId,
      threadId: ref.threadId,
    };
    const currentBinding = await service.inspect(currentTarget);
    const rootThreadId =
      typeof currentBinding.metadata?.flarySubagentRootThreadId === "string"
        ? currentBinding.metadata.flarySubagentRootThreadId
        : ref.threadId;
    const rootTarget = { ...currentTarget, threadId: rootThreadId };
    const value: Record<string, unknown> = {
      ...(input.value ?? {}),
      currentThreadId: ref.threadId,
    };

    if (input.action === "spawn") {
      const requestedName = String(value.agent ?? value.agentId ?? "");
      const child = findDeclaredChild(current, requestedName);
      if (!child) {
        throw new FlaryFunctionError(
          "subagent_not_declared",
          `Subagent '${requestedName}' is not declared by '${current.name}'.`,
          400,
        );
      }
      const selection = resolveAgentModelSelection(child, value.model);
      value.agentId = child.name;
      value.model = selection;
      value.parentThreadId = ref.threadId;
      value.requestId = value.requestId ?? `request_${crypto.randomUUID()}`;
      value.metadata = {
        ...objectRecord(value.metadata),
        flaryRuntimeAgentId: root.name,
        flaryAgentRevision: child.revision,
        flarySubagentRootThreadId: rootThreadId,
        flarySubagentParentThreadId: ref.threadId,
        flaryModelPolicy: modelPolicyMetadata(child),
        flaryDelegation: delegationMetadata(child),
        flaryCompaction: { ...(child.definition.compaction ?? { mode: "auto" }) },
        flaryLimits: { ...(child.definition.limits ?? {}) },
      };
    } else if (input.action === "send") {
      value.fromThreadId = ref.threadId;
      value.requestId = value.requestId ?? `request_${crypto.randomUUID()}`;
    } else if (
      input.action === "interrupt" ||
      input.action === "close" ||
      input.action === "resume"
    ) {
      value.requestId = value.requestId ?? `request_${crypto.randomUUID()}`;
    }

    return service.subagentAction(rootTarget, input.action, value);
  }

  /** True when this app has a Flue-backed durable host. */
  hasDurableRuntime(): boolean {
    return this.#runServiceOverride !== undefined;
  }

  private configuredRunService(): FlaryAppOptions<TBindings>["runService"] {
    return this.#runServiceOverride;
  }

  /** Define a Zod-backed native or prompt-backed callable function. */
  fn<
    TInput extends FlarySchema,
    TOutput extends FlarySchema,
  >(
    definition: FlaryFunctionOptions<TInput, TOutput, TBindings>,
  ): FlaryFunction<TInput, TOutput, TBindings> {
    validateFunctionDefinition(definition);
    if (typeof definition.run !== "function" && definition.prompt === undefined) {
      throw new FlaryFunctionError(
        "function_implementation_missing",
        "A Flary function needs exactly one prompt or run implementation.",
        400,
      );
    }
    if (typeof definition.run === "function" && definition.prompt !== undefined) {
      throw new FlaryFunctionError(
        "function_implementation_ambiguous",
        "A Flary function cannot define both prompt and run.",
        400,
      );
    }

    const state: FunctionState = {
      app: this,
      definition: definition as FlaryFunctionOptions<any, any, any>,
      mode: typeof definition.run === "function" ? "run" : "prompt",
      ...(definition.name ? { functionId: definition.name } : {}),
      invoke: async (input, invocation) =>
        this.invokeDefinition(definition as FlaryFunctionOptions<any, any, any>, input, {
          bindings:
            invocation?.bindings === undefined
              ? this.defaultBindings()
              : invocation.bindings,
          identity: invocation?.identity,
          request: invocation?.request,
          signal: invocation?.signal ?? new AbortController().signal,
          runId: invocation?.runId,
          idempotencyKey: invocation?.idempotencyKey,
          stepCache: invocation?.stepCache ?? new Map(),
        }),
    };

    const callable = (async (input: FlaryInput<TInput>) => {
      if (this.hasDurableRuntime()) {
        const run = await this.startState(state, input);
        return run.result();
      }
      return state.invoke(input);
    }) as FlaryFunction<TInput, TOutput, TBindings> & {
      [FUNCTION_STATE]?: FunctionState;
    };
    Object.defineProperties(callable, {
      input: { value: definition.input, enumerable: true },
      output: { value: definition.output, enumerable: true },
      mode: { value: state.mode, enumerable: true },
      definition: { value: definition, enumerable: true },
      [FUNCTION_STATE]: { value: state },
    });
    callable.start = (
      input: FlaryInput<TInput>,
      options: FlaryRunOptions = {},
    ) => this.startState(state, input, options) as Promise<FlaryRun<z.output<TOutput>>>;
    callable.stream = (
      input: FlaryInput<TInput>,
      options: FlaryRunOptions = {},
    ) => this.streamState(state, input, options) as AsyncIterable<FlaryEvent<z.output<TOutput>>>;
    return callable;
  }

  /** Define a persistent interactive agent. Flue remains its transcript owner. */
  agent(definition: FlaryAgentOptions<TBindings>): FlaryAgent<TBindings> {
    assertNamespace(definition.name);
    validateAgentDefinition(definition);
    const value = {
      kind: "agent" as const,
      name: definition.name,
      definition: Object.freeze({ ...definition }),
      revision: stableRevision({
        name: definition.name,
        model: definition.model ?? this.options.model,
        models: definition.models,
        thinking: definition.thinking,
        mode: definition.mode,
        tools: definition.tools?.descriptors ?? [],
        skills: definition.skills?.map((skill) => ({
          name: skill.name,
          revision: skill.revision,
        })),
        subagents: Object.keys(definition.subagents ?? {}).sort(),
        delegation: definition.delegation,
        compaction: definition.compaction,
        limits: definition.limits,
      }),
    } as FlaryAgent<TBindings> & { [AGENT_STATE]?: AgentState };
    Object.defineProperty(value, AGENT_STATE, {
      value: { app: this, definition },
    });
    return Object.freeze(value);
  }

  /** Define one immutable, lazily discoverable skill revision. */
  skill(input: {
    readonly name: string;
    readonly description?: string;
    readonly instructions: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
  }): FlarySkill {
    assertNamespace(input.name);
    if (!input.instructions.trim()) {
      throw new FlaryFunctionError(
        "skill_instructions_missing",
        "A skill needs instructions.",
        400,
      );
    }
    return Object.freeze({
      kind: "skill" as const,
      ...input,
      revision: stableRevision(input),
    });
  }

  /** Build and validate one lazy tool registry. */
  tools<T extends Readonly<Record<string, FlaryToolSource>>>(
    entries: T,
  ): FlaryToolRegistry & { readonly entries: T } {
    const names = Object.keys(entries);
    const seenNamespaces = new Set<string>();
    for (const name of names) {
      if (!isSafeName(name)) {
        throw new FlaryFunctionError(
          "unsafe_tool_name",
          `Tool name '${name}' is not a safe JavaScript property name.`,
          400,
        );
      }
      const source = entries[name]!;
      if (!source) {
        throw new FlaryFunctionError(
          "invalid_tool_source",
          `Tool '${name}' is empty.`,
          400,
        );
      }
      const namespace = sourceNamespace(source, name);
      assertNamespace(namespace);
      if (seenNamespaces.has(namespace)) {
        throw new FlaryFunctionError(
          "duplicate_tool_namespace",
          `Tool namespace '${namespace}' is already registered.`,
          400,
        );
      }
      seenNamespaces.add(namespace);
    }
    const descriptors = names.map((name) => describeToolSource(name, entries[name]!));
    return Object.freeze({
      kind: "tools" as const,
      entries: Object.freeze({ ...entries }) as T,
      names: Object.freeze(names),
      descriptors: Object.freeze(descriptors),
    });
  }

  /** Register an MCP connection by logical name. */
  mcp(name: string): FlaryMcpSource;
  /** Register an explicit MCP endpoint. */
  mcp(options: Omit<FlaryMcpSource, "kind"> & { namespace: string }): FlaryMcpSource;
  mcp(
    value: string | (Omit<FlaryMcpSource, "kind"> & { namespace: string }),
  ): FlaryMcpSource {
    const source =
      typeof value === "string"
        ? { kind: "mcp" as const, namespace: value, connection: value }
        : { kind: "mcp" as const, ...value };
    assertNamespace(source.namespace);
    if (!source.connection && !source.url) {
      throw new FlaryFunctionError(
        "mcp_connection_missing",
        `MCP source '${source.namespace}' needs a connection or URL.`,
        400,
      );
    }
    return Object.freeze(source);
  }

  /** Register an OpenAPI document. The document remains lazy until execution. */
  openapi(
    options: Omit<FlaryOpenApiSource, "kind"> & { namespace: string },
  ): FlaryOpenApiSource {
    assertNamespace(options.namespace);
    if (typeof options.spec !== "string" && !isRecord(options.spec)) {
      throw new FlaryFunctionError(
        "openapi_spec_invalid",
        `OpenAPI source '${options.namespace}' needs a file, URL, or object.`,
        400,
      );
    }
    return Object.freeze({ kind: "openapi" as const, ...options });
  }

  workspace(options: FlaryWorkspaceOptions = {}): FlaryWorkspaceSource {
    return Object.freeze({ kind: "workspace" as const, options: { ...options } });
  }

  /** Register a tenant-scoped R2 or S3-compatible file source. */
  r2(
    options: Omit<FlaryR2Source, "kind"> & { namespace: string },
  ): FlaryR2Source {
    assertNamespace(options.namespace);
    if (!options.binding && !options.connection) {
      throw new FlaryFunctionError(
        "r2_connection_missing",
        `R2 source '${options.namespace}' needs a binding or connection.`,
        400,
      );
    }
    if (options.prefix !== undefined) {
      validateR2Prefix(options.prefix);
    }
    return Object.freeze({
      kind: "r2" as const,
      ...options,
      access: options.access ?? "read-write",
    });
  }

  sandbox(options: Record<string, unknown> = {}): FlarySandboxSource {
    return Object.freeze({ kind: "sandbox" as const, options: { ...options } });
  }

  browser(options: FlaryBrowserSource["options"] = {}): FlaryBrowserSource {
    const source: FlaryBrowserSource = {
      kind: "browser" as const,
      options: {
        profile: "thread",
        siteAccess: "approval",
        sensitiveActions: "approval",
        uploads: "disabled",
        ...options,
      },
    };
    return Object.freeze(source);
  }

  /**
   * Create Flary's default isolated code runtime with this app's resolvers.
   * Pass the returned value as `code` to a host-specific Flary application,
   * or use it directly in a function runtime.
   */
  codemode(
    options: Omit<FlaryCodemodeExecutorOptions<TBindings>, "resolveMcp" | "resolveOpenApi">,
  ) {
    return createFlaryCodemodeExecutor({
      ...options,
      ...(this.options.resolveMcp ? { resolveMcp: this.options.resolveMcp } : {}),
      ...(this.options.resolveOpenApi ? { resolveOpenApi: this.options.resolveOpenApi } : {}),
      ...(this.options.resolveBrowser ? { resolveBrowser: this.options.resolveBrowser } : {}),
    });
  }

  /** Serve a map of finite functions and persistent agents from one Worker. */
  serve<TExports extends Readonly<Record<string, FlaryApplicationExport>>>(
    exports: TExports,
    options: FlaryServeOptions = {},
  ): Hono<{ Bindings: TBindings }> {
    const router = new Hono<{ Bindings: TBindings }>();
    const prefix = normalizePrefix(options.prefix ?? "");
    const functions: Record<string, AnyFunction> = {};
    const agents: Record<string, AnyAgent> = {};
    const functionIds = new Set<string>();
    for (const [exportName, value] of Object.entries(exports)) {
      if (!isSafeName(exportName)) {
        throw new FlaryFunctionError(
          "unsafe_export_name",
          `Export name '${exportName}' is not safe.`,
          400,
        );
      }
      if (isFlaryAgent(value)) {
        if (agents[value.name]) {
          throw new FlaryFunctionError(
            "duplicate_agent_id",
            `Agent id '${value.name}' is already registered.`,
            400,
          );
        }
        agents[value.name] = value;
        continue;
      }
      const state = this.functionState(value, exportName);
      state.functionId ??= exportName;
      if (functionIds.has(state.functionId)) {
        throw new FlaryFunctionError(
          "duplicate_function_id",
          `Function id '${state.functionId}' is already registered.`,
          400,
        );
      }
      functionIds.add(state.functionId);
      functions[exportName] = value;
    }

    router.get(`${prefix}/health`, (context) =>
      context.json({ ok: true, app: this.options.name ?? "flary" }),
    );
    router.get(`${prefix}/functions`, (context) =>
      context.json({ functions: Object.keys(functions) }),
    );
    router.get(`${prefix}/agents`, (context) =>
      context.json({
        agents: Object.values(agents).map((agent) => ({
          name: agent.name,
          description: agent.definition.description,
          revision: agent.revision,
        })),
      }),
    );

    router.post(`${prefix}/functions/:name`, async (context) => {
      const state = this.functionState(functions, context.req.param("name"));
      const input = await readJson(context.req.raw);
      const bindings = this.parseBindings(context.env);
      const identity = await this.authorize(context.req.raw, bindings);
      const output = this.hasDurableRuntime()
        ? await (
            await this.startState(state, input, {
              internal: {
                bindings,
                identity,
                request: context.req.raw,
                waitUntil: executionWaitUntil(context),
              },
            })
          ).result()
        : await state.invoke(input, {
            bindings,
            identity,
            request: context.req.raw,
            signal: new AbortController().signal,
            stepCache: new Map(),
          });
      return context.json({ output });
    });

    router.post(`${prefix}/functions/:name/runs`, async (context) => {
      const state = this.functionState(functions, context.req.param("name"));
      const input = await readJson(context.req.raw);
      const bindings = this.parseBindings(context.env);
      const identity = await this.authorize(context.req.raw, bindings);
      const requestId = context.req.header("x-request-id");
      const idempotencyKey = context.req.header("idempotency-key");
      const run = await this.startState(state, input, {
        ...(requestId ? { requestId } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
        internal: {
          bindings,
          identity,
          request: context.req.raw,
          waitUntil: executionWaitUntil(context),
        },
      });
      return context.json(
        { runId: run.runId, status: run.status },
        202,
      );
    });

    router.get(`${prefix}/functions/:name/runs/:runId`, async (context) => {
      const state = this.functionState(functions, context.req.param("name"));
      const run = await this.serviceRunForRequest(
        state,
        context.req.param("runId"),
        context.req.raw,
        this.parseBindings(context.env),
      );
      return runResponse(run);
    });

    router.post(
      `${prefix}/functions/:name/runs/:runId/cancel`,
      async (context) => {
        const state = this.functionState(functions, context.req.param("name"));
        const run = await this.serviceRunForRequest(
          state,
          context.req.param("runId"),
          context.req.raw,
          this.parseBindings(context.env),
        );
        const body = await readOptionalJson(context.req.raw);
        const reason = isRecord(body) && typeof body.reason === "string"
          ? body.reason
          : undefined;
        await run.cancel(reason);
        return context.json({ runId: run.runId, status: run.status }, 202);
      },
    );

    router.post(
      `${prefix}/functions/:name/runs/:runId/input`,
      async (context) => {
        const state = this.functionState(functions, context.req.param("name"));
        const run = await this.serviceRunForRequest(
          state,
          context.req.param("runId"),
          context.req.raw,
          this.parseBindings(context.env),
        );
        const body = await readJson(context.req.raw);
        const value = isRecord(body) && "input" in body ? body.input : body;
        const idempotencyKey =
          isRecord(body) && typeof body.idempotencyKey === "string"
            ? body.idempotencyKey
            : undefined;
        await run.sendInput(value, {
          ...(idempotencyKey ? { idempotencyKey } : {}),
        });
        return context.json({ runId: run.runId, status: run.status }, 202);
      },
    );

    router.get(
      `${prefix}/functions/:name/runs/:runId/approvals`,
      async (context) => {
        const state = this.functionState(functions, context.req.param("name"));
        const run = await this.serviceRunForRequest(
          state,
          context.req.param("runId"),
          context.req.raw,
          this.parseBindings(context.env),
        );
        return context.json({ approvals: await run.approvals() });
      },
    );

    router.post(
      `${prefix}/functions/:name/runs/:runId/approvals/:approvalId`,
      async (context) => {
        const state = this.functionState(functions, context.req.param("name"));
        const run = await this.serviceRunForRequest(
          state,
          context.req.param("runId"),
          context.req.raw,
          this.parseBindings(context.env),
        );
        const input = z.object({
          status: z.enum(["approved", "rejected"]),
          comment: z.string().trim().min(1).max(4_096).optional(),
          metadata: z.record(z.string(), z.unknown()).optional(),
        }).strict().parse(await readJson(context.req.raw));
        const decision = input.status === "approved" ? run.approve : run.reject;
        await decision(context.req.param("approvalId"), {
          ...(input.comment ? { comment: input.comment } : {}),
          ...(input.metadata ? { metadata: input.metadata } : {}),
        });
        return context.json({ runId: run.runId, status: run.status }, 202);
      },
    );

    router.get(
      `${prefix}/functions/:name/runs/:runId/user-input`,
      async (context) => {
        const state = this.functionState(functions, context.req.param("name"));
        const run = await this.serviceRunForRequest(
          state,
          context.req.param("runId"),
          context.req.raw,
          this.parseBindings(context.env),
        );
        return context.json({ requests: await run.userInput() });
      },
    );

    router.post(
      `${prefix}/functions/:name/runs/:runId/user-input/:requestId`,
      async (context) => {
        const state = this.functionState(functions, context.req.param("name"));
        const run = await this.serviceRunForRequest(
          state,
          context.req.param("runId"),
          context.req.raw,
          this.parseBindings(context.env),
        );
        await run.respond(
          context.req.param("requestId"),
          z.object({
            answers: z.record(z.string(), z.string().max(100_000)).default({}),
            response: z.string().max(100_000).optional(),
            canceled: z.boolean().default(false),
            metadata: z.record(z.string(), z.unknown()).optional(),
          }).strict().parse(await readJson(context.req.raw)),
        );
        return context.json({ runId: run.runId, status: run.status }, 202);
      },
    );

    router.get(`${prefix}/runs/:runId`, async (context) => {
      if (this.hasDurableRuntime()) {
        throw new FlaryFunctionError(
          "function_scope_required",
          "Use the function-scoped durable run route.",
          404,
        );
      }
      const store = this.runStore as FlaryAppOptions<TBindings>["runStore"] & {
        get?: (runId: string) => FlaryRun | Promise<FlaryRun | undefined>;
      };
      const run = await store?.get?.(context.req.param("runId"));
      if (!run) {
        throw new FlaryFunctionError(
          "run_not_found",
          "The requested Flary run was not found.",
          404,
        );
      }
      await this.authorize(
        context.req.raw,
        this.parseBindings(context.env),
      );
      const status = run.status;
      if (status === "completed") {
        return context.json({ runId: run.runId, status, result: await run.result() });
      }
      if (status === "failed" || status === "cancelled") {
        try {
          await run.result();
        } catch (cause) {
          return context.json({
            runId: run.runId,
            status,
            error: { code: "flary_function_failed", message: cause instanceof Error ? cause.message : "The function failed" },
          });
        }
      }
      return context.json({ runId: run.runId, status });
    });

    router.post(`${prefix}/runs/:runId/cancel`, async (context) => {
      if (this.hasDurableRuntime()) {
        throw new FlaryFunctionError(
          "function_scope_required",
          "Use the function-scoped durable run route.",
          404,
        );
      }
      const store = this.runStore as FlaryAppOptions<TBindings>["runStore"] & {
        get?: (runId: string) => FlaryRun | Promise<FlaryRun | undefined>;
      };
      const run = await store?.get?.(context.req.param("runId"));
      if (!run) {
        throw new FlaryFunctionError(
          "run_not_found",
          "The requested Flary run was not found.",
          404,
        );
      }
      await this.authorize(
        context.req.raw,
        this.parseBindings(context.env),
      );
      await run.cancel("Cancelled by the client");
      return context.json({ runId: run.runId, status: run.status });
    });

    if (Object.keys(agents).length > 0) {
      router.route(
        prefix || "/",
        createFlaryHostRouter<TBindings>({
          authorize: async ({ request, env, appId }) => {
            if (!agents[appId]) {
              throw new FlaryHostError(404, "agent_not_found", "The agent was not found.");
            }
            const identity = await this.authorize(request, this.parseBindings(env));
            if (!identity) {
              throw new FlaryHostError(
                401,
                "authentication_required",
                "This agent requires an authenticated identity.",
              );
            }
            return {
              organizationId: identity.tenantId,
              actor: {
                id: identity.userId ?? identity.tenantId,
                kind: identity.userId ? "user" : "service",
              },
              roles: [...(identity.roles ?? [])],
              scopes: [...(identity.scopes ?? [])],
            };
          },
          service: (env) => {
            // Resolve this at request time. A generated Cloudflare host calls
            // app.serve() once while it imports the authored module, then
            // attaches the Durable Object service before the first request.
            const threadService = this.#threadServiceOverride;
            if (!threadService) {
              throw new FlaryFunctionError(
                "thread_service_missing",
                "Persistent agents need the generated durable thread service.",
                500,
              );
            }
            return agentAwareThreadService(
              resolveThreadService(threadService, {
                bindings: this.parseBindings(env),
              }),
              agents,
            );
          },
        }),
      );
    }

    router.onError((error, context) => {
      if (error instanceof FlaryHostError) {
        return context.json(
          { error: { type: error.code, message: error.message } },
          error.status as 400,
        );
      }
      if (error instanceof FlaryFunctionError) {
        return context.json(
          { error: { type: error.code, message: error.message } },
          error.status as 400,
        );
      }
      if (error instanceof ZodError) {
        return context.json(
          {
            error: {
              type: "invalid_input",
              message: "The function input is invalid.",
              details: error.issues,
            },
          },
          400,
        );
      }
      throw error;
    });
    return router;
  }

  /** Resolve a function state for integrations such as a code executor. */
  functionState(value: unknown, name = "function"): FunctionState {
    const candidate =
      isRecord(value) && name in value
        ? value[name]
        : value;
    const state = getFunctionState(candidate);
    if (!state) {
      throw new FlaryFunctionError(
        "function_not_found",
        `Flary function '${name}' was not registered.`,
        404,
      );
    }
    return state;
  }

  /**
   * Execute the native body of a function from its generated Flue workflow.
   *
   * This method does not admit another run. Flue already owns the active run.
   */
  async invokeFromWorkflow(
    value: unknown,
    invocation: FlaryWorkflowInvocation,
  ): Promise<unknown> {
    const state = this.functionState(value);
    if (state.mode !== "run") {
      throw new FlaryFunctionError(
        "workflow_function_mode_invalid",
        "Only native functions can use direct workflow invocation.",
        500,
      );
    }
    return state.invoke(invocation.input, {
      bindings: invocation.bindings,
      signal: invocation.signal ?? new AbortController().signal,
      runId: invocation.runId,
      stepStore: await this.defaultStepStore(),
      stepCache: new Map(),
    });
  }

  /** Execute the one model-visible code tool inside a generated Flue workflow. */
  async executeCodeFromWorkflow(
    value: unknown,
    input: {
      readonly code: string;
      readonly runId: string;
      readonly bindings: unknown;
      readonly signal?: AbortSignal;
    },
  ): Promise<unknown> {
    const state = this.functionState(value);
    const tools = state.definition.tools;
    if (!tools) {
      throw new FlaryFunctionError(
        "function_tools_missing",
        "This function has no tool registry.",
        500,
      );
    }
    const bindings = input.bindings as TBindings;
    const context = this.contextFor({
      bindings,
      signal: input.signal ?? new AbortController().signal,
      runId: input.runId,
      stepCache: new Map(),
    });
    const executor = this.options.code ?? await this.defaultCodeExecutor(bindings);
    if (!executor) {
      throw new FlaryFunctionError(
        "code_executor_missing",
        "This function needs the Flary Dynamic Worker executor.",
        500,
      );
    }
    return executor.execute({
      code: input.code,
      bindings,
      tools,
      context,
      limits: state.definition.limits,
    });
  }

  /** Execute the same isolated lazy tool runtime for an interactive agent. */
  async executeAgentCode(
    value: FlaryAgent<TBindings>,
    input: {
      readonly code: string;
      readonly runId: string;
      readonly bindings: TBindings;
      readonly signal?: AbortSignal;
    },
  ): Promise<unknown> {
    const state = getAgentState(value);
    if (!state || state.app !== this || !state.definition.tools) {
      throw new FlaryFunctionError(
        "agent_tools_missing",
        "This agent has no tool registry.",
        500,
      );
    }
    const identity = await this.identityForAgentRun(
      input.bindings,
      input.runId,
    );
    const context = this.contextFor({
      bindings: input.bindings,
      identity,
      signal: input.signal ?? new AbortController().signal,
      runId: input.runId,
      stepCache: new Map(),
    });
    const executor =
      this.options.code ?? await this.defaultCodeExecutor(input.bindings);
    if (!executor) {
      throw new FlaryFunctionError(
        "code_executor_missing",
        "This agent needs the Flary Dynamic Worker executor.",
        500,
      );
    }
    return executor.execute({
      code: input.code,
      bindings: input.bindings,
      tools: state.definition.tools,
      context,
      limits: state.definition.limits,
    });
  }

  async agentApprovalContinuation(
    value: FlaryAgent<TBindings>,
    input: {
      readonly bindings: TBindings;
      readonly runId: string;
      readonly signal?: AbortSignal;
    },
  ): Promise<ApprovalContinuation | undefined> {
    const state = getAgentState(value);
    if (!state?.definition.tools) return undefined;
    const executor =
      this.options.code ?? await this.defaultCodeExecutor(input.bindings);
    if (!executor?.approvalContinuation) return undefined;
    const identity = await this.identityForAgentRun(
      input.bindings,
      input.runId,
    );
    return executor.approvalContinuation({
      bindings: input.bindings,
      tools: state.definition.tools,
      context: this.contextFor({
        bindings: input.bindings,
        identity,
        signal: input.signal ?? new AbortController().signal,
        runId: input.runId,
        stepCache: new Map(),
      }),
    });
  }

  async agentApprovalBridge(
    value: FlaryAgent<TBindings>,
    input: {
      readonly bindings: TBindings;
      readonly runId: string;
      readonly signal?: AbortSignal;
    },
  ): Promise<FlaryCodemodeApprovalBridge | undefined> {
    const state = getAgentState(value);
    if (!state?.definition.tools) return undefined;
    const executor =
      this.options.code ?? await this.defaultCodeExecutor(input.bindings);
    if (!executor?.approvalBridge) return undefined;
    const identity = await this.identityForAgentRun(
      input.bindings,
      input.runId,
    );
    return executor.approvalBridge({
      bindings: input.bindings,
      tools: state.definition.tools,
      context: this.contextFor({
        bindings: input.bindings,
        identity,
        signal: input.signal ?? new AbortController().signal,
        runId: input.runId,
        stepCache: new Map(),
      }),
    });
  }

  /**
   * Create the Flue approval recovery hook for one generated function.
   * Codemode keeps the pending action and replay cursor in its Durable Object
   * facet; this method only supplies the current function catalog and context.
   */
  async approvalContinuationFor(
    value: unknown,
    input: {
      readonly bindings: TBindings;
      readonly runId: string;
      readonly signal?: AbortSignal;
    },
  ): Promise<ApprovalContinuation | undefined> {
    const state = this.functionState(value);
    if (!state.definition.tools) return undefined;
    const executor = this.options.code ?? await this.defaultCodeExecutor(input.bindings);
    if (!executor?.approvalContinuation) return undefined;
    return executor.approvalContinuation({
      bindings: input.bindings,
      tools: state.definition.tools,
      context: this.contextFor({
        bindings: input.bindings,
        signal: input.signal ?? new AbortController().signal,
        runId: input.runId,
        stepCache: new Map(),
      }),
    });
  }

  /**
   * Create the protected agent-route bridge used by the Runtime Durable
   * Object to list and decide Dynamic Worker approvals. The bridge reads the
   * Codemode journal from the current Flue agent Durable Object.
   */
  async approvalBridgeFor(
    value: unknown,
    input: {
      readonly bindings: TBindings;
      readonly runId: string;
      readonly signal?: AbortSignal;
    },
  ): Promise<FlaryCodemodeApprovalBridge | undefined> {
    const state = this.functionState(value);
    if (!state.definition.tools) return undefined;
    const executor = this.options.code ?? await this.defaultCodeExecutor(input.bindings);
    if (!executor?.approvalBridge) return undefined;
    return executor.approvalBridge({
      bindings: input.bindings,
      tools: state.definition.tools,
      context: this.contextFor({
        bindings: input.bindings,
        signal: input.signal ?? new AbortController().signal,
        runId: input.runId,
        stepCache: new Map(),
      }),
    });
  }

  /** Validate a generated Flue workflow result with the function Zod schema. */
  parseWorkflowOutput(value: unknown, output: unknown): unknown {
    return this.functionState(value).definition.output.parse(output);
  }

  private async identityForAgentRun(
    bindings: TBindings,
    runId: string,
  ): Promise<FlaryIdentity | undefined> {
    const configured = this.#threadServiceOverride;
    if (!configured) return undefined;
    const ref = parseThreadName(runId);
    const binding = await resolveThreadService(configured, { bindings }).inspect({
      authorization: {
        organizationId: ref.organizationId,
        actor: { id: "flary-agent", kind: "service" },
      },
      appId: ref.appId,
      threadId: ref.threadId,
    });
    return {
      tenantId: binding.thread.organizationId,
      userId: binding.createdBy.id,
      roles: Array.isArray(binding.metadata?.flaryAdmittedRoles)
        ? binding.metadata.flaryAdmittedRoles.filter(
            (role): role is string => typeof role === "string",
          )
        : [],
      scopes: Array.isArray(binding.metadata?.flaryAdmittedScopes)
        ? binding.metadata.flaryAdmittedScopes.filter(
            (scope): scope is string => typeof scope === "string",
          )
        : [],
      applicationId: binding.workspace.appId,
      projectId: binding.workspace.projectId,
      workspaceId: binding.workspace.workspaceId,
      branch: binding.workspace.branch,
    };
  }

  private defaultBindings(): TBindings {
    if (this.options.defaultBindings !== undefined) {
      return this.options.defaultBindings;
    }
    if (this.options.bindings) {
      return this.options.bindings.parse({});
    }
    return undefined as unknown as TBindings;
  }

  private parseBindings(value: unknown): TBindings {
    if (!this.options.bindings) return value as TBindings;
    const parsed = this.options.bindings.parse(value);
    // Zod object schemas strip unknown keys by default. Keep the validated
    // view, but also retain host bindings that are added by Flary's generated
    // Cloudflare host (Durable Objects, D1, R2, queues, and loaders). Without
    // this merge, an authored binding schema can remove the services needed by
    // the generated runtime before it receives the request.
    if (isRecord(value) && isRecord(parsed)) {
      return { ...value, ...parsed } as TBindings;
    }
    return parsed;
  }

  private async authorize(
    request: Request,
    bindings: TBindings,
  ): Promise<FlaryIdentity | undefined> {
    if (!this.options.auth) return this.options.defaultIdentity;
    const identity = await this.options.auth({ request, bindings });
    if (!identity) {
      throw new FlaryFunctionError(
        "unauthorized",
        "The request is not authenticated.",
        401,
      );
    }
    return identity;
  }

  private async startState(
    state: FunctionState,
    input: unknown,
    options: FlaryRunOptions & {
      readonly internal?: Partial<Invocation<TBindings>>;
    } = {},
  ): Promise<FlaryRun<unknown>> {
    // Parse before a run is admitted. This gives callers a fast, deterministic
    // validation error and prevents invalid input from entering the run store.
    const parsedInput = state.definition.input.parse(input);
    const internal = options.internal;
    const bindings =
      internal?.bindings === undefined
        ? this.defaultBindings()
        : internal.bindings;
    const identity = internal?.identity ?? this.options.defaultIdentity;

    if (this.hasDurableRuntime()) {
      const functionId = state.functionId;
      if (!functionId) {
        throw new FlaryFunctionError(
          "function_id_missing",
          "A Flue-backed function needs a stable name or must be registered with app.serve().",
          500,
        );
      }
      const invocation: Invocation<TBindings> = {
        bindings,
        identity,
        request: internal?.request,
        signal: options.signal ?? new AbortController().signal,
        idempotencyKey: options.idempotencyKey,
        waitUntil: internal?.waitUntil,
        stepCache: new Map(),
      };
      const prompt = state.mode === "prompt"
      ? await this.renderPrompt(state.definition, parsedInput, invocation)
        : undefined;
      const revision = await this.functionRevision(
        state,
        prompt,
        bindings,
        identity,
        invocation,
      );
      const trusted = await this.resolveTrustedContext({
        state,
        revision,
        bindings,
        identity,
        request: internal?.request,
      });
      const service = this.resolveRunService({
        bindings,
        request: internal?.request,
        waitUntil: internal?.waitUntil,
      });
      const requestId = IdentifierSchema.parse(
        options.requestId ?? `request_${crypto.randomUUID()}`,
      );
      const metadata = ContractJsonObjectSchema.parse({
        ...(options.metadata ?? {}),
        flaryFunction: revision,
        ...(state.definition.limits
          ? { flaryLimits: state.definition.limits }
          : {}),
        ...(state.definition.delegation
          ? { flaryDelegation: state.definition.delegation }
          : {}),
      });
      const request = CreateRunRequestSchema.parse({
        requestId,
        channelId: functionId,
        input: state.mode === "prompt" ? prompt! : parsedInput,
        execution: state.mode === "prompt" ? "agent" : "workflow",
        ...(options.idempotencyKey
          ? { idempotencyKey: options.idempotencyKey }
          : {}),
        requestedAt: new Date().toISOString(),
        metadata,
      });
      const handle = await service.create(trusted, request);
      return createFlueBackedFlaryRun({
        service,
        trusted,
        runId: handle.runId,
        initialStatus: handle.status,
        parseOutput: (value) =>
          parseDurableOutput(state.definition.output, value),
      });
    }

    const ephemeral =
      this.options.runs?.mode === "ephemeral" || this.options.runtime === "local";
    if (!ephemeral) {
      throw new FlaryFunctionError(
        "durable_host_required",
        "A durable Flary function host is not attached. Run the generated Cloudflare host or set runs: { mode: 'ephemeral' } for tests only.",
        503,
      );
    }

    const runName = state.definition.name ?? "function";
    const id =
      options.idempotencyKey ?? options.requestId ?? makeRunId(runName);
    return this.runStore.create({
      runId: id,
      execute: (signal) =>
        state.invoke(parsedInput, {
          bindings,
          identity,
          request: internal?.request,
          signal: options.signal ?? signal,
          runId: id,
          idempotencyKey: options.idempotencyKey,
          stepCache: new Map(),
        }),
    });
  }

  private async renderPrompt(
    definition: FlaryFunctionOptions<any, any, any>,
    input: unknown,
    invocation: Invocation<TBindings>,
  ): Promise<string> {
    if (definition.prompt === undefined) {
      throw new FlaryFunctionError(
        "prompt_missing",
        "The prompt-backed function has no prompt.",
        500,
      );
    }
    return typeof definition.prompt === "function"
      ? definition.prompt(input, this.contextFor(invocation, definition.limits?.steps))
      : definition.prompt;
  }

  private async functionRevision(
    state: FunctionState,
    prompt: string | undefined,
    bindings: TBindings,
    identity: FlaryIdentity | undefined,
    invocation: Invocation<TBindings>,
    resolveSources = true,
  ): Promise<FlaryFunctionRevision> {
    const functionId = state.functionId ?? state.definition.name;
    if (!functionId) {
      throw new FlaryFunctionError(
        "function_id_missing",
        "The function needs a stable id before revision admission.",
        500,
      );
    }
    const inputSchema = toJsonSchema(state.definition.input) ?? {};
    const outputSchema = toJsonSchema(state.definition.output) ?? {};
    const inputSchemaHash = await sha256Hex(stableJson(inputSchema));
    const outputSchemaHash = await sha256Hex(stableJson(outputSchema));
    const sourceRevisions: Record<string, string> = {};
    const connectionGrants = new Set<string>();

    for (const name of state.definition.tools?.names ?? []) {
      const source = state.definition.tools!.entries[name]!;
      if (typeof source === "function") {
        sourceRevisions[name] = await sha256Hex(
          stableJson(describeToolSource(name, source)),
        );
        continue;
      }
      if ("connection" in source && source.connection) {
        connectionGrants.add(source.connection);
      }
      if (!resolveSources) {
        sourceRevisions[name] = await sha256Hex(stableJson(source));
        continue;
      }
      if (source.kind === "openapi") {
        const runtime = this.options.resolveOpenApi
          ? await this.options.resolveOpenApi(source, {
              bindings,
              context: this.contextFor(invocation),
            })
          : await createOpenApiRuntime(source);
        sourceRevisions[name] =
          runtime.revision ?? await openApiRevision(runtime.spec);
        continue;
      }
      if (source.kind === "mcp") {
        const connection = this.options.resolveMcp
          ? await this.options.resolveMcp(source, {
              bindings,
              context: this.contextFor(invocation),
            })
          : source.url
            ? createMcpConnection(source)
            : undefined;
        if (!connection) {
          throw new FlaryFunctionError(
            "mcp_revision_unavailable",
            `MCP source '${source.namespace}' must resolve before durable admission.`,
            500,
          );
        }
        const descriptors =
          connection.tools ?? await connection.fetchTools?.() ?? [];
        sourceRevisions[name] =
          connection.revision ?? await sha256Hex(stableJson(descriptors));
        continue;
      }
      sourceRevisions[name] = await sha256Hex(stableJson(source));
    }

    const promptHash = prompt === undefined
      ? undefined
      : await sha256Hex(prompt);
    const toolRegistryRevision = state.definition.tools
      ? await sha256Hex(stableJson({
          descriptors: state.definition.tools.descriptors ?? [],
          sources: sourceRevisions,
        }))
      : undefined;
    const model = state.definition.model ?? this.options.model;
    const staticBuild = {
      functionId,
      mode: state.mode,
      implementation:
        typeof state.definition.run === "function"
          ? state.definition.run.toString()
          : typeof state.definition.prompt === "function"
            ? state.definition.prompt.toString()
            : state.definition.prompt,
      inputSchemaHash,
      outputSchemaHash,
      toolRegistryRevision,
      sourceRevisions,
      model,
      thinking: state.definition.thinking,
      operationalMode: state.definition.mode,
      durable: state.definition.durable,
      limits: state.definition.limits,
      delegation: state.definition.delegation,
      subagents: Object.keys(state.definition.subagents ?? {}).sort(),
    };
    const buildHash = await sha256Hex(stableJson(staticBuild));
    return Object.freeze({
      functionId,
      buildHash,
      ...(promptHash ? { promptHash } : {}),
      inputSchemaHash,
      outputSchemaHash,
      ...(toolRegistryRevision ? { toolRegistryRevision } : {}),
      sourceRevisions: Object.freeze({ ...sourceRevisions }),
      ...(model ? { model } : {}),
      ...(state.definition.thinking
        ? { thinking: state.definition.thinking }
        : {}),
      ...(state.definition.mode ? { mode: state.definition.mode } : {}),
      connectionGrants: Object.freeze([...connectionGrants].sort()),
    });
  }

  private resolveRunService(input: {
    readonly bindings: TBindings;
    readonly request?: Request;
    readonly waitUntil?: (work: Promise<unknown>) => void;
  }): FlaryRunService {
    const configured = this.configuredRunService();
    if (!configured) {
      throw new FlaryFunctionError(
        "flue_runtime_missing",
        "The Flue run service is not configured.",
        500,
      );
    }
    return typeof configured === "function"
      ? configured(input)
      : configured;
  }

  private async resolveTrustedContext(input: {
    readonly state: FunctionState;
    readonly revision: FlaryFunctionRevision;
    readonly bindings: TBindings;
    readonly identity?: FlaryIdentity;
    readonly request?: Request;
    readonly runId?: string;
  }): Promise<TrustedRunContext> {
    const functionId = input.state.functionId ?? input.revision.functionId;
    if (this.options.resolveRunContext) {
      return TrustedRunContextSchema.parse(
        await this.options.resolveRunContext({
          bindings: input.bindings,
          request: input.request,
          identity: input.identity,
          functionId,
          revision: input.revision,
          runId: input.runId,
        }),
      );
    }
    const identity = input.identity;
    if (!identity?.tenantId) {
      throw new FlaryFunctionError(
        "trusted_identity_missing",
        "A Flue-backed function run needs an authenticated tenant identity.",
        401,
      );
    }
    const applicationId =
      identity.applicationId ??
      this.options.applicationId ??
      this.options.name ??
      "flary";
    return TrustedRunContextSchema.parse({
      tenantId: identity.tenantId,
      applicationId,
      projectId: identity.projectId ?? this.options.projectId,
      agentId: functionId,
      revisionId: input.revision.buildHash,
      identity: {
        id: identity.userId ?? `service_${applicationId}`,
        kind: identity.userId ? "user" : "service",
        version: "1",
      },
      roles: identity.roles ?? [],
      scopes: identity.scopes ?? [],
      metadata: {
        flaryFunction: input.revision,
      },
    });
  }

  private async serviceRunForRequest(
    state: FunctionState,
    runId: string,
    request: Request,
    bindings: TBindings,
  ): Promise<FlaryRun<unknown>> {
    if (!this.hasDurableRuntime()) {
      throw new FlaryFunctionError(
        "flue_runtime_missing",
        "This function does not use the Flue run service.",
        404,
      );
    }
    const identity = await this.authorize(request, bindings);
    const invocation: Invocation<TBindings> = {
      bindings,
      identity,
      request,
      signal: request.signal,
      stepCache: new Map(),
    };
    const revision = await this.functionRevision(
      state,
      undefined,
      bindings,
      identity,
      invocation,
      false,
    );
    const trusted = await this.resolveTrustedContext({
      state,
      revision,
      bindings,
      identity,
      request,
      runId,
    });
    const service = this.resolveRunService({ bindings, request });
    const current = await service.get(trusted, runId);
    return createFlueBackedFlaryRun({
      service,
      trusted,
      runId,
      initialStatus: current.status,
      parseOutput: (value) =>
        parseDurableOutput(state.definition.output, value),
    });
  }

  private streamState(
    state: FunctionState,
    input: unknown,
    options: FlaryRunOptions,
  ): AsyncIterable<FlaryEvent<unknown>> {
    const start = this.startState(state, input, options);
    return (async function* () {
      const run = await start;
      yield* run.stream({ signal: options.signal });
    })();
  }

  private async invokeDefinition(
    definition: FlaryFunctionOptions<any, any, any>,
    input: unknown,
    invocation: Invocation<any>,
  ): Promise<unknown> {
    const parsedInput = definition.input.parse(input);
    const context = this.contextFor(invocation, definition.limits?.steps);
    let value: unknown;
    if (typeof definition.run === "function") {
      value = await definition.run(parsedInput, context);
    } else {
      const prompt =
        typeof definition.prompt === "function"
          ? await definition.prompt(parsedInput, context)
          : definition.prompt;
      value = await this.runPrompt(definition, prompt, context);
    }
    return definition.output.parse(value);
  }

  private contextFor(
    invocation: Invocation<any>,
    stepLimit?: number,
  ): FlaryStepContext<any> {
    return {
      bindings: invocation.bindings,
      identity: invocation.identity,
      signal: invocation.signal,
      runId: invocation.runId,
      idempotencyKey: invocation.idempotencyKey,
      step: async <TInput, TOutput>(
        name: string,
        fn: FlaryCallableLike<TInput, TOutput>,
        input: TInput,
      ) => {
        if (!isSafeName(name)) {
          throw new FlaryFunctionError(
            "unsafe_step_name",
            `Step name '${name}' is not safe.`,
            400,
          );
        }
        const target = getFunctionState(fn);
        if (!target) {
          throw new FlaryFunctionError(
            "invalid_step_function",
            `Step '${name}' must use a Flary function.`,
            400,
          );
        }
        const key = `${invocation.runId ?? "local"}:${name}`;
        const inputKey = stableJson(input);
        const prior = invocation.stepCache.get(key);
        if (prior) {
          if (prior.input !== inputKey) {
            throw new FlaryFunctionError(
              "step_input_changed",
              `Step '${name}' received different input during replay.`,
              409,
            );
          }
          return prior.value as Promise<TOutput>;
        }
        if (stepLimit !== undefined && invocation.stepCache.size >= stepLimit) {
          throw new FlaryFunctionError(
            "function_step_limit",
            `The function exceeded its ${stepLimit} step limit.`,
            408,
          );
        }
        const stepStore = invocation.stepStore ?? this.stepStore;
        if (invocation.runId && stepStore) {
          const durable = await stepStore.get({
            runId: invocation.runId,
            name,
          });
          if (durable) {
            if (durable.inputHash !== inputKey) {
              throw new FlaryFunctionError(
                "step_input_changed",
                `Step '${name}' received different input during replay.`,
                409,
              );
            }
            const restored = Promise.resolve(
              target.definition.output.parse(durable.value),
            ) as Promise<TOutput>;
            invocation.stepCache.set(key, { input: inputKey, value: restored });
            return restored;
          }
        }
        const value = target.invoke(input, {
          bindings: invocation.bindings,
          identity: invocation.identity,
          request: invocation.request,
          signal: invocation.signal,
          runId: invocation.runId,
          idempotencyKey: invocation.idempotencyKey
            ? `${invocation.idempotencyKey}_${name}`
            : undefined,
          stepStore: invocation.stepStore,
          stepCache: invocation.stepCache,
        });
        const persisted = stepStore && invocation.runId
          ? value.then(async (result) => {
              await stepStore.put({
                runId: invocation.runId!,
                name,
                inputHash: inputKey,
                value: result,
              });
              return result;
            })
          : value;
        invocation.stepCache.set(key, { input: inputKey, value: persisted });
        return persisted as Promise<TOutput>;
      },
      log: {
        info: (message, attributes) => log("info", message, attributes),
        warn: (message, attributes) => log("warn", message, attributes),
        error: (message, attributes) => log("error", message, attributes),
      },
    };
  }

  private async runPrompt(
    definition: FlaryFunctionOptions<any, any, any>,
    prompt: string,
    context: FlaryStepContext<any>,
  ): Promise<unknown> {
    if (this.options.prompt) {
      return this.options.prompt({
        model: definition.model ?? this.options.model ?? "openai/gpt-5",
        prompt,
        output: definition.output,
        tools: definition.tools,
        context: context as FlaryPromptRequest["context"],
      });
    }
    const codeExecutor = this.options.code ?? await this.defaultCodeExecutor(context.bindings);
    if (definition.tools && !codeExecutor) {
      throw new FlaryFunctionError(
        "code_executor_missing",
        "This prompt function has tools, but the application has no code executor. Configure a Flary Dynamic Worker executor.",
        500,
      );
    }
    const model = definition.model ?? this.options.model ?? "openai/gpt-5";
    const selection = parseFlueModelSpecifier(model);
    const modelName = selection?.model ?? model;
    const adapter = this.resolveAdapter(selection?.provider ?? providerFromModel(model), context.bindings);
    const messages: ProviderMessage[] = [{ role: "user", content: prompt }];
    const executeTool = definition.tools
      ? {
          name: "execute",
          description: executeToolDescription(definition.tools),
          inputSchema: {
            type: "object",
            properties: { code: { type: "string" } },
            required: ["code"],
            additionalProperties: false,
          },
        }
      : undefined;
    const maxSteps = Math.max(
      1,
      definition.limits?.steps ?? this.options.maxPromptSteps ?? 20,
    );

    for (let step = 0; step < maxSteps; step += 1) {
      const request: NormalizedModelRequest = {
        model: modelName,
        messages,
        ...(executeTool ? { tools: [executeTool], toolChoice: "auto" as const } : {}),
        ...(definition.thinking && ReasoningEffortSchema.safeParse(definition.thinking).success
          ? { reasoningEffort: definition.thinking as NormalizedModelRequest["reasoningEffort"] }
          : {}),
        ...(isStringSchema(definition.output)
          ? { responseFormat: "text" as const }
          : {
              responseFormat: {
                type: "json_object" as const,
                schema: JsonObjectSchema.parse(z.toJSONSchema(definition.output)),
              },
            }),
      };
      const response = await adapter.complete(request, {
        signal: context.signal,
      });
      if (response.toolCalls.length === 0) {
        return parseModelOutput(definition.output, response.content);
      }
      messages.push({
        role: "assistant",
        content: response.content,
        toolCalls: response.toolCalls,
      });
      if (!codeExecutor || !definition.tools) {
        throw new FlaryFunctionError(
          "unexpected_model_tool_call",
          "The model requested a tool, but no tool runtime is configured.",
          500,
        );
      }
      for (const toolCall of response.toolCalls) {
        if (toolCall.name !== "execute") {
          throw new FlaryFunctionError(
            "unknown_model_tool",
            `The model requested unknown tool '${toolCall.name}'.`,
            400,
          );
        }
        const args = z.object({ code: z.string().min(1) }).parse(toolCall.arguments);
        const result = await codeExecutor!.execute({
          code: args.code,
          bindings: context.bindings,
          tools: definition.tools,
          context,
          limits: definition.limits,
        });
        messages.push({
          role: "tool",
          content: stringifyToolResult(result),
          toolCallId: toolCall.id,
        });
      }
    }
    throw new FlaryFunctionError(
      "prompt_step_limit",
      `The prompt function exceeded its ${maxSteps} step limit.`,
      408,
    );
  }

  private resolveAdapter(provider: string, bindings: unknown): ModelAdapter {
    if (this.options.provider) return this.options.provider;
    const configured = this.options.providers?.get(provider) ?? this.options.providers?.get("openai");
    if (configured) return configured;
    const source = isRecord(bindings) ? bindings : undefined;
    if (
      provider === "cloudflare" &&
      source?.AI &&
      typeof source.AI === "object" &&
      "run" in source.AI &&
      typeof source.AI.run === "function"
    ) {
      return new CloudflareWorkersAIAdapter(source.AI as ConstructorParameters<typeof CloudflareWorkersAIAdapter>[0]);
    }
    const apiKey =
      stringValue(source?.OPENAI_API_KEY) ?? environmentValue("OPENAI_API_KEY");
    if (provider === "anthropic") {
      return new AnthropicMessagesAdapter({
        apiKey:
          stringValue(source?.ANTHROPIC_API_KEY) ?? environmentValue("ANTHROPIC_API_KEY"),
        baseUrl: stringValue(source?.ANTHROPIC_BASE_URL),
      });
    }
    return new OpenAICompatibleAdapter({
      apiKey,
      baseUrl:
        stringValue(source?.OPENAI_BASE_URL) ??
        environmentValue("OPENAI_BASE_URL") ??
        "https://api.openai.com/v1",
      provider: provider === "openai" ? "openai" : "custom",
    });
  }

  private async defaultCodeExecutor(bindings: unknown): Promise<FlaryCodeExecutor<TBindings> | undefined> {
    const record = isRecord(bindings) ? bindings : undefined;
    const loader = record?.LOADER ?? record?.WORKER_LOADER;
    if (!loader) return undefined;
    let ctx: FlaryDurableObjectState | undefined;
    try {
      const cloudflare = await import("@flue/runtime/cloudflare");
      const current = cloudflare.getCloudflareContext() as ReturnType<
        typeof cloudflare.getCloudflareContext
      > & { readonly durableObjectState?: FlaryDurableObjectState };
      ctx = current.durableObjectState;
    } catch {
      // Local calls do not have a Cloudflare context. They can still use a
      // supplied application code executor, but the default executor stays
      // fail-closed for durable external tools.
    }
    return createFlaryCodemodeExecutor({
      loader: loader as never,
      ...(ctx ? { ctx } : {}),
      env: bindings,
      resolveMcp: this.options.resolveMcp,
      resolveOpenApi: this.options.resolveOpenApi,
      resolveWorkspace:
        this.options.resolveWorkspace ??
        (ctx ? defaultWorkspaceResolver(this.options, bindings, ctx.storage) : undefined),
      resolveR2:
        this.options.resolveR2 ??
        (ctx
          ? async (source, input) =>
              createR2FileConnection(source, input.bindings, input.context)
          : undefined),
      resolveSandbox:
        this.options.resolveSandbox ??
        (ctx ? defaultSandboxResolver(this.options, bindings) : undefined),
      resolveBrowser:
        this.options.resolveBrowser ??
        (ctx
          ? async (source, input) => createCloudflareBrowserConnection(source, {
              bindings: input.bindings,
              context: input.context,
              storage: input.storage,
            })
          : undefined),
    });
  }

  /** Resolve the current Flue Durable Object as the default named-step store. */
  private async defaultStepStore(): Promise<FlaryStepStore | undefined> {
    if (this.stepStore) return this.stepStore;
    try {
      const cloudflare = await import("@flue/runtime/cloudflare");
      const current = cloudflare.getCloudflareContext();
      const storage = current.storage as { readonly sql?: unknown };
      if (storage.sql && typeof storage.sql === "object") {
        return new SqliteFlaryStepStore(storage.sql as never);
      }
      const kvStorage = current.storage as {
        get?: <T = unknown>(key: string) => Promise<T | undefined>;
        put?: <T = unknown>(key: string, value: T) => Promise<void>;
      };
      if (typeof kvStorage.get !== "function" || typeof kvStorage.put !== "function") {
        return undefined;
      }
      return new DurableObjectFlaryStepStore(kvStorage as {
        get<T = unknown>(key: string): Promise<T | undefined>;
        put<T = unknown>(key: string, value: T): Promise<void>;
      });
    } catch {
      // Local and non-Flue hosts can still provide options.stepStore.
      return undefined;
    }
  }
}

export function flary<TBindings extends object = Record<string, unknown>>(
  options: FlaryAppOptions<TBindings> = {},
): FlaryApplication<TBindings> {
  return new FlaryApplication(options);
}

export function getFunctionState(value: unknown): FunctionState | undefined {
  if (typeof value !== "function") return undefined;
  return (value as { [FUNCTION_STATE]?: FunctionState })[FUNCTION_STATE];
}

/**
 * Return the application that owns an authored function.
 *
 * The Vite integration uses this to attach the generated Durable Object run
 * service without requiring developers to export a second host object.
 */
export function getFunctionApp(
  value: unknown,
): FlaryApplication<any> | undefined {
  return getFunctionState(value)?.app;
}

export function isFlaryAgent(value: unknown): value is FlaryAgent<any> {
  return isRecord(value) &&
    value.kind === "agent" &&
    typeof value.name === "string" &&
    typeof value.revision === "string";
}

export function getAgentState(value: unknown): AgentState | undefined {
  if (!isFlaryAgent(value)) return undefined;
  return (value as FlaryAgent<any> & { [AGENT_STATE]?: AgentState })[
    AGENT_STATE
  ];
}

export function getAgentApp(
  value: unknown,
): FlaryApplication<any> | undefined {
  return getAgentState(value)?.app;
}

function resolveThreadService<TBindings>(
  service: NonNullable<FlaryAppOptions<TBindings>["threadService"]>,
  input: { readonly bindings: TBindings },
): FlaryThreadHostService {
  return typeof service === "function"
    ? service({ bindings: input.bindings })
    : service;
}

function agentAwareThreadService(
  service: FlaryThreadHostService,
  agents: Readonly<Record<string, AnyAgent>>,
): FlaryThreadHostService {
  return new Proxy(service, {
    get(target, property, receiver) {
      if (property === "create") {
        return async (
          scope: Parameters<FlaryThreadHostService["create"]>[0],
          input: Parameters<FlaryThreadHostService["create"]>[1],
        ) => {
          const agent = agents[scope.appId];
          if (!agent) {
            throw new FlaryHostError(
              404,
              "agent_not_found",
              "The agent was not found.",
            );
          }
          const requestedModel = input.model ?? (
            agent.definition.model
              ? parseFlueModelSpecifier(agent.definition.model)
              : agent.definition.models?.allow[0]
                ? normalizeModelInput(agent.definition.models.allow[0])
                : undefined
          );
          if (agent.definition.models?.allow.length && requestedModel) {
            const allowed = agent.definition.models.allow.some((candidate) => {
              const parsed = normalizeModelInput(candidate);
              return parsed.provider === requestedModel.provider &&
                parsed.model === requestedModel.model &&
                parsed.deployment === requestedModel.deployment &&
                parsed.variant === requestedModel.variant;
            });
            if (!allowed) {
              throw new FlaryFunctionError(
                "invalid_agent_model",
                "The selected model is not allowed for this agent.",
                400,
              );
            }
          }
          return target.create(scope, {
            ...input,
            agentId: agent.name,
            model: input.model ?? (
              agent.definition.model
                ? parseFlueModelSpecifier(agent.definition.model)
                : agent.definition.models?.allow[0]
                  ? normalizeModelInput(agent.definition.models.allow[0])
                  : getAgentState(agent)?.app.options.model
                    ? parseFlueModelSpecifier(
                        getAgentState(agent)!.app.options.model!,
                      )
                  : parseFlueModelSpecifier("openai/gpt-5")
            ),
            metadata: {
              ...(input.metadata ?? {}),
              flaryAdmittedRoles: [...(scope.authorization.roles ?? [])],
              flaryAdmittedScopes: [...(scope.authorization.scopes ?? [])],
              flaryRuntimeAgentId: agent.name,
              flaryAgentRevision: agent.revision,
              flaryModelPolicy: modelPolicyMetadata(agent) as never,
              flaryDelegation: delegationMetadata(agent) as never,
              flaryCompaction: {
                ...(agent.definition.compaction ?? { mode: "auto" }),
              },
              flaryLimits: { ...(agent.definition.limits ?? {}) },
            },
          });
        };
      }
      if (property === "subagentAction") {
        return async (
          scope: FlaryThreadTarget,
          action: string,
          input: Readonly<Record<string, unknown>>,
        ) => {
          if (!target.subagentAction) {
            throw new FlaryFunctionError(
              "subagents_unavailable",
              "The durable thread host does not support subagents.",
              501,
            );
          }
          const root = agents[scope.appId];
          if (!root) {
            throw new FlaryHostError(404, "agent_not_found", "The agent was not found.");
          }
          const currentBinding = await target.inspect(scope);
          const current = findAgentInTree(root, currentBinding.agentId);
          if (!current) {
            throw new FlaryFunctionError(
              "subagent_not_declared",
              `Agent '${currentBinding.agentId}' is not declared by '${root.name}'.`,
              400,
            );
          }
          const rootThreadId =
            typeof currentBinding.metadata?.flarySubagentRootThreadId === "string"
              ? currentBinding.metadata.flarySubagentRootThreadId
              : scope.threadId;
          const value: Record<string, unknown> = {
            ...input,
            currentThreadId: scope.threadId,
          };
          if (action === "spawn") {
            const requestedName = String(value.agent ?? value.agentId ?? "");
            const child = findDeclaredChild(current, requestedName);
            if (!child) {
              throw new FlaryFunctionError(
                "subagent_not_declared",
                `Subagent '${requestedName}' is not declared by '${current.name}'.`,
                400,
              );
            }
            value.agentId = child.name;
            value.model = resolveAgentModelSelection(child, value.model);
            value.parentThreadId = scope.threadId;
            value.requestId = value.requestId ?? `request_${crypto.randomUUID()}`;
            value.metadata = {
              ...objectRecord(value.metadata),
              flaryRuntimeAgentId: root.name,
              flaryAgentRevision: child.revision,
              flarySubagentRootThreadId: rootThreadId,
              flarySubagentParentThreadId: scope.threadId,
              flaryModelPolicy: modelPolicyMetadata(child),
              flaryDelegation: delegationMetadata(child),
              flaryCompaction: { ...(child.definition.compaction ?? { mode: "auto" }) },
              flaryLimits: { ...(child.definition.limits ?? {}) },
            };
          } else if (action === "send") {
            value.fromThreadId = scope.threadId;
            value.requestId = value.requestId ?? `request_${crypto.randomUUID()}`;
          }
          return target.subagentAction(
            { ...scope, threadId: rootThreadId },
            action,
            value,
          );
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function stableRevision(value: unknown): string {
  const text = stableJson(value);
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = Math.imul(second ^ code, 0x85ebca6b) >>> 0;
  }
  return `rev_${first.toString(16).padStart(8, "0")}${second
    .toString(16)
    .padStart(8, "0")}`;
}

function validateFunctionDefinition(
  definition: FlaryFunctionOptions<any, any, any>,
): void {
  const positiveInteger = (
    value: number | undefined,
    label: string,
  ): void => {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
      throw new FlaryFunctionError(
        "invalid_function_limit",
        `${label} must be a positive integer.`,
        400,
      );
    }
  };
  positiveInteger(definition.durable?.maxAttempts, "durable.maxAttempts");
  positiveInteger(definition.limits?.steps, "limits.steps");
  positiveInteger(definition.limits?.toolCalls, "limits.toolCalls");
  positiveInteger(definition.limits?.timeoutMs, "limits.timeoutMs");
  if (
    definition.limits?.costUsd !== undefined &&
    (!Number.isFinite(definition.limits.costUsd) || definition.limits.costUsd <= 0)
  ) {
    throw new FlaryFunctionError(
      "invalid_function_limit",
      "limits.costUsd must be a positive finite number.",
      400,
    );
  }
  const duration = definition.durable?.timeout;
  if (
    typeof duration === "number" &&
    (!Number.isFinite(duration) || duration <= 0)
  ) {
    throw new FlaryFunctionError(
      "invalid_function_timeout",
      "durable.timeout must be a positive number or a duration string.",
      400,
    );
  }
  if (
    typeof duration === "string" &&
    !/^\d+(?:ms|s|m|h|d)$/.test(duration.trim())
  ) {
    throw new FlaryFunctionError(
      "invalid_function_timeout",
      "durable.timeout must use ms, s, m, h, or d.",
      400,
    );
  }
  positiveInteger(definition.delegation?.maxConcurrent, "delegation.maxConcurrent");
  positiveInteger(definition.delegation?.maxTotal, "delegation.maxTotal");
  positiveInteger(definition.delegation?.maxDepth, "delegation.maxDepth");
  if (
    definition.delegation?.maxConcurrent !== undefined &&
    definition.delegation.maxTotal !== undefined &&
    definition.delegation.maxConcurrent > definition.delegation.maxTotal
  ) {
    throw new FlaryFunctionError(
      "invalid_delegation_policy",
      "delegation.maxConcurrent cannot exceed delegation.maxTotal.",
      400,
    );
  }
}

function validateAgentDefinition(
  definition: FlaryAgentOptions<unknown>,
): void {
  const positiveInteger = (value: number | undefined, label: string): void => {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
      throw new FlaryFunctionError(
        "invalid_agent_limit",
        `${label} must be a positive integer.`,
        400,
      );
    }
  };
  positiveInteger(definition.delegation?.maxConcurrent, "delegation.maxConcurrent");
  positiveInteger(definition.delegation?.maxTotal, "delegation.maxTotal");
  positiveInteger(definition.delegation?.maxDepth, "delegation.maxDepth");
  positiveInteger(definition.compaction?.reserveTokens, "compaction.reserveTokens");
  positiveInteger(definition.compaction?.thresholdTokens, "compaction.thresholdTokens");
  positiveInteger(definition.limits?.steps, "limits.steps");
  positiveInteger(definition.limits?.toolCalls, "limits.toolCalls");
  positiveInteger(definition.limits?.timeoutMs, "limits.timeoutMs");
  if (
    definition.delegation?.maxConcurrent !== undefined &&
    definition.delegation.maxTotal !== undefined &&
    definition.delegation.maxConcurrent > definition.delegation.maxTotal
  ) {
    throw new FlaryFunctionError(
      "invalid_agent_delegation",
      "delegation.maxConcurrent cannot exceed delegation.maxTotal.",
      400,
    );
  }
  if (
    definition.limits?.costUsd !== undefined &&
    (!Number.isFinite(definition.limits.costUsd) || definition.limits.costUsd <= 0)
  ) {
    throw new FlaryFunctionError(
      "invalid_agent_limit",
      "limits.costUsd must be a positive finite number.",
      400,
    );
  }
  for (const skill of definition.skills ?? []) {
    if (skill.kind !== "skill" || !skill.revision) {
      throw new FlaryFunctionError(
        "invalid_agent_skill",
        `Agent '${definition.name}' has an invalid skill.`,
        400,
      );
    }
  }
  if (definition.models) {
    if (definition.models.allow.length === 0) {
      throw new FlaryFunctionError(
        "invalid_agent_models",
        "models.allow must contain at least one model.",
        400,
      );
    }
    for (const candidate of definition.models.allow) {
      try {
        ModelSelectionSchema.parse(normalizeModelInput(candidate));
      } catch {
        throw new FlaryFunctionError(
          "invalid_agent_model",
          "Every allowed model must use the provider/model form.",
          400,
        );
      }
    }
    const defaultModel = definition.model ?? undefined;
    if (defaultModel) {
      const parsedDefault = parseFlueModelSpecifier(defaultModel);
      if (
        !parsedDefault ||
        !definition.models.allow.some((candidate) => {
          const parsed = normalizeModelInput(candidate);
          return parsed.provider === parsedDefault.provider &&
            parsed.model === parsedDefault.model &&
            parsed.deployment === parsedDefault.deployment &&
            parsed.variant === parsedDefault.variant;
        })
      ) {
        throw new FlaryFunctionError(
          "invalid_agent_model_policy",
          "The agent default model must be present in models.allow.",
          400,
        );
      }
    }
    if (definition.models.compactionModel !== undefined) {
      try {
        ModelSelectionSchema.parse(
          normalizeModelInput(definition.models.compactionModel),
        );
      } catch {
        throw new FlaryFunctionError(
          "invalid_agent_compaction_model",
          "The compaction model must use the provider/model form.",
          400,
        );
      }
    }
  }
}

function sourceNamespace(source: FlaryToolSource, fallback: string): string {
  if (typeof source === "function") {
    return source.definition.name ?? fallback;
  }
  return "namespace" in source ? source.namespace : fallback;
}

function describeToolSource(
  name: string,
  source: FlaryToolSource,
): FlaryToolDescriptor {
  if (typeof source === "function") {
    const definition = source.definition;
    return {
      id: name,
      namespace: definition.name ?? name,
      ...(definition.description ? { description: definition.description } : {}),
      inputSchema: toJsonSchema(definition.input),
      outputSchema: toJsonSchema(definition.output),
      operation: definition.policy?.operation ?? "read",
      capabilities: definition.policy?.capabilities ?? [],
      requiresApproval:
        definition.policy?.requiresApproval ?? definition.policy?.operation === "write",
      ...(definition.policy?.concurrencyKey
        ? { concurrencyKey: definition.policy.concurrencyKey }
        : {}),
      ...(definition.policy?.operation === "write"
        ? { idempotency: "required" as const }
        : {}),
    };
  }
  const operation = source.kind === "sandbox" || source.kind === "workspace" ||
    (source.kind === "r2" && source.access !== "read") ? "write" : "read";
  const namespace = "namespace" in source ? source.namespace : name;
  return {
    id: name,
    namespace,
    description: `${source.kind} tools`,
    tags: [source.kind],
    operation,
    capabilities: [],
    requiresApproval: operation === "write",
    ...(source.kind === "mcp" && source.connection
      ? { connection: source.connection }
      : {}),
    ...(source.kind === "openapi" && source.connection
      ? { connection: source.connection }
      : {}),
    ...(source.kind === "r2" && source.connection
      ? { connection: source.connection }
      : {}),
    ...(operation === "write" ? { idempotency: "required" as const } : {}),
  };
}

function toJsonSchema(schema: FlarySchema): Record<string, unknown> | undefined {
  try {
    return JsonObjectSchema.parse(z.toJSONSchema(schema));
  } catch {
    return undefined;
  }
}

function assertNamespace(value: string): void {
  if (!isSafeName(value)) {
    throw new FlaryFunctionError(
      "unsafe_tool_namespace",
      `Tool namespace '${value}' is not safe.`,
      400,
    );
  }
}

function validateR2Prefix(value: string): void {
  if (value.length > 1_024 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new FlaryFunctionError(
      "r2_prefix_invalid",
      "An R2 prefix must be a short path without control characters.",
      400,
    );
  }
  const normalized = value.replace(/^\/+|\/+$/g, "");
  if (normalized.split("/").some((part) => part === ".." || part === ".")) {
    throw new FlaryFunctionError(
      "r2_prefix_invalid",
      "An R2 prefix cannot contain . or .. path segments.",
      400,
    );
  }
}

function isSafeName(value: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value) &&
    value !== "__proto__" &&
    value !== "constructor" &&
    value !== "prototype";
}

function normalizePrefix(value: string): string {
  if (!value || value === "/") return "";
  return `/${value.replace(/^\/+|\/+$/g, "")}`;
}

async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new FlaryFunctionError(
      "invalid_json",
      "The request body must contain valid JSON.",
      400,
    );
  }
}

async function readOptionalJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new FlaryFunctionError(
      "invalid_json",
      "The request body must contain valid JSON.",
      400,
    );
  }
}

async function runResponse(run: FlaryRun<unknown>): Promise<Response> {
  if (run.status === "completed") {
    return Response.json({
      runId: run.runId,
      status: run.status,
      result: await run.result(),
    });
  }
  if (run.status === "failed" || run.status === "cancelled") {
    try {
      await run.result();
    } catch (cause) {
      return Response.json({
        runId: run.runId,
        status: run.status,
        error: {
          code:
            cause instanceof Error && "code" in cause
              ? String((cause as { code: unknown }).code)
              : "flary_function_failed",
          message:
            cause instanceof Error ? cause.message : "The function failed",
        },
      });
    }
  }
  return Response.json({ runId: run.runId, status: run.status });
}

function providerFromModel(model: string): string {
  const slash = model.indexOf("/");
  return slash > 0 ? model.slice(0, slash) : "openai";
}

function parseModelOutput(schema: ZodType, content: string): unknown {
  const direct = schema.safeParse(content);
  if (direct.success) return direct.data;
  const cleaned = content
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  let value: unknown;
  try {
    value = JSON.parse(cleaned) as unknown;
  } catch {
    throw new FlaryFunctionError(
      "model_output_invalid",
      "The model did not return valid output for the function schema.",
      502,
    );
  }
  return schema.parse(value);
}

function parseDurableOutput(schema: ZodType, value: unknown): unknown {
  const direct = schema.safeParse(value);
  if (direct.success) return direct.data;
  if (typeof value === "string") return parseModelOutput(schema, value);
  if (
    isRecord(value) &&
    "data" in value &&
    schema.safeParse(value.data).success
  ) {
    return schema.parse(value.data);
  }
  return schema.parse(value);
}

function stringifyToolResult(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? "null" : serialized;
  } catch {
    return JSON.stringify({ error: "The tool result was not serializable." });
  }
}

function isStringSchema(schema: ZodType): boolean {
  const definition = (schema as { def?: { type?: unknown } }).def;
  return definition?.type === "string" || schema.safeParse("").success;
}

function stableJson(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, item: unknown) =>
      isRecord(item)
        ? Object.fromEntries(
            Object.entries(item).sort(([left], [right]) => left.localeCompare(right)),
          )
        : item,
    ) ?? "undefined";
  } catch {
    return String(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function findDeclaredChild(
  parent: FlaryAgent<any>,
  requestedName: string,
): FlaryAgent<any> | undefined {
  for (const [key, child] of Object.entries(parent.definition.subagents ?? {})) {
    if (key === requestedName || child.name === requestedName) return child;
  }
  return undefined;
}

function findAgentInTree(
  root: FlaryAgent<any>,
  name: string,
): FlaryAgent<any> | undefined {
  if (root.name === name) return root;
  for (const child of Object.values(root.definition.subagents ?? {})) {
    const match = findAgentInTree(child, name);
    if (match) return match;
  }
  return undefined;
}

function resolveAgentModelSelection(
  agent: FlaryAgent<any>,
  requested: unknown,
) {
  const state = getAgentState(agent);
  const selected = requested !== undefined
    ? normalizeModelInput(requested as never)
    : agent.definition.model
      ? parseFlueModelSpecifier(agent.definition.model)
      : agent.definition.models?.allow[0]
        ? normalizeModelInput(agent.definition.models.allow[0])
        : state?.app.options.model
          ? parseFlueModelSpecifier(state.app.options.model)
          : parseFlueModelSpecifier("openai/gpt-5");
  if (!selected) {
    throw new FlaryFunctionError(
      "subagent_model_missing",
      `Subagent '${agent.name}' has no model.`,
      400,
    );
  }
  const allowed = modelPolicyMetadata(agent).allow as Array<{
    provider: string;
    model: string;
    deployment?: string;
    variant?: string;
  }>;
  if (!allowed.some((candidate) =>
    candidate.provider === selected.provider &&
    candidate.model === selected.model &&
    candidate.deployment === selected.deployment &&
    candidate.variant === selected.variant
  )) {
    throw new FlaryFunctionError(
      "invalid_subagent_model",
      `Model '${selected.provider}/${selected.model}' is not allowed for '${agent.name}'.`,
      400,
    );
  }
  return selected;
}

function modelPolicyMetadata(agent: FlaryAgent<any>): Record<string, unknown> & {
  allow: unknown[];
} {
  const selected = resolveDefaultAgentModel(agent);
  return {
    allow: agent.definition.models?.allow.map((candidate) =>
      normalizeModelInput(candidate)
    ) ?? (selected ? [selected] : []),
    switching: agent.definition.models?.switching ?? "user",
    fallback: agent.definition.models?.fallback ?? "none",
    ...(agent.definition.models?.compactionModel
      ? {
          compactionModel: normalizeModelInput(
            agent.definition.models.compactionModel,
          ),
        }
      : {}),
  };
}

function resolveDefaultAgentModel(agent: FlaryAgent<any>) {
  const state = getAgentState(agent);
  return agent.definition.model
    ? parseFlueModelSpecifier(agent.definition.model)
    : agent.definition.models?.allow[0]
      ? normalizeModelInput(agent.definition.models.allow[0])
      : state?.app.options.model
        ? parseFlueModelSpecifier(state.app.options.model)
        : parseFlueModelSpecifier("openai/gpt-5");
}

function delegationMetadata(agent: FlaryAgent<any>): Record<string, unknown> {
  return {
    mode: agent.definition.delegation?.mode ?? "explicit",
    maxConcurrentChildren: agent.definition.delegation?.maxConcurrent ?? 4,
    maxTotalChildren: agent.definition.delegation?.maxTotal ?? 16,
    maxDepth: agent.definition.delegation?.maxDepth ?? 2,
    allowPeerMessaging:
      agent.definition.delegation?.allowPeerMessaging ?? true,
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function defaultWorkspaceResolver<TBindings>(
  appOptions: FlaryAppOptions<TBindings>,
  bindings: unknown,
  storage: unknown,
): NonNullable<FlaryAppOptions<TBindings>["resolveWorkspace"]> {
  return async (source, input) => {
    const storageRecord = isRecord(storage) ? storage : undefined;
    const sql = storageRecord?.sql;
    const options = isRecord(source.options) ? source.options : {};
    const draft = options.mode === "draft";
    const identity = input.context.identity;
    if (!identity?.tenantId) {
      throw new FlaryFunctionError(
        "trusted_identity_missing",
        "A workspace tool needs an authenticated tenant identity.",
        401,
      );
    }
    const scope = {
      organizationId: identity.tenantId,
      appId:
        stringValue(options.appId) ??
        identity.applicationId ??
        appOptions.applicationId ??
        appOptions.name ??
        "flary",
      projectId:
        stringValue(options.projectId) ??
        identity.projectId ??
        appOptions.projectId ??
        "default",
      workspaceId:
        stringValue(options.workspaceId) ??
        stringValue(identity.workspaceId) ??
        input.context.runId ??
        "default",
      branch:
        stringValue(options.branch) ??
        stringValue(identity.branch) ??
        "main",
    };
    const r2Name = stringValue(options.r2Binding) ?? "WORKSPACE_BLOBS";
    const r2 = isRecord(bindings) ? bindings[r2Name] : undefined;
    const workspaceNamespace = isRecord(bindings)
      ? bindings.FLARY_WORKSPACE
      : undefined;
    if (
      isRecord(workspaceNamespace) &&
      typeof workspaceNamespace.idFromName === "function" &&
      typeof workspaceNamespace.get === "function"
    ) {
      return createCloudflareWorkspaceConnection(
        workspaceNamespace as never,
        scope,
        { approveWrites: !draft },
      );
    }
    if (!sql) {
      throw new FlaryFunctionError(
        "workspace_runtime_missing",
        "app.workspace() needs the generated FLARY_WORKSPACE binding.",
        503,
      );
    }
    const { ShellWorkspace } = await import("../storage/shell-workspace.js");
    const workspace = new ShellWorkspace({
      sql: sql as never,
      scope,
      ...(r2 ? { r2 } : {}),
      requireR2ForLargeFiles: options.requireR2ForLargeFiles !== false,
    });
    const descriptors = [
      ["read", "Read one workspace file", "read"],
      ["list", "List workspace files", "read"],
      ["stat", "Read safe metadata for one workspace file", "read"],
      ["glob", "Find workspace files by glob", "read"],
      ["grep", "Search workspace file contents", "read"],
      ["diff", "Compare workspace files or content", "read"],
      ["write", "Write one workspace file", "write"],
      ["edit", "Apply text edits to one workspace file", "write"],
      ["batchEdit", "Apply a group of workspace edits", "write"],
      ["move", "Move a workspace file", "write"],
      ["delete", "Delete a workspace file", "write"],
    ] as const;
    const allowed = Array.isArray(options.tools)
      ? new Set(options.tools.filter((value): value is string => typeof value === "string"))
      : undefined;
    return {
      descriptors: descriptors
        .filter(([name]) => !allowed || allowed.has(name))
        .map(([name, description, operation]) => ({
          name,
          description,
          operation,
          requiresApproval: operation === "write" && !draft,
          inputSchema: name === "stat"
            ? {
                type: "object",
                properties: { path: { type: "string" } },
                required: ["path"],
                additionalProperties: false,
              }
            : { type: "object", additionalProperties: true },
        })),
      call: async (name, value) => {
        if (allowed && !allowed.has(name)) {
          throw new Error(`Workspace tool '${name}' is not enabled`);
        }
        const method = workspace[name as keyof typeof workspace];
        if (typeof method !== "function") {
          throw new Error(`Workspace tool '${name}' is not available`);
        }
        const normalizedValue = name === "stat" && isRecord(value)
          ? value.path
          : value;
        return (method as (input: unknown) => Promise<unknown>).call(
          workspace,
          normalizedValue,
        );
      },
    };
  };
}

function defaultSandboxResolver<TBindings>(
  appOptions: FlaryAppOptions<TBindings>,
  bindings: unknown,
): NonNullable<FlaryAppOptions<TBindings>["resolveSandbox"]> {
  return async (source, input) => {
    const options = isRecord(source.options) ? source.options : {};
    const bindingName = stringValue(options.bindingName) ?? "SANDBOX";
    const binding = isRecord(bindings) ? bindings[stringValue(options.binding) ?? bindingName] : undefined;
    if (!binding) {
      throw new FlaryFunctionError(
        "sandbox_runtime_missing",
        `app.sandbox() needs a '${stringValue(options.binding) ?? bindingName}' binding.`,
        503,
      );
    }
    const { getSandbox } = await import("@cloudflare/sandbox");
    const sandboxId =
      stringValue(options.sandboxId) ??
      stringValue(input.context.identity?.workspaceId) ??
      input.context.runId ??
      "default";
    const sandbox = getSandbox(binding as never, sandboxId, {
      transport: "rpc",
      sleepAfter: stringValue(options.sleepAfter) ?? "10m",
      enableDefaultSession: true,
      normalizeId: true,
      labels: { runId: input.context.runId ?? "flary" },
    });
    const workspaceNamespace = isRecord(bindings)
      ? bindings.FLARY_WORKSPACE
      : undefined;
    const workspaceScope = input.context.identity?.tenantId && workspaceNamespace
      ? {
          organizationId: input.context.identity.tenantId,
          appId: input.context.identity.applicationId ?? appOptions.applicationId ?? appOptions.name ?? "flary",
          projectId: input.context.identity.projectId ?? appOptions.projectId ?? "default",
          workspaceId: stringValue(input.context.identity.workspaceId) ?? input.context.runId ?? "default",
          branch: stringValue(input.context.identity.branch) ?? "main",
        }
      : undefined;
    const workspaceBackend = input.storage && workspaceScope && isRecord(workspaceNamespace) &&
        typeof workspaceNamespace.idFromName === "function" &&
        typeof workspaceNamespace.get === "function"
      ? new CloudflareSandboxWorkspaceBackend({
          sandbox,
          workspace: await createCloudflareWorkspaceConnection(
            workspaceNamespace as never,
            workspaceScope,
          ),
          sql: input.storage,
          sessionId: input.context.runId ?? workspaceScope.workspaceId,
        })
      : undefined;
    if (workspaceBackend) await workspaceBackend.prepare();
    const processRuntime = input.storage
      ? new DurableSandboxProcessRuntime({
          sandbox,
          registry: new SqliteSandboxProcessRegistry(input.storage),
          onSettled: workspaceBackend
            ? async ({ processId }) => {
                const operationId = `process_${processId}_exit`;
                try {
                  await workspaceBackend.settle({ operationId, changed: true });
                } catch (error) {
                  await workspaceBackend.uncertain(operationId);
                  throw error;
                }
              }
            : undefined,
        })
      : undefined;
    return {
      descriptors: [
        {
          name: "exec",
          description: "Run one command in the isolated Linux sandbox",
          operation: "write",
          requiresApproval: true,
          inputSchema: {
            type: "object",
            properties: {
              command: { type: "string", minLength: 1 },
              cwd: { type: "string" },
              timeoutMs: { type: "number", minimum: 1 },
            },
            required: ["command"],
            additionalProperties: false,
          },
        },
        ...(["processStart", "processAttach", "processStdin", "processSignal", "processSleep", "processWake"] as const)
          .map((name) => ({
            name,
            description: `Durable sandbox ${name} operation`,
            operation: (name === "processAttach" ? "read" : "write") as "read" | "write",
            requiresApproval: name !== "processAttach",
            inputSchema: { type: "object", additionalProperties: true },
          })),
      ],
      call: async (name, value) => {
        if (!isRecord(value)) throw new Error("Sandbox input must be an object");
        const operationId = stringValue(value.requestId) ??
          `sandbox_${crypto.randomUUID().replaceAll("-", "")}`;
        try {
        if (name === "exec") {
          if (typeof value.command !== "string") {
            throw new Error("Sandbox exec needs a command");
          }
          const result = await sandbox.exec(value.command, {
            ...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}),
            ...(typeof value.timeoutMs === "number" ? { timeout: value.timeoutMs } : {}),
          });
          const output = {
            command: result.command,
            exitCode: result.exitCode,
            success: result.success,
            stdout: result.stdout,
            stderr: result.stderr,
            duration: result.duration,
          };
          await workspaceBackend?.settle({ operationId, changed: true });
          return output;
        }
        if (!processRuntime) {
          throw new Error("Durable sandbox processes need Code Mode SQLite");
        }
        const processId =
          stringValue(value.processId) ??
          `process_${crypto.randomUUID().replaceAll("-", "")}`;
        const requestId =
          stringValue(value.requestId) ??
          `control_${crypto.randomUUID().replaceAll("-", "")}`;
        if (name === "processStart") {
          if (typeof value.command !== "string") {
            throw new Error("processStart needs a command");
          }
          const output = await processRuntime.start({
            id: processId,
            runId: input.context.runId ?? sandboxId,
            sandboxId,
            command: value.command,
            cwd: stringValue(value.cwd) ?? "/workspace",
            ...(isRecord(value.environment)
              ? {
                  environmentHash: await hashSandboxEnvironment(
                    Object.fromEntries(
                      Object.entries(value.environment).map(([key, item]) => [
                        key,
                        String(item),
                      ]),
                    ),
                  ),
                }
              : {}),
          });
          return output;
        }
        if (name === "processAttach") {
          return processRuntime.attach(
            processId,
            typeof value.afterCursor === "number" ? value.afterCursor : 0,
          );
        }
        if (name === "processStdin") {
          if (typeof value.data !== "string") {
            throw new Error("processStdin needs data");
          }
          const output = await processRuntime.stdin({
            requestId,
            processId,
            data: value.data,
          });
          await workspaceBackend?.settle({ operationId, changed: true });
          return output;
        }
        if (name === "processSignal") {
          const output = await processRuntime.signal({
            requestId,
            processId,
            signal: String(value.signal ?? "SIGTERM") as never,
          });
          await workspaceBackend?.settle({ operationId, changed: true });
          return output;
        }
        if (name === "processSleep") {
          const output = await processRuntime.sleep(processId, requestId);
          await workspaceBackend?.settle({ operationId, changed: true });
          return output;
        }
        if (name === "processWake") {
          const output = await processRuntime.wake(processId, requestId);
          await workspaceBackend?.settle({ operationId, changed: true });
          return output;
        }
        throw new Error(`Sandbox tool '${name}' is not available`);
        } catch (error) {
          await workspaceBackend?.uncertain(operationId).catch(() => undefined);
          throw error;
        }
      },
    };
  };
}

function environmentValue(name: string): string | undefined {
  const processLike = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return processLike?.env?.[name];
}

function log(
  level: "info" | "warn" | "error",
  message: string,
  attributes?: Record<string, unknown>,
): void {
  const line = attributes ? `${message} ${stringifyToolResult(attributes)}` : message;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function executionWaitUntil(context: unknown):
  | ((work: Promise<unknown>) => void)
  | undefined {
  try {
    const execution = (context as {
      executionCtx?: { waitUntil(work: Promise<unknown>): void };
    }).executionCtx;
    return execution
      ? (work) => execution.waitUntil(work)
      : undefined;
  } catch {
    return undefined;
  }
}

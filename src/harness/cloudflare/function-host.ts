import {
  createFlueClient,
  type CreateFlueClientOptions,
  type FlueClient,
} from "@flue/sdk";

import {
  createFlueAgentGateway,
  createFlueRunService,
  FlueAdmissionSchema,
  type FlueAgentGateway,
  type FlaryRunRecord,
} from "../flue/service.js";
import type {
  CancelRunRequest,
  CreateRunRequest,
  RunEvent,
  RunHandle,
  RunInput,
  RunResult,
} from "../contracts/index.js";
import type {
  ApprovalDecision,
  ApprovalRequest,
  UserInputAnswerRequest,
  UserInputRecord,
  UserInputRequest,
} from "../contracts/index.js";
import { UserInputRequestSchema } from "../contracts/index.js";
import type {
  FlaryRunService,
  ObserveRunOptions,
  TrustedRunContext,
} from "../host/runs.js";
import {
  SqliteFlaryRunRepository,
  type FlaryUserInputRepository,
} from "./sqlite-run-repository.js";

/** Minimal structural view of Cloudflare Durable Object APIs. */
export interface FlaryDurableObjectState {
  readonly storage: { readonly sql: unknown };
  readonly waitUntil?: (work: Promise<unknown>) => void;
}

export interface FlaryDurableObjectId {
  toString(): string;
}

export interface FlaryDurableObjectStub {
  fetch(request: Request): Promise<Response>;
}

export interface FlaryDurableObjectNamespace {
  idFromName(name: string): FlaryDurableObjectId;
  get(id: FlaryDurableObjectId): FlaryDurableObjectStub;
}

export interface FlaryDurableRunServiceOptions {
  readonly namespace: FlaryDurableObjectNamespace;
  readonly name?: string;
}

/**
 * Create the Worker-side proxy for the Flary Runtime Durable Object.
 *
 * The proxy carries only validated run data. Execution, SQLite state, and
 * Flue tracking stay inside the Durable Object, so Worker eviction cannot
 * stop a run after admission.
 */
export function createFlaryDurableRunService(
  options: FlaryDurableRunServiceOptions,
): FlaryRunService {
  const stub = options.namespace.get(
    options.namespace.idFromName(options.name ?? "default"),
  );
  const call = async <T>(method: string, body: Record<string, unknown>): Promise<T> => {
    const response = await stub.fetch(
      new Request(`https://flary.internal/rpc/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    const value = await response.json().catch(() => undefined);
    if (!response.ok) {
      const message = isRecord(value) && isRecord(value.error) &&
          typeof value.error.message === "string"
        ? value.error.message
        : `Flary Runtime Durable Object request failed (${response.status})`;
      const error = new Error(message);
      if (isRecord(value) && isRecord(value.error) && typeof value.error.code === "string") {
        Object.defineProperty(error, "code", { value: value.error.code });
      }
      throw error;
    }
    return value as T;
  };

  return {
    create: (context, request) =>
      call<RunHandle>("create", { context, request }),
    get: (context, runId) =>
      call<RunResult>("get", { context, runId }),
    async *observe(context, runId, observeOptions) {
      let cursor = observeOptions.afterSequence;
      while (!observeOptions.signal.aborted) {
        const response = await call<{
          readonly events: RunEvent[];
          readonly result: RunResult;
        }>("observe", { context, runId, afterSequence: cursor });
        for (const event of response.events) {
          cursor = Math.max(cursor, event.sequence);
          yield event;
        }
        if (isTerminal(response.result.status)) return;
        await delay(100, observeOptions.signal);
      }
    },
    input: (context, runId, input) =>
      call<RunResult>("input", { context, runId, input }),
    cancel: (context, runId, input) =>
      call<RunResult>("cancel", { context, runId, input }),
    async listApprovals(context, runId) {
      return call<ApprovalRequest[]>("listApprovals", { context, runId });
    },
    async decideApproval(context, runId, decision) {
      return call<RunResult>("decideApproval", { context, runId, decision });
    },
    async listUserInput(context, runId) {
      return call<UserInputRecord[]>("listUserInput", { context, runId });
    },
    async respondToUserInput(context, runId, requestId, input) {
      return call<RunResult>("respondToUserInput", {
        context,
        runId,
        requestId,
        input,
      });
    },
  };
}

export interface FlaryDurableRunObjectOptions<TEnv = Record<string, unknown>> {
  /** Construct the Flue gateway using the Worker bindings. */
  readonly createGateway: (env: TEnv) => FlueAgentGateway;
  /** Optional bridge for approvals owned by a generated agent facet. */
  readonly createApprovalHooks?: (
    env: TEnv,
    repository?: FlaryUserInputRepository,
  ) => {
    readonly listApprovals?: (
      record: FlaryRunRecord,
    ) => Promise<readonly ApprovalRequest[]> | readonly ApprovalRequest[];
    readonly decideApproval?: (
      record: FlaryRunRecord,
      decision: ApprovalDecision,
    ) => Promise<void> | void;
    readonly listUserInput?: (
      record: FlaryRunRecord,
    ) => Promise<readonly UserInputRecord[]> | readonly UserInputRecord[];
    readonly respondToUserInput?: (
      record: FlaryRunRecord,
      requestId: string,
      input: UserInputAnswerRequest,
    ) => Promise<void> | void;
  };
  /** Schedule projection work outside the request when the host supports it. */
  readonly schedule?: (state: FlaryDurableObjectState, work: Promise<void>) => void;
}

/**
 * Handle one request inside the application-owned Runtime Durable Object.
 *
 * The generated Worker exports a small subclass of `DurableObject` and
 * delegates `fetch()` to this function. The library stays free of a static
 * `cloudflare:workers` import, so Node clients can still import the package.
 */
export async function handleFlaryDurableRunObjectRequest<TEnv>(input: {
  readonly state: FlaryDurableObjectState;
  readonly env: TEnv;
  readonly request: Request;
  readonly options: FlaryDurableRunObjectOptions<TEnv>;
}): Promise<Response> {
  const pathname = new URL(input.request.url).pathname;
  const method = pathname.split("/").filter(Boolean).at(-1);
  if (method === "health") return json({ ok: true });
  if (!method) return json({ error: { code: "invalid_runtime_request", message: "Missing RPC method" } }, 400);

  const repository = new SqliteFlaryRunRepository(input.state.storage.sql);
  const service = createFlueRunService({
    repository,
    gateway: input.options.createGateway(input.env),
    ...(input.options.createApprovalHooks
      ? input.options.createApprovalHooks(input.env, repository)
      : {}),
    schedule: (work) => {
      if (input.options.schedule) input.options.schedule(input.state, work);
      else input.state.waitUntil?.(work);
    },
  });
  try {
    if (method === "createUserInput" || method === "getUserInput") {
      assertInternalToken(input.request, input.env);
    }
    const body = await readJson(input.request);
    const value = await dispatchRuntimeRpc(service, repository, method, body);
    return json(value);
  } catch (cause) {
    return json({
      error: {
        code: errorCode(cause),
        message: cause instanceof Error ? cause.message : String(cause),
      },
    }, errorStatus(cause));
  }
}

async function dispatchRuntimeRpc(
  service: FlaryRunService,
  repository: FlaryUserInputRepository,
  method: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const context = body.context as TrustedRunContext;
  switch (method) {
    case "create":
      return service.create(context, body.request as CreateRunRequest);
    case "get":
      return service.get(context, string(body.runId));
    case "input":
      return service.input(context, string(body.runId), body.input as RunInput);
    case "cancel":
      return service.cancel(context, string(body.runId), body.input as CancelRunRequest);
    case "observe": {
      const controller = new AbortController();
      const events: RunEvent[] = [];
      const iterator = service.observe(context, string(body.runId), {
        afterSequence: number(body.afterSequence),
        signal: controller.signal,
      })[Symbol.asyncIterator]();
      const deadline = delay(50, controller.signal).then(() => ({ done: true as const }));
      while (events.length < 100) {
        const next = await Promise.race([
          iterator.next().then((result) => ({ done: result.done, value: result.value })),
          deadline,
        ]);
        if (next.done) break;
        if ("value" in next && next.value) events.push(next.value);
      }
      controller.abort();
      return { events, result: await service.get(context, string(body.runId)) };
    }
    case "listApprovals":
      if (!service.listApprovals) throw featureMissing("Run approvals");
      return service.listApprovals(context, string(body.runId));
    case "decideApproval":
      if (!service.decideApproval) throw featureMissing("Run approvals");
      return service.decideApproval(context, string(body.runId), body.decision as ApprovalDecision);
    case "listUserInput":
      if (!service.listUserInput) throw featureMissing("Run user input");
      return service.listUserInput(context, string(body.runId));
    case "respondToUserInput":
      if (!service.respondToUserInput) throw featureMissing("Run user input");
      return service.respondToUserInput(
        context,
        string(body.runId),
        string(body.requestId),
        body.input as UserInputAnswerRequest,
      );
    case "createUserInput":
      return repository.createUserInput(
        string(body.runId),
        UserInputRequestSchema.parse(body.request),
      );
    case "getUserInput":
      return repository.getUserInput(string(body.runId), string(body.requestId));
    default:
      throw Object.assign(new Error(`Unknown Flary Runtime method '${method}'`), {
        code: "invalid_runtime_request",
        status: 400,
      });
  }
}

/**
 * Build a Flue client that routes generated agent and workflow requests to
 * their Durable Object bindings. This is useful inside the Runtime DO, where
 * no public Worker URL or secret-bearing network request is needed.
 */
export function createCloudflareFlueGateway<TEnv extends Record<string, unknown>>(
  env: TEnv,
  options: {
    readonly token?: string;
    readonly fetch?: typeof fetch;
  } = {},
): FlueAgentGateway {
  let workflowForRun: string | undefined;
  const client = createFlueClient({
    baseUrl: "https://flue.internal",
    token: options.token,
    fetch: options.fetch ?? createCloudflareFlueFetch(env, {
      resolveWorkflowName: () => workflowForRun,
    }),
  });
  const gateway = createFlueAgentGateway(client);
  const directFetch = options.fetch ?? createCloudflareFlueFetch(env, {
    resolveWorkflowName: () => workflowForRun,
  });
  return {
    ...gateway,
    // @flue/sdk@1.0.0-beta.9 only forwards `message` and `images`. Provider
    // switching needs the patched direct-submission fields as well, so send
    // the request to the Flue Durable Object without the lossy SDK helper.
    async send(agentName, instanceId, message, sendOptions = {}) {
      const headers = new Headers({ "content-type": "application/json" });
      if (options.token) headers.set("authorization", `Bearer ${options.token}`);
      const response = await directFetch(
        `https://flue.internal/agents/${encodeURIComponent(agentName)}/${encodeURIComponent(instanceId)}`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            message,
            ...(sendOptions.images ? { images: sendOptions.images } : {}),
            ...(sendOptions.idempotencyKey
              ? { idempotencyKey: sendOptions.idempotencyKey }
              : {}),
            ...(sendOptions.model ? { model: sendOptions.model } : {}),
            ...(sendOptions.thinkingLevel
              ? { thinkingLevel: sendOptions.thinkingLevel }
              : {}),
            ...(sendOptions.cacheRetention
              ? { cacheRetention: sendOptions.cacheRetention }
              : {}),
          }),
        },
      );
      const value = await response.json().catch(() => undefined);
      if (!response.ok) {
        const detail = isRecord(value) && isRecord(value.error)
          ? value.error.message
          : undefined;
        throw new Error(
          typeof detail === "string"
            ? detail
            : `Flue direct submission failed (${response.status})`,
        );
      }
      return FlueAdmissionSchema.parse(value);
    },
    async delete(agentName, instanceId) {
      const headers = new Headers({ "content-type": "application/json" });
      if (options.token) headers.set("authorization", `Bearer ${options.token}`);
      let response: Response;
      try {
        response = await directFetch(
          `https://flue.internal/agents/${encodeURIComponent(agentName)}/${encodeURIComponent(instanceId)}?flary=delete`,
          {
            method: "POST",
            headers,
            body: "{}",
          },
        );
      } catch (cause) {
        // Agent.destroy() erases durable state and then aborts its isolate. A
        // service binding reports that successful terminal action as this
        // exact exception instead of delivering the JSON response.
        const message = cause instanceof Error
          ? cause.message
          : isRecord(cause) && typeof cause.message === "string"
            ? cause.message
            : typeof cause === "string"
              ? cause
              : "";
        if (message === "destroyed" || message === "Error: destroyed") return;
        throw cause;
      }
      if (!response.ok) {
        const value = await response.json().catch(() => undefined);
        const detail = isRecord(value) && isRecord(value.error)
          ? value.error.message
          : undefined;
        throw new Error(
          typeof detail === "string"
            ? detail
            : `Flue agent deletion failed (${response.status})`,
        );
      }
    },
    async waitWorkflow(admission, onEvent, workflowName) {
      workflowForRun = workflowName;
      try {
        return await gateway.waitWorkflow!(admission, onEvent, workflowName);
      } finally {
        workflowForRun = undefined;
      }
    },
  };
}

/** Route a Flue SDK request to the generated agent/workflow DO binding. */
export function createCloudflareFlueFetch<TEnv extends Record<string, unknown>>(
  env: TEnv,
  options: { readonly resolveWorkflowName?: () => string | undefined } = {},
): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (parts[0] === "agents" && parts.length >= 3) {
      const binding = bindingFor(env, "agent", parts[1]!);
      return forwardToNamespace(binding, parts[2]!, request);
    }
    if (parts[0] === "workflows" && parts.length >= 2) {
      const binding = bindingFor(env, "workflow", parts[1]!);
      const runId = `run_${crypto.randomUUID()}`;
      return forwardToNamespace(binding, runId, request);
    }
    if (parts[0] === "runs" && parts.length >= 2) {
      const workflowName = options.resolveWorkflowName?.();
      if (!workflowName) throw new Error("The workflow name is required to route a Flue run");
      const binding = bindingFor(env, "workflow", workflowName);
      return forwardToNamespace(binding, parts[1]!, request);
    }
    throw new Error(`Flue binding is not available for '${url.pathname}'`);
  };
}

/**
 * Connect the Runtime Durable Object to Codemode approval state in the
 * generated Flue agent Durable Object. The public run service calls these
 * hooks only after it validates tenant ownership in SQLite.
 */
export function createFlaryCodemodeApprovalHooks<
  TEnv extends Record<string, unknown>,
>(
  env: TEnv,
  options: {
    readonly token?: string;
    readonly repository?: FlaryUserInputRepository;
  } = {},
): Pick<
  FlaryDurableRunObjectOptions<TEnv>,
  "createApprovalHooks"
>["createApprovalHooks"] {
  const token = options.token ?? stringValue(env.FLARY_INTERNAL_TOKEN);
  const request = async (
    record: FlaryRunRecord,
    action: "approvals" | "approval" | "wake",
    init: RequestInit = {},
  ): Promise<unknown> => {
    const kind = record.request?.execution === "workflow" ? "workflow" : "agent";
    const targetId = kind === "workflow"
      ? record.admission.submissionId
      : record.instanceId;
    const binding = bindingFor(env, kind, record.agentName);
    const path = `/${kind === "workflow" ? "workflows" : "agents"}/${encodeURIComponent(record.agentName)}/${encodeURIComponent(targetId)}?flary=${action}`;
    const headers = new Headers(init.headers);
    if (token) headers.set("authorization", `Bearer ${token}`);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
    const response = await binding.get(binding.idFromName(targetId)).fetch(
      new Request(`https://flue.internal${path}`, { ...init, headers }),
    );
    const value = await response.json().catch(() => undefined);
    if (!response.ok) {
      throw Object.assign(
        new Error(
          isRecord(value) && isRecord(value.error) && typeof value.error.message === "string"
            ? value.error.message
            : `The Flue approval route failed (${response.status})`,
        ),
        { code: "flary_approval_route_failed", status: response.status },
      );
    }
    return value;
  };
  return (_env, repositoryInput) => ({
      async listApprovals(record) {
        const value = await request(record, "approvals");
        const approvals = isRecord(value) && Array.isArray(value.approvals)
          ? value.approvals
          : [];
        return approvals.map((approval) =>
          isRecord(approval)
            ? { ...approval, runId: record.runId }
            : approval,
        ) as ApprovalRequest[];
      },
      async decideApproval(record, decision) {
        await request(record, "approval", {
          method: "POST",
          body: JSON.stringify(decision),
        });
        await request(record, "wake", { method: "GET" });
      },
      ...(options.repository ?? repositoryInput
        ? {
            async listUserInput(record) {
              return (await (options.repository ?? repositoryInput)!.listUserInput(record.runId));
            },
            async respondToUserInput(record, requestId, input) {
              await (options.repository ?? repositoryInput)!.respondToUserInput(
                record.runId,
                requestId,
                input,
                record.trusted.identity,
              );
              await request(record, "wake", { method: "GET" });
            },
          }
        : {}),
    });
}

function assertInternalToken(
  request: Request,
  env: unknown,
): void {
  const expected = isRecord(env) ? stringValue(env.FLARY_INTERNAL_TOKEN) : undefined;
  if (!expected || expected.length < 32 || request.headers.get("authorization") !== `Bearer ${expected}`) {
    throw Object.assign(new Error("The internal Flary token is invalid"), {
      code: "unauthorized",
      status: 401,
    });
  }
}

function bindingFor(
  env: Record<string, unknown>,
  kind: "agent" | "workflow",
  name: string,
): FlaryDurableObjectNamespace {
  const bindingName = `FLUE_${name.replace(/[^a-zA-Z0-9]+/g, "_").toUpperCase()}_${kind === "agent" ? "AGENT" : "WORKFLOW"}`;
  const binding = env[bindingName];
  if (!binding || typeof binding !== "object" ||
      typeof (binding as FlaryDurableObjectNamespace).idFromName !== "function" ||
      typeof (binding as FlaryDurableObjectNamespace).get !== "function") {
    throw new Error(`Flue Durable Object binding '${bindingName}' is not configured`);
  }
  return binding as FlaryDurableObjectNamespace;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

async function forwardToNamespace(
  namespace: FlaryDurableObjectNamespace,
  name: string,
  request: Request,
): Promise<Response> {
  const stub = namespace.get(namespace.idFromName(name));
  return stub.fetch(new Request(`https://flue.internal${new URL(request.url).pathname}${new URL(request.url).search}`, request));
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const value = await request.json().catch(() => ({}));
  if (!isRecord(value)) throw Object.assign(new Error("RPC body must be an object"), { code: "invalid_runtime_request", status: 400 });
  return value;
}

function featureMissing(name: string): Error {
  return Object.assign(new Error(`${name} is not configured`), {
    code: "feature_unavailable",
    status: 501,
  });
}

function errorCode(cause: unknown): string {
  return isRecord(cause) && typeof cause.code === "string"
    ? cause.code
    : "flary_runtime_failed";
}

function errorStatus(cause: unknown): number {
  return isRecord(cause) && typeof cause.status === "number"
    ? cause.status
    : 500;
}

function isTerminal(status: RunResult["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function string(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new Error("RPC value must be a non-empty string");
  return value;
}

function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("RPC value must be a non-negative integer");
  return value;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

import type {
  FlaryApprovalDecisionOptions,
  FlaryEvent,
  FlaryFunction,
  FlaryInput,
  FlaryOutput,
  FlaryRun,
  FlarySendInputOptions,
} from "../functions/types.js";
import type {
  ApprovalRequest,
  UserInputAnswerRequest,
  UserInputRecord,
} from "../contracts/index.js";

export interface FlaryFunctionClientOptions {
  readonly baseUrl: string;
  readonly headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
  readonly token?: string;
  readonly fetch?: typeof fetch;
  readonly pollMs?: number;
}

export interface FlaryRemoteRun<Output> {
  readonly runId: string;
  readonly status: FlaryRun["status"];
  result(): Promise<Output>;
  stream(options?: { readonly signal?: AbortSignal }): AsyncIterable<FlaryEvent<Output>>;
  cancel(): Promise<void>;
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
  respond(requestId: string, input: UserInputAnswerRequest): Promise<void>;
  sendInput(input: unknown, options?: FlarySendInputOptions): Promise<void>;
}

type FunctionClient<F> = F extends FlaryFunction<infer Input, infer Output, any>
  ? ((input: FlaryInput<Input>) => Promise<FlaryOutput<Output>>) & {
      start(
        input: FlaryInput<Input>,
        options?: { readonly requestId?: string; readonly idempotencyKey?: string },
      ): Promise<FlaryRemoteRun<FlaryOutput<Output>>>;
      stream(
        input: FlaryInput<Input>,
        options?: {
          readonly requestId?: string;
          readonly idempotencyKey?: string;
          readonly signal?: AbortSignal;
        },
      ): AsyncIterable<FlaryEvent<FlaryOutput<Output>>>;
    }
  : never;

type RuntimeFunction = ((input: unknown) => Promise<unknown>) & {
  start(
    input: unknown,
    options?: { readonly requestId?: string; readonly idempotencyKey?: string },
  ): Promise<FlaryRemoteRun<unknown>>;
  stream(
    input: unknown,
    options?: {
      readonly requestId?: string;
      readonly idempotencyKey?: string;
      readonly signal?: AbortSignal;
    },
  ): AsyncIterable<FlaryEvent<unknown>>;
};

export type FlaryClientFunctions<TFunctions extends Record<string, unknown>> = {
  [K in keyof TFunctions]: FunctionClient<TFunctions[K]>;
};

/** Typed client for functions served by `app.serve()`. */
export function flary<TFunctions extends Record<string, unknown>>(
  options: FlaryFunctionClientOptions,
): FlaryClientFunctions<TFunctions> {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const request = options.fetch ?? globalThis.fetch;
  const make = (name: string) => {
    const call = (async (input: unknown) => {
      const response = await requestJson(request, `${baseUrl}/functions/${encodeURIComponent(name)}`, {
        method: "POST",
        headers: { "x-request-id": crypto.randomUUID() },
        body: JSON.stringify(input),
      }, options);
      return response.output;
    }) as RuntimeFunction;
    call.start = async (input: unknown, runOptions = {}) => {
      const requestId = runOptions.requestId ?? crypto.randomUUID();
      const idempotencyKey = runOptions.idempotencyKey ?? crypto.randomUUID();
      const response = await requestJson(
        request,
        `${baseUrl}/functions/${encodeURIComponent(name)}/runs`,
        {
          method: "POST",
          headers: {
            "x-request-id": requestId,
            "idempotency-key": idempotencyKey,
          },
          body: JSON.stringify(input),
        },
        options,
      );
      return remoteRun<unknown>(
        request,
        baseUrl,
        name,
        response.runId,
        response.status,
        options,
      );
    };
    call.stream = (input: unknown, runOptions = {}) => (async function* () {
      const run = await call.start(input, runOptions);
      yield* run.stream({ signal: runOptions.signal });
    })();
    return call;
  };

  return new Proxy(
    {},
    {
      get: (_target, property: string | symbol) =>
        typeof property === "string" ? make(property) : undefined,
    },
  ) as FlaryClientFunctions<TFunctions>;
}

export const createFlaryFunctionClient = flary;

function remoteRun<Output>(
  request: typeof fetch,
  baseUrl: string,
  functionName: string,
  runId: string,
  initialStatus: FlaryRun["status"],
  options: FlaryFunctionClientOptions,
): FlaryRemoteRun<Output> {
  let latestStatus: FlaryRun["status"] = initialStatus;
  const runPath =
    `${baseUrl}/functions/${encodeURIComponent(functionName)}` +
    `/runs/${encodeURIComponent(runId)}`;
  return {
    runId,
    get status() {
      return latestStatus;
    },
    async result() {
      while (true) {
        const value = await requestJson(request, runPath, {}, options);
        latestStatus = value.status as FlaryRun["status"];
        if (value.status === "completed") return value.result as Output;
        if (value.status === "failed" || value.status === "cancelled") {
          throw new Error(value.error?.message ?? `Flary run ${value.status}`);
        }
        await delay(options.pollMs ?? 250);
      }
    },
    async *stream(streamOptions = {}) {
      let last: string | undefined;
      while (true) {
        if (streamOptions.signal?.aborted) throw streamOptions.signal.reason;
        const value = await requestJson(request, runPath, {}, options);
        latestStatus = value.status as FlaryRun["status"];
        const marker = `${value.status}:${JSON.stringify(value.result ?? null)}`;
        if (marker !== last) {
          last = marker;
          const event: FlaryEvent<Output> = value.status === "completed"
            ? { type: "output", runId, output: value.result as Output, occurredAt: new Date().toISOString() }
            : value.status === "failed"
              ? { type: "failed", runId, error: value.error ?? { code: "flary_function_failed", message: "The function failed" }, occurredAt: new Date().toISOString() }
              : value.status === "cancelled"
                ? { type: "cancelled", runId, occurredAt: new Date().toISOString() }
                : value.status === "paused"
                  ? {
                      type: "paused",
                      runId,
                      reason: "The run is waiting for approval or input.",
                      occurredAt: new Date().toISOString(),
                    }
                : { type: "started", runId, occurredAt: new Date().toISOString() };
          yield event;
        }
        if (value.status === "completed" || value.status === "failed" || value.status === "cancelled") return;
        await delay(options.pollMs ?? 250);
      }
    },
    async cancel() {
      await requestJson(
        request,
        `${runPath}/cancel`,
        { method: "POST", body: "{}" },
        options,
      );
      latestStatus = "cancelled";
    },
    async approvals() {
      const value = await requestJson(
        request,
        `${runPath}/approvals`,
        {},
        options,
      );
      return value.approvals ?? [];
    },
    async approve(approvalId, decisionOptions = {}) {
      await decideApproval("approved", approvalId, decisionOptions);
    },
    async reject(approvalId, decisionOptions = {}) {
      await decideApproval("rejected", approvalId, decisionOptions);
    },
    async userInput() {
      const value = await requestJson(
        request,
        `${runPath}/user-input`,
        {},
        options,
      );
      return value.requests ?? [];
    },
    async respond(requestId, input) {
      await requestJson(
        request,
        `${runPath}/user-input/${encodeURIComponent(requestId)}`,
        { method: "POST", body: JSON.stringify(input) },
        options,
      );
    },
    async sendInput(input, inputOptions = {}) {
      await requestJson(
        request,
        `${runPath}/input`,
        {
          method: "POST",
          body: JSON.stringify({
            input,
            ...(inputOptions.idempotencyKey
              ? { idempotencyKey: inputOptions.idempotencyKey }
              : {}),
            ...(inputOptions.metadata
              ? { metadata: inputOptions.metadata }
              : {}),
          }),
        },
        options,
      );
    },
  };

  async function decideApproval(
    status: "approved" | "rejected",
    approvalId: string,
    decisionOptions: FlaryApprovalDecisionOptions,
  ): Promise<void> {
    await requestJson(
      request,
      `${runPath}/approvals/${encodeURIComponent(approvalId)}`,
      {
        method: "POST",
        body: JSON.stringify({ status, ...decisionOptions }),
      },
      options,
    );
  }
}

async function requestJson(
  request: typeof fetch,
  url: string,
  init: RequestInit,
  options: FlaryFunctionClientOptions,
): Promise<any> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  const configured = typeof options.headers === "function" ? await options.headers() : options.headers;
  for (const [key, value] of new Headers(configured).entries()) if (!headers.has(key)) headers.set(key, value);
  const response = await request(url, { ...init, headers });
  const value = await response.json().catch(() => undefined);
  if (!response.ok) {
    throw new Error(value?.error?.message ?? `Flary function request failed (${response.status})`);
  }
  return value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

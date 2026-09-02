import type {
  FlaryApprovalDecisionOptions,
  FlaryEvent,
  FlaryAgent,
  FlaryFunction,
  FlaryInput,
  FlaryOutput,
  FlaryRun,
  FlarySendInputOptions,
} from "../functions/types.js";
import type {
  ThreadBinding,
  ThreadDeletion,
  ThreadForkRequest,
  ThreadHistoryDiffResponse,
  ThreadHistoryListResponse,
  ThreadPortableArchive,
  ThreadRef,
} from "../contracts/index.js";
import type {
  SubagentActivityEvent,
  SubagentMailboxMessage,
  SubagentThread,
} from "../contracts/subagents.js";
import {
  createFlaryThreadClient,
  type FlaryRealtimeConnection,
  type FlaryTerminalTicket,
  type FlaryRealtimeSocket,
  type FlaryThreadClientCreateOptions,
  type FlaryThreadClient,
} from "./flue.js";
import type {
  ApprovalRequest,
  ConnectionSecretMetadata,
  SecretRequestResult,
  UserInputAnswerRequest,
  UserInputRecord,
} from "../contracts/index.js";
import type { ModelInput, ReasoningEffort } from "../contracts/provider.js";

export interface FlaryFunctionClientOptions {
  readonly baseUrl: string;
  readonly headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
  readonly token?: string;
  readonly fetch?: typeof fetch;
  readonly pollMs?: number;
  readonly webSocketFactory?: (url: string) => FlaryRealtimeSocket;
}

export interface FlaryRemoteRun<Output> {
  readonly runId: string;
  readonly status: FlaryRun["status"];
  result(): Promise<Output>;
  stream(options?: { readonly signal?: AbortSignal }): AsyncIterable<FlaryEvent<Output>>;
  cancel(): Promise<void>;
  approvals(): Promise<readonly ApprovalRequest[]>;
  approve(approvalId: string, options?: FlaryApprovalDecisionOptions): Promise<void>;
  reject(approvalId: string, options?: FlaryApprovalDecisionOptions): Promise<void>;
  userInput(): Promise<readonly UserInputRecord[]>;
  respond(requestId: string, input: UserInputAnswerRequest): Promise<void>;
  sendInput(input: unknown, options?: FlarySendInputOptions): Promise<void>;
}

export interface FlarySubagentListResult {
  readonly threads: readonly SubagentThread[];
  readonly messages: readonly SubagentMailboxMessage[];
  readonly activity: readonly SubagentActivityEvent[];
}

export interface FlarySubagentSpawnResult {
  readonly thread: SubagentThread;
}

export interface FlarySubagentSendResult {
  readonly message: SubagentMailboxMessage;
  readonly thread?: SubagentThread;
}

export interface FlarySubagentWaitResult extends FlarySubagentListResult {
  readonly timedOut: boolean;
}

export interface FlarySubagentControlResult {
  readonly thread: SubagentThread;
}

type FunctionClient<F> =
  F extends FlaryFunction<infer Input, infer Output, any>
    ? ((input: FlaryInput<Input>) => Promise<FlaryOutput<Output>>) & {
        start(
          input: FlaryInput<Input>,
          options?: {
            readonly requestId?: string;
            readonly idempotencyKey?: string;
          },
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

export interface FlaryAgentThreadHandle {
  readonly ref: ThreadRef;
  readonly binding: ThreadBinding;
  history(options?: Record<string, unknown>): unknown;
  turns(options?: {
    after?: number;
    limit?: number;
    types?: readonly string[];
  }): Promise<readonly unknown[]>;
  stream(options?: { after?: string; signal?: AbortSignal }): unknown;
  connect(options?: {
    after?: number;
    includeChildren?: boolean;
  }): Promise<FlaryRealtimeConnection>;
  send(input: {
    message: string;
    mode?: "queue" | "steer";
    model?: ModelInput;
    thinkingLevel?: ReasoningEffort;
    cacheRetention?: "none" | "short" | "long";
    images?: readonly {
      type: "image";
      data: string;
      mimeType: string;
      filename?: string;
    }[];
    idempotencyKey?: string;
  }): Promise<unknown>;
  edit(input: {
    turnId: string;
    message: string;
    mode?: "queue" | "steer";
    model?: ModelInput;
    thinkingLevel?: ReasoningEffort;
    cacheRetention?: "none" | "short" | "long";
    idempotencyKey?: string;
  }): Promise<unknown>;
  interrupt(): Promise<void>;
  cancel(): Promise<unknown>;
  fork(input?: ThreadForkRequest): Promise<FlaryAgentThreadHandle>;
  rollback(input: { turnId: string; reason?: string }): Promise<unknown>;
  restore(
    input:
      { jsonl: string; replace?: boolean } | { archive: ThreadPortableArchive; replace?: boolean },
  ): Promise<unknown>;
  export(): ReturnType<FlaryThreadClient["exportSession"]>;
  compact(input?: { reason?: string }): Promise<unknown>;
  rename(title: string): Promise<ThreadBinding>;
  archive(): Promise<void>;
  unarchive(): Promise<ThreadBinding>;
  pin(pinned?: boolean): Promise<ThreadBinding>;
  markRead(throughSequence?: number): Promise<ThreadBinding>;
  delete(): Promise<ThreadDeletion>;
  approvals(): Promise<unknown[]>;
  approve(approvalId: string, options?: { reason?: string }): Promise<void>;
  reject(approvalId: string, options?: { reason?: string }): Promise<void>;
  userInput(): Promise<readonly UserInputRecord[]>;
  sendInput(
    requestId: string,
    answers: Readonly<Record<string, string>>,
    options?: { response?: string; canceled?: boolean },
  ): Promise<unknown>;
  fulfillSecret(
    requestId: string,
    input: { value: string; description?: string; expiresAt?: string },
  ): Promise<{
    secret: ConnectionSecretMetadata;
    result: SecretRequestResult;
  }>;
  setGoal(input: {
    objective: string;
    tokenBudget?: number;
    costBudgetUsd?: number;
  }): Promise<unknown>;
  clearGoal(): Promise<unknown>;
  readonly model: {
    get(): Promise<unknown>;
    list(): Promise<readonly unknown[]>;
    set(model: ModelInput): Promise<unknown>;
    history(): Promise<readonly unknown[]>;
  };
  readonly subagents: {
    list(input?: { afterSequence?: number }): Promise<FlarySubagentListResult>;
    spawn(input: {
      agent: string;
      task: string;
      model?: ModelInput;
      seedTurns?: number;
      nickname?: string;
      idempotencyKey?: string;
    }): Promise<FlarySubagentSpawnResult>;
    send(input: {
      toThreadId: string;
      content: string;
      mode?: "queue" | "interrupt";
      kind?: "instruction" | "progress" | "question" | "result" | "control";
      idempotencyKey?: string;
    }): Promise<FlarySubagentSendResult>;
    wait(input: {
      threadIds: readonly string[];
      afterSequence?: number;
      timeoutMs?: number;
    }): Promise<FlarySubagentWaitResult>;
    interrupt(input: { threadId: string; reason?: string }): Promise<FlarySubagentControlResult>;
    resume(input: { threadId: string }): Promise<FlarySubagentControlResult>;
    close(input: { threadId: string; reason?: string }): Promise<FlarySubagentControlResult>;
  };
  readonly audit: {
    list(options?: {
      after?: number;
      limit?: number;
      types?: readonly string[];
    }): Promise<readonly unknown[]>;
    export(): Promise<string>;
  };
  readonly checkpoints: {
    list(options?: { limit?: number }): Promise<ThreadHistoryListResponse>;
    diff(input: {
      baseCommitId?: string;
      headCommitId: string;
    }): Promise<ThreadHistoryDiffResponse>;
    restore(commitId: string): Promise<unknown>;
  };
  readonly processes: {
    list(): Promise<readonly unknown[]>;
    start(input: {
      command: string;
      cwd?: string;
      processId?: string;
      requestId?: string;
    }): Promise<unknown>;
    attach(input: { processId: string; afterCursor?: number }): Promise<unknown>;
    stdin(input: { processId: string; data: string; requestId?: string }): Promise<unknown>;
    signal(input: { processId: string; signal: string; requestId?: string }): Promise<unknown>;
    resize(input: {
      processId: string;
      cols: number;
      rows: number;
      requestId?: string;
    }): Promise<unknown>;
    sleep(input: { processId: string; requestId?: string }): Promise<unknown>;
    wake(input: { processId: string; requestId?: string }): Promise<unknown>;
  };
  readonly terminal: {
    connect(input?: { cols?: number; rows?: number }): Promise<FlaryTerminalTicket>;
  };
  readonly browser: {
    status(): Promise<unknown>;
    takeover(): Promise<unknown>;
    input(input: Readonly<Record<string, unknown>>): Promise<unknown>;
    release(): Promise<unknown>;
    close(): Promise<unknown>;
  };
  readonly schedules: {
    register(input: Readonly<Record<string, unknown>>): Promise<unknown>;
    list(): Promise<unknown>;
    history(input?: Readonly<Record<string, unknown>>): Promise<unknown>;
    pause(scheduleId: string): Promise<unknown>;
    resume(scheduleId: string): Promise<unknown>;
    delete(scheduleId: string): Promise<unknown>;
  };
}

type AgentClient<A> =
  A extends FlaryAgent<any>
    ? {
        readonly threads: {
          create(
            input: Omit<FlaryThreadClientCreateOptions, "agentId">,
          ): Promise<FlaryAgentThreadHandle>;
          list(): Promise<ThreadBinding[]>;
          open(ref: Omit<ThreadRef, "appId" | "agentId">): Promise<FlaryAgentThreadHandle>;
        };
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
  [K in keyof TFunctions]: TFunctions[K] extends FlaryAgent<any>
    ? AgentClient<TFunctions[K]>
    : FunctionClient<TFunctions[K]>;
};

/** Typed client for functions served by `app.serve()`. */
export function flary<TFunctions extends Record<string, unknown>>(
  options: FlaryFunctionClientOptions,
): FlaryClientFunctions<TFunctions> {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const request = options.fetch ?? globalThis.fetch;
  const threadClient = createFlaryThreadClient({
    baseUrl,
    apiPath: "",
    mountPath: "/flue",
    fetch: options.fetch,
    ...(options.webSocketFactory ? { webSocketFactory: options.webSocketFactory } : {}),
    ...(options.headers
      ? {
          headers: async () => {
            const value =
              typeof options.headers === "function" ? await options.headers() : options.headers;
            return Object.fromEntries(new Headers(value).entries());
          },
        }
      : {}),
    token: options.token,
  });
  const make = (name: string) => {
    const call = (async (input: unknown) => {
      const response = await requestJson(
        request,
        `${baseUrl}/functions/${encodeURIComponent(name)}`,
        {
          method: "POST",
          headers: { "x-request-id": crypto.randomUUID() },
          body: JSON.stringify(input),
        },
        options,
      );
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
      return remoteRun<unknown>(request, baseUrl, name, response.runId, response.status, options);
    };
    call.stream = (input: unknown, runOptions = {}) =>
      (async function* () {
        const run = await call.start(input, runOptions);
        yield* run.stream({ signal: runOptions.signal });
      })();
    return call;
  };

  return new Proxy(
    {},
    {
      get: (_target, property: string | symbol) => {
        if (typeof property !== "string") return undefined;
        const callable = make(property) as RuntimeFunction & {
          threads?: unknown;
        };
        callable.threads = makeAgentThreads(threadClient, property);
        return callable;
      },
    },
  ) as FlaryClientFunctions<TFunctions>;
}

export const createFlaryFunctionClient = flary;

function makeAgentThreads(client: FlaryThreadClient, agentName: string) {
  return {
    async create(
      input: Omit<FlaryThreadClientCreateOptions, "agentId">,
    ): Promise<FlaryAgentThreadHandle> {
      const binding = await client.create({ ...input, agentId: agentName });
      return makeAgentThreadHandle(client, binding, agentName);
    },
    list(): Promise<ThreadBinding[]> {
      return client.list(agentName);
    },
    async open(ref: Omit<ThreadRef, "appId" | "agentId">): Promise<FlaryAgentThreadHandle> {
      const complete = { ...ref, appId: agentName, agentId: agentName };
      const binding = await client.inspect(complete);
      return makeAgentThreadHandle(client, binding, agentName);
    },
  };
}

function makeAgentThreadHandle(
  client: FlaryThreadClient,
  binding: ThreadBinding,
  agentName = binding.agentId,
): FlaryAgentThreadHandle {
  const ref = binding.thread;
  const subagent = (
    action: "list" | "spawn" | "send" | "wait" | "interrupt" | "resume" | "close",
    input: Readonly<Record<string, unknown>> = {},
  ) => client.subagent(ref, action, input);
  return {
    ref,
    binding,
    history: (options) => client.history(ref, options as never, agentName),
    turns: (options) => client.turns(ref, options),
    stream: (options) =>
      client.observe(
        ref,
        {
          ...(options?.after ? { offset: options.after } : {}),
          ...(options?.signal ? { signal: options.signal } : {}),
        } as never,
        agentName,
      ),
    connect: (options) => client.connect(ref, options),
    send: (input) =>
      client.submit(ref, {
        message: input.message,
        mode: input.mode,
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
        ...(input.cacheRetention ? { cacheRetention: input.cacheRetention } : {}),
        ...(input.images ? { images: [...input.images] } : {}),
        idempotencyKey: input.idempotencyKey ?? crypto.randomUUID(),
      }),
    edit: (input) =>
      client.edit(ref, {
        ...input,
        idempotencyKey: input.idempotencyKey ?? crypto.randomUUID(),
      }),
    interrupt: () => client.interrupt(ref),
    cancel: () => client.abort(ref, undefined, agentName),
    async fork(input = {}) {
      const child = await client.fork(ref, input);
      return makeAgentThreadHandle(client, child, agentName);
    },
    rollback: (input) => client.rollback(ref, input),
    restore: (input) => client.restore(ref, input),
    export: () => client.exportSession(ref),
    compact: (input = {}) => client.compact(ref, input),
    rename: (title) => client.rename(ref, title),
    archive: () => client.archive(ref),
    unarchive: () => client.unarchive(ref),
    pin: (pinned = true) => client.pin(ref, pinned),
    markRead: (throughSequence) => client.markRead(ref, throughSequence),
    delete: () => client.delete(ref),
    approvals: () => client.approvals(ref),
    approve: (approvalId, options = {}) =>
      client.decideApproval(ref, approvalId, {
        status: "approved",
        decidedBy: binding.createdBy,
        decidedAt: new Date().toISOString(),
        ...(options.reason ? { comment: options.reason } : {}),
      }),
    reject: (approvalId, options = {}) =>
      client.decideApproval(ref, approvalId, {
        status: "rejected",
        decidedBy: binding.createdBy,
        decidedAt: new Date().toISOString(),
        ...(options.reason ? { comment: options.reason } : {}),
      }),
    userInput: () => client.userInput(ref),
    sendInput: (requestId, answers, options = {}) =>
      client.respondToUserInput(ref, requestId, { answers, ...options }),
    fulfillSecret: (requestId, input) => client.fulfillSecretRequest(ref, requestId, input),
    setGoal: (input) => client.setGoal(ref, input),
    clearGoal: () => client.clearGoal(ref),
    model: {
      get: () => client.modelGet(ref),
      list: () => client.modelList(ref),
      set: (model) => client.modelSet(ref, { model }),
      history: () => client.modelHistory(ref),
    },
    subagents: {
      list: (input) => subagent("list", input) as Promise<FlarySubagentListResult>,
      spawn: (input) => subagent("spawn", input) as Promise<FlarySubagentSpawnResult>,
      send: (input) => subagent("send", input) as Promise<FlarySubagentSendResult>,
      wait: (input) => subagent("wait", input) as Promise<FlarySubagentWaitResult>,
      interrupt: (input) => subagent("interrupt", input) as Promise<FlarySubagentControlResult>,
      resume: (input) => subagent("resume", input) as Promise<FlarySubagentControlResult>,
      close: (input) => subagent("close", input) as Promise<FlarySubagentControlResult>,
    },
    audit: {
      list: (options) => client.audit(ref, options),
      export: () => client.auditExport(ref),
    },
    checkpoints: {
      list: (options) => client.historyCheckpoints(ref, options),
      diff: (input) => client.historyDiff(ref, input),
      restore: (commitId) => client.historyRestore(ref, { commitId }),
    },
    processes: {
      list: () => client.processes(ref),
      start: (input) => client.process(ref, "start", input),
      attach: (input) => client.process(ref, "attach", input),
      stdin: (input) => client.process(ref, "stdin", input),
      signal: (input) => client.process(ref, "signal", input),
      resize: (input) => client.process(ref, "resize", input),
      sleep: (input) => client.process(ref, "sleep", input),
      wake: (input) => client.process(ref, "wake", input),
    },
    terminal: {
      connect: (input) => client.terminalTicket(ref, input),
    },
    browser: {
      status: () => client.browser(ref, "status"),
      takeover: () => client.browser(ref, "takeover"),
      input: (input) => client.browser(ref, "input", input),
      release: () => client.browser(ref, "release"),
      close: () => client.browser(ref, "close"),
    },
    schedules: {
      register: (input) => client.schedule(ref, "register", input),
      list: () => client.schedule(ref, "list"),
      history: (input) => client.schedule(ref, "history", input),
      pause: (scheduleId) => client.schedule(ref, "pause", { scheduleId }),
      resume: (scheduleId) => client.schedule(ref, "resume", { scheduleId }),
      delete: (scheduleId) => client.schedule(ref, "delete", { scheduleId }),
    },
  };
}

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
          const event: FlaryEvent<Output> =
            value.status === "completed"
              ? {
                  type: "output",
                  runId,
                  output: value.result as Output,
                  occurredAt: new Date().toISOString(),
                }
              : value.status === "failed"
                ? {
                    type: "failed",
                    runId,
                    error: value.error ?? {
                      code: "flary_function_failed",
                      message: "The function failed",
                    },
                    occurredAt: new Date().toISOString(),
                  }
                : value.status === "cancelled"
                  ? {
                      type: "cancelled",
                      runId,
                      occurredAt: new Date().toISOString(),
                    }
                  : value.status === "paused"
                    ? {
                        type: "paused",
                        runId,
                        reason: "The run is waiting for approval or input.",
                        occurredAt: new Date().toISOString(),
                      }
                    : {
                        type: "started",
                        runId,
                        occurredAt: new Date().toISOString(),
                      };
          yield event;
        }
        if (
          value.status === "completed" ||
          value.status === "failed" ||
          value.status === "cancelled"
        )
          return;
        await delay(options.pollMs ?? 250);
      }
    },
    async cancel() {
      await requestJson(request, `${runPath}/cancel`, { method: "POST", body: "{}" }, options);
      latestStatus = "cancelled";
    },
    async approvals() {
      const value = await requestJson(request, `${runPath}/approvals`, {}, options);
      return value.approvals ?? [];
    },
    async approve(approvalId, decisionOptions = {}) {
      await decideApproval("approved", approvalId, decisionOptions);
    },
    async reject(approvalId, decisionOptions = {}) {
      await decideApproval("rejected", approvalId, decisionOptions);
    },
    async userInput() {
      const value = await requestJson(request, `${runPath}/user-input`, {}, options);
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
            ...(inputOptions.idempotencyKey ? { idempotencyKey: inputOptions.idempotencyKey } : {}),
            ...(inputOptions.metadata ? { metadata: inputOptions.metadata } : {}),
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
  if (init.body !== undefined && !headers.has("content-type"))
    headers.set("content-type", "application/json");
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  const configured =
    typeof options.headers === "function" ? await options.headers() : options.headers;
  for (const [key, value] of new Headers(configured).entries())
    if (!headers.has(key)) headers.set(key, value);
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

import {
  createFlueClient,
  type AgentConversationObserveOptions,
  type AgentPromptOptions,
  type CreateFlueClientOptions,
  type FlueClient,
  type FlueConversationHistoryOptions,
  type AgentSendResult,
} from "@flue/sdk";

import {
  ApprovalDecisionSchema,
  RecallDocumentSchema,
  RecallSearchModeSchema,
  RecallSearchResponseSchema,
  RecallKindSchema,
  ThreadBindingSchema,
  ThreadConnectionsRequestSchema,
  ThreadCompactRequestSchema,
  ThreadCreateRequestSchema,
  ThreadForkRequestSchema,
  ThreadListResponseSchema,
  ThreadHistoryDiffResponseSchema,
  ThreadHistoryDiffRequestSchema,
  ThreadHistoryListResponseSchema,
  ThreadMessageRequestSchema,
  ThreadModelSetRequestSchema,
  ThreadModeRequestSchema,
  ThreadGoalRequestSchema,
  ThreadPinRequestSchema,
  ThreadReadRequestSchema,
  ThreadRenameRequestSchema,
  ThreadRollbackRequestSchema,
  ThreadRestoreRequestSchema,
  UserInputAnswerRequestSchema,
  UserInputRecordSchema,
  ThreadOperationalStateSchema,
  type ApprovalDecision,
  type ThreadBinding,
  type ThreadCreateRequest,
  type ThreadForkRequest,
  type ThreadMessageRequest,
  type ThreadModelSetRequest,
  type ThreadRef,
  type RecallDocument,
  type RecallReference,
  type ThreadHistoryDiffResponse,
  type ThreadHistoryListResponse,
} from "../contracts/index.js";
import { ThreadRefSchema } from "../contracts/tenancy.js";
import { threadName } from "../storage/scopes.js";

export interface CreateFlaryThreadClientOptions
  extends Omit<CreateFlueClientOptions, "baseUrl"> {
  /** Flary application origin or API base. */
  baseUrl: string;
  /** Flue mount below baseUrl. */
  mountPath?: string;
  /** Thread control mount below baseUrl. Defaults to `/api`. */
  apiPath?: string;
}

export interface FlaryThreadMessageOptions
  extends Omit<ThreadMessageRequest, "message"> {
  message: string;
}

export interface FlaryThreadClientCreateOptions
  extends Omit<ThreadCreateRequest, "workspace"> {
  workspace: ThreadCreateRequest["workspace"];
}

export interface FlaryRecallSearchOptions {
  query: string;
  mode?: "exact" | "semantic" | "hybrid";
  kinds?: Array<"message" | "plan" | "decision" | "file" | "tool" | "run" | "event">;
  limit?: number;
}

export type FlaryRecallOpenOptions =
  | { id: string }
  | { reference: RecallReference };

export class FlaryThreadClient {
  readonly flue: FlueClient;
  readonly #baseUrl: string;
  readonly #request: typeof fetch;
  readonly #headers: CreateFlueClientOptions["headers"];
  readonly #token?: string;
  readonly #apiPath: string;

  constructor(options: CreateFlaryThreadClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#request = options.fetch ?? globalThis.fetch;
    this.#headers = options.headers;
    this.#token = options.token;
    this.#apiPath = normalizeApiPath(options.apiPath ?? "/api");
    const mountPath = options.mountPath ?? "/api/flue";
    this.flue = createFlueClient({
      baseUrl: joinBaseUrl(options.baseUrl, mountPath),
      fetch: options.fetch,
      headers: options.headers,
      token: options.token,
    });
  }

  id(ref: ThreadRef): string {
    return threadName(ThreadRefSchema.parse(ref));
  }

  prompt(ref: ThreadRef, options: AgentPromptOptions) {
    // Flary is stream-first. Keep this alias for SDK users, but route it
    // through authenticated admission instead of bypassing credentials and
    // idempotency with Flue's public direct prompt endpoint.
    return this.submit(ref, {
      message: options.message,
      ...(options.images ? { images: options.images } : {}),
      idempotencyKey: crypto.randomUUID(),
    });
  }

  send(ref: ThreadRef, options: AgentPromptOptions | FlaryThreadMessageOptions) {
    // Route every turn through Flary admission. This keeps credential checks,
    // idempotency, mode policy, and model snapshots on one authenticated path.
    return this.submit(ref, options);
  }

  async submit(
    refInput: ThreadRef,
    options: FlaryThreadMessageOptions,
  ): Promise<AgentSendResult> {
    const ref = ThreadRefSchema.parse(refInput);
    const body = ThreadMessageRequestSchema.parse(options);
    const value = await this.apiJson(
      `${this.#apiPath}/apps/${encodeURIComponent(ref.appId)}/threads/${encodeURIComponent(ref.threadId)}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    return value as AgentSendResult;
  }

  async create(options: FlaryThreadClientCreateOptions): Promise<ThreadBinding> {
    const body = ThreadCreateRequestSchema.parse(options);
    const value = await this.apiJson(
      `${this.#apiPath}/apps/${encodeURIComponent(body.workspace.appId)}/threads`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    return ThreadBindingSchema.parse((value as { binding: unknown }).binding);
  }

  async list(appId: string): Promise<ThreadBinding[]> {
    const value = await this.apiJson(
      `${this.#apiPath}/apps/${encodeURIComponent(appId)}/threads`,
    );
    return ThreadListResponseSchema.parse(value).threads;
  }

  async inspect(refInput: ThreadRef): Promise<ThreadBinding> {
    const ref = ThreadRefSchema.parse(refInput);
    const value = await this.apiJson(
      `${this.#apiPath}/apps/${encodeURIComponent(ref.appId)}/threads/${encodeURIComponent(ref.threadId)}`,
    );
    return ThreadBindingSchema.parse((value as { binding: unknown }).binding);
  }

  async archive(refInput: ThreadRef): Promise<void> {
    const ref = ThreadRefSchema.parse(refInput);
    await this.apiJson(
      `${this.#apiPath}/apps/${encodeURIComponent(ref.appId)}/threads/${encodeURIComponent(ref.threadId)}/archive`,
      { method: "POST" },
    );
  }

  async fork(
    refInput: ThreadRef,
    options: ThreadForkRequest = {},
  ): Promise<ThreadBinding> {
    const ref = ThreadRefSchema.parse(refInput);
    const body = ThreadForkRequestSchema.parse(options);
    const value = await this.apiJson(
      `${this.#apiPath}/apps/${encodeURIComponent(ref.appId)}/threads/${encodeURIComponent(ref.threadId)}/fork`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    return ThreadBindingSchema.parse((value as { binding: unknown }).binding);
  }

  async setMode(refInput: ThreadRef, mode: string, reason?: string): Promise<ThreadBinding> {
    const ref = ThreadRefSchema.parse(refInput);
    const body = ThreadModeRequestSchema.parse({ mode, reason });
    const value = await this.apiJson(
      `${this.#apiPath}/apps/${encodeURIComponent(ref.appId)}/threads/${encodeURIComponent(ref.threadId)}/mode`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    return ThreadBindingSchema.parse((value as { binding: unknown }).binding);
  }

  async setConnections(refInput: ThreadRef, connectionIds: string[]): Promise<ThreadBinding> {
    const ref = ThreadRefSchema.parse(refInput);
    const body = ThreadConnectionsRequestSchema.parse({ connectionIds });
    const value = await this.apiJson(
      `${this.#apiPath}/apps/${encodeURIComponent(ref.appId)}/threads/${encodeURIComponent(ref.threadId)}/connections`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    return ThreadBindingSchema.parse((value as { binding: unknown }).binding);
  }

  async modelGet(refInput: ThreadRef): Promise<unknown> {
    const ref = ThreadRefSchema.parse(refInput);
    const value = await this.apiJson(
      `${this.#apiPath}/apps/${encodeURIComponent(ref.appId)}/threads/${encodeURIComponent(ref.threadId)}/model`,
    );
    return (value as { model: unknown }).model;
  }

  async modelList(refInput: ThreadRef): Promise<readonly unknown[]> {
    const ref = ThreadRefSchema.parse(refInput);
    const value = await this.apiJson(
      `${this.#apiPath}/apps/${encodeURIComponent(ref.appId)}/threads/${encodeURIComponent(ref.threadId)}/models`,
    );
    return Array.isArray((value as { models?: unknown }).models)
      ? (value as { models: unknown[] }).models
      : [];
  }

  async modelSet(refInput: ThreadRef, input: ThreadModelSetRequest): Promise<unknown> {
    const ref = ThreadRefSchema.parse(refInput);
    const body = ThreadModelSetRequestSchema.parse(input);
    const value = await this.apiJson(
      `${this.#apiPath}/apps/${encodeURIComponent(ref.appId)}/threads/${encodeURIComponent(ref.threadId)}/model`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    return (value as { model: unknown }).model;
  }

  async modelHistory(refInput: ThreadRef): Promise<readonly unknown[]> {
    const ref = ThreadRefSchema.parse(refInput);
    const value = await this.apiJson(
      `${this.#apiPath}/apps/${encodeURIComponent(ref.appId)}/threads/${encodeURIComponent(ref.threadId)}/model/history`,
    );
    return Array.isArray((value as { history?: unknown }).history)
      ? (value as { history: unknown[] }).history
      : [];
  }

  async approvals(refInput: ThreadRef): Promise<unknown[]> {
    const ref = ThreadRefSchema.parse(refInput);
    const value = await this.apiJson(
      `${this.#apiPath}/apps/${encodeURIComponent(ref.appId)}/threads/${encodeURIComponent(ref.threadId)}/approvals`,
    );
    return Array.isArray((value as { approvals?: unknown }).approvals)
      ? (value as { approvals: unknown[] }).approvals
      : [];
  }

  async userInput(refInput: ThreadRef) {
    const ref = ThreadRefSchema.parse(refInput);
    const value = await this.apiJson(
      `${this.#apiPath}/apps/${encodeURIComponent(ref.appId)}/threads/${encodeURIComponent(ref.threadId)}/user-input`,
    );
    const requests =
      typeof value === "object" && value !== null && "requests" in value
        ? (value as { requests: unknown }).requests
        : [];
    return Array.isArray(requests)
      ? requests.map((record) => UserInputRecordSchema.parse(record))
      : [];
  }

  async respondToUserInput(
    refInput: ThreadRef,
    requestId: string,
    responseInput: unknown,
  ) {
    const ref = ThreadRefSchema.parse(refInput);
    const response = UserInputAnswerRequestSchema.parse(responseInput);
    return this.apiJson(
      `${this.#apiPath}/apps/${encodeURIComponent(ref.appId)}/threads/${encodeURIComponent(ref.threadId)}/user-input/${encodeURIComponent(requestId)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(response),
      },
    );
  }

  async historyCheckpoints(
    refInput: ThreadRef,
    options?: { limit?: number },
  ): Promise<ThreadHistoryListResponse> {
    const ref = ThreadRefSchema.parse(refInput);
    const query = options?.limit === undefined
      ? ""
      : `?limit=${encodeURIComponent(String(options.limit))}`;
    const value = await this.apiJson(
      `${this.#apiPath}/apps/${encodeURIComponent(ref.appId)}/threads/${encodeURIComponent(ref.threadId)}/history${query}`,
    );
    return ThreadHistoryListResponseSchema.parse(value);
  }

  async historyDiff(
    refInput: ThreadRef,
    input: { baseCommitId?: string; headCommitId: string },
  ): Promise<ThreadHistoryDiffResponse> {
    const ref = ThreadRefSchema.parse(refInput);
    const body = ThreadHistoryDiffRequestSchema.parse(input);
    const value = await this.apiJson(
      `${this.#apiPath}/apps/${encodeURIComponent(ref.appId)}/threads/${encodeURIComponent(ref.threadId)}/history/diff`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    return ThreadHistoryDiffResponseSchema.parse(value);
  }

  async cursor(refInput: ThreadRef) {
    const ref = ThreadRefSchema.parse(refInput);
    const value = await this.apiJson(
      `${this.#apiPath}/apps/${encodeURIComponent(ref.appId)}/threads/${encodeURIComponent(ref.threadId)}/cursor`,
    );
    return ThreadOperationalStateSchema.shape.cursor.parse(
      (value as { cursor: unknown }).cursor,
    );
  }

  async decideApproval(
    refInput: ThreadRef,
    approvalId: string,
    decision: Omit<ApprovalDecision, "requestId">,
  ): Promise<void> {
    const ref = ThreadRefSchema.parse(refInput);
    const body = ApprovalDecisionSchema.parse({ ...decision, requestId: approvalId });
    await this.apiJson(
      `${this.#apiPath}/apps/${encodeURIComponent(ref.appId)}/threads/${encodeURIComponent(ref.threadId)}/approvals/${encodeURIComponent(approvalId)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
  }

  async recallSearch(
    refInput: ThreadRef,
    options: FlaryRecallSearchOptions,
  ) {
    const ref = ThreadRefSchema.parse(refInput);
    const mode = options.mode
      ? RecallSearchModeSchema.parse(options.mode)
      : undefined;
    const kinds = options.kinds?.map((kind) => RecallKindSchema.parse(kind));
    const query = new URLSearchParams({ query: options.query });
    if (mode) query.set("mode", mode);
    if (kinds?.length) query.set("kinds", kinds.join(","));
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    const value = await this.apiJson(
      `${this.#apiPath}/apps/${encodeURIComponent(ref.appId)}/threads/${encodeURIComponent(ref.threadId)}/recall/search?${query.toString()}`,
    );
    return RecallSearchResponseSchema.parse(value);
  }

  async recallOpen(
    refInput: ThreadRef,
    options: FlaryRecallOpenOptions,
  ): Promise<RecallDocument | undefined> {
    const ref = ThreadRefSchema.parse(refInput);
    const value = await this.apiJson(
      `${this.#apiPath}/apps/${encodeURIComponent(ref.appId)}/threads/${encodeURIComponent(ref.threadId)}/recall/open`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(options),
      },
    );
    const document = (value as { document?: unknown }).document;
    return document === undefined ? undefined : RecallDocumentSchema.parse(document);
  }

  async rename(refInput: ThreadRef, title: string): Promise<ThreadBinding> {
    const ref = ThreadRefSchema.parse(refInput);
    const body = ThreadRenameRequestSchema.parse({ title });
    const value = await this.apiJson(
      `${this.#apiPath}/apps/${encodeURIComponent(ref.appId)}/threads/${encodeURIComponent(ref.threadId)}/rename`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    );
    return ThreadBindingSchema.parse((value as { binding: unknown }).binding);
  }

  async unarchive(refInput: ThreadRef): Promise<ThreadBinding> {
    return this.bindingMutation(refInput, "unarchive", {});
  }

  async pin(refInput: ThreadRef, pinned = true): Promise<ThreadBinding> {
    return this.bindingMutation(
      refInput,
      "pin",
      ThreadPinRequestSchema.parse({ pinned }),
    );
  }

  async markRead(
    refInput: ThreadRef,
    throughSequence?: number,
  ): Promise<ThreadBinding> {
    return this.bindingMutation(
      refInput,
      "read",
      ThreadReadRequestSchema.parse({ throughSequence }),
    );
  }

  async delete(refInput: ThreadRef): Promise<void> {
    const ref = ThreadRefSchema.parse(refInput);
    await this.apiJson(
      `${this.#apiPath}/apps/${encodeURIComponent(ref.appId)}/threads/${encodeURIComponent(ref.threadId)}`,
      { method: "DELETE" },
    );
  }

  async interrupt(refInput: ThreadRef): Promise<void> {
    await this.control(refInput, "interrupt", {});
  }

  compact(refInput: ThreadRef, input: unknown = {}) {
    return this.control(
      refInput,
      "compact",
      ThreadCompactRequestSchema.parse(input),
    );
  }

  rollback(refInput: ThreadRef, input: unknown) {
    return this.control(
      refInput,
      "rollback",
      ThreadRollbackRequestSchema.parse(input),
    );
  }

  restore(refInput: ThreadRef, input: unknown) {
    return this.control(
      refInput,
      "restore",
      ThreadRestoreRequestSchema.parse(input),
    );
  }

  setGoal(refInput: ThreadRef, input: unknown) {
    return this.control(
      refInput,
      "goal",
      ThreadGoalRequestSchema.parse(input),
    );
  }

  async clearGoal(refInput: ThreadRef) {
    const ref = ThreadRefSchema.parse(refInput);
    return this.apiJson(
      `${this.#apiPath}/apps/${encodeURIComponent(ref.appId)}/threads/${encodeURIComponent(ref.threadId)}/goal`,
      { method: "DELETE" },
    );
  }

  async turns(
    refInput: ThreadRef,
    options: { after?: number; limit?: number; types?: readonly string[] } = {},
  ): Promise<readonly unknown[]> {
    const value = await this.listRecords(refInput, "turns", options);
    return Array.isArray((value as { turns?: unknown }).turns)
      ? (value as { turns: unknown[] }).turns
      : [];
  }

  async audit(
    refInput: ThreadRef,
    options: { after?: number; limit?: number; types?: readonly string[] } = {},
  ): Promise<readonly unknown[]> {
    const value = await this.listRecords(refInput, "audit", options);
    return Array.isArray((value as { records?: unknown }).records)
      ? (value as { records: unknown[] }).records
      : [];
  }

  async auditExport(refInput: ThreadRef): Promise<string> {
    const ref = ThreadRefSchema.parse(refInput);
    return this.apiText(
      `${this.#apiPath}/apps/${encodeURIComponent(ref.appId)}/threads/${encodeURIComponent(ref.threadId)}/audit/export`,
    );
  }

  subagent(
    refInput: ThreadRef,
    action: "list" | "spawn" | "send" | "wait" | "interrupt" | "resume" | "close",
    input: Readonly<Record<string, unknown>> = {},
  ) {
    const ref = ThreadRefSchema.parse(refInput);
    return this.apiJson(
      `${this.#apiPath}/apps/${encodeURIComponent(ref.appId)}/threads/${encodeURIComponent(ref.threadId)}/subagents/${action}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      },
    ).then((value) => (value as { result: unknown }).result);
  }

  schedule(
    refInput: ThreadRef,
    action: "register" | "list" | "history" | "pause" | "resume" | "delete",
    input: Readonly<Record<string, unknown>> = {},
  ): Promise<unknown> {
    const ref = ThreadRefSchema.parse(refInput);
    return this.apiJson(
      `${this.#apiPath}/apps/${encodeURIComponent(ref.appId)}/threads/${encodeURIComponent(ref.threadId)}/schedules/${action}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      },
    ).then((value) => (value as { result: unknown }).result);
  }

  /** The Flue observer reconnects from its last durable-stream cursor. */
  reconnect(ref: ThreadRef, options?: AgentConversationObserveOptions) {
    return this.observe(ref, options);
  }

  history(ref: ThreadRef, options?: FlueConversationHistoryOptions, agentName = ref.agentId) {
    return this.flue.agents.history(
      agentName,
      this.id(ref),
      options,
    );
  }

  observe(ref: ThreadRef, options?: AgentConversationObserveOptions, agentName = ref.agentId) {
    return this.flue.agents.observe(
      agentName,
      this.id(ref),
      options,
    );
  }

  abort(ref: ThreadRef, options?: { signal?: AbortSignal }, agentName = ref.agentId) {
    return this.flue.agents.abort(agentName, this.id(ref), options);
  }

  attachmentUrl(ref: ThreadRef, attachmentId: string, agentName = ref.agentId): string {
    return this.flue.agents.attachmentUrl(
      agentName,
      this.id(ref),
      attachmentId,
    );
  }

  private async apiJson(path: string, init: RequestInit = {}): Promise<unknown> {
    const headers = new Headers(init.headers);
    if (this.#token) headers.set("authorization", `Bearer ${this.#token}`);
    const configured =
      typeof this.#headers === "function" ? await this.#headers() : this.#headers;
    for (const [key, value] of Object.entries(configured ?? {})) {
      if (!headers.has(key)) headers.set(key, value);
    }
    const response = await this.#request(
      path.startsWith("http") ? path : `${this.#baseUrl}${path}`,
      { ...init, headers },
    );
    const body = await response.json().catch(() => undefined);
    if (!response.ok) {
      const detail =
        typeof body === "object" && body !== null && "error" in body
          ? (body as { error?: unknown }).error
          : undefined;
      const message =
        typeof detail === "string"
          ? detail
          : typeof detail === "object" && detail !== null && "message" in detail
            ? String((detail as { message: unknown }).message)
            : undefined;
      throw new Error(
        `Flary thread request failed (${response.status})${message ? `: ${message}` : ""}`,
      );
    }
    return body;
  }

  private async apiText(path: string): Promise<string> {
    const headers = new Headers();
    if (this.#token) headers.set("authorization", `Bearer ${this.#token}`);
    const configured =
      typeof this.#headers === "function" ? await this.#headers() : this.#headers;
    for (const [key, value] of Object.entries(configured ?? {})) {
      headers.set(key, value);
    }
    const response = await this.#request(`${this.#baseUrl}${path}`, { headers });
    if (!response.ok) {
      throw new Error(`Flary thread request failed (${response.status})`);
    }
    return response.text();
  }

  private async bindingMutation(
    refInput: ThreadRef,
    action: string,
    body: unknown,
  ): Promise<ThreadBinding> {
    const value = await this.control(refInput, action, body);
    return ThreadBindingSchema.parse((value as { binding: unknown }).binding);
  }

  private control(refInput: ThreadRef, action: string, body: unknown) {
    const ref = ThreadRefSchema.parse(refInput);
    return this.apiJson(
      `${this.#apiPath}/apps/${encodeURIComponent(ref.appId)}/threads/${encodeURIComponent(ref.threadId)}/${action}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
  }

  private listRecords(
    refInput: ThreadRef,
    action: string,
    options: { after?: number; limit?: number; types?: readonly string[] },
  ) {
    const ref = ThreadRefSchema.parse(refInput);
    const query = new URLSearchParams();
    if (options.after !== undefined) query.set("after", String(options.after));
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    if (options.types?.length) query.set("types", options.types.join(","));
    const suffix = query.size ? `?${query.toString()}` : "";
    return this.apiJson(
      `${this.#apiPath}/apps/${encodeURIComponent(ref.appId)}/threads/${encodeURIComponent(ref.threadId)}/${action}${suffix}`,
    );
  }
}

export function createFlaryThreadClient(
  options: CreateFlaryThreadClientOptions,
): FlaryThreadClient {
  return new FlaryThreadClient(options);
}

function joinBaseUrl(baseUrl: string, mountPath: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const mount = mountPath.replace(/^\/+|\/+$/g, "");
  if (!base && typeof location === "undefined") {
    throw new Error("A Flary thread client needs an absolute baseUrl outside a browser");
  }
  return `${base}/${mount}`;
}

function normalizeApiPath(value: string): string {
  if (!value || value === "/") return "";
  return `/${value.replace(/^\/+|\/+$/g, "")}`;
}

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
  ThreadCreateRequestSchema,
  ThreadForkRequestSchema,
  ThreadListResponseSchema,
  ThreadHistoryDiffResponseSchema,
  ThreadHistoryDiffRequestSchema,
  ThreadHistoryListResponseSchema,
  ThreadMessageRequestSchema,
  ThreadModeRequestSchema,
  ThreadOperationalStateSchema,
  type ApprovalDecision,
  type ThreadBinding,
  type ThreadCreateRequest,
  type ThreadForkRequest,
  type ThreadMessageRequest,
  type ThreadRef,
  type RecallDocument,
  type RecallReference,
  type ThreadHistoryDiffResponse,
  type ThreadHistoryListResponse,
} from "../contracts/index.js";
import { ThreadRefSchema } from "../contracts/tenancy.js";
import { threadName } from "../storage/scopes.js";

const FLARY_THREAD_AGENT = "flary-thread";

export interface CreateFlaryThreadClientOptions
  extends Omit<CreateFlueClientOptions, "baseUrl"> {
  /** Flary application origin or API base. */
  baseUrl: string;
  /** Flue mount below baseUrl. */
  mountPath?: string;
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

  constructor(options: CreateFlaryThreadClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#request = options.fetch ?? globalThis.fetch;
    this.#headers = options.headers;
    this.#token = options.token;
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
      `/api/apps/${encodeURIComponent(ref.appId)}/threads/${encodeURIComponent(ref.threadId)}/messages`,
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
      `/api/apps/${encodeURIComponent(body.workspace.appId)}/threads`,
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
      `/api/apps/${encodeURIComponent(appId)}/threads`,
    );
    return ThreadListResponseSchema.parse(value).threads;
  }

  async inspect(refInput: ThreadRef): Promise<ThreadBinding> {
    const ref = ThreadRefSchema.parse(refInput);
    const value = await this.apiJson(
      `/api/apps/${encodeURIComponent(ref.appId)}/threads/${encodeURIComponent(ref.threadId)}`,
    );
    return ThreadBindingSchema.parse((value as { binding: unknown }).binding);
  }

  async archive(refInput: ThreadRef): Promise<void> {
    const ref = ThreadRefSchema.parse(refInput);
    await this.apiJson(
      `/api/apps/${encodeURIComponent(ref.appId)}/threads/${encodeURIComponent(ref.threadId)}/archive`,
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
      `/api/apps/${encodeURIComponent(ref.appId)}/threads/${encodeURIComponent(ref.threadId)}/fork`,
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
      `/api/apps/${encodeURIComponent(ref.appId)}/threads/${encodeURIComponent(ref.threadId)}/mode`,
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
      `/api/apps/${encodeURIComponent(ref.appId)}/threads/${encodeURIComponent(ref.threadId)}/connections`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    return ThreadBindingSchema.parse((value as { binding: unknown }).binding);
  }

  async approvals(refInput: ThreadRef): Promise<unknown[]> {
    const ref = ThreadRefSchema.parse(refInput);
    const value = await this.apiJson(
      `/api/apps/${encodeURIComponent(ref.appId)}/threads/${encodeURIComponent(ref.threadId)}/approvals`,
    );
    return Array.isArray((value as { approvals?: unknown }).approvals)
      ? (value as { approvals: unknown[] }).approvals
      : [];
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
      `/api/apps/${encodeURIComponent(ref.appId)}/threads/${encodeURIComponent(ref.threadId)}/history${query}`,
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
      `/api/apps/${encodeURIComponent(ref.appId)}/threads/${encodeURIComponent(ref.threadId)}/history/diff`,
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
      `/api/apps/${encodeURIComponent(ref.appId)}/threads/${encodeURIComponent(ref.threadId)}/cursor`,
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
      `/api/apps/${encodeURIComponent(ref.appId)}/threads/${encodeURIComponent(ref.threadId)}/approvals/${encodeURIComponent(approvalId)}`,
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
      `/api/apps/${encodeURIComponent(ref.appId)}/threads/${encodeURIComponent(ref.threadId)}/recall/search?${query.toString()}`,
    );
    return RecallSearchResponseSchema.parse(value);
  }

  async recallOpen(
    refInput: ThreadRef,
    options: FlaryRecallOpenOptions,
  ): Promise<RecallDocument | undefined> {
    const ref = ThreadRefSchema.parse(refInput);
    const value = await this.apiJson(
      `/api/apps/${encodeURIComponent(ref.appId)}/threads/${encodeURIComponent(ref.threadId)}/recall/open`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(options),
      },
    );
    const document = (value as { document?: unknown }).document;
    return document === undefined ? undefined : RecallDocumentSchema.parse(document);
  }

  /** The Flue observer reconnects from its last durable-stream cursor. */
  reconnect(ref: ThreadRef, options?: AgentConversationObserveOptions) {
    return this.observe(ref, options);
  }

  history(ref: ThreadRef, options?: FlueConversationHistoryOptions) {
    return this.flue.agents.history(
      FLARY_THREAD_AGENT,
      this.id(ref),
      options,
    );
  }

  observe(ref: ThreadRef, options?: AgentConversationObserveOptions) {
    return this.flue.agents.observe(
      FLARY_THREAD_AGENT,
      this.id(ref),
      options,
    );
  }

  abort(ref: ThreadRef, options?: { signal?: AbortSignal }) {
    return this.flue.agents.abort(FLARY_THREAD_AGENT, this.id(ref), options);
  }

  attachmentUrl(ref: ThreadRef, attachmentId: string): string {
    return this.flue.agents.attachmentUrl(
      FLARY_THREAD_AGENT,
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

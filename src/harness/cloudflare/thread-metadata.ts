import {
  ApprovalDecisionSchema,
  ApprovalRequestSchema,
  CapabilityLeaseSchema,
  ThreadCursorSchema,
  ThreadMetadataPatchSchema,
  ThreadOperationalStateSchema,
  ThreadRefSchema,
  ThreadBindingSchema,
  ThreadApprovalRecordSchema,
  ProviderSessionSchema,
  UsageRecordSchema,
  UserInputRecordSchema,
  UserInputRequestSchema,
  UserInputResponseSchema,
  ToolLifecycleEventSchema,
  type ToolLifecycleEvent,
  type ApprovalDecision,
  type ApprovalRequest,
  type CapabilityLease,
  type SandboxJob,
  type ThreadMetadataPatch,
  type ThreadOperationalState,
  type ThreadRef,
  type ThreadBinding,
  type ProviderSession,
  type UsageRecord,
  type UserInputQuestion,
  type UserInputRecord,
  type UserInputResponse,
  type IdentityReference,
} from "../contracts/index.js";
import { SandboxJobSchema } from "../contracts/runtime.js";
import {
  ApprovalLifecycleEventSchema,
  DurableApprovalRecordSchema,
  DurableToolCallSnapshotSchema,
  type DurableApprovalRecord,
  type DurableToolCallSnapshot,
} from "../execution/approval-continuation.js";
import { redactSecrets } from "../execution/redaction.js";

type ThreadSql = {
  exec<T = Record<string, unknown>>(...args: any[]): { toArray(): T[] };
};

type IdentityRow = { ref_json: string };
type StateRow = {
  mode_id: string;
  status: ThreadOperationalState["status"];
  active_run_id: string | null;
  metadata_json: string | null;
  updated_at: string;
};
type CursorRow = {
  flue_offset: string;
  flary_sequence: number;
  updated_at: string;
};
type ProviderSessionRow = { session_json: string };
type BindingRow = { binding_json: string };
type ApprovalRow = {
  approval_id: string;
  request_json: string;
  tool_call_json: string | null;
  decision_json: string | null;
  updated_at: string;
};
type ThreadEventRow = {
  event_id: string;
  run_id: string;
  event_json: string;
  created_at: string;
};
type UserInputRow = {
  request_id: string;
  request_json: string;
  response_json: string | null;
  updated_at: string;
};

/**
 * Operational state for one Flue agent instance.
 *
 * Flue owns the conversation stream. This store only keeps Flary metadata
 * needed for authorization, approvals, provider handoff, usage, and replay
 * cursors. It must never receive a model message or tool transcript entry.
 */
export class FlaryThreadMetadataStore {
  readonly #sql: ThreadSql;
  readonly #ref: ThreadRef;
  readonly #approvalWaiters = new Map<string, Set<(decision: ApprovalDecision) => void>>();

  constructor(sql: unknown, refInput: ThreadRef) {
    this.#sql = sql as ThreadSql;
    this.#ref = ThreadRefSchema.parse(refInput);
    this.ensureSchema();
    this.ensureIdentity();
  }

  /**
   * Copy the D1 registry binding into this thread object.
   *
   * Workspace identity is write-once. Other fields can be refreshed from the
   * registry because mode and connection grants are operational settings.
   */
  initializeBinding(bindingInput: ThreadBinding): ThreadBinding {
    const binding = ThreadBindingSchema.parse(bindingInput);
    if (JSON.stringify(binding.thread) !== JSON.stringify(this.#ref)) {
      throw new Error("Thread binding identity does not match this Durable Object");
    }
    const stored = this.readBinding();
    if (stored) {
      if (JSON.stringify(stored.workspace) !== JSON.stringify(binding.workspace)) {
        throw new Error("Thread workspace binding is immutable");
      }
      this.#sql.exec(
        `UPDATE flary_thread_binding SET binding_json = ?, updated_at = ?
         WHERE singleton = 1`,
        JSON.stringify(binding),
        new Date().toISOString(),
      );
    } else {
      this.#sql.exec(
        `INSERT INTO flary_thread_binding (singleton, binding_json, created_at, updated_at)
         VALUES (1, ?, ?, ?)`,
        JSON.stringify(binding),
        binding.createdAt,
        binding.updatedAt,
      );
    }
    const current = this.read();
    if (current.mode !== binding.defaultMode) {
      this.#sql.exec(
        `UPDATE flary_thread_operational SET mode_id = ?, updated_at = ?
         WHERE singleton = 1`,
        binding.defaultMode,
        binding.updatedAt,
      );
    }
    return binding;
  }

  readBinding(): ThreadBinding | undefined {
    const row = this.#sql
      .exec<BindingRow>(`SELECT binding_json FROM flary_thread_binding WHERE singleton = 1`)
      .toArray()[0];
    return row ? ThreadBindingSchema.parse(JSON.parse(row.binding_json)) : undefined;
  }

  setConnectionGrants(connectionIds: string[]): ThreadBinding {
    const current = this.readBinding();
    if (!current) throw new Error("Thread binding has not been initialized");
    const next = ThreadBindingSchema.parse({
      ...current,
      connectionIds,
      updatedAt: new Date().toISOString(),
    });
    this.#sql.exec(
      `UPDATE flary_thread_binding SET binding_json = ?, updated_at = ?
       WHERE singleton = 1`,
      JSON.stringify(next),
      next.updatedAt,
    );
    return next;
  }

  listApprovals() {
    return this.#sql
      .exec<ApprovalRow>(
        `SELECT approval_id, request_json, tool_call_json, decision_json, updated_at
         FROM flary_thread_approvals ORDER BY updated_at DESC`,
      )
      .toArray()
      .map((row) =>
        ThreadApprovalRecordSchema.parse({
          request: JSON.parse(row.request_json),
          decision: row.decision_json ? JSON.parse(row.decision_json) : null,
        }),
      );
  }

  decideApproval(decisionInput: ApprovalDecision): boolean {
    const decision = ApprovalDecisionSchema.parse(decisionInput);
    const row = this.#sql
      .exec<ApprovalRow>(
        `SELECT approval_id, request_json, tool_call_json, decision_json, updated_at
         FROM flary_thread_approvals WHERE approval_id = ?`,
        decision.requestId,
      )
      .toArray()[0];
    if (!row) throw new Error("Approval request not found");
    if (row.decision_json) {
      const existing = ApprovalDecisionSchema.parse(JSON.parse(row.decision_json));
      if (JSON.stringify(existing) !== JSON.stringify(decision)) {
        throw new Error("Approval request has already been decided");
      }
      return false;
    }
    const request = ApprovalRequestSchema.parse(JSON.parse(row.request_json));
    this.#sql.exec(
      `UPDATE flary_thread_approvals SET decision_json = ?, updated_at = ?
       WHERE approval_id = ?`,
      JSON.stringify(decision),
      decision.decidedAt,
      decision.requestId,
    );
    const nextStatus =
      decision.status === "approved"
        ? this.hasPendingApproval(request.runId)
          ? "waiting"
          : "running"
        : "failed";
    this.recordRun(request.runId, nextStatus);
    this.patch({
      status: nextStatus,
      activeRunId: request.runId,
    });
    this.appendApprovalResolvedEvent(request, decision);
    for (const resolve of this.#approvalWaiters.get(decision.requestId) ?? []) {
      resolve(decision);
    }
    this.#approvalWaiters.delete(decision.requestId);
    return true;
  }

  /** Read the private exact call bound to one approval request. */
  getToolApproval(toolCallInput: DurableToolCallSnapshot): DurableApprovalRecord | undefined {
    const toolCall = DurableToolCallSnapshotSchema.parse(toolCallInput);
    return this.findToolApproval({
      ...toolCall,
      callId: toolCall.callId,
    });
  }

  /** Find an approval by the model call when the original call omitted callId. */
  findToolApproval(input: {
    runId: string;
    toolId: string;
    arguments: Record<string, unknown>;
    callId?: string;
    idempotencyKey?: string;
    operation?: "read" | "write";
    resourceKey?: string;
  }): DurableApprovalRecord | undefined {
    const rows = this.#sql
      .exec<ApprovalRow>(
        `SELECT approval_id, request_json, tool_call_json, decision_json, updated_at
         FROM flary_thread_approvals
         ORDER BY updated_at DESC`,
      )
      .toArray();
    for (const row of rows) {
      if (!row.tool_call_json) continue;
      const stored = DurableToolCallSnapshotSchema.parse(JSON.parse(row.tool_call_json));
      if (
        stored.runId !== input.runId ||
        stored.toolId !== input.toolId ||
        (input.callId && stored.callId !== input.callId) ||
        (input.idempotencyKey && stored.idempotencyKey !== input.idempotencyKey) ||
        (input.operation && stored.operation !== input.operation) ||
        (input.resourceKey && stored.resourceKey !== input.resourceKey) ||
        stableJson(stored.arguments) !== stableJson(input.arguments)
      )
        continue;
      return DurableApprovalRecordSchema.parse({
        request: JSON.parse(row.request_json),
        toolCall: stored,
        decision: row.decision_json ? JSON.parse(row.decision_json) : null,
      });
    }
    return undefined;
  }

  /** Wait in the current isolate, while retaining the durable decision in SQL. */
  async waitForToolApproval(
    requestIdInput: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<ApprovalDecision> {
    const requestId = String(requestIdInput);
    const row = this.#sql
      .exec<ApprovalRow>(
        `SELECT approval_id, request_json, tool_call_json, decision_json, updated_at
         FROM flary_thread_approvals WHERE approval_id = ?`,
        requestId,
      )
      .toArray()[0];
    if (!row) throw new Error("Approval request not found");
    const request = ApprovalRequestSchema.parse(JSON.parse(row.request_json));
    if (row.decision_json) {
      return ApprovalDecisionSchema.parse(JSON.parse(row.decision_json));
    }
    if (request.expiresAt && Date.parse(request.expiresAt) <= Date.now()) {
      this.decideApproval(expiredDecision(request.id));
      return this.waitForToolApproval(request.id, options);
    }
    return new Promise<ApprovalDecision>((resolve, reject) => {
      const waiters = this.#approvalWaiters.get(request.id) ?? new Set();
      waiters.add(resolve);
      this.#approvalWaiters.set(request.id, waiters);
      const onAbort = () => {
        waiters.delete(resolve);
        if (waiters.size === 0) this.#approvalWaiters.delete(request.id);
        reject(options.signal?.reason ?? new Error("Approval wait aborted"));
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (request.expiresAt) {
        const delay = Math.max(0, Date.parse(request.expiresAt) - Date.now());
        setTimeout(() => {
          if (!this.#approvalWaiters.get(request.id)?.has(resolve)) return;
          try {
            this.decideApproval(expiredDecision(request.id));
          } catch {
            // A host decision won the race. The persisted decision is authoritative.
          }
        }, delay);
      }
    });
  }

  hasApprovalWaiter(requestIdInput: string): boolean {
    return (this.#approvalWaiters.get(String(requestIdInput))?.size ?? 0) > 0;
  }

  expireApproval(requestIdInput: string): void {
    const requestId = String(requestIdInput);
    const row = this.#sql
      .exec<ApprovalRow>(
        `SELECT approval_id, request_json, tool_call_json, decision_json, updated_at
         FROM flary_thread_approvals WHERE approval_id = ?`,
        requestId,
      )
      .toArray()[0];
    if (!row || row.decision_json) return;
    const request = ApprovalRequestSchema.parse(JSON.parse(row.request_json));
    if (!request.expiresAt || Date.parse(request.expiresAt) > Date.now()) return;
    this.decideApproval(expiredDecision(request.id));
  }

  /** Return safe, durable Flary and tool lifecycle events for one run. */
  listEvents(runIdInput?: string): unknown[] {
    const rows = this.#sql
      .exec<ThreadEventRow>(
        runIdInput
          ? `SELECT event_id, run_id, event_json, created_at
             FROM flary_thread_events WHERE run_id = ? ORDER BY rowid ASC`
          : `SELECT event_id, run_id, event_json, created_at
             FROM flary_thread_events ORDER BY rowid ASC`,
        ...(runIdInput ? [runIdInput] : []),
      )
      .toArray();
    return rows.map((row) => JSON.parse(row.event_json));
  }

  recordToolEvent(eventInput: ToolLifecycleEvent): void {
    const event = ToolLifecycleEventSchema.parse(eventInput);
    this.appendThreadEvent(`tool:${event.type}:${event.runId}:${event.callId}`, event);
  }

  listUserInputRequests(): UserInputRecord[] {
    return this.#sql
      .exec<UserInputRow>(
        `SELECT request_id, request_json, response_json, updated_at
         FROM flary_thread_user_input ORDER BY updated_at DESC`,
      )
      .toArray()
      .map((row) =>
        UserInputRecordSchema.parse({
          request: JSON.parse(row.request_json),
          response: row.response_json ? JSON.parse(row.response_json) : null,
        }),
      );
  }

  createUserInputRequest(input: {
    questions: UserInputQuestion[];
    requestedBy: IdentityReference;
    expiresAt?: string;
  }) {
    const request = UserInputRequestSchema.parse({
      id: `input_${crypto.randomUUID().replaceAll("-", "")}`,
      threadId: this.#ref.threadId,
      questions: input.questions,
      requestedBy: input.requestedBy,
      requestedAt: new Date().toISOString(),
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    });
    this.#sql.exec(
      `INSERT INTO flary_thread_user_input
        (request_id, request_json, response_json, updated_at)
       VALUES (?, ?, NULL, ?)`,
      request.id,
      JSON.stringify(request),
      request.requestedAt,
    );
    return request;
  }

  respondToUserInput(responseInput: UserInputResponse): UserInputRecord {
    const response = UserInputResponseSchema.parse(responseInput);
    const row = this.#sql
      .exec<UserInputRow>(
        `SELECT request_id, request_json, response_json, updated_at
         FROM flary_thread_user_input WHERE request_id = ?`,
        response.requestId,
      )
      .toArray()[0];
    if (!row) throw new Error("User input request not found");
    const request = UserInputRequestSchema.parse(JSON.parse(row.request_json));
    if (request.threadId !== this.#ref.threadId) {
      throw new Error("User input request belongs to another thread");
    }
    if (row.response_json) {
      const existing = UserInputResponseSchema.parse(JSON.parse(row.response_json));
      if (JSON.stringify(existing) !== JSON.stringify(response)) {
        throw new Error("User input request has already been answered");
      }
      return UserInputRecordSchema.parse({ request, response: existing });
    }
    this.#sql.exec(
      `UPDATE flary_thread_user_input
       SET response_json = ?, updated_at = ?
       WHERE request_id = ? AND response_json IS NULL`,
      JSON.stringify(response),
      response.answeredAt,
      response.requestId,
    );
    return UserInputRecordSchema.parse({ request, response });
  }

  hasApprovedTool(toolId: string): boolean {
    const now = Date.now();
    return this.#sql
      .exec<ApprovalRow>(
        `SELECT approval_id, request_json, decision_json, updated_at
         FROM flary_thread_approvals`,
      )
      .toArray()
      .some((row) => {
        if (!row.decision_json) return false;
        const decision = JSON.parse(row.decision_json) as { status?: string };
        if (decision.status !== "approved") return false;
        const request = JSON.parse(row.request_json) as {
          toolCallId?: string;
          resourceId?: string;
          expiresAt?: string;
          context?: { toolId?: string };
        };
        if (request.expiresAt && Date.parse(request.expiresAt) <= now) return false;
        return (
          request.toolCallId === toolId ||
          request.resourceId === toolId ||
          request.context?.toolId === toolId
        );
      });
  }

  /** Issue a short-lived capability for one already approved tool. */
  issueToolLease(toolId: string, ttlMs = 15 * 60_000): CapabilityLease {
    const now = Date.now();
    const row = this.#sql
      .exec<ApprovalRow>(
        `SELECT approval_id, request_json, decision_json, updated_at
         FROM flary_thread_approvals ORDER BY updated_at DESC`,
      )
      .toArray()
      .find((candidate) => {
        if (!candidate.decision_json) return false;
        const decision = JSON.parse(candidate.decision_json) as { status?: string };
        if (decision.status !== "approved") return false;
        const request = JSON.parse(candidate.request_json) as {
          toolCallId?: string;
          resourceId?: string;
          expiresAt?: string;
          context?: { toolId?: string };
        };
        return (
          (!request.expiresAt || Date.parse(request.expiresAt) > now) &&
          (request.toolCallId === toolId ||
            request.resourceId === toolId ||
            request.context?.toolId === toolId)
        );
      });
    if (!row) throw new Error("No active approval grants this tool");
    return this.issueCapabilityLease(row.approval_id, toolId, ttlMs);
  }

  createToolApproval(input: {
    runId: string;
    toolId: string;
    reason: string;
    requestedBy: ApprovalRequest["requestedBy"];
    toolCall?: DurableToolCallSnapshot;
  }): ApprovalRequest {
    const toolCall = DurableToolCallSnapshotSchema.parse(
      input.toolCall ?? {
        runId: input.runId,
        callId: `legacy_${input.toolId}`,
        toolId: input.toolId,
        arguments: {},
        operation: "write",
      },
    );
    if (toolCall.runId !== input.runId) {
      throw new Error("Approval tool call does not belong to the request run");
    }
    const pending = this.#sql
      .exec<ApprovalRow>(
        `SELECT approval_id, request_json, tool_call_json, decision_json, updated_at
         FROM flary_thread_approvals
         WHERE decision_json IS NULL ORDER BY updated_at DESC`,
      )
      .toArray()
      .map((row) => ({
        request: ApprovalRequestSchema.parse(JSON.parse(row.request_json)),
        toolCall: row.tool_call_json
          ? DurableToolCallSnapshotSchema.parse(JSON.parse(row.tool_call_json))
          : undefined,
      }))
      .find((candidate) =>
        candidate.toolCall
          ? sameToolCall(candidate.toolCall, toolCall)
          : candidate.request.runId === input.runId &&
            (candidate.request.toolCallId === input.toolId ||
              candidate.request.resourceId === input.toolId ||
              candidate.request.context?.toolId === input.toolId),
      );
    if (pending) return pending.request;

    const request = ApprovalRequestSchema.parse({
      id: `approval_${crypto.randomUUID().replaceAll("-", "")}`,
      runId: input.runId,
      action: "tool-call",
      reason: input.reason,
      requestedBy: input.requestedBy,
      resourceId: input.toolId,
      toolCallId: toolCall.callId,
      requestedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      context: {
        toolId: input.toolId,
        operation: toolCall.operation,
        ...(toolCall.resourceKey ? { resourceKey: toolCall.resourceKey } : {}),
      },
    });
    this.recordApproval(request, undefined, toolCall);
    this.recordRun(request.runId, "waiting");
    this.patch({ status: "waiting", activeRunId: request.runId });
    this.appendApprovalRequestedEvent(request);
    this.appendThreadEvent(`run.waiting:${request.runId}:${request.id}`, {
      type: "run.waiting",
      runId: request.runId,
      approvalId: request.id,
      reason: request.reason,
      occurredAt: request.requestedAt,
    });
    return request;
  }

  /** Issue a bounded capability after a matching approval was accepted. */
  issueCapabilityLease(approvalId: string, toolId: string, ttlMs = 15 * 60_000): CapabilityLease {
    const row = this.#sql
      .exec<ApprovalRow>(
        `SELECT approval_id, request_json, decision_json, updated_at
         FROM flary_thread_approvals WHERE approval_id = ?`,
        approvalId,
      )
      .toArray()[0];
    if (!row) throw new Error("Approval request not found");
    const request = ApprovalRequestSchema.parse(JSON.parse(row.request_json));
    const decision = row.decision_json
      ? ApprovalDecisionSchema.parse(JSON.parse(row.decision_json))
      : undefined;
    if (!decision || decision.status !== "approved") {
      throw new Error("A capability lease requires an approved request");
    }
    if (
      request.toolCallId !== toolId &&
      request.resourceId !== toolId &&
      request.context?.toolId !== toolId
    ) {
      throw new Error("Approval does not grant the requested tool");
    }
    const issuedAt = new Date().toISOString();
    const requestedExpiry = request.expiresAt ? Date.parse(request.expiresAt) : Date.now() + ttlMs;
    const expiresAt = new Date(Math.min(Date.now() + ttlMs, requestedExpiry)).toISOString();
    if (Date.parse(expiresAt) <= Date.now()) {
      throw new Error("The approval request has expired");
    }
    return CapabilityLeaseSchema.parse({
      id: `lease_${crypto.randomUUID().replaceAll("-", "")}`,
      approvalId,
      toolId,
      issuedAt,
      expiresAt,
    });
  }

  read(): ThreadOperationalState {
    const state = this.#sql
      .exec<StateRow>(
        `SELECT mode_id, status, active_run_id, metadata_json, updated_at
           FROM flary_thread_operational WHERE singleton = 1`,
      )
      .toArray()[0];
    const cursor = this.#sql
      .exec<CursorRow>(
        `SELECT flue_offset, flary_sequence, updated_at
           FROM flary_thread_cursor WHERE singleton = 1`,
      )
      .toArray()[0];
    const provider = this.#sql
      .exec<ProviderSessionRow>(
        `SELECT session_json FROM flary_thread_provider_session
           WHERE singleton = 1`,
      )
      .toArray()[0];
    if (!state || !cursor) {
      const now = new Date().toISOString();
      const binding = this.readBinding();
      this.#sql.exec(
        `INSERT OR IGNORE INTO flary_thread_operational
          (singleton, mode_id, status, active_run_id, metadata_json, updated_at)
         VALUES (1, ?, 'idle', NULL, NULL, ?)`,
        binding?.defaultMode ?? "ask",
        now,
      );
      this.#sql.exec(
        `INSERT OR IGNORE INTO flary_thread_cursor
          (singleton, flue_offset, flary_sequence, updated_at)
         VALUES (1, '0', 0, ?)`,
        now,
      );
      return this.read();
    }
    return ThreadOperationalStateSchema.parse({
      thread: this.#ref,
      mode: state.mode_id,
      status: state.status,
      ...(state.active_run_id ? { activeRunId: state.active_run_id } : {}),
      cursor: ThreadCursorSchema.parse({
        thread: this.#ref,
        flueOffset: cursor.flue_offset,
        flarySequence: Number(cursor.flary_sequence),
        updatedAt: cursor.updated_at,
      }),
      ...(provider
        ? { providerSession: ProviderSessionSchema.parse(JSON.parse(provider.session_json)) }
        : {}),
      ...(state.metadata_json ? { metadata: JSON.parse(state.metadata_json) } : {}),
      updatedAt: state.updated_at,
    });
  }

  patch(patchInput: ThreadMetadataPatch): ThreadOperationalState {
    const patch = ThreadMetadataPatchSchema.parse(patchInput);
    const current = this.read();
    const now = new Date().toISOString();
    const nextMode = patch.mode ?? current.mode;
    const nextStatus = patch.status ?? current.status;
    const nextRunId =
      patch.activeRunId === undefined ? (current.activeRunId ?? null) : patch.activeRunId;
    const nextMetadata = patch.metadata ?? current.metadata;
    const nextOffset = patch.flueOffset ?? current.cursor.flueOffset;
    const nextSequence = patch.flarySequence ?? current.cursor.flarySequence;
    this.#sql.exec(
      `UPDATE flary_thread_operational
          SET mode_id = ?, status = ?, active_run_id = ?, metadata_json = ?, updated_at = ?
        WHERE singleton = 1`,
      nextMode,
      nextStatus,
      nextRunId,
      nextMetadata ? JSON.stringify(nextMetadata) : null,
      now,
    );
    this.#sql.exec(
      `UPDATE flary_thread_cursor
          SET flue_offset = ?, flary_sequence = ?, updated_at = ?
        WHERE singleton = 1`,
      nextOffset,
      nextSequence,
      now,
    );
    if (patch.providerSession !== undefined) {
      if (patch.providerSession === null) {
        this.#sql.exec("DELETE FROM flary_thread_provider_session WHERE singleton = 1");
      } else {
        const providerSession = ProviderSessionSchema.parse(patch.providerSession);
        this.#sql.exec(
          `INSERT INTO flary_thread_provider_session
            (singleton, session_json, updated_at)
           VALUES (1, ?, ?)
           ON CONFLICT(singleton) DO UPDATE SET
             session_json = excluded.session_json,
             updated_at = excluded.updated_at`,
          JSON.stringify(providerSession),
          now,
        );
      }
    }
    return this.read();
  }

  recordProviderSession(sessionInput: ProviderSession): void {
    const session = ProviderSessionSchema.parse(sessionInput);
    this.#sql.exec(
      `INSERT INTO flary_thread_provider_session
        (singleton, session_json, updated_at)
       VALUES (1, ?, ?)
       ON CONFLICT(singleton) DO UPDATE SET
         session_json = excluded.session_json,
         updated_at = excluded.updated_at`,
      JSON.stringify(session),
      session.updatedAt,
    );
  }

  recordApproval(
    requestInput: ApprovalRequest,
    decisionInput?: ApprovalDecision,
    toolCallInput?: DurableToolCallSnapshot,
  ): void {
    const request = ApprovalRequestSchema.parse(requestInput);
    const toolCall = toolCallInput ? DurableToolCallSnapshotSchema.parse(toolCallInput) : undefined;
    if (toolCall && toolCall.runId !== request.runId) {
      throw new Error("Approval tool call does not belong to the request run");
    }
    const decision = decisionInput ? ApprovalDecisionSchema.parse(decisionInput) : undefined;
    if (decision && decision.requestId !== request.id) {
      throw new Error("Approval decision does not match the request");
    }
    this.#sql.exec(
      `INSERT INTO flary_thread_approvals
        (approval_id, request_json, tool_call_json, decision_json, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(approval_id) DO UPDATE SET
         request_json = excluded.request_json,
         tool_call_json = COALESCE(excluded.tool_call_json, flary_thread_approvals.tool_call_json),
         decision_json = excluded.decision_json,
         updated_at = excluded.updated_at`,
      request.id,
      JSON.stringify(request),
      toolCall ? JSON.stringify(toolCall) : null,
      decision ? JSON.stringify(decision) : null,
      new Date().toISOString(),
    );
  }

  recordUsage(recordInput: UsageRecord): void {
    const record = UsageRecordSchema.parse({
      ...recordInput,
      threadId: recordInput.threadId,
    });
    if (record.threadId !== this.#ref.threadId) {
      throw new Error("Usage record does not belong to this thread");
    }
    this.#sql.exec(
      `INSERT OR REPLACE INTO flary_thread_usage
        (usage_id, record_json, recorded_at)
       VALUES (?, ?, ?)`,
      record.id,
      JSON.stringify(record),
      record.recordedAt,
    );
  }

  recordSandboxJob(jobInput: SandboxJob): void {
    const job = SandboxJobSchema.parse(jobInput);
    this.#sql.exec(
      `INSERT OR REPLACE INTO flary_thread_sandbox_jobs
        (job_id, job_json, updated_at)
       VALUES (?, ?, ?)`,
      job.id,
      JSON.stringify(job),
      new Date().toISOString(),
    );
  }

  recordRun(runId: string, status: string, metadata?: Record<string, unknown>): void {
    this.#sql.exec(
      `INSERT OR REPLACE INTO flary_thread_runs
        (run_id, status, metadata_json, updated_at)
       VALUES (?, ?, ?, ?)`,
      runId,
      runStatus(status),
      metadata ? JSON.stringify(redactSecrets(metadata)) : null,
      new Date().toISOString(),
    );
  }

  private appendApprovalRequestedEvent(request: ApprovalRequest): void {
    const event = ApprovalLifecycleEventSchema.parse({
      type: "approval.requested",
      runId: request.runId,
      approvalId: request.id,
      request,
      occurredAt: request.requestedAt,
    });
    this.appendThreadEvent(`approval.requested:${request.id}`, event);
  }

  private appendApprovalResolvedEvent(request: ApprovalRequest, decision: ApprovalDecision): void {
    const event = ApprovalLifecycleEventSchema.parse({
      type: "approval.resolved",
      runId: request.runId,
      approvalId: request.id,
      decision,
      occurredAt: decision.decidedAt,
    });
    this.appendThreadEvent(`approval.resolved:${request.id}`, event);
  }

  private appendThreadEvent(eventId: string, input: unknown): void {
    const safe = redactSecrets(input);
    this.#sql.exec(
      `INSERT OR IGNORE INTO flary_thread_events
        (event_id, run_id, event_json, created_at)
       VALUES (?, ?, ?, ?)`,
      eventId,
      typeof safe === "object" && safe !== null && "runId" in safe
        ? String((safe as { runId: unknown }).runId)
        : this.#ref.threadId,
      JSON.stringify(safe),
      new Date().toISOString(),
    );
  }

  private hasPendingApproval(runId: string): boolean {
    return this.#sql
      .exec<ApprovalRow>(
        `SELECT approval_id, request_json, tool_call_json, decision_json, updated_at
         FROM flary_thread_approvals`,
      )
      .toArray()
      .some((row) => {
        if (row.decision_json) return false;
        return ApprovalRequestSchema.parse(JSON.parse(row.request_json)).runId === runId;
      });
  }

  private ensureSchema(): void {
    this.#sql.exec(`
      CREATE TABLE IF NOT EXISTS flary_thread_identity (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        ref_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS flary_thread_binding (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        binding_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS flary_thread_operational (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        mode_id TEXT NOT NULL,
        status TEXT NOT NULL,
        active_run_id TEXT,
        metadata_json TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS flary_thread_cursor (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        flue_offset TEXT NOT NULL,
        flary_sequence INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS flary_thread_provider_session (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        session_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS flary_thread_approvals (
        approval_id TEXT PRIMARY KEY,
        request_json TEXT NOT NULL,
        tool_call_json TEXT,
        decision_json TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS flary_thread_events (
        event_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        event_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS flary_thread_user_input (
        request_id TEXT PRIMARY KEY,
        request_json TEXT NOT NULL,
        response_json TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS flary_thread_usage (
        usage_id TEXT PRIMARY KEY,
        record_json TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS flary_thread_sandbox_jobs (
        job_id TEXT PRIMARY KEY,
        job_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS flary_thread_runs (
        run_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        metadata_json TEXT,
        updated_at TEXT NOT NULL
      );
    `);
    try {
      this.#sql.exec("ALTER TABLE flary_thread_approvals ADD COLUMN tool_call_json TEXT");
    } catch {
      // Existing Durable Objects already have the column.
    }
  }

  private ensureIdentity(): void {
    const existing = this.#sql
      .exec<IdentityRow>(`SELECT ref_json FROM flary_thread_identity WHERE singleton = 1`)
      .toArray()[0];
    if (existing) {
      const stored = ThreadRefSchema.parse(JSON.parse(existing.ref_json));
      if (JSON.stringify(stored) !== JSON.stringify(this.#ref)) {
        throw new Error("Flary thread identity does not match this Durable Object");
      }
      return;
    }
    this.#sql.exec(
      `INSERT INTO flary_thread_identity (singleton, ref_json, created_at)
       VALUES (1, ?, ?)`,
      JSON.stringify(this.#ref),
      new Date().toISOString(),
    );
  }
}

function runStatus(value: string): string {
  if (!/^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(value)) {
    throw new Error("Run status must be a safe identifier");
  }
  return value;
}

function sameToolCall(left: DurableToolCallSnapshot, right: DurableToolCallSnapshot): boolean {
  return (
    left.runId === right.runId &&
    left.callId === right.callId &&
    left.toolId === right.toolId &&
    left.operation === right.operation &&
    left.resourceKey === right.resourceKey &&
    left.idempotencyKey === right.idempotencyKey &&
    stableJson(left.arguments) === stableJson(right.arguments)
  );
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
}

function expiredDecision(requestId: string): ApprovalDecision {
  return ApprovalDecisionSchema.parse({
    requestId,
    status: "expired",
    decidedBy: { id: "flary", kind: "system", version: "1" },
    decidedAt: new Date().toISOString(),
  });
}

import { z } from "zod";

import {
  ApprovalDecisionSchema,
  ApprovalRequestSchema,
  IdentifierSchema,
  JsonObjectSchema,
  NonEmptyStringSchema,
  TimestampSchema,
  type ApprovalDecision,
  type ApprovalRequest,
} from "../contracts/index.js";

/** The exact private tool invocation held while an approval is pending. */
export const DurableToolCallSnapshotSchema = z
  .object({
    runId: IdentifierSchema,
    callId: IdentifierSchema,
    toolId: IdentifierSchema,
    arguments: JsonObjectSchema,
    operation: z.enum(["read", "write"]),
    resourceKey: IdentifierSchema.optional(),
    idempotencyKey: IdentifierSchema.optional(),
  })
  .strict();
export type DurableToolCallSnapshot = z.infer<
  typeof DurableToolCallSnapshotSchema
>;

export const DurableApprovalRecordSchema = z
  .object({
    request: ApprovalRequestSchema,
    toolCall: DurableToolCallSnapshotSchema,
    decision: ApprovalDecisionSchema.nullable(),
  })
  .strict();
export type DurableApprovalRecord = z.infer<
  typeof DurableApprovalRecordSchema
>;

export const ApprovalLifecycleEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("approval.requested"),
      runId: IdentifierSchema,
      approvalId: IdentifierSchema,
      request: ApprovalRequestSchema,
      occurredAt: TimestampSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("approval.resolved"),
      runId: IdentifierSchema,
      approvalId: IdentifierSchema,
      decision: ApprovalDecisionSchema,
      occurredAt: TimestampSchema,
    })
    .strict(),
]);
export type ApprovalLifecycleEvent = z.infer<
  typeof ApprovalLifecycleEventSchema
>;

export interface ToolApprovalStore {
  create(input: {
    request: ApprovalRequest;
    toolCall: DurableToolCallSnapshot;
  }): Promise<DurableApprovalRecord> | DurableApprovalRecord;
  get(requestId: string):
    | Promise<DurableApprovalRecord | undefined>
    | DurableApprovalRecord
    | undefined;
  decide(
    decision: ApprovalDecision,
  ): Promise<DurableApprovalRecord> | DurableApprovalRecord;
  wait(
    requestId: string,
    options?: { signal?: AbortSignal },
  ): Promise<ApprovalDecision>;
}

export type ApprovalRecoveryState = "none" | "waiting" | "ready";

export interface ApprovalRecoveryCall {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly arguments: Record<string, unknown>;
  readonly signal?: AbortSignal;
}

export interface ApprovalRecoveryResult {
  readonly content: string;
  readonly isError?: boolean;
  readonly output?: unknown;
}

export interface ApprovalContinuation {
  inspect(input: ApprovalRecoveryCall):
    | ApprovalRecoveryState
    | Promise<ApprovalRecoveryState>;
  resume(
    input: ApprovalRecoveryCall,
  ): Promise<ApprovalRecoveryResult>;
}

export interface ApprovalRequestInput {
  readonly runId: string;
  readonly toolId: string;
  readonly reason: string;
  readonly requestedBy: ApprovalRequest["requestedBy"];
  readonly toolCall: DurableToolCallSnapshot;
  readonly expiresAt?: string;
}

/** Error used by hosts when a durable approval is still waiting. */
export class ApprovalPendingError extends Error {
  readonly code = "approval_pending";
  readonly approvalId: string;

  constructor(approvalId: string) {
    super("The tool is waiting for approval.");
    this.name = "ApprovalPendingError";
    this.approvalId = NonEmptyStringSchema.parse(approvalId);
  }
}

/** Error used when a pending approval expires before a decision arrives. */
export class ApprovalExpiredError extends Error {
  readonly code = "approval_expired";

  constructor() {
    super("The approval request expired before the tool could run.");
    this.name = "ApprovalExpiredError";
  }
}

/**
 * Small in-memory implementation for local hosts and contract tests.
 * Durable hosts can use the same record shape with a SQL-backed adapter.
 */
export class InMemoryToolApprovalStore implements ToolApprovalStore {
  readonly #records = new Map<string, DurableApprovalRecord>();
  readonly #waiters = new Map<
    string,
    Set<(decision: ApprovalDecision) => void>
  >();

  constructor(records: readonly DurableApprovalRecord[] = []) {
    for (const record of records) {
      const parsed = DurableApprovalRecordSchema.parse(record);
      this.#records.set(parsed.request.id, parsed);
    }
  }

  create(input: {
    request: ApprovalRequest;
    toolCall: DurableToolCallSnapshot;
  }): DurableApprovalRecord {
    const request = ApprovalRequestSchema.parse(input.request);
    const toolCall = DurableToolCallSnapshotSchema.parse(input.toolCall);
    const existing = this.#records.get(request.id);
    if (existing) return existing;
    const record = DurableApprovalRecordSchema.parse({
      request,
      toolCall,
      decision: null,
    });
    this.#records.set(request.id, record);
    return record;
  }

  get(requestId: string): DurableApprovalRecord | undefined {
    return this.#records.get(IdentifierSchema.parse(requestId));
  }

  decide(decisionInput: ApprovalDecision): DurableApprovalRecord {
    const decision = ApprovalDecisionSchema.parse(decisionInput);
    const current = this.#records.get(decision.requestId);
    if (!current) throw new Error("Approval request not found");
    if (current.decision) {
      if (JSON.stringify(current.decision) !== JSON.stringify(decision)) {
        throw new Error("Approval request has already been decided");
      }
      return current;
    }
    const next = { ...current, decision };
    this.#records.set(decision.requestId, next);
    for (const resolve of this.#waiters.get(decision.requestId) ?? []) {
      resolve(decision);
    }
    this.#waiters.delete(decision.requestId);
    return next;
  }

  async wait(
    requestIdInput: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<ApprovalDecision> {
    const requestId = IdentifierSchema.parse(requestIdInput);
    const record = this.#records.get(requestId);
    if (!record) throw new Error("Approval request not found");
    if (record.decision) return record.decision;
    if (
      record.request.expiresAt &&
      Date.parse(record.request.expiresAt) <= Date.now()
    ) {
      const expired = ApprovalDecisionSchema.parse({
        requestId,
        status: "expired",
        decidedBy: { id: "flary", kind: "system", version: "1" },
        decidedAt: new Date().toISOString(),
      });
      return this.decide(expired).decision!;
    }
    return new Promise<ApprovalDecision>((resolve, reject) => {
      const waiters = this.#waiters.get(requestId) ?? new Set();
      waiters.add(resolve);
      this.#waiters.set(requestId, waiters);
      const onAbort = () => {
        waiters.delete(resolve);
        if (waiters.size === 0) this.#waiters.delete(requestId);
        reject(options.signal?.reason ?? new Error("Approval wait aborted"));
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  snapshot(): DurableApprovalRecord[] {
    return [...this.#records.values()].map((record) =>
      DurableApprovalRecordSchema.parse(record),
    );
  }
}

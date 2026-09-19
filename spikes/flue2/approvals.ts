import assert from "node:assert/strict";

import { instrument, type FlueInstrumentation } from "@flue/runtime";
import type {
  FlueExecutionContext,
  FlueExecutionInterceptor,
  FlueExecutionOperation,
} from "@flue/runtime";

const APPROVAL_REASON = "flary.approval.waiting";

type ApprovalRow = {
  readonly key: string;
  readonly submissionId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly argsHash: string;
  status: "waiting" | "approved" | "completed";
  result?: unknown;
};

class FlaryApprovalError extends Error {
  readonly code = APPROVAL_REASON;
  constructor(readonly approvalKey: string) {
    super(`[${APPROVAL_REASON}] approval is required for ${approvalKey}`);
    this.name = "FlaryApprovalError";
  }
}

class ApprovalGate {
  readonly #rows = new Map<string, ApprovalRow>();

  constructor(rows: readonly ApprovalRow[] = []) {
    for (const row of rows) this.#rows.set(row.key, { ...row });
  }

  readonly interceptor: FlueExecutionInterceptor = async <T>(
    operation,
    context,
    next,
  ): Promise<T> => {
    if (operation.type !== "tool") return next();
    const key = this.key(context, operation);
    const row = this.#rows.get(key);
    if (!row) {
      this.#rows.set(key, {
        key,
        submissionId: context.submissionId ?? "submission-unknown",
        toolCallId: operation.toolCallId,
        toolName: operation.toolName,
        argsHash: "fixture-args-hash",
        status: "waiting",
      });
      throw new FlaryApprovalError(key);
    }
    if (row.status === "waiting") throw new FlaryApprovalError(key);
    if (row.status === "completed") return row.result as T;

    const result = await next();
    row.status = "completed";
    row.result = result;
    return result;
  };

  approve(key: string): void {
    const row = this.#rows.get(key);
    if (!row) throw new Error(`Unknown approval ${key}`);
    row.status = "approved";
  }

  snapshot(): string {
    return JSON.stringify([...this.#rows.values()]);
  }

  static restore(snapshot: string): ApprovalGate {
    return new ApprovalGate(JSON.parse(snapshot) as ApprovalRow[]);
  }

  key(
    context: FlueExecutionContext,
    operation: Extract<FlueExecutionOperation, { type: "tool" }>,
  ): string {
    return `${context.submissionId ?? "submission-unknown"}:${operation.toolCallId}`;
  }
}

const operation: Extract<FlueExecutionOperation, { type: "tool" }> = {
  type: "tool",
  toolCallId: "tool-call-1",
  toolName: "write_file",
};
const context: FlueExecutionContext = {
  submissionId: "submission-1",
  turnId: "turn-1",
  conversationId: "conversation-1",
};

const gate = new ApprovalGate();
let toolCalls = 0;
await assert.rejects(
  () => gate.interceptor(operation, context, async () => "should-not-run"),
  (error: unknown) => error instanceof FlaryApprovalError && error.code === APPROVAL_REASON,
);
assert.equal(toolCalls, 0);

const recovered = ApprovalGate.restore(gate.snapshot());
recovered.approve(recovered.key(context, operation));
const first = await recovered.interceptor(operation, context, async () => {
  toolCalls += 1;
  return "committed";
});
const replay = await recovered.interceptor(operation, context, async () => {
  toolCalls += 1;
  return "duplicate";
});
assert.equal(first, "committed");
assert.equal(replay, "committed");
assert.equal(toolCalls, 1);

const instrumentation: FlueInstrumentation = {
  observe: () => {},
  interceptor: gate.interceptor,
  dispose: () => {},
};
const dispose = instrument(instrumentation);
await dispose();

console.log(
  JSON.stringify({
    intercepted: true,
    taggedAbort: APPROVAL_REASON,
    evictedAndRestored: true,
    toolCallsAfterRedispatch: toolCalls,
    flueApi: "instrument({ observe, interceptor, dispose })",
  }),
);

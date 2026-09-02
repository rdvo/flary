import assert from "node:assert/strict";
import test from "node:test";

import {
  ApprovalDecisionSchema,
  ApprovalRequestSchema,
  type JsonObject,
} from "../../src/harness/contracts/index.js";
import {
  DurableToolCallSnapshotSchema,
  InMemoryToolApprovalStore,
  type DurableApprovalRecord,
  type DurableToolCallSnapshot,
} from "../../src/harness/execution/approval-continuation.js";
import { InMemoryToolExecutionJournal } from "../../src/harness/execution/tool-journal.js";
import { resolveAgentMode } from "../../src/harness/contracts/modes.js";
import { InMemoryToolCatalog } from "../../src/harness/tools/catalog.js";
import { LazyToolRuntime } from "../../src/harness/tools/runtime.js";

const RUN_ID = "run_approval_test";
const CALL_ID = "call_original_write";
const IDEMPOTENCY_KEY = "write_original_key";

function decision(requestId: string, status: "approved" | "rejected" | "expired") {
  return ApprovalDecisionSchema.parse({
    requestId,
    status,
    decidedBy: { id: "host_user", kind: "user", version: "1" },
    decidedAt: new Date().toISOString(),
  });
}

function findRecord(
  store: InMemoryToolApprovalStore,
  toolCall: DurableToolCallSnapshot,
): DurableApprovalRecord | undefined {
  return store
    .snapshot()
    .find((candidate) => JSON.stringify(candidate.toolCall) === JSON.stringify(toolCall));
}

function createRuntime(options: {
  store: InMemoryToolApprovalStore;
  journal: InMemoryToolExecutionJournal;
  events: Array<{ type: string; [key: string]: unknown }>;
  calls: Array<JsonObject>;
  expiresAt?: string;
}) {
  const catalog = new InMemoryToolCatalog();
  catalog.register({
    definition: {
      id: "files.write",
      name: "Write file",
      kind: "native",
      operation: "write",
      capabilities: ["files.write"],
      requiresApproval: true,
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
    resourceKey: (input) => String((input as { path?: unknown }).path ?? "files/"),
    async execute(input) {
      options.calls.push(input as JsonObject);
      return { written: true };
    },
  });

  return new LazyToolRuntime({
    catalog,
    mode: resolveAgentMode("build"),
    runId: RUN_ID,
    toolJournal: options.journal,
    onToolEvent: (event) => options.events.push(event),
    async approve(tool, input, context) {
      const toolCall = DurableToolCallSnapshotSchema.parse({
        runId: context.runId,
        callId: context.callId,
        toolId: tool.id,
        arguments: input as JsonObject,
        operation: context.operation,
        resourceKey: context.resourceKey,
        ...(context.idempotencyKey ? { idempotencyKey: context.idempotencyKey } : {}),
      });
      let record = findRecord(options.store, toolCall);
      if (!record) {
        const request = ApprovalRequestSchema.parse({
          id: `approval_${crypto.randomUUID().replaceAll("-", "")}`,
          runId: RUN_ID,
          action: "tool-call",
          reason: "This write needs approval.",
          requestedBy: { id: "agent", kind: "agent", version: "1" },
          toolCallId: context.callId,
          requestedAt: new Date().toISOString(),
          expiresAt: options.expiresAt ?? new Date(Date.now() + 60_000).toISOString(),
          context: { toolId: tool.id, operation: context.operation },
        });
        record = options.store.create({ request, toolCall });
        options.events.push({
          type: "approval.requested",
          runId: RUN_ID,
          approvalId: request.id,
        });
      }
      const resolved = record.decision ?? (await options.store.wait(record.request.id));
      if (resolved.status !== "approved") {
        throw new Error(`Approval ${resolved.status}.`);
      }
    },
  });
}

test("an approval pauses the exact write and resumes it once", async () => {
  const store = new InMemoryToolApprovalStore();
  const journal = new InMemoryToolExecutionJournal();
  const events: Array<{ type: string; [key: string]: unknown }> = [];
  const calls: Array<JsonObject> = [];
  const runtime = createRuntime({ store, journal, events, calls });

  const pending = runtime.call({
    id: "files.write",
    arguments: { path: "docs/approval.md", content: "approved" },
    callId: CALL_ID,
    idempotencyKey: IDEMPOTENCY_KEY,
  });
  let settled = false;
  pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(settled, false);
  assert.equal(calls.length, 0);
  const record = store.snapshot()[0];
  assert.ok(record);
  assert.equal(record.toolCall.callId, CALL_ID);
  assert.equal(record.toolCall.idempotencyKey, IDEMPOTENCY_KEY);
  assert.deepEqual(record.toolCall.arguments, {
    path: "docs/approval.md",
    content: "approved",
  });

  const approved = decision(record.request.id, "approved");
  store.decide(approved);
  events.push({
    type: "approval.resolved",
    runId: RUN_ID,
    approvalId: record.request.id,
  });
  const result = await pending;
  assert.equal(result.status, "fulfilled");
  assert.equal(calls.length, 1);
  assert.equal((await journal.get(RUN_ID, CALL_ID))?.idempotencyKey, IDEMPOTENCY_KEY);

  store.decide(approved);
  const duplicate = await runtime.call({
    id: "files.write",
    arguments: { path: "docs/approval.md", content: "approved" },
    callId: CALL_ID,
    idempotencyKey: IDEMPOTENCY_KEY,
  });
  assert.equal(duplicate.status, "fulfilled");
  assert.equal(duplicate.deduplicated, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(
    events.map((event) => event.type),
    ["approval.requested", "approval.resolved", "tool.started", "tool.completed", "tool.completed"],
  );
});

test("approval after a runtime restart resumes the stored call", async () => {
  const originalStore = new InMemoryToolApprovalStore();
  const journal = new InMemoryToolExecutionJournal();
  const originalEvents: Array<{ type: string; [key: string]: unknown }> = [];
  const calls: Array<JsonObject> = [];
  const original = createRuntime({
    store: originalStore,
    journal,
    events: originalEvents,
    calls,
  });
  const abandoned = original.call({
    id: "files.write",
    arguments: { path: "docs/restart.md", content: "resume" },
    callId: CALL_ID,
    idempotencyKey: IDEMPOTENCY_KEY,
  });
  abandoned.catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const persisted = originalStore.snapshot();
  assert.equal(calls.length, 0);

  const restartedStore = new InMemoryToolApprovalStore(persisted);
  const restartedEvents: Array<{ type: string; [key: string]: unknown }> = [];
  const restarted = createRuntime({
    store: restartedStore,
    journal,
    events: restartedEvents,
    calls,
  });
  const request = restartedStore.snapshot()[0]!.request;
  const approved = decision(request.id, "approved");
  restartedStore.decide(approved);
  restartedStore.decide(approved);

  const result = await restarted.call({
    id: "files.write",
    arguments: { path: "docs/restart.md", content: "resume" },
    callId: CALL_ID,
    idempotencyKey: IDEMPOTENCY_KEY,
  });
  assert.equal(result.status, "fulfilled");
  assert.equal(calls.length, 1);
  assert.equal((await journal.get(RUN_ID, CALL_ID))?.state, "completed");
  assert.equal((await journal.get(RUN_ID, CALL_ID))?.idempotencyKey, IDEMPOTENCY_KEY);
});

test("rejection and expiration never execute the write", async () => {
  for (const status of ["rejected", "expired"] as const) {
    const store = new InMemoryToolApprovalStore();
    const journal = new InMemoryToolExecutionJournal();
    const events: Array<{ type: string; [key: string]: unknown }> = [];
    const calls: Array<JsonObject> = [];
    const runtime = createRuntime({
      store,
      journal,
      events,
      calls,
      ...(status === "expired" ? { expiresAt: new Date(Date.now() - 1_000).toISOString() } : {}),
    });
    const call = runtime.call({
      id: "files.write",
      arguments: { path: `docs/${status}.md`, content: "blocked" },
      callId: `${CALL_ID}_${status}`,
      idempotencyKey: `${IDEMPOTENCY_KEY}_${status}`,
    });
    if (status === "rejected") {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const record = store.snapshot()[0]!;
      store.decide(decision(record.request.id, status));
    }
    await assert.rejects(call, /Approval (rejected|expired)/);
    assert.equal(calls.length, 0);
    assert.equal((await journal.get(RUN_ID, `${CALL_ID}_${status}`))?.state, undefined);
  }
});

test("an uncertain write is not retried during approval recovery", async () => {
  const store = new InMemoryToolApprovalStore();
  const journal = new InMemoryToolExecutionJournal();
  await journal.put({
    runId: RUN_ID,
    callId: CALL_ID,
    toolId: "files.write",
    operation: "write",
    state: "started",
    idempotencyKey: IDEMPOTENCY_KEY,
    input: { path: "docs/uncertain.md", content: "maybe" },
    startedAt: new Date().toISOString(),
  });
  const request = ApprovalRequestSchema.parse({
    id: "approval_uncertain",
    runId: RUN_ID,
    action: "tool-call",
    reason: "This write needs approval.",
    requestedBy: { id: "agent", kind: "agent", version: "1" },
    toolCallId: CALL_ID,
    requestedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    context: { toolId: "files.write", operation: "write" },
  });
  store.create({
    request,
    toolCall: {
      runId: RUN_ID,
      callId: CALL_ID,
      toolId: "files.write",
      arguments: { path: "docs/uncertain.md", content: "maybe" },
      operation: "write",
      resourceKey: "docs/uncertain.md",
      idempotencyKey: IDEMPOTENCY_KEY,
    },
  });
  store.decide(decision(request.id, "approved"));

  const calls: Array<JsonObject> = [];
  const result = await createRuntime({
    store,
    journal,
    events: [],
    calls,
  }).call({
    id: "files.write",
    arguments: { path: "docs/uncertain.md", content: "maybe" },
    callId: CALL_ID,
    idempotencyKey: IDEMPOTENCY_KEY,
  });
  assert.equal(result.status, "outcome_unknown");
  assert.equal(calls.length, 0);
  assert.equal((await journal.get(RUN_ID, CALL_ID))?.state, "outcome_unknown");
});

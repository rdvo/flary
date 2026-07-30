import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { FlaryThreadMetadataStore } from "../../src/harness/cloudflare/thread-metadata.js";
import { SqliteToolExecutionJournal } from "../../src/harness/cloudflare/tool-journal.js";
import {
  ApprovalDecisionSchema,
  type ThreadRef,
} from "../../src/harness/contracts/index.js";

type SqlDatabase = {
  exec(query: string): void;
  prepare(query: string): {
    all(...bindings: unknown[]): unknown[];
    run(...bindings: unknown[]): unknown;
  };
};

function sqlStore() {
  const database = new DatabaseSync(":memory:") as unknown as SqlDatabase;
  return {
    database,
    exec<T = Record<string, unknown>>(
      query: string,
      ...bindings: unknown[]
    ): { toArray(): T[] } {
      const trimmed = query.trim().toLowerCase();
      if (bindings.length === 0 && !/^(select|with|pragma|explain)\b/.test(trimmed)) {
        database.exec(query);
        return { toArray: () => [] };
      }
      const statement = database.prepare(query);
      if (
        /^(select|with|pragma|explain)\b/.test(trimmed) ||
        /\breturning\b/.test(trimmed)
      ) {
        return { toArray: () => statement.all(...bindings) as T[] };
      }
      statement.run(...bindings);
      return { toArray: () => [] };
    },
  };
}

function ref(organizationId: string): ThreadRef {
  return {
    organizationId,
    appId: "app_1",
    agentId: "flary-thread",
    threadId: "thread_1",
  };
}

test("thread metadata persists an exact approval and safe lifecycle events", () => {
  const database = sqlStore();
  const store = new FlaryThreadMetadataStore(database, ref("org_a"));
  const request = store.createToolApproval({
    runId: "run_metadata_1",
    toolId: "files.write",
    reason: "The write needs approval.",
    requestedBy: { id: "agent", kind: "agent", version: "1" },
    toolCall: {
      runId: "run_metadata_1",
      callId: "call_metadata_1",
      toolId: "files.write",
      arguments: {
        apiKey: "sk-do-not-persist-in-events",
        path: "docs/metadata.md",
      },
      operation: "write",
      resourceKey: "docs/metadata.md",
      idempotencyKey: "key_metadata_1",
    },
  });

  assert.equal(store.read().status, "waiting");
  const publicApproval = store.listApprovals()[0]!;
  assert.equal("toolCall" in publicApproval, false);
  const exact = store.findToolApproval({
    runId: "run_metadata_1",
    toolId: "files.write",
    arguments: {
      path: "docs/metadata.md",
      apiKey: "sk-do-not-persist-in-events",
    },
    idempotencyKey: "key_metadata_1",
    operation: "write",
    resourceKey: "docs/metadata.md",
  });
  assert.equal(exact?.toolCall.callId, "call_metadata_1");

  store.recordToolEvent({
    type: "tool.started",
    runId: "run_metadata_1",
    callId: "call_metadata_1",
    toolId: "files.write",
    operation: "write",
    occurredAt: new Date().toISOString(),
    metadata: { apiKey: "sk-do-not-persist-in-events" },
  });
  const approved = ApprovalDecisionSchema.parse({
    requestId: request.id,
    status: "approved",
    decidedBy: { id: "user_1", kind: "user", version: "1" },
    decidedAt: new Date().toISOString(),
  });
  assert.equal(store.decideApproval(approved), true);
  assert.equal(store.decideApproval(approved), false);
  assert.equal(store.read().status, "running");
  store.recordToolEvent({
    type: "tool.completed",
    runId: "run_metadata_1",
    callId: "call_metadata_1",
    toolId: "files.write",
    operation: "write",
    occurredAt: new Date().toISOString(),
    durationMs: 1,
    deduplicated: false,
  });

  const events = store.listEvents("run_metadata_1");
  assert.deepEqual(
    events.map((event) => (event as { type: string }).type),
    [
      "approval.requested",
      "run.waiting",
      "tool.started",
      "approval.resolved",
      "tool.completed",
    ],
  );
  assert.equal(JSON.stringify(events).includes("sk-do-not-persist-in-events"), false);
});

test("approval records stay isolated to their thread Durable Object", () => {
  const first = sqlStore();
  const second = sqlStore();
  const firstStore = new FlaryThreadMetadataStore(first, ref("org_a"));
  const secondStore = new FlaryThreadMetadataStore(second, ref("org_b"));
  const request = firstStore.createToolApproval({
    runId: "run_private",
    toolId: "files.write",
    reason: "Private approval.",
    requestedBy: { id: "agent", kind: "agent", version: "1" },
    toolCall: {
      runId: "run_private",
      callId: "call_private",
      toolId: "files.write",
      arguments: { path: "private.txt" },
      operation: "write",
      resourceKey: "private.txt",
      idempotencyKey: "private_key",
    },
  });

  assert.equal(secondStore.listApprovals().length, 0);
  assert.equal(secondStore.listEvents().length, 0);
  assert.throws(
    () => secondStore.decideApproval({
      requestId: request.id,
      status: "approved",
      decidedBy: { id: "other_user", kind: "user", version: "1" },
      decidedAt: new Date().toISOString(),
    }),
    /not found/i,
  );
});

test("the SQLite tool journal claims a started write once", async () => {
  const database = sqlStore();
  const journal = new SqliteToolExecutionJournal(database);
  const record = {
    runId: "run_journal_claim",
    callId: "call_journal_claim",
    toolId: "files.write",
    operation: "write" as const,
    state: "started" as const,
    idempotencyKey: "key_journal_claim",
    input: { path: "docs/claim.md" },
    startedAt: new Date().toISOString(),
  };

  await journal.put(record);
  await assert.rejects(journal.put(record), /already claimed/);
  await journal.put({
    ...record,
    state: "outcome_unknown",
    error: {
      code: "tool_outcome_unknown",
      message: "The write outcome is unknown.",
      retryable: false,
    },
    completedAt: new Date().toISOString(),
  });
  assert.equal(
    (await journal.get(record.runId, record.callId))?.state,
    "outcome_unknown",
  );
});

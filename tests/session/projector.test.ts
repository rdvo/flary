import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { FlarySessionProjector, SqliteSessionLedger } from "../../src/harness/session/index.ts";

test("the session projector records redacted Flue tool events in order", async () => {
  const database = new DatabaseSync(":memory:");
  const storage = {
    exec<T>(query: string, ...bindings: unknown[]) {
      const trimmed = query.trim().toLowerCase();
      if (bindings.length === 0 && !trimmed.startsWith("select")) {
        database.exec(query);
        return { toArray: () => [] as T[] };
      }
      const statement = database.prepare(query);
      if (trimmed.startsWith("select")) {
        return { toArray: () => statement.all(...bindings) as T[] };
      }
      statement.run(...bindings);
      return { toArray: () => [] as T[] };
    },
    transactionSync<T>(closure: () => T): T {
      database.exec("BEGIN IMMEDIATE");
      try {
        const result = closure();
        database.exec("COMMIT");
        return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const ledger = new SqliteSessionLedger(storage);
  const projector = new FlarySessionProjector(ledger, {
    tenantId: "tenant",
    applicationId: "app",
    sessionId: "session",
    threadId: "thread",
    agentId: "coder",
    sourceRevision: "flue-v3",
  });

  const call = await projector.project({
    sourceCursor: "1",
    event: {
      type: "tool_start",
      callId: "call_1",
      timestamp: "2026-07-30T12:00:00.000Z",
      input: { token: "secret-value" },
    },
  });
  const result = await projector.project({
    sourceCursor: "2",
    event: {
      type: "tool",
      callId: "call_1",
      timestamp: "2026-07-30T12:00:01.000Z",
      output: { ok: true },
    },
  });

  assert.equal(call.recordType, "tool.call");
  assert.equal(result.recordType, "tool.result");
  assert.equal(result.previousHash, call.recordHash);
  assert.notEqual(JSON.stringify(call.publicPayload).includes("secret-value"), true);
});

test("the session projector keeps provider-private state out of public records", async () => {
  const database = new DatabaseSync(":memory:");
  const sql = {
    exec<T>(query: string, ...bindings: unknown[]) {
      const trimmed = query.trim().toLowerCase();
      if (bindings.length === 0 && !trimmed.startsWith("select")) {
        database.exec(query);
        return { toArray: () => [] as T[] };
      }
      const statement = database.prepare(query);
      if (trimmed.startsWith("select")) {
        return { toArray: () => statement.all(...bindings) as T[] };
      }
      statement.run(...bindings);
      return { toArray: () => [] as T[] };
    },
    transactionSync<T>(closure: () => T): T {
      database.exec("BEGIN IMMEDIATE");
      try {
        const result = closure();
        database.exec("COMMIT");
        return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const ledger = new SqliteSessionLedger(sql, { hotRecordLimit: 10 });
  const projector = new FlarySessionProjector(ledger, {
    tenantId: "tenant",
    applicationId: "app",
    sessionId: "thread_private",
    threadId: "thread_private",
    sourceRevision: "rev_1",
  });
  const record = await projector.project({
    sourceCursor: "cursor_private",
    event: {
      type: "message-delta",
      kind: "reasoning",
      text: "hidden chain of thought",
      responseId: "resp_private",
      cacheKey: "cache_private",
    },
  });
  assert.equal(record.publicPayload.responseId, "[REDACTED]");
  assert.equal(record.publicPayload.cacheKey, "[REDACTED]");
  assert.equal(record.publicPayload.text, "[PROVIDER_PRIVATE_REASONING]");
});

test("the session projector retains safe model-turn failures", async () => {
  const database = new DatabaseSync(":memory:");
  const sql = {
    exec<T>(query: string, ...bindings: unknown[]) {
      const trimmed = query.trim().toLowerCase();
      if (bindings.length === 0 && !trimmed.startsWith("select")) {
        database.exec(query);
        return { toArray: () => [] as T[] };
      }
      const statement = database.prepare(query);
      if (trimmed.startsWith("select")) {
        return { toArray: () => statement.all(...bindings) as T[] };
      }
      statement.run(...bindings);
      return { toArray: () => [] as T[] };
    },
    transactionSync<T>(closure: () => T): T {
      database.exec("BEGIN IMMEDIATE");
      try {
        const result = closure();
        database.exec("COMMIT");
        return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const projector = new FlarySessionProjector(
    new SqliteSessionLedger(sql, { hotRecordLimit: 10 }),
    {
      tenantId: "tenant",
      applicationId: "app",
      sessionId: "thread_failure",
      threadId: "thread_failure",
      sourceRevision: "rev_1",
    },
  );
  const record = await projector.project({
    sourceCursor: "cursor_failure",
    event: {
      type: "turn",
      response: {
        responseId: "resp_private",
        error: {
          type: "authentication_error",
          message: "The API key cannot use this model",
        },
      },
    },
  });
  assert.equal(record.recordType, "provider.turn");
  assert.equal((record.publicPayload.response as Record<string, unknown>).responseId, "[REDACTED]");
  assert.deepEqual((record.publicPayload.response as Record<string, unknown>).error, {
    type: "authentication_error",
    message: "The API key cannot use this model",
  });
});

test("the session projector closes a turn only when the submission settles", async () => {
  const database = new DatabaseSync(":memory:");
  const sql = {
    exec<T>(query: string, ...bindings: unknown[]) {
      const trimmed = query.trim().toLowerCase();
      if (bindings.length === 0 && !trimmed.startsWith("select")) {
        database.exec(query);
        return { toArray: () => [] as T[] };
      }
      const statement = database.prepare(query);
      if (trimmed.startsWith("select")) {
        return { toArray: () => statement.all(...bindings) as T[] };
      }
      statement.run(...bindings);
      return { toArray: () => [] as T[] };
    },
    transactionSync<T>(closure: () => T): T {
      database.exec("BEGIN IMMEDIATE");
      try {
        const result = closure();
        database.exec("COMMIT");
        return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const projector = new FlarySessionProjector(
    new SqliteSessionLedger(sql, { hotRecordLimit: 10 }),
    {
      tenantId: "tenant",
      applicationId: "app",
      sessionId: "thread_tools",
      threadId: "thread_tools",
      sourceRevision: "rev_1",
    },
  );

  const message = await projector.project({
    sourceCursor: "message_done",
    event: { type: "message-completed", messageId: "assistant_tool_message" },
  });
  const submission = await projector.project({
    sourceCursor: "submission_done",
    event: {
      type: "submission-settled",
      submissionId: "submission_1",
      outcome: "completed",
    },
  });

  assert.equal(message.recordType, "message.assistant");
  assert.equal(submission.recordType, "turn.completed");
  assert.equal(submission.turnId, "submission_1");
});

import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  SqliteSubagentCoordinator,
  type SubagentCoordinatorSqlStorage,
} from "../../src/harness/cloudflare/subagent-coordinator.ts";
import type {
  SubagentConversationTurn,
  SubagentThread,
} from "../../src/harness/contracts/subagents.ts";
import { SubagentPolicyError } from "../../src/harness/subagents/coordinator.ts";

const NOW = "2026-07-30T12:00:00.000Z";

type SqlDatabase = {
  exec(query: string): void;
  prepare(query: string): {
    all(...bindings: unknown[]): unknown[];
    run(...bindings: unknown[]): unknown;
  };
};

function sqlStore(): SubagentCoordinatorSqlStorage {
  const database = new DatabaseSync(":memory:") as unknown as SqlDatabase;
  return {
    exec<T = Record<string, unknown>>(
      query: string,
      ...bindings: unknown[]
    ): { toArray(): T[] } {
      const trimmed = query.trim().toLowerCase();
      if (
        bindings.length === 0 &&
        !/^(select|with|pragma|explain|update)\b/.test(trimmed)
      ) {
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
}

function rootThread(): SubagentThread {
  return {
    threadId: "thread_root",
    sessionId: "session_1",
    rootThreadId: "thread_root",
    agentId: "main",
    role: "default",
    agentPath: "/root",
    depth: 0,
    status: "running",
    task: "Coordinate the work",
    contextSeed: {
      turns: 0,
      includeSystem: true,
      includeArtifacts: true,
    },
    seededTurnIds: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function turn(ordinal: number): SubagentConversationTurn {
  return {
    id: `turn_${ordinal}`,
    sessionId: "session_1",
    threadId: "thread_root",
    ordinal,
    messages: [
      { role: "user", content: `Question ${ordinal}` },
      { role: "assistant", content: `Answer ${ordinal}` },
    ],
    createdAt: NOW,
  };
}

function ids(start = 0): () => string {
  let value = start;
  return () => String(++value);
}

const policy = {
  maxConcurrentChildren: 2,
  maxTotalChildren: 4,
  maxDepth: 2,
};

test("SQLite restores lineage, seed references, activity, and idempotent spawn results", () => {
  const sql = sqlStore();
  const first = new SqliteSubagentCoordinator({
    sql,
    sessionId: "session_1",
    rootThread: rootThread(),
    policy,
    now: () => new Date(NOW),
    id: ids(),
  });
  for (let ordinal = 0; ordinal < 4; ordinal += 1) {
    first.appendTurn(turn(ordinal));
  }

  const child = first.spawn({
    requestId: "request_child",
    idempotencyKey: "spawn_child",
    sessionId: "session_1",
    parentThreadId: "thread_root",
    agentId: "reviewer",
    role: "reviewer",
    task: "Review the recent work",
    seedTurns: 2,
  });
  assert.deepEqual(child.seededTurnIds, ["turn_2", "turn_3"]);
  assert.equal(child.agentPath, "/root/reviewer");

  const restarted = new SqliteSubagentCoordinator({
    sql,
    sessionId: "session_1",
    rootThread: rootThread(),
    policy,
    now: () => new Date(NOW),
    id: ids(100),
  });
  const replayed = restarted.spawn({
    requestId: "different_request_is_not_used_for_replay",
    idempotencyKey: "spawn_child",
    sessionId: "session_1",
    parentThreadId: "thread_root",
    agentId: "ignored",
    task: "This input is ignored by reference-model idempotency",
    seedTurns: 0,
  });
  assert.deepEqual(replayed, child);
  assert.equal(restarted.listThreads().length, 2);
  assert.equal(restarted.readActivity().length, 1);
  assert.equal(restarted.readActivity()[0]?.kind, "spawned");

  const grandchild = restarted.spawn({
    requestId: "request_grandchild",
    sessionId: "session_1",
    parentThreadId: child.threadId,
    agentId: "worker",
    role: "worker",
    task: "Apply the review",
    seedTurns: 1,
  });
  assert.equal(grandchild.rootThreadId, "thread_root");
  assert.equal(grandchild.parentThreadId, child.threadId);
  assert.equal(grandchild.agentPath, "/root/reviewer/worker");
  assert.deepEqual(grandchild.seededTurnIds, ["turn_3"]);
});

test("SQLite applies concurrent and total spawn limits in transactions", () => {
  const sql = sqlStore();
  const coordinator = new SqliteSubagentCoordinator({
    sql,
    sessionId: "session_1",
    rootThread: rootThread(),
    policy: {
      maxConcurrentChildren: 1,
      maxTotalChildren: 2,
      maxDepth: 1,
    },
    now: () => new Date(NOW),
    id: ids(),
  });
  const first = coordinator.spawn({
    requestId: "spawn_1",
    sessionId: "session_1",
    parentThreadId: "thread_root",
    agentId: "reader",
    task: "Read files",
    seedTurns: 0,
  });
  assert.throws(
    () =>
      coordinator.spawn({
        requestId: "spawn_blocked",
        sessionId: "session_1",
        parentThreadId: "thread_root",
        agentId: "reviewer",
        task: "Review files",
        seedTurns: 0,
      }),
    (error: unknown) =>
      error instanceof SubagentPolicyError &&
      error.message === "Subagent concurrency limit reached"
  );
  assert.equal(coordinator.listThreads().length, 2);
  assert.equal(coordinator.readActivity().length, 1);

  coordinator.control({
    requestId: "complete_1",
    sessionId: "session_1",
    threadId: first.threadId,
    action: "complete",
    output: { done: true },
  });
  coordinator.spawn({
    requestId: "spawn_2",
    sessionId: "session_1",
    parentThreadId: "thread_root",
    agentId: "reviewer",
    task: "Review files",
    seedTurns: 0,
  });
  assert.throws(
    () =>
      coordinator.spawn({
        requestId: "spawn_total_blocked",
        sessionId: "session_1",
        parentThreadId: "thread_root",
        agentId: "worker",
        task: "Do more work",
        seedTurns: 0,
      }),
    (error: unknown) =>
      error instanceof SubagentPolicyError &&
      error.message === "Subagent total limit reached"
  );
});

test("SQLite restores queued and interrupt mailbox messages with shared cursors", () => {
  const sql = sqlStore();
  const first = new SqliteSubagentCoordinator({
    sql,
    sessionId: "session_1",
    rootThread: rootThread(),
    policy,
    now: () => new Date(NOW),
    id: ids(),
  });
  const child = first.spawn({
    requestId: "spawn_child",
    sessionId: "session_1",
    parentThreadId: "thread_root",
    agentId: "reader",
    task: "Read files",
    seedTurns: 0,
  });
  const queued = first.send({
    requestId: "message_queue",
    idempotencyKey: "message_queue_key",
    sessionId: "session_1",
    fromThreadId: "thread_root",
    toThreadId: child.threadId,
    content: "Read the API files.",
    mode: "queue",
  });
  const interrupt = first.send({
    requestId: "message_interrupt",
    sessionId: "session_1",
    fromThreadId: "thread_root",
    toThreadId: child.threadId,
    content: "Stop and inspect the failing test.",
    mode: "interrupt",
  });
  assert.equal(queued.mode, "queue");
  assert.equal(interrupt.mode, "interrupt");
  assert.ok(interrupt.sequence > queued.sequence);

  const restarted = new SqliteSubagentCoordinator({
    sql,
    sessionId: "session_1",
    rootThread: rootThread(),
    policy,
    now: () => new Date(NOW),
    id: ids(100),
  });
  assert.deepEqual(
    restarted.readMessages(child.threadId).map((message) => message.mode),
    ["queue", "interrupt"]
  );
  assert.deepEqual(
    restarted
      .readMessages(child.threadId, queued.sequence)
      .map((message) => message.id),
    [interrupt.id]
  );
  assert.deepEqual(
    restarted.send({
      requestId: "message_replay",
      idempotencyKey: "message_queue_key",
      sessionId: "session_1",
      fromThreadId: "thread_root",
      toThreadId: child.threadId,
      content: "Ignored replay input",
    }),
    queued
  );
  assert.deepEqual(
    restarted.readActivity().map((event) => event.kind),
    ["spawned", "interacted", "interacted"]
  );
});

test("SQLite restores control state and rejects a changed durable identity", () => {
  const sql = sqlStore();
  const first = new SqliteSubagentCoordinator({
    sql,
    sessionId: "session_1",
    rootThread: rootThread(),
    policy,
    now: () => new Date(NOW),
    id: ids(),
  });
  const child = first.spawn({
    requestId: "spawn_child",
    sessionId: "session_1",
    parentThreadId: "thread_root",
    agentId: "worker",
    task: "Implement the task",
    seedTurns: 0,
  });
  const running = first.control({
    requestId: "start_child",
    idempotencyKey: "start_child_once",
    sessionId: "session_1",
    threadId: child.threadId,
    action: "start",
  });
  assert.equal(running.status, "running");

  const restarted = new SqliteSubagentCoordinator({
    sql,
    sessionId: "session_1",
    rootThread: rootThread(),
    policy,
    now: () => new Date(NOW),
    id: ids(100),
  });
  assert.equal(restarted.getThread(child.threadId)?.status, "running");
  assert.deepEqual(
    restarted.control({
      requestId: "start_replay",
      idempotencyKey: "start_child_once",
      sessionId: "session_1",
      threadId: child.threadId,
      action: "start",
    }),
    running
  );
  const completed = restarted.control({
    requestId: "complete_child",
    sessionId: "session_1",
    threadId: child.threadId,
    action: "complete",
    output: { summary: "done" },
  });
  assert.equal(completed.status, "completed");
  assert.deepEqual(completed.output, { summary: "done" });

  assert.throws(
    () =>
      new SqliteSubagentCoordinator({
        sql,
        sessionId: "session_2",
        rootThread: {
          ...rootThread(),
          sessionId: "session_2",
          threadId: "thread_other",
          rootThreadId: "thread_other",
        },
        policy,
      }),
    /identity does not match/
  );
});

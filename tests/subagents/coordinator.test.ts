import assert from "node:assert/strict";
import test from "node:test";

import {
  SeedTurnsSchema,
  type SubagentConversationTurn,
  type SubagentThread,
} from "../../src/harness/contracts/subagents.js";
import {
  InMemorySubagentCoordinator,
  SubagentPolicyError,
} from "../../src/harness/subagents/coordinator.js";
import { selectSeededTurns } from "../../src/harness/subagents/context.js";

const NOW = "2026-07-28T12:00:00.000Z";

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

test("seedTurns accepts an exact count from zero through the safety limit", () => {
  assert.equal(SeedTurnsSchema.parse(0), 0);
  assert.equal(SeedTurnsSchema.parse(3), 3);
  assert.equal(SeedTurnsSchema.safeParse(-1).success, false);
  assert.equal(SeedTurnsSchema.safeParse(65).success, false);
});

test("seed selection keeps the newest complete turns in source order", () => {
  const selected = selectSeededTurns([turn(0), turn(1), turn(2), turn(3)], 3);
  assert.deepEqual(
    selected.map((item) => item.id),
    ["turn_1", "turn_2", "turn_3"],
  );
  assert.deepEqual(selectSeededTurns([turn(0)], 0), []);
});

test("a child thread records the exact parent turns used to seed it", () => {
  let id = 0;
  const coordinator = new InMemorySubagentCoordinator({
    sessionId: "session_1",
    rootThread: rootThread(),
    now: () => new Date(NOW),
    id: () => String(++id),
    policy: { maxConcurrentChildren: 4, maxTotalChildren: 8, maxDepth: 2 },
  });
  for (let ordinal = 0; ordinal < 5; ordinal += 1) {
    coordinator.appendTurn(turn(ordinal));
  }

  const cleanChild = coordinator.spawn({
    requestId: "request_clean",
    sessionId: "session_1",
    parentThreadId: "thread_root",
    agentId: "explorer",
    role: "explorer",
    task: "Inspect the repository",
    seedTurns: 0,
  });
  const contextualChild = coordinator.spawn({
    requestId: "request_context",
    sessionId: "session_1",
    parentThreadId: "thread_root",
    agentId: "reviewer",
    role: "reviewer",
    task: "Review the recent decisions",
    seedTurns: 3,
    verbosity: "high",
  });

  assert.deepEqual(cleanChild.seededTurnIds, []);
  assert.deepEqual(contextualChild.seededTurnIds, ["turn_2", "turn_3", "turn_4"]);
  assert.equal(contextualChild.verbosity, "high");
});

test("messages are direct by default and preserve queue or interrupt mode", () => {
  let id = 0;
  const coordinator = new InMemorySubagentCoordinator({
    sessionId: "session_1",
    rootThread: rootThread(),
    now: () => new Date(NOW),
    id: () => String(++id),
    policy: { maxConcurrentChildren: 4, maxTotalChildren: 8, maxDepth: 2 },
  });
  const first = coordinator.spawn({
    requestId: "request_1",
    sessionId: "session_1",
    parentThreadId: "thread_root",
    agentId: "reader",
    task: "Read files",
    seedTurns: 0,
  });
  const second = coordinator.spawn({
    requestId: "request_2",
    sessionId: "session_1",
    parentThreadId: "thread_root",
    agentId: "reviewer",
    task: "Review files",
    seedTurns: 0,
  });

  const interrupt = coordinator.send({
    requestId: "message_1",
    sessionId: "session_1",
    fromThreadId: "thread_root",
    toThreadId: first.threadId,
    content: "Stop and inspect the failing test.",
    mode: "interrupt",
  });
  assert.equal(interrupt.mode, "interrupt");
  assert.throws(
    () =>
      coordinator.send({
        requestId: "message_2",
        sessionId: "session_1",
        fromThreadId: first.threadId,
        toThreadId: second.threadId,
        content: "Send me your notes.",
      }),
    SubagentPolicyError,
  );
});

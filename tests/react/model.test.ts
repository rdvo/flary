import assert from "node:assert/strict";
import test from "node:test";

import {
  mergeFlaryUiRecords,
  normalizeFlaryUiRecords,
  projectFlaryUiTurns,
} from "../../src/react/model.ts";

const record = (
  sequence: number,
  recordType: string,
  publicPayload: Record<string, unknown> = {}
) => ({
  sequence,
  recordType,
  occurredAt: `2026-08-21T12:00:${String(sequence).padStart(2, "0")}.000Z`,
  publicPayload,
});

test("the React projector creates one durable turn and one ordered work rail", () => {
  const records = normalizeFlaryUiRecords([
    record(1, "message.user", { message: "Check revenue" }),
    record(2, "turn.started", { turnId: "turn_1" }),
    record(3, "message.reasoning", { summary: "Checking performance" }),
    record(4, "codemode.started", { executionId: "exec_1" }),
    record(5, "tool.search", {
      query: "revenue tools",
      resultCount: 2,
      durationMs: 3,
    }),
    record(6, "tool.call", {
      callId: "call_1",
      toolId: "tracked.get_stats",
      input: { range: "today" },
    }),
    record(7, "tool.result", {
      callId: "call_1",
      toolId: "tracked.get_stats",
      result: { output: { revenue: 250 } },
    }),
    record(8, "codemode.completed", {
      executionId: "exec_1",
      durationMs: 91,
      usage: { toolCalls: 1 },
    }),
    record(9, "message.assistant", { delta: "Revenue is " }),
    record(10, "message.assistant", { delta: "$250." }),
    record(11, "turn.completed", { turnId: "turn_1" }),
    record(12, "provider.turn", { provider: "openai", model: "gpt" }),
  ]);

  const turns = projectFlaryUiTurns(records);
  assert.equal(turns.length, 1);
  assert.equal(turns[0]?.status, "completed");
  assert.deepEqual(
    turns[0]?.messages.map((item) => [item.role, item.text]),
    [
      ["user", "Check revenue"],
      ["assistant", "Revenue is $250."],
    ]
  );
  assert.deepEqual(
    turns[0]?.activity.map((item) => item.label),
    [
      "Checking performance",
      "Completed Code Mode",
      "Searched tools · 2 found",
      "Used tracked get stats",
    ]
  );
  assert.equal(
    turns[0]?.activity.filter((item) => item.kind === "reasoning").length,
    1
  );
});

test("record merge replaces replay duplicates by durable sequence", () => {
  const first = normalizeFlaryUiRecords([
    record(1, "message.user", { message: "one" }),
  ]);
  const second = normalizeFlaryUiRecords([
    record(1, "message.user", { message: "one" }),
    record(2, "message.assistant", { message: "two" }),
  ]);
  assert.deepEqual(
    mergeFlaryUiRecords(first, second).map((item) => item.sequence),
    [1, 2]
  );
});

test("approval records pause the turn without exposing private data", () => {
  const turns = projectFlaryUiTurns(
    normalizeFlaryUiRecords([
      record(1, "message.user", { text: "Publish it" }),
      record(2, "approval.requested", {
        approvalId: "approval_1",
        operation: "workspace.publish",
      }),
    ])
  );
  assert.equal(turns[0]?.status, "waiting");
  assert.equal(turns[0]?.activity[0]?.approvalId, "approval_1");
  assert.equal(JSON.stringify(turns).includes("secret"), false);
});

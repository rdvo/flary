import assert from "node:assert/strict";
import test from "node:test";

import type { FlueEvent } from "@flue/runtime";

import { normalizeFlueEvent } from "../../src/harness/flue/events.js";

const options = {
  runId: "run_123",
  agentId: "research",
};

test("normalizes Flue streaming and tool events", () => {
  const delta = normalizeFlueEvent(
    {
      v: 3,
      type: "text_delta",
      text: "Hello",
      eventIndex: 4,
      timestamp: "2026-07-29T12:00:00.000Z",
    } as FlueEvent,
    options,
  );
  const tool = normalizeFlueEvent(
    {
      v: 3,
      type: "tool_start",
      toolCallId: "call_1",
      toolName: "files.read",
      args: { path: "README.md" },
      eventIndex: 5,
      timestamp: "2026-07-29T12:00:01.000Z",
    } as FlueEvent,
    options,
  );

  assert.equal(delta?.type, "message.delta");
  assert.deepEqual(delta?.payload, { delta: "Hello" });
  assert.equal(tool?.type, "tool.call");
  if (tool?.type === "tool.call") {
    assert.equal(tool.payload.call.toolId, "files.read");
    assert.deepEqual(tool.payload.call.arguments, { path: "README.md" });
  }
});

test("normalizes provider usage and cost from a Flue turn", () => {
  const event = normalizeFlueEvent(
    {
      v: 3,
      type: "turn",
      request: {
        model: { provider: "openai", id: "gpt-5.6-sol" },
      },
      response: {
        usage: {
          input: 100,
          output: 50,
          cacheRead: 20,
          cacheWrite: 5,
          totalTokens: 175,
          cost: { total: 0.012345 },
        },
      },
      durationMs: 750,
      eventIndex: 9,
      timestamp: "2026-07-29T12:00:02.000Z",
    } as FlueEvent,
    options,
  );

  assert.equal(event?.type, "model.completed");
  if (event?.type === "model.completed") {
    assert.equal(event.payload.provider, "openai");
    assert.equal(event.payload.model, "gpt-5.6-sol");
    assert.equal(event.payload.usage?.inputTokens, 100);
    assert.equal(event.payload.usage?.cost.state, "known");
    if (event.payload.usage?.cost.state === "known") {
      assert.equal(event.payload.usage.cost.microUnits, 12_345);
    }
  }
});

test("normalizes terminal Flue settlement", () => {
  const event = normalizeFlueEvent(
    {
      v: 3,
      type: "submission_settled",
      submissionId: "submission_1",
      outcome: "completed",
      result: { answer: "done" },
      eventIndex: 12,
      timestamp: "2026-07-29T12:00:03.000Z",
    } as FlueEvent,
    options,
  );

  assert.equal(event?.type, "run.completed");
  if (event?.type === "run.completed") {
    assert.deepEqual(event.payload.output, { answer: "done" });
  }
});

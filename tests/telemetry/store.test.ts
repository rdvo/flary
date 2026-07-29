import assert from "node:assert/strict";
import test from "node:test";

import {
  InMemoryTelemetryStore,
  createTraceContext,
  traceParent,
} from "../../src/harness/telemetry/store.js";

const root = createTraceContext();

test("telemetry store appends, queries child spans, and replays in order", async () => {
  const store = new InMemoryTelemetryStore();
  const received: number[] = [];
  const unsubscribe = store.subscribe((entry) => received.push(entry.sequence));
  const child = createTraceContext(root);

  await store.appendMany([
    {
      id: "model-1",
      occurredAt: "2026-07-28T12:00:00.000Z",
      runId: "run-1",
      traceContext: root,
      spanKind: "client",
      type: "model",
      payload: {
        action: "completed",
        model: { redacted: true, kind: "model", id: "openai/gpt-5" },
        usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
      },
    },
    {
      id: "tool-1",
      occurredAt: "2026-07-28T12:00:01.000Z",
      runId: "run-1",
      traceContext: child,
      spanKind: "internal",
      type: "tool",
      payload: {
        action: "completed",
        tool: { redacted: true, kind: "tool", id: "files.read" },
        status: "fulfilled",
        durationMs: 12,
      },
    },
  ]);
  unsubscribe();

  assert.deepEqual(received, [1, 2]);
  assert.equal((await store.readTrace(root.traceId)).length, 2);
  assert.equal((await store.readChildren(root.spanId)).length, 1);
  assert.equal((await store.readRun("run-1")).length, 2);

  const replayed: number[] = [];
  for await (const entry of store.replay({ afterSequence: 1 })) {
    replayed.push(entry.sequence);
  }
  assert.deepEqual(replayed, [2]);
  assert.match(traceParent(root), /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
});

test("run aggregation does not add cache tokens to total tokens and preserves unknown cost", async () => {
  const store = new InMemoryTelemetryStore();
  await store.append({
    id: "model-aggregate-1",
    occurredAt: "2026-07-28T12:00:00.000Z",
    runId: "run-aggregate",
    traceContext: root,
    spanKind: "client",
    type: "model",
    payload: {
      action: "completed",
      model: { redacted: true, kind: "model", id: "provider/model" },
      usage: {
        inputTokens: 10,
        outputTokens: 3,
        totalTokens: 13,
        cache: { readTokens: 7, writeTokens: 2 },
        reasoning: { tokens: 4, effort: "high" },
        cost: { state: "known", microUnits: 100, unit: "USD" },
      },
    },
  });
  await store.append({
    id: "model-aggregate-2",
    occurredAt: "2026-07-28T12:00:01.000Z",
    runId: "run-aggregate",
    traceContext: createTraceContext(root),
    spanKind: "client",
    type: "model",
    payload: {
      action: "completed",
      model: { redacted: true, kind: "model", id: "provider/model" },
      cost: { state: "unknown", reason: "provider did not report billing" },
    },
  });

  const aggregate = await store.aggregateRun("run-aggregate");
  assert.equal(aggregate.inputTokens, 10);
  assert.equal(aggregate.outputTokens, 3);
  assert.equal(aggregate.totalTokens, 13);
  assert.equal(aggregate.reasoningTokens, 4);
  assert.equal(aggregate.cacheReadTokens, 7);
  assert.equal(aggregate.cacheWriteTokens, 2);
  assert.equal(aggregate.cost.state, "unknown");
});

test("telemetry event IDs are append-only", async () => {
  const store = new InMemoryTelemetryStore();
  const event = {
    id: "duplicate-event",
    occurredAt: "2026-07-28T12:00:00.000Z",
    traceContext: root,
    spanKind: "internal" as const,
    type: "artifact" as const,
    payload: {
      action: "created" as const,
      artifact: {
        redacted: true as const,
        kind: "artifact" as const,
        id: "artifact-1",
      },
    },
  };
  await store.append(event);
  await assert.rejects(() => store.append(event), /already exists/);
});

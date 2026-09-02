import assert from "node:assert/strict";
import test from "node:test";

import {
  CostSchema,
  ModelTelemetryEventSchema,
  NormalizedUsageSchema,
  PromptSelectionTelemetryEventSchema,
  RedactedReferenceSchema,
  RetryTelemetryEventSchema,
  SandboxTelemetryEventSchema,
  SpanSchema,
  ToolTelemetryEventSchema,
  TraceContextSchema,
  TraceParentSchema,
  TelemetryEventSchema,
} from "../../src/harness/contracts/telemetry.js";

const traceContext = {
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  spanId: "00f067aa0ba902b7",
  parentSpanId: "b7ad6b7169203331",
  traceFlags: "01",
};

const reference = (kind: string, id: string) => ({
  redacted: true as const,
  kind,
  id,
});

const eventBase = {
  id: "telemetry-1",
  occurredAt: "2026-07-28T12:00:00.000Z",
  runId: "run-1",
  traceContext,
  spanKind: "internal" as const,
};

test("accepts W3C trace context and rejects invalid IDs", () => {
  const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
  assert.equal(TraceParentSchema.parse(traceparent), traceparent);
  assert.deepEqual(TraceContextSchema.parse(traceContext), traceContext);

  assert.throws(() => TraceParentSchema.parse(traceparent.toUpperCase()));
  assert.throws(() =>
    TraceParentSchema.parse("00-00000000000000000000000000000000-00f067aa0ba902b7-01"),
  );
});

test("validates span kind, status, and time order", () => {
  const span = SpanSchema.parse({
    context: traceContext,
    name: "model.call",
    kind: "client",
    status: "ok",
    startedAt: "2026-07-28T12:00:00.000Z",
    endedAt: "2026-07-28T12:00:01.000Z",
  });

  assert.equal(span.kind, "client");
  assert.equal(span.status, "ok");
  assert.throws(() =>
    SpanSchema.parse({
      context: traceContext,
      name: "bad-span",
      kind: "client",
      status: "ok",
      startedAt: "2026-07-28T12:00:01.000Z",
      endedAt: "2026-07-28T12:00:00.000Z",
    }),
  );
});

test("normalizes token, cache, reasoning, media, provider, and cost data", () => {
  const usage = NormalizedUsageSchema.parse({
    inputTokens: 100,
    outputTokens: 40,
    totalTokens: 140,
    cache: { hit: true, readTokens: 20, writeTokens: 0 },
    reasoning: { tokens: 12, effort: "high" },
    media: {
      audio: { input: { seconds: 2.5, tokens: 8 } },
      image: { input: { count: 1, bytes: 4096 } },
    },
    providerExtensions: { "provider.cache_tier": "standard" },
    cost: { state: "known", microUnits: 125, unit: "USD" },
  });

  assert.equal(usage.totalTokens, 140);
  assert.equal(usage.cost?.state, "known");
  assert.deepEqual(CostSchema.parse({ state: "unknown", reason: "not billed" }), {
    state: "unknown",
    reason: "not billed",
  });
  assert.throws(() => CostSchema.parse({ state: "known", microUnits: 1.5, unit: "USD" }));
  assert.throws(() => CostSchema.parse({ state: "known", unit: "USD" }));
});

test("references contain only safe metadata and reject raw content", () => {
  const safe = RedactedReferenceSchema.parse({
    kind: "artifact",
    id: "artifact:commit-1",
    digest: "a".repeat(64),
  });

  assert.equal(safe.redacted, true);
  assert.equal("content" in safe, false);
  assert.throws(() =>
    RedactedReferenceSchema.parse({
      kind: "prompt",
      id: "prompt-1",
      content: "a secret prompt",
    }),
  );
});

test("validates typed telemetry event families", () => {
  const events = [
    ModelTelemetryEventSchema.parse({
      ...eventBase,
      type: "model",
      payload: {
        action: "completed",
        model: reference("model", "openai/gpt-5"),
        usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      },
    }),
    ToolTelemetryEventSchema.parse({
      ...eventBase,
      type: "tool",
      payload: {
        action: "completed",
        tool: reference("tool", "files.read"),
        call: reference("tool-call", "call-1"),
        status: "fulfilled",
      },
    }),
    RetryTelemetryEventSchema.parse({
      ...eventBase,
      type: "retry",
      payload: {
        action: "scheduled",
        retry: reference("retry", "retry-1"),
        target: reference("model", "openai/gpt-5"),
        attempt: 2,
        maxAttempts: 3,
        delayMs: 100,
      },
    }),
    {
      ...eventBase,
      type: "approval",
      payload: {
        action: "approved",
        approval: reference("approval", "approval-1"),
      },
    },
    {
      ...eventBase,
      type: "cache",
      payload: {
        action: "hit",
        cache: reference("cache", "prompt-cache"),
        key: reference("cache-entry", "entry-1"),
      },
    },
    SandboxTelemetryEventSchema.parse({
      ...eventBase,
      type: "sandbox",
      payload: {
        action: "completed",
        sandbox: reference("sandbox", "sandbox-1"),
        engine: "sandbox",
        exitCode: 0,
      },
    }),
    {
      ...eventBase,
      type: "artifact",
      payload: {
        action: "committed",
        artifact: reference("artifact", "artifact-1"),
        bytes: 512,
      },
    },
    PromptSelectionTelemetryEventSchema.parse({
      ...eventBase,
      type: "prompt.selection",
      payload: {
        action: "selected",
        prompt: reference("prompt", "support.answer"),
        selected: reference("prompt", "support.answer:v2"),
        rank: 1,
      },
    }),
  ];

  for (const event of events) {
    assert.doesNotThrow(() => TelemetryEventSchema.parse(event));
  }

  assert.throws(() =>
    TelemetryEventSchema.parse({
      ...eventBase,
      type: "model",
      payload: {
        action: "completed",
        model: reference("model", "openai/gpt-5"),
        promptText: "must not be stored in telemetry",
      },
    }),
  );
});

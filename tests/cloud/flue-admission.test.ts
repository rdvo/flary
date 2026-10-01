import assert from "node:assert/strict";
import test from "node:test";
import {
  matchesPersistedDirectSubmission,
  prepareDirectSubmission,
} from "@flue/runtime-legacy/adapter";

import { normalizeFlueThinkingLevel } from "../../apps/cloud/worker/flue-admission.js";

test("maps Flary reasoning values at the Flue boundary", () => {
  assert.equal(normalizeFlueThinkingLevel("none"), "off");
  assert.equal(normalizeFlueThinkingLevel("medium"), "medium");
  assert.equal(normalizeFlueThinkingLevel("max"), "xhigh");
  assert.equal(normalizeFlueThinkingLevel("ultra"), "xhigh");
  assert.equal(normalizeFlueThinkingLevel(undefined), undefined);
});

test("direct submission replay ignores new acceptance time and trace while preserving request identity", () => {
  const first = {
    kind: "direct" as const,
    submissionId: "schedule_once_123",
    agent: "coder",
    id: "thread-test",
    payload: { message: "Original scheduled task", idempotencyKey: "schedule_once_123" },
    acceptedAt: "2026-09-30T10:00:00.000Z",
    traceCarrier: { traceparent: "first-trace" },
  };
  const persisted = prepareDirectSubmission(first);
  const replay = {
    ...first,
    acceptedAt: "2026-09-30T10:00:05.000Z",
    traceCarrier: { traceparent: "retry-trace" },
  };
  assert.equal(matchesPersistedDirectSubmission(replay, persisted.value, persisted.chunks), true);
  for (const different of [
    { ...replay, agent: "other" },
    { ...replay, id: "other-thread" },
    { ...replay, submissionId: "other-key" },
    { ...replay, payload: { ...replay.payload, message: "Different work" } },
  ]) {
    assert.equal(
      matchesPersistedDirectSubmission(different, persisted.value, persisted.chunks),
      false,
    );
  }
});

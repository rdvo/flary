import assert from "node:assert/strict";
import test from "node:test";

import {
  DeterministicModelRouter,
  MemoryRouteDecisionStore,
} from "../../src/harness/providers/routing.ts";

test("routing selects a healthy eligible model and replays its decision", async () => {
  const store = new MemoryRouteDecisionStore();
  const router = new DeterministicModelRouter({ store });
  const input = {
    operationId: "turn_1",
    policy: {
      strategy: "balanced" as const,
      allow: ["openai/gpt-5", "anthropic/claude-sonnet"],
      fallback: ["google/gemini"],
      capabilities: ["tools" as const],
    },
    candidates: [
      {
        selection: { provider: "openai", model: "gpt-5" },
        quality: 10,
        latencyMs: 500,
        capabilities: ["tools" as const],
      },
      {
        selection: { provider: "anthropic", model: "claude-sonnet" },
        quality: 9,
        latencyMs: 100,
        capabilities: ["tools" as const],
      },
      {
        selection: { provider: "google", model: "gemini" },
        quality: 20,
        healthy: false,
        capabilities: ["tools" as const],
      },
    ],
  };
  const first = await router.decide(input);
  const second = await router.decide(input);
  assert.deepEqual(second, first);
  assert.equal(first.selection.provider, "openai");
});

test("state-changing routes do not fall back automatically", async () => {
  const router = new DeterministicModelRouter();
  await assert.rejects(
    router.execute({
      operationId: "write_1",
      policy: {
        strategy: "explicit",
        allow: ["openai/gpt-5"],
        fallback: ["anthropic/claude-sonnet"],
        stateChanging: true,
      },
      candidates: [
        { selection: { provider: "openai", model: "gpt-5" }, healthy: true },
        { selection: { provider: "anthropic", model: "claude-sonnet" }, healthy: true },
      ],
      run: async () => {
        throw new Error("provider down");
      },
      isRetryable: () => true,
    }),
    /provider down/,
  );
});

test("fallback models do not participate in initial scoring", async () => {
  const router = new DeterministicModelRouter();
  const decision = await router.decide({
    operationId: "fallback_score_1",
    policy: {
      strategy: "quality",
      allow: ["openai/gpt-5"],
      fallback: ["anthropic/claude-sonnet"],
    },
    candidates: [
      { selection: { provider: "openai", model: "gpt-5" }, quality: 1 },
      { selection: { provider: "anthropic", model: "claude-sonnet" }, quality: 100 },
    ],
  });
  assert.equal(decision.selection.provider, "openai");
  assert.equal(decision.fallbackIndex, 0);
  assert.equal(decision.candidates.at(-1)?.reason, "fallback_only");
});

test("fallback execution returns the model that produced the result", async () => {
  const store = new MemoryRouteDecisionStore();
  const router = new DeterministicModelRouter({ store });
  const result = await router.execute({
    operationId: "fallback_result_1",
    policy: {
      strategy: "explicit",
      allow: ["openai/gpt-5"],
      fallback: ["anthropic/claude-sonnet"],
    },
    candidates: [
      { selection: { provider: "openai", model: "gpt-5" }, healthy: true },
      { selection: { provider: "anthropic", model: "claude-sonnet" }, healthy: true },
    ],
    run: async (selection) => {
      if (selection.provider === "openai") throw new Error("primary unavailable");
      return "fallback result";
    },
    isRetryable: () => true,
  });
  assert.equal(result.value, "fallback result");
  assert.equal(result.decision.selection.provider, "anthropic");
  assert.equal(result.decision.fallbackIndex, 1);
  assert.equal((await store.get("fallback_result_1"))?.selection.provider, "anthropic");
});

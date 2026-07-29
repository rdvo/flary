import assert from "node:assert/strict";
import test from "node:test";

import { resolveProviderRequestTuning } from "../../src/harness/execution/provider-options.js";

test("OpenAI Responses receives Pi-style native verbosity", () => {
  const tuning = resolveProviderRequestTuning({
    providerKind: "openai",
    api: "responses",
    selection: {
      provider: "openai-main",
      model: "gpt-5.6-sol",
      verbosity: "high",
      reasoningEffort: "xhigh",
      parameters: { store: false },
    },
  });

  assert.deepEqual(tuning.parameters, {
    store: false,
    text: { verbosity: "high" },
    reasoning: { effort: "xhigh" },
  });
  assert.deepEqual(tuning.instructions, []);
  assert.deepEqual(tuning.warnings, []);
});

test("providers without native verbosity receive prompt guidance", () => {
  const tuning = resolveProviderRequestTuning({
    providerKind: "anthropic",
    api: "messages",
    selection: {
      provider: "anthropic-main",
      model: "claude-opus",
      verbosity: "low",
    },
  });

  assert.match(tuning.instructions[0] ?? "", /concise/);
  assert.deepEqual(tuning.parameters, {});
});

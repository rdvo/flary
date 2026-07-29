import assert from "node:assert/strict";
import test from "node:test";

import { resolveSubagentModelSelection } from "../../src/harness/subagents/model.js";

test("direct subagent controls override inherited model controls", () => {
  const selection = resolveSubagentModelSelection(
    {
      verbosity: "low",
      reasoningEffort: "high",
    },
    {
      provider: "openai-main",
      model: "gpt-5.6-sol",
      verbosity: "high",
      reasoningEffort: "medium",
    }
  );

  assert.equal(selection?.verbosity, "low");
  assert.equal(selection?.reasoningEffort, "high");
});

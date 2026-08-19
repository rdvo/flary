import assert from "node:assert/strict";
import test from "node:test";
import {
  interactiveToolFailureState,
  projectPublicToolActivityInput,
} from "../../src/harness/functions/codemode.js";

test("draw_canvas projects a bounded redacted UI artifact", () => {
  const canvas = {
    title: "Weekly performance",
    metrics: [{ label: "Revenue", value: "$2,500" }],
    apiKey: "secret-value",
  };
  const projected = projectPublicToolActivityInput(canvas, "draw_canvas");
  assert.equal((projected.canvas as any).title, "Weekly performance");
  assert.notEqual((projected.canvas as any).apiKey, "secret-value");
});

test("normal tools do not project arbitrary structured inputs", () => {
  assert.deepEqual(projectPublicToolActivityInput({ query: "secret", range: "7d" }, "stats"), {
    range: "7d",
  });
});

test("read failures settle while uncertain writes stay blocked", () => {
  assert.equal(interactiveToolFailureState("read"), "failed");
  assert.equal(interactiveToolFailureState(undefined), "failed");
  assert.equal(interactiveToolFailureState("write"), "outcome_unknown");
});

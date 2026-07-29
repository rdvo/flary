import assert from "node:assert/strict";
import test from "node:test";

import {
  BUILT_IN_AGENT_MODES,
  resolveAgentMode,
} from "../../src/harness/contracts/modes.js";
import {
  checkModeAccess,
  modeRequiresApproval,
} from "../../src/harness/execution/mode-policy.js";
import { executeToolTasks } from "../../src/harness/execution/scheduler.js";

test("built-in modes are strict, named permission profiles", () => {
  assert.deepEqual(
    Object.keys(BUILT_IN_AGENT_MODES),
    ["ask", "plan", "build", "review"],
  );
  assert.equal(resolveAgentMode("ask").approvalPolicy.requireForWrites, false);
  assert.equal(resolveAgentMode("build").approvalPolicy.requireForWrites, true);
  assert.throws(() => resolveAgentMode("unknown"));
});

test("ask and plan deny unrelated writes while build requires approval", () => {
  assert.deepEqual(
    checkModeAccess(resolveAgentMode("ask"), {
      capability: "recall.search",
      operation: "read",
    }),
    { allowed: true, requiresApproval: false },
  );
  assert.equal(
    checkModeAccess(resolveAgentMode("ask"), {
      capability: "file.write",
      operation: "write",
      resource: "src/decision.md",
    }).allowed,
    false,
  );
  assert.deepEqual(
    checkModeAccess(resolveAgentMode("plan"), {
      capability: "artifact.plan.write",
      operation: "write",
      resource: "plans/next.md",
    }),
    { allowed: true, requiresApproval: false },
  );
  assert.deepEqual(
    checkModeAccess(resolveAgentMode("build"), {
      capability: "file.write",
      operation: "write",
      resource: "src/index.ts",
    }),
    { allowed: true, requiresApproval: true },
  );
  assert.equal(
    modeRequiresApproval(resolveAgentMode("build"), {
      capability: "file.read",
      operation: "read",
    }),
    false,
  );
});

test("the scheduler applies the selected mode before it invokes a tool", async () => {
  let called = false;
  const report = await executeToolTasks(
    [
      {
        id: "file",
        name: "file.write",
        operation: "write",
        resourceKey: "src/decision.md",
        input: {},
      },
    ],
    {
      mode: resolveAgentMode("ask"),
      handlers: {
        "file.write": async () => {
          called = true;
          return { ok: true };
        },
      },
    },
  );
  assert.equal(called, false);
  assert.equal(report.results[0]?.status, "denied");
});

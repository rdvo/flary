import assert from "node:assert/strict";
import test from "node:test";
import {
  dispatchDueSchedules,
  type ScheduledInvocation,
} from "../../src/harness/cloudflare/scheduler.js";

test("dispatches claimed schedules in one parallel batch", async () => {
  const schedules: ScheduledInvocation[] = [
    {
      id: "one",
      tenantId: "tenant",
      appId: "app",
      target: { kind: "flow", slug: "support/review" },
      input: {},
      expression: "* * * * *",
      timeZone: "UTC",
      nextRunAt: 100,
      enabled: true,
    },
    {
      id: "two",
      tenantId: "tenant",
      appId: "app",
      target: {
        kind: "agent",
        slug: "support",
        instanceId: "customer-1",
      },
      input: {},
      expression: "* * * * *",
      timeZone: "UTC",
      nextRunAt: 100,
      enabled: true,
    },
  ];
  const dispatched: string[] = [];

  const result = await dispatchDueSchedules(
    {
      async listDue() {
        return schedules;
      },
      async claim() {
        return true;
      },
    },
    {
      async dispatch(claim) {
        dispatched.push(claim.idempotencyKey);
      },
    },
    (_expression, _timeZone, after) => after + 60_000,
    { now: 100 },
  );

  assert.equal(result.claimed, 2);
  assert.equal(result.dispatched, 2);
  assert.deepEqual(dispatched.sort(), ["schedule:one:100", "schedule:two:100"]);
});

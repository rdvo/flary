import assert from "node:assert/strict";
import test from "node:test";
import { executeToolTasks } from "../../src/harness/execution/scheduler.js";
import { InMemoryToolExecutionJournal } from "../../src/harness/execution/tool-journal.js";

test("runs independent reads in parallel and serializes writes by resource", async () => {
  let activeReads = 0;
  let peakReads = 0;
  let activeWrites = 0;
  let peakWrites = 0;

  const report = await executeToolTasks(
    [
      { id: "read-1", name: "read" },
      { id: "read-2", name: "read" },
      {
        id: "write-1",
        name: "write",
        operation: "write",
        resourceKey: "ticket:1",
        idempotencyKey: "write-ticket-1-a",
      },
      {
        id: "write-2",
        name: "write",
        operation: "write",
        resourceKey: "ticket:1",
        idempotencyKey: "write-ticket-1-b",
      },
    ],
    {
      maxConcurrency: 4,
      readParallelism: 4,
      handlers: {
        read: async () => {
          activeReads += 1;
          peakReads = Math.max(peakReads, activeReads);
          await new Promise((resolve) => setTimeout(resolve, 10));
          activeReads -= 1;
          return "read";
        },
        write: {
          operation: "write",
          resourceKey: "ticket:1",
          async execute() {
            activeWrites += 1;
            peakWrites = Math.max(peakWrites, activeWrites);
            await new Promise((resolve) => setTimeout(resolve, 10));
            activeWrites -= 1;
            return "write";
          },
        },
      },
    },
  );

  assert.equal(peakReads, 2);
  assert.equal(peakWrites, 1);
  assert.deepEqual(
    report.results.map((result) => result.status),
    ["fulfilled", "fulfilled", "fulfilled", "fulfilled"],
  );
});

test("write tools need an idempotency key", async () => {
  let calls = 0;
  const report = await executeToolTasks(
    [{ id: "write-1", name: "write", operation: "write" }],
    {
      handlers: {
        write: async () => {
          calls += 1;
        },
      },
    },
  );

  assert.equal(calls, 0);
  assert.equal(report.results[0]?.status, "rejected");
  assert.equal(
    report.results[0]?.error?.code,
    "idempotency_key_required",
  );
});

test("an unknown write outcome is persisted and is not repeated", async () => {
  const journal = new InMemoryToolExecutionJournal();
  let calls = 0;
  const task = {
    id: "charge-1",
    name: "charge",
    operation: "write" as const,
    idempotencyKey: "charge-invoice-1",
  };
  const options = {
    runId: "run-1",
    toolJournal: journal,
    handlers: {
      charge: async () => {
        calls += 1;
        const started = await journal.get("run-1", "charge-1");
        assert.equal(started?.state, "started");
        throw new Error("The connection closed after submission.");
      },
    },
  };

  const first = await executeToolTasks([task], options);
  const second = await executeToolTasks([task], options);

  assert.equal(first.results[0]?.status, "outcome_unknown");
  assert.equal(second.results[0]?.status, "outcome_unknown");
  assert.equal(calls, 1);
  assert.equal(
    (await journal.get("run-1", "charge-1"))?.state,
    "outcome_unknown",
  );
});

test("a recovered started write becomes unknown and never runs again", async () => {
  const journal = new InMemoryToolExecutionJournal();
  await journal.put({
    runId: "run-recovered",
    callId: "write-recovered",
    toolId: "write",
    operation: "write",
    state: "started",
    idempotencyKey: "write-recovered-key",
    input: { value: "one" },
    startedAt: new Date().toISOString(),
  });
  let calls = 0;
  const report = await executeToolTasks(
    [
      {
        id: "write-recovered",
        name: "write",
        operation: "write",
        idempotencyKey: "write-recovered-key",
      },
    ],
    {
      runId: "run-recovered",
      toolJournal: journal,
      handlers: {
        write: async () => {
          calls += 1;
        },
      },
    },
  );

  assert.equal(calls, 0);
  assert.equal(report.results[0]?.status, "outcome_unknown");
  assert.equal(
    (await journal.get("run-recovered", "write-recovered"))?.state,
    "outcome_unknown",
  );
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  CodeExecutionRouter,
  FunctionExecutionAdapter,
} from "../../src/harness/execution/adapters.js";

test("the router selects a supported engine and emits durable events", async () => {
  const events: string[] = [];
  const router = new CodeExecutionRouter({
    adapters: [
      new FunctionExecutionAdapter({
        engine: "dynamic-worker",
        operations: ["test.echo"],
        async execute(request, context) {
          await context.onOutput?.("log", "running");
          return { output: request.input };
        },
      }),
    ],
    onEvent(event) {
      events.push(event.type);
    },
  });

  const result = await router.execute({
    executionId: "execution_1",
    runId: "run_1",
    engine: "auto",
    operation: "test.echo",
    input: { ok: true },
  });

  assert.equal(result.status, "completed");
  assert.equal(result.engine, "dynamic-worker");
  assert.deepEqual(result.output, { ok: true });
  assert.deepEqual(events, [
    "execution.started",
    "execution.output",
    "execution.completed",
  ]);
});

test("the router returns a typed failure without leaking an exception", async () => {
  const router = new CodeExecutionRouter({
    adapters: [
      new FunctionExecutionAdapter({
        engine: "sandbox",
        operations: ["test.fail"],
        async execute() {
          throw new Error("expected failure");
        },
      }),
    ],
  });

  const result = await router.execute({
    executionId: "execution_2",
    runId: "run_2",
    engine: "sandbox",
    operation: "test.fail",
    input: null,
  });

  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "execution_failed");
  assert.match(result.error?.message ?? "", /expected failure/);
});

test("the router uses the declared isolate or Linux runtime", async () => {
  const router = new CodeExecutionRouter({
    adapters: [
      new FunctionExecutionAdapter({
        engine: "dynamic-worker",
        operations: ["test.runtime"],
        async execute() {
          return { output: { runtime: "isolate" } };
        },
      }),
      new FunctionExecutionAdapter({
        engine: "sandbox",
        operations: ["test.runtime"],
        async execute() {
          return { output: { runtime: "linux" } };
        },
      }),
    ],
  });

  const isolate = await router.execute({
    executionId: "execution_isolate",
    runId: "run_runtime",
    runtime: "isolate",
    operation: "test.runtime",
    input: null,
  });
  const linux = await router.execute({
    executionId: "execution_linux",
    runId: "run_runtime",
    runtime: "linux",
    operation: "test.runtime",
    input: null,
  });

  assert.equal(isolate.engine, "dynamic-worker");
  assert.equal(linux.engine, "sandbox");
  await assert.rejects(
    router.execute({
      executionId: "execution_conflict",
      runId: "run_runtime",
      engine: "sandbox",
      runtime: "isolate",
      operation: "test.runtime",
      input: null,
    }),
    /conflicts with runtime isolate/,
  );
});

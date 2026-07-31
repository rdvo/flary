import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  SandboxProcessCreateSchema,
  SqliteSandboxProcessRegistry,
  hashSandboxEnvironment,
} from "../../src/harness/cloudflare/sandbox-process-registry.ts";

type SqlDatabase = {
  exec(query: string): void;
  prepare(query: string): {
    all(...bindings: unknown[]): unknown[];
    run(...bindings: unknown[]): unknown;
  };
};

function sqlStore() {
  const database = new DatabaseSync(":memory:") as unknown as SqlDatabase;
  return {
    database,
    exec<T = Record<string, unknown>>(
      query: string,
      ...bindings: unknown[]
    ): { toArray(): T[] } {
      const trimmed = query.trim().toLowerCase();
      if (
        bindings.length === 0 &&
        !/^(select|with|pragma|explain)\b/.test(trimmed)
      ) {
        database.exec(query);
        return { toArray: () => [] };
      }
      const statement = database.prepare(query);
      if (
        /^(select|with|pragma|explain)\b/.test(trimmed) ||
        /\breturning\b/.test(trimmed)
      ) {
        return { toArray: () => statement.all(...bindings) as T[] };
      }
      statement.run(...bindings);
      return { toArray: () => [] };
    },
  };
}

function tickingClock() {
  let milliseconds = Date.parse("2026-07-30T12:00:00.000Z");
  return () => new Date(milliseconds++).toISOString();
}

test("sandbox process state and lifecycle survive registry restart", async () => {
  const sql = sqlStore();
  const clock = tickingClock();
  const environmentHash = await hashSandboxEnvironment({
    OPENAI_API_KEY: "sk-never-persist-this",
    PATH: "/usr/bin",
  });
  assert.equal(
    environmentHash,
    await hashSandboxEnvironment({
      PATH: "/usr/bin",
      OPENAI_API_KEY: "sk-never-persist-this",
    })
  );
  const first = new SqliteSandboxProcessRegistry(sql, { now: clock });
  const created = await first.create({
    id: "process_1",
    runId: "run_1",
    sandboxId: "sandbox_1",
    command: "npm test",
    environmentHash,
  });
  assert.equal(created.status, "queued");
  assert.match(created.environmentHash ?? "", /^sha256:[0-9a-f]{64}$/);

  await first.start(created.id);
  await first.sleep(created.id, "2026-07-30T12:10:00.000Z");

  const restarted = new SqliteSandboxProcessRegistry(sql, { now: clock });
  assert.equal((await restarted.get(created.id))?.status, "sleeping");
  await restarted.wake(created.id);
  const completed = await restarted.complete(created.id, 0);
  assert.equal(completed.status, "completed");
  assert.equal(completed.exitCode, 0);

  assert.deepEqual(
    (await restarted.readLifecycle(created.id)).map((event) => event.action),
    ["created", "started", "slept", "woke", "completed"]
  );
  await assert.rejects(
    restarted.cancel(created.id),
    /cannot move from completed to cancelled/
  );

  const storedJson = sql.database
    .prepare(
      "SELECT record_json FROM flary_sandbox_processes WHERE process_id = ?"
    )
    .all(created.id);
  assert.equal(
    JSON.stringify(storedJson).includes("sk-never-persist-this"),
    false
  );
});

test("sandbox process output is chunked, byte bounded, and replayable by cursor", async () => {
  const sql = sqlStore();
  const registry = new SqliteSandboxProcessRegistry(sql, {
    now: tickingClock(),
    maxOutputBytes: 10,
    maxChunkBytes: 4,
  });
  await registry.create({
    id: "process_output",
    runId: "run_output",
    sandboxId: "sandbox_output",
    command: "printf output",
  });
  await registry.start("process_output");

  const chunks = await registry.appendOutput({
    processId: "process_output",
    stream: "stdout",
    text: "ab😀cdefgh",
  });
  assert.deepEqual(
    chunks.map((chunk) => chunk.text),
    ["ab", "😀", "cdef"]
  );
  assert.equal(chunks.at(-1)?.truncated, true);
  assert.equal(
    chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
    10
  );

  const afterFirst = await registry.readOutput("process_output", {
    afterCursor: chunks[0]?.cursor,
  });
  assert.deepEqual(
    afterFirst.map((chunk) => chunk.text),
    ["😀", "cdef"]
  );
  assert.deepEqual(
    await registry.appendOutput({
      processId: "process_output",
      stream: "stderr",
      text: "not stored",
    }),
    []
  );
  assert.deepEqual(
    {
      outputBytes: (await registry.get("process_output"))?.outputBytes,
      outputTruncated: (await registry.get("process_output"))?.outputTruncated,
    },
    { outputBytes: 10, outputTruncated: true }
  );

  const exact = new SqliteSandboxProcessRegistry(sqlStore(), {
    now: tickingClock(),
    maxOutputBytes: 4,
    maxChunkBytes: 4,
  });
  await exact.create({
    id: "process_exact_output",
    runId: "run_exact_output",
    sandboxId: "sandbox_exact_output",
    command: "printf output",
  });
  await exact.start("process_exact_output");
  assert.equal(
    (
      await exact.appendOutput({
        processId: "process_exact_output",
        stream: "stdout",
        text: "abcd",
      })
    )[0]?.truncated,
    false
  );
  const marker = await exact.appendOutput({
    processId: "process_exact_output",
    stream: "stdout",
    text: "e",
  });
  assert.deepEqual(
    marker.map(({ text, byteLength, truncated }) => ({
      text,
      byteLength,
      truncated,
    })),
    [{ text: "", byteLength: 0, truncated: true }]
  );
});

test("stdin and signal requests are durable and resolve once", async () => {
  const sql = sqlStore();
  const clock = tickingClock();
  const first = new SqliteSandboxProcessRegistry(sql, { now: clock });
  await first.create({
    id: "process_control",
    runId: "run_control",
    sandboxId: "sandbox_control",
    command: "node server.js",
  });
  await first.start("process_control");
  await first.requestStdin({
    id: "control_stdin",
    processId: "process_control",
    data: "continue\n",
  });
  await first.requestSignal({
    id: "control_signal",
    processId: "process_control",
    signal: "SIGTERM",
  });

  const restarted = new SqliteSandboxProcessRegistry(sql, { now: clock });
  assert.deepEqual(
    (await restarted.listControlRequests("process_control")).map(
      (request) => request.kind
    ),
    ["stdin", "signal"]
  );
  const resolved = await restarted.resolveControlRequest({
    requestId: "control_stdin",
    status: "delivered",
  });
  assert.equal(resolved.status, "delivered");
  assert.deepEqual(
    (
      await restarted.listControlRequests("process_control", {
        status: "pending",
      })
    ).map((request) => request.id),
    ["control_signal"]
  );
  assert.equal(
    (
      await restarted.resolveControlRequest({
        requestId: "control_stdin",
        status: "failed",
        errorCode: "late_failure",
      })
    ).status,
    "delivered"
  );
  assert.equal(
    (
      await restarted.requestStdin({
        id: "control_stdin",
        processId: "process_control",
        data: "continue\n",
      })
    ).status,
    "delivered"
  );
});

test("process contracts reject raw environments and invalid transitions", async () => {
  assert.equal(
    SandboxProcessCreateSchema.safeParse({
      id: "unsafe_process",
      runId: "unsafe_run",
      sandboxId: "unsafe_sandbox",
      command: "env",
      environment: { TOKEN: "secret" },
    }).success,
    false
  );

  const registry = new SqliteSandboxProcessRegistry(sqlStore(), {
    now: tickingClock(),
  });
  await registry.create({
    id: "process_invalid",
    runId: "run_invalid",
    sandboxId: "sandbox_invalid",
    command: "true",
  });
  await assert.rejects(
    registry.appendOutput({
      processId: "process_invalid",
      stream: "stdout",
      text: "too early",
    }),
    /cannot accept output while queued/
  );
  await assert.rejects(
    registry.requestSignal({
      id: "signal_invalid",
      processId: "process_invalid",
      signal: "SIGTERM",
    }),
    /cannot accept control requests while queued/
  );
});

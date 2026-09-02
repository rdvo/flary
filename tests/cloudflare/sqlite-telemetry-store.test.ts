import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { SqliteTelemetryStore } from "../../src/harness/cloudflare/sqlite-telemetry-store.ts";
import { createTraceContext } from "../../src/harness/telemetry/store.ts";

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
    exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): { toArray(): T[] } {
      const trimmed = query.trim().toLowerCase();
      if (bindings.length === 0 && !/^(select|with|pragma|explain)\b/.test(trimmed)) {
        database.exec(query);
        return { toArray: () => [] };
      }
      const statement = database.prepare(query);
      if (/^(select|with|pragma|explain)\b/.test(trimmed) || /\breturning\b/.test(trimmed)) {
        return { toArray: () => statement.all(...bindings) as T[] };
      }
      statement.run(...bindings);
      return { toArray: () => [] };
    },
  };
}

const root = createTraceContext();
const child = createTraceContext(root);

const modelEvent = {
  id: "model_sqlite_1",
  occurredAt: "2026-07-30T12:00:00.000Z",
  runId: "run_sqlite_telemetry",
  traceContext: root,
  spanKind: "client" as const,
  type: "model" as const,
  payload: {
    action: "completed" as const,
    model: {
      redacted: true as const,
      kind: "model" as const,
      id: "openai/gpt-5",
    },
    usage: {
      inputTokens: 11,
      outputTokens: 5,
      totalTokens: 16,
      reasoning: { tokens: 3, effort: "high" as const },
      cache: { readTokens: 7, writeTokens: 2 },
      cost: { state: "known" as const, microUnits: 25, unit: "USD" },
    },
  },
};

const toolEvent = {
  id: "tool_sqlite_1",
  occurredAt: "2026-07-30T12:00:01.000Z",
  runId: "run_sqlite_telemetry",
  traceContext: child,
  spanKind: "internal" as const,
  type: "tool" as const,
  payload: {
    action: "completed" as const,
    tool: {
      redacted: true as const,
      kind: "tool" as const,
      id: "workspace.read",
    },
    status: "fulfilled" as const,
    durationMs: 4,
  },
};

test("SQLite telemetry preserves append-only IDs and ordered queries after restart", async () => {
  const sql = sqlStore();
  const first = new SqliteTelemetryStore(sql);
  const observed: number[] = [];
  first.subscribe((entry) => observed.push(entry.sequence));

  const stored = await first.appendMany([modelEvent, toolEvent]);
  assert.deepEqual(
    stored.map((entry) => entry.sequence),
    [1, 2],
  );
  assert.deepEqual(observed, [1, 2]);

  const restarted = new SqliteTelemetryStore(sql);
  assert.deepEqual(
    (await restarted.readRun("run_sqlite_telemetry")).map((entry) => entry.event.id),
    ["model_sqlite_1", "tool_sqlite_1"],
  );
  assert.deepEqual(
    (await restarted.readChildren(root.spanId)).map((entry) => entry.event.id),
    ["tool_sqlite_1"],
  );
  assert.deepEqual(
    (
      await restarted.read({
        traceId: root.traceId,
        type: ["tool"],
        afterSequence: 1,
        limit: 1,
      })
    ).map((entry) => entry.sequence),
    [2],
  );

  const replayed: number[] = [];
  for await (const entry of restarted.replay({ afterSequence: 0 })) {
    replayed.push(entry.sequence);
  }
  assert.deepEqual(replayed, [1, 2]);
  await assert.rejects(restarted.append(modelEvent), /already exists/);
});

test("SQLite telemetry aggregation matches the reference store", async () => {
  const store = new SqliteTelemetryStore(sqlStore());
  await store.appendMany([
    modelEvent,
    {
      ...modelEvent,
      id: "model_sqlite_2",
      occurredAt: "2026-07-30T12:00:02.000Z",
      traceContext: createTraceContext(root),
      payload: {
        ...modelEvent.payload,
        usage: undefined,
        cost: {
          state: "unknown" as const,
          reason: "Provider did not report billing",
        },
      },
    },
  ]);

  const aggregate = await store.aggregateRun("run_sqlite_telemetry");
  assert.deepEqual(
    {
      eventCount: aggregate.eventCount,
      inputTokens: aggregate.inputTokens,
      outputTokens: aggregate.outputTokens,
      totalTokens: aggregate.totalTokens,
      reasoningTokens: aggregate.reasoningTokens,
      cacheReadTokens: aggregate.cacheReadTokens,
      cacheWriteTokens: aggregate.cacheWriteTokens,
      costState: aggregate.cost.state,
    },
    {
      eventCount: 2,
      inputTokens: 11,
      outputTokens: 5,
      totalTokens: 16,
      reasoningTokens: 3,
      cacheReadTokens: 7,
      cacheWriteTokens: 2,
      costState: "unknown",
    },
  );
});

test("SQLite telemetry validates empty and invalid read windows", async () => {
  const store = new SqliteTelemetryStore(sqlStore());
  await store.append(modelEvent);
  assert.deepEqual(await store.read({ type: [] }), []);
  assert.deepEqual(await store.read({ limit: 0 }), []);
  await assert.rejects(
    store.read({ afterSequence: -1 }),
    /sequence must be a non-negative safe integer/,
  );
  await assert.rejects(store.read({ limit: 1.5 }), /limit must be a non-negative integer/);
});

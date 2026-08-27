import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";

import { SqliteToolExecutionJournal } from "../../src/harness/cloudflare/tool-journal.ts";
import { resolveAgentMode } from "../../src/harness/contracts/modes.ts";
import { InMemoryToolCatalog } from "../../src/harness/tools/catalog.ts";
import { LazyToolRuntime } from "../../src/harness/tools/runtime.ts";
import { defineFlaryTool } from "../../src/harness/tools/sdk.ts";

const sources = [
  "local",
  "mcp",
  "openapi",
  "workspace",
  "r2",
  "sandbox",
  "browser",
] as const;

test("every write source replays a completed call after runtime eviction", async () => {
  const sql = sqlStore();
  const executions = new Map<string, number>();
  const catalog = sourceCatalog(executions);

  for (const source of sources) {
    const call = {
      id: `${source}.write`,
      callId: `${source}_completed`,
      idempotencyKey: `${source}_idempotency`,
      arguments: { value: "saved" },
    };
    const first = await runtime(catalog, sql, "run_completed").call(call);
    assert.equal(first.status, "fulfilled", source);

    // Create a new runtime and journal instance to simulate Durable Object eviction.
    const recovered = await runtime(catalog, sql, "run_completed").call(call);
    assert.equal(recovered.status, "fulfilled", source);
    assert.equal(recovered.deduplicated, true, source);
    assert.equal(executions.get(source), 1, source);
  }
});

test("every interrupted write source fails closed after runtime eviction", async () => {
  const sql = sqlStore();
  const executions = new Map<string, number>();
  const catalog = sourceCatalog(executions);
  const journal = new SqliteToolExecutionJournal(sql);

  for (const source of sources) {
    await journal.put({
      runId: "run_unknown",
      callId: `${source}_started`,
      toolId: `${source}.write`,
      operation: "write",
      state: "started",
      idempotencyKey: `${source}_idempotency`,
      input: { value: "saved" },
      startedAt: "2026-08-27T12:00:00.000Z",
    });

    const recovered = await runtime(catalog, sql, "run_unknown").call({
      id: `${source}.write`,
      callId: `${source}_started`,
      idempotencyKey: `${source}_idempotency`,
      arguments: { value: "saved" },
    });
    assert.equal(recovered.status, "outcome_unknown", source);
    assert.equal(executions.get(source) ?? 0, 0, source);
  }
});

function sourceCatalog(executions: Map<string, number>): InMemoryToolCatalog {
  const catalog = new InMemoryToolCatalog();
  for (const source of sources) {
    defineFlaryTool({
      id: `${source}.write`,
      name: `${source}_write`,
      description: `Write through the ${source} source adapter`,
      input: z.object({ value: z.string() }),
      output: z.object({ source: z.string(), value: z.string() }),
      operation: "write",
      capabilities: [`${source}.write`],
      tags: [source, "restart-test"],
      resourceKey: `${source}:resource`,
      async execute(input) {
        executions.set(source, (executions.get(source) ?? 0) + 1);
        return { source, value: input.value };
      },
    }).register(catalog);
  }
  return catalog;
}

function runtime(catalog: InMemoryToolCatalog, sql: ReturnType<typeof sqlStore>, runId: string) {
  return new LazyToolRuntime({
    catalog,
    runId,
    mode: resolveAgentMode("build"),
    toolJournal: new SqliteToolExecutionJournal(sql),
    approve: () => undefined,
  });
}

function sqlStore() {
  const database = new DatabaseSync(":memory:");
  return {
    exec<T = Record<string, unknown>>(
      query: string,
      ...bindings: unknown[]
    ): { toArray(): T[] } {
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

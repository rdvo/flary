import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  createCloudflareThreadService,
  handleFlaryThreadControlObjectRequest,
} from "../../src/harness/cloudflare/thread-control.ts";

function namespace() {
  const stores = new Map<string, ReturnType<typeof sqlStorage>>();
  return {
    idFromName(name: string) {
      return name;
    },
    get(id: unknown) {
      const name = String(id);
      let storage = stores.get(name);
      if (!storage) {
        storage = sqlStorage();
        stores.set(name, storage);
      }
      return {
        fetch(request: Request) {
          return handleFlaryThreadControlObjectRequest({ storage: storage!, request });
        },
      };
    },
  };
}

function sqlStorage() {
  const database = new DatabaseSync(":memory:");
  let transactionDepth = 0;
  return {
    sql: {
      exec<T>(query: string, ...bindings: unknown[]) {
        const trimmed = query.trim().toLowerCase();
        if (bindings.length === 0 && !trimmed.startsWith("select")) {
          database.exec(query);
          return { toArray: () => [] as T[] };
        }
        const statement = database.prepare(query);
        if (trimmed.startsWith("select")) {
          return { toArray: () => statement.all(...bindings) as T[] };
        }
        statement.run(...bindings);
        return { toArray: () => [] as T[] };
      },
      transactionSync<T>(closure: () => T): T {
        if (transactionDepth > 0) return closure();
        transactionDepth += 1;
        database.exec("BEGIN IMMEDIATE");
        try {
          const result = closure();
          database.exec("COMMIT");
          return result;
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        } finally {
          transactionDepth -= 1;
        }
      },
    },
  };
}

test("generated Thread Control keeps ownership and append-only controls", async () => {
  const service = createCloudflareThreadService({
    env: {},
    namespace: namespace(),
  });
  const scope = {
    authorization: {
      organizationId: "tenant",
      actor: { id: "user", kind: "user" as const },
    },
    appId: "coder",
  };
  const binding = await service.create(scope, {
    threadId: "thread_1",
    agentId: "coder",
    workspace: {
      organizationId: "tenant",
      appId: "coder",
      projectId: "project",
      workspaceId: "workspace",
      branch: "main",
    },
    mode: "build",
    thinkingLevel: "high",
  });
  const target = { ...scope, threadId: binding.thread.threadId };

  assert.equal((await service.list(scope)).length, 1);
  assert.equal((await service.rename!(target, { title: "Rate limits" })).metadata?.title, "Rate limits");
  await service.rollback!(target, { turnId: "turn_1" });
  const subagents = await service.subagentAction!(target, "list", {});
  assert.equal((subagents as { threads: unknown[] }).threads.length, 1);
  await service.scheduleAction!(target, "register", {
    id: "daily-review",
    message: "Review the repository.",
    trigger: { kind: "interval", intervalMs: 60_000 },
  });
  const schedules = await service.scheduleAction!(target, "list", {});
  assert.equal(
    (schedules as { schedules: unknown[] }).schedules.length,
    1,
  );
  const records = await service.auditList!(target, { after: 0, limit: 100 });
  assert.ok(records.some((record: any) => record.recordType === "rollback"));

  await assert.rejects(
    service.inspect({
      ...target,
      authorization: {
        organizationId: "other",
        actor: { id: "user", kind: "user" },
      },
    }),
    /not found|does not belong/,
  );
});

test("thread model selection is durable, exact, and auditable", async () => {
  const service = createCloudflareThreadService({
    env: {},
    namespace: namespace(),
  });
  const scope = {
    authorization: {
      organizationId: "tenant_models",
      actor: { id: "user", kind: "user" as const },
    },
    appId: "coder",
  };
  const binding = await service.create(scope, {
    threadId: "thread_models",
    agentId: "coder",
    workspace: {
      organizationId: "tenant_models",
      appId: "coder",
      projectId: "project",
      workspaceId: "workspace",
      branch: "main",
    },
    mode: "build",
    model: { provider: "openai", model: "gpt-5" },
    thinkingLevel: "high",
    metadata: {
      flaryModelPolicy: {
        allow: [
          { provider: "openai", model: "gpt-5" },
          { provider: "anthropic", model: "claude-sonnet" },
        ],
        switching: "user",
        fallback: "none",
      },
    },
  });
  const target = { ...scope, threadId: binding.thread.threadId };
  assert.deepEqual(await service.modelGet!(target), {
    provider: "openai",
    model: "gpt-5",
  });
  assert.equal((await service.modelList!(target)).length, 2);
  await service.modelSet!(target, {
    model: "anthropic/claude-sonnet",
  });
  assert.deepEqual(await service.modelGet!(target), {
    provider: "anthropic",
    model: "claude-sonnet",
  });
  await assert.rejects(
    service.modelSet!(target, { model: "google/gemini" }),
    /not allowed/,
  );
  const history = await service.modelHistory!(target);
  assert.equal(history.length, 1);
  const records = await service.auditList!(target, { after: 0, limit: 100 });
  assert.ok(records.some((record: any) => record.recordType === "model.changed"));
  assert.ok(records.some((record: any) => record.recordType === "provider.cache_reset"));
  const archive = await service.auditExport!(target);
  const restored = await service.restore!(target, {
    jsonl: archive as string,
    replace: true,
  });
  assert.equal((restored as { restored: boolean }).restored, true);
  const child = await service.fork(target, { threadId: "thread_models_child" });
  const childRecords = await service.auditList!(
    { ...scope, threadId: child.thread.threadId },
    { after: 0, limit: 100 },
  );
  assert.ok(childRecords.some((record: any) => record.publicPayload?._forkedFrom));
});

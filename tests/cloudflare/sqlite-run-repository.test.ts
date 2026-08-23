import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { SqliteFlaryRunRepository } from "../../src/harness/cloudflare/sqlite-run-repository.ts";
import {
  createFlueRunService,
  type FlueAgentGateway,
} from "../../src/harness/flue/service.ts";
import { SqliteFlaryStepStore } from "../../src/harness/functions/runs.ts";
import { UserInputRequestSchema } from "../../src/harness/contracts/index.ts";
import type { TrustedRunContext } from "../../src/harness/host/runs.ts";

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

const tenantOne: TrustedRunContext = {
  tenantId: "tenant_1",
  applicationId: "app_1",
  agentId: "support",
  identity: { id: "user_1", kind: "user", version: "1" },
  roles: [],
  scopes: [],
};

test("Durable Object SQLite keeps run ownership after service restart", async () => {
  const sql = sqlStore();
  const gateway: FlueAgentGateway = {
    async send() {
      return {
        streamUrl: "https://example.com/stream",
        offset: "0",
        submissionId: "submission_sqlite",
      };
    },
    async wait() {
      return { answer: "done" };
    },
    async abort() {
      return { aborted: true };
    },
  };
  const first = createFlueRunService({
    repository: new SqliteFlaryRunRepository(sql),
    gateway,
    createRunId: () => "run_sqlite_restart",
    pollMs: 1,
  });
  const handle = await first.create(tenantOne, {
    requestId: "request_sqlite",
    channelId: "support",
    execution: "agent",
    input: "test",
    requestedAt: new Date().toISOString(),
  });

  const restarted = createFlueRunService({
    repository: new SqliteFlaryRunRepository(sql),
    gateway,
    pollMs: 1,
  });
  assert.equal((await restarted.get(tenantOne, handle.runId)).runId, handle.runId);
  await assert.rejects(
    restarted.get({ ...tenantOne, tenantId: "tenant_2" }, handle.runId),
    (error: unknown) =>
      error instanceof Error &&
      (error as Error & { code?: string }).code === "run_not_found",
  );
});

test("Durable Object SQLite replays named function steps after restart", async () => {
  const sql = sqlStore();
  const first = new SqliteFlaryStepStore(sql);
  await first.put({
    runId: "run_steps",
    name: "plan",
    inputHash: "hash_1",
    value: { summary: "keep this" },
  });

  const restarted = new SqliteFlaryStepStore(sql);
  assert.deepEqual(await restarted.get({ runId: "run_steps", name: "plan" }), {
    inputHash: "hash_1",
    value: { summary: "keep this" },
  });
});

test("Durable Object SQLite keeps user-input requests across restart and workflow ids", async () => {
  const sql = sqlStore();
  const gateway: FlueAgentGateway = {
    async send() {
      return {
        streamUrl: "https://example.com/stream",
        offset: "0",
        submissionId: "submission_user_input",
      };
    },
    async wait() {
      return { answer: "done" };
    },
    async abort() {
      return { aborted: true };
    },
  };
  const service = createFlueRunService({
    repository: new SqliteFlaryRunRepository(sql),
    gateway,
    createRunId: () => "run_user_input",
    pollMs: 1,
  });
  await service.create(tenantOne, {
    requestId: "request_user_input",
    channelId: "support",
    execution: "agent",
    input: "test",
    requestedAt: new Date().toISOString(),
  });

  const request = UserInputRequestSchema.parse({
    id: "input_restart",
    threadId: "submission_user_input",
    questions: [{
      header: "Branch",
      question: "Which branch should Flary use?",
      options: [{ label: "main", description: "The default branch" }],
      multiSelect: false,
    }],
    requestedBy: { id: "flary", kind: "agent", version: "1" },
    requestedAt: new Date().toISOString(),
  });
  const first = new SqliteFlaryRunRepository(sql);
  await first.createUserInput("submission_user_input", request);

  const restarted = new SqliteFlaryRunRepository(sql);
  assert.equal((await restarted.listUserInput("run_user_input")).length, 1);
  assert.equal(
    (await restarted.getUserInput("submission_user_input", "input_restart"))?.response,
    null,
  );
  const answered = await restarted.respondToUserInput(
    "submission_user_input",
    "input_restart",
    { answers: { Branch: "main" } },
    tenantOne.identity,
  );
  assert.equal(answered.response?.answers.Branch, "main");
  assert.equal((await restarted.listUserInput("run_user_input"))[0]?.response?.canceled, false);
});

test("Durable Object SQLite stores input for standalone interactive threads", async () => {
  const repository = new SqliteFlaryRunRepository(sqlStore());
  const runId = "tenant:app:concierge:thread_input";
  const request = UserInputRequestSchema.parse({
    id: "input_thread",
    threadId: runId,
    questions: [{
      header: "Delivery",
      question: "When should we deliver?",
      options: [{ label: "Tomorrow", description: "Recommended" }],
      multiSelect: false,
    }],
    requestedBy: { id: "concierge", kind: "agent" },
    requestedAt: new Date().toISOString(),
  });
  await repository.createUserInput(runId, request);
  assert.equal((await repository.listUserInput(runId))[0]?.request.id, "input_thread");
  const answered = await repository.respondToUserInput(
    runId,
    "input_thread",
    { answers: { Delivery: "Tomorrow" } },
    { id: "user_1", kind: "user" },
  );
  assert.equal(answered.response?.answers.Delivery, "Tomorrow");
});

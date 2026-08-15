import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { D1ThreadCatalog } from "../../src/harness/cloudflare/index.ts";

test("D1 thread catalog lists only the requested tenant and agent", async () => {
  const database = new DatabaseSync(":memory:");
  const catalog = new D1ThreadCatalog({
    async exec(query) {
      database.exec(query);
      return {};
    },
    prepare(query) {
      let bindings: unknown[] = [];
      return {
        bind(...values: unknown[]) {
          bindings = values;
          return this;
        },
        async run() {
          database.prepare(query).run(...bindings);
          return {};
        },
        async all<T>() {
          return {
            results: database.prepare(query).all(...bindings) as T[],
          };
        },
        async first<T>() {
          return (database.prepare(query).get(...bindings) as T) ?? null;
        },
      };
    },
  });
  const binding = (tenant: string, threadId: string) => ({
    thread: {
      organizationId: tenant,
      appId: "coder",
      agentId: "coder",
      threadId,
    },
    workspace: {
      organizationId: tenant,
      appId: "coder",
      projectId: "project",
      workspaceId: "workspace",
      branch: "main",
    },
    agentId: "coder",
    persona: "default",
    defaultMode: "build" as const,
    defaultModel: { provider: "openai", model: "gpt-5" },
    defaultThinkingLevel: "high" as const,
    connectionIds: [],
    createdBy: { id: "user", kind: "user" as const },
    status: "active" as const,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  await catalog.put(binding("tenant-a", "thread-a"));
  await catalog.put(binding("tenant-b", "thread-b"));

  const rows = await catalog.list({
    tenantId: "tenant-a",
    applicationId: "coder",
    agentId: "coder",
  });
  assert.deepEqual(rows.map((row) => row.thread.threadId), ["thread-a"]);

  const deletion = await catalog.putDeletion({
    id: "delete_thread_a",
    threadId: "thread-a",
    status: "accepted",
    acceptedAt: "2026-08-06T00:00:00.000Z",
    tenantId: "tenant-a",
    applicationId: "coder",
  });
  assert.equal(deletion.status, "accepted");
  assert.equal(
    (await catalog.getDeletion({
      tenantId: "tenant-a",
      applicationId: "coder",
      deletionId: "delete_thread_a",
    }))?.threadId,
    "thread-a",
  );
});

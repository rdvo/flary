import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { CloudflareSandboxWorkspaceBackend } from "../../src/harness/cloudflare/workspace-execution.ts";

function sqlStorage() {
  const database = new DatabaseSync(":memory:");
  return {
    database,
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
    },
  };
}

test("Sandbox workspace execution restores, syncs, checkpoints, and backs up", async () => {
  const storage = sqlStorage();
  const workspaceFiles = new Map<string, string>([["old.txt", "old"]]);
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  const workspace = {
    descriptors: [],
    async call(name: string, input: unknown) {
      const value = input as Record<string, unknown>;
      calls.push({ name, input: value });
      if (name === "list") {
        return { files: [...workspaceFiles].map(([path]) => ({ path, mediaType: "text/plain" })) };
      }
      if (name === "read") {
        return { content: workspaceFiles.get(String(value.path)), encoding: "utf8" };
      }
      if (name === "write") {
        workspaceFiles.set(String(value.path), String(value.content));
        return { written: true };
      }
      if (name === "delete") {
        workspaceFiles.delete(String(value.path));
        return { deleted: true };
      }
      if (name === "__checkpoint") return { commit: { id: value.id } };
      throw new Error(`Unexpected workspace call ${name}`);
    },
  };
  let restored: unknown;
  let watched = false;
  let backups = 0;
  const sandbox = {
    async createBackup() {
      backups += 1;
      return { id: "backup_1", dir: "/workspace", localBucket: true };
    },
    async restoreBackup(backup: unknown) {
      restored = backup;
      return { success: true, id: "backup_1", dir: "/workspace" };
    },
    async listFiles() {
      return {
        files: [
          {
            type: "file",
            relativePath: "new.txt",
            absolutePath: "/workspace/new.txt",
          },
        ],
      };
    },
    async readFile() {
      return { content: "bmV3", mimeType: "text/plain" };
    },
    async writeFile() {},
    async mkdir() {},
    async watch() {
      watched = true;
      return new ReadableStream<Uint8Array>();
    },
  };
  const backend = new CloudflareSandboxWorkspaceBackend({
    sandbox: sandbox as never,
    workspace,
    sql: storage.sql,
    sessionId: "thread_1",
  });
  await backend.prepare();
  assert.equal(watched, true);
  const result = await backend.settle({
    operationId: "operation_1",
    submissionId: "submission_1",
    changed: true,
  });
  assert.equal(result.state, "completed");
  assert.equal(workspaceFiles.has("old.txt"), false);
  assert.equal(workspaceFiles.get("new.txt"), "bmV3");
  assert.ok(calls.some(({ name }) => name === "__checkpoint"));
  const replayed = await backend.settle({
    operationId: "operation_1",
    submissionId: "submission_1",
    changed: true,
  });
  assert.equal(replayed.state, "completed");
  assert.equal(backups, 1);

  const replacement = new CloudflareSandboxWorkspaceBackend({
    sandbox: sandbox as never,
    workspace,
    sql: storage.sql,
    sessionId: "thread_1",
  });
  await replacement.prepare();
  assert.deepEqual(restored, {
    id: "backup_1",
    dir: "/workspace",
    localBucket: true,
  });
});

test("interrupted Sandbox operations stay outcome_unknown", async () => {
  const storage = sqlStorage();
  const backend = new CloudflareSandboxWorkspaceBackend({
    sandbox: {} as never,
    workspace: {} as never,
    sql: storage.sql,
    sessionId: "thread_1",
  });
  const result = await backend.uncertain("operation_2");
  assert.equal(result.state, "outcome_unknown");
  const row = storage.database
    .prepare("SELECT state FROM flary_workspace_execution WHERE operation_id = ?")
    .get("operation_2") as { state: string };
  assert.equal(row.state, "outcome_unknown");
});

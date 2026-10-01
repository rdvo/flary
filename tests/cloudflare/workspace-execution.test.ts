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

test("missing or expired backups recover from durable workspace files", async (t) => {
  for (const code of ["BACKUP_NOT_FOUND", "BACKUP_EXPIRED"]) {
    await t.test(code, async () => {
      const fixture = createRecoveryFixture(code);
      await fixture.backend.prepare();

      assert.equal(fixture.watchCalls, 1);
      assert.deepEqual([...fixture.sandboxFiles.keys()].sort(), ["README.md", "payload.bin"]);
      assert.deepEqual(fixture.sandboxFiles.get("README.md"), {
        content: "durable text",
        encoding: "utf8",
        mediaType: "text/plain",
      });
      assert.deepEqual(fixture.sandboxFiles.get("payload.bin"), {
        content: "AP8BQg==",
        encoding: "base64",
        mediaType: "application/octet-stream",
      });
      assert.deepEqual(fixture.deletedFiles.sort(), [
        "/workspace/README.md",
        "/workspace/stale.txt",
      ]);
      assert.equal(
        fixture.storage.database
          .prepare(
            "SELECT value_json FROM flary_workspace_execution_state WHERE key = 'latest-backup'",
          )
          .get() as unknown,
        undefined,
      );

      const result = await fixture.backend.settle({
        operationId: `recover_${code}`,
        changed: true,
      });
      assert.equal(result.backup?.id, "backup_fresh_1");
      assert.deepEqual(fixture.workspaceFiles.get("payload.bin"), {
        content: "AP8BQg==",
        encoding: "base64",
        mediaType: "application/octet-stream",
      });
      const latest = fixture.storage.database
        .prepare(
          "SELECT value_json FROM flary_workspace_execution_state WHERE key = 'latest-backup'",
        )
        .get() as { value_json: string };
      assert.equal(JSON.parse(latest.value_json).id, "backup_fresh_1");
    });
  }
});

test("unrelated restore failures propagate and leave prepare uncompleted", async (t) => {
  for (const code of ["BACKUP_RESTORE_FAILED", "MISSING_CREDENTIALS", "SERVICE_NOT_RESPONDING"]) {
    await t.test(code, async () => {
      const fixture = createRecoveryFixture(code);
      await assert.rejects(fixture.backend.prepare(), (error) => error === fixture.restoreError);
      assert.equal(fixture.restoreCalls, 1);
      assert.equal(fixture.workspaceCalls.length, 0);
      assert.equal(fixture.listFilesCalls, 0);
      assert.equal(fixture.watchCalls, 0);

      // A second call retries restore, proving the failed preparation was not latched.
      await assert.rejects(fixture.backend.prepare(), (error) => error === fixture.restoreError);
      assert.equal(fixture.restoreCalls, 2);
      assert.equal(fixture.workspaceCalls.length, 0);
      assert.equal(fixture.watchCalls, 0);
    });
  }
});

function createRecoveryFixture(code: string) {
  const storage = sqlStorage();
  const restoreError = Object.assign(new Error(`restore failed: ${code}`), { code });
  const workspaceFiles = new Map([
    ["README.md", { content: "durable text", encoding: "utf8", mediaType: "text/plain" }],
    [
      "payload.bin",
      { content: "AP8BQg==", encoding: "base64", mediaType: "application/octet-stream" },
    ],
  ]);
  const sandboxFiles = new Map<string, { content: string; encoding: string; mediaType: string }>();
  const workspaceCalls: string[] = [];
  const deletedFiles: string[] = [];
  let restoreCalls = 0;
  let listFilesCalls = 0;
  let watchCalls = 0;
  let backups = 0;
  const workspace = {
    descriptors: [],
    async call(name: string, input: unknown) {
      workspaceCalls.push(name);
      const value = input as Record<string, unknown>;
      if (name === "list") {
        return {
          files: [...workspaceFiles].map(([path, file]) => ({ path, mediaType: file.mediaType })),
        };
      }
      if (name === "read") {
        const file = workspaceFiles.get(String(value.path));
        assert.ok(file, `missing durable workspace file ${String(value.path)}`);
        if (value.encoding === "base64" && file.encoding === "utf8") {
          return {
            content: Buffer.from(file.content, "utf8").toString("base64"),
            encoding: "base64",
          };
        }
        return { content: file.content, encoding: file.encoding };
      }
      if (name === "write") {
        workspaceFiles.set(String(value.path), {
          content: String(value.content),
          encoding: String(value.encoding),
          mediaType: String(value.mediaType ?? "application/octet-stream"),
        });
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
  const sandbox = {
    async createBackup() {
      backups += 1;
      return { id: `backup_fresh_${backups}`, dir: "/workspace", localBucket: true };
    },
    async restoreBackup() {
      restoreCalls += 1;
      sandboxFiles.set("README.md", {
        content: "partial stale text",
        encoding: "utf8",
        mediaType: "text/plain",
      });
      sandboxFiles.set("stale.txt", {
        content: "must be removed",
        encoding: "utf8",
        mediaType: "text/plain",
      });
      throw restoreError;
    },
    async listFiles() {
      listFilesCalls += 1;
      return {
        files: [...sandboxFiles].map(([relativePath]) => ({
          type: "file",
          relativePath,
          absolutePath: `/workspace/${relativePath}`,
        })),
      };
    },
    async deleteFile(path: string) {
      deletedFiles.push(path);
      sandboxFiles.delete(path.replace(/^\/workspace\//, ""));
      return { success: true };
    },
    async readFile(path: string) {
      const file = sandboxFiles.get(path.replace(/^\/workspace\//, ""));
      assert.ok(file, `missing sandbox file ${path}`);
      return {
        content:
          file.encoding === "base64"
            ? file.content
            : Buffer.from(file.content, "utf8").toString("base64"),
        mimeType: file.mediaType,
      };
    },
    async writeFile(path: string, content: string, options?: { encoding?: string }) {
      const relativePath = path.replace(/^\/workspace\//, "");
      sandboxFiles.set(relativePath, {
        content,
        encoding: options?.encoding ?? "utf8",
        mediaType: relativePath.endsWith(".bin") ? "application/octet-stream" : "text/plain",
      });
    },
    async mkdir() {},
    async watch() {
      watchCalls += 1;
      return new ReadableStream<Uint8Array>();
    },
  };
  const backend = new CloudflareSandboxWorkspaceBackend({
    sandbox: sandbox as never,
    workspace,
    sql: storage.sql,
    sessionId: "thread_recovery",
  });
  storage.database
    .prepare(
      "INSERT INTO flary_workspace_execution_state (key, value_json, updated_at) VALUES ('latest-backup', ?, ?)",
    )
    .run(
      JSON.stringify({ id: "backup_old", dir: "/workspace", localBucket: true }),
      new Date().toISOString(),
    );

  return {
    backend,
    deletedFiles,
    get listFilesCalls() {
      return listFilesCalls;
    },
    get restoreCalls() {
      return restoreCalls;
    },
    restoreError,
    sandboxFiles,
    storage,
    get watchCalls() {
      return watchCalls;
    },
    workspaceCalls,
    workspaceFiles,
  };
}

test("an existing live process keeps its workspace instead of restoring an older backup", async () => {
  const storage = sqlStorage();
  let watchCalls = 0;
  const backend = new CloudflareSandboxWorkspaceBackend({
    sandbox: {
      async watch() {
        watchCalls += 1;
        return new ReadableStream<Uint8Array>();
      },
    } as never,
    workspace: {} as never,
    sql: storage.sql,
    sessionId: "live_process_workspace",
  });
  storage.sql.exec(
    "INSERT INTO flary_workspace_execution_state (key, value_json, updated_at) VALUES ('latest-backup', ?, ?)",
    JSON.stringify({ id: "older_backup" }),
    new Date().toISOString(),
  );
  await backend.prepare({ preserveLiveWorkspace: true });
  await backend.prepare();
  assert.equal(watchCalls, 1, "prepare must watch without reading or overwriting live files");
});

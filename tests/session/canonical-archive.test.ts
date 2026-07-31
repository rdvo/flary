import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  R2CanonicalSessionArchive,
  SqliteCanonicalSessionArchive,
} from "../../src/harness/session/index.ts";

test("canonical session archive encrypts and verifies complete content", async () => {
  const objects = new Map<string, Uint8Array>();
  const bucket = {
    async put(key: string, value: ArrayBuffer | ArrayBufferView) {
      const bytes = value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
      objects.set(key, bytes);
    },
    async get(key: string) {
      const value = objects.get(key);
      return value ? { arrayBuffer: async () => value.slice().buffer } : null;
    },
    async delete(key: string) {
      objects.delete(key);
    },
  };
  const archive = new R2CanonicalSessionArchive({
    bucket,
    secret: "a".repeat(48),
  });
  const entry = await archive.put("thread_1", '{"nativeResponseId":"private"}\n');
  assert.notDeepEqual(objects.get(entry.storageKey), new TextEncoder().encode('{"nativeResponseId":"private"}\n'));
  const restored = new TextDecoder().decode(await archive.read(entry));
  assert.equal(restored, '{"nativeResponseId":"private"}\n');
  await archive.delete(entry);
  await assert.rejects(archive.read(entry), /missing/);
});

test("canonical archive keeps an SQLite manifest and deletes all session objects", async () => {
  const database = new DatabaseSync(":memory:");
  const sql = {
    exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]) {
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
  };
  const objects = new Map<string, Uint8Array>();
  const bucket = {
    async put(key: string, value: ArrayBuffer | ArrayBufferView) {
      const bytes = value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
      objects.set(key, bytes);
    },
    async get(key: string) {
      const value = objects.get(key);
      return value ? { arrayBuffer: async () => value.slice().buffer } : null;
    },
    async delete(key: string) {
      objects.delete(key);
    },
  };
  const archive = new SqliteCanonicalSessionArchive({
    sql,
    bucket,
    secret: "b".repeat(48),
  });
  await archive.append("thread_1", "snapshot-1");
  await archive.append("thread_1", "snapshot-2");
  assert.equal((await archive.list("thread_1")).length, 2);
  assert.deepEqual(
    (await archive.read("thread_1")).map((value) => new TextDecoder().decode(value)),
    ["snapshot-1", "snapshot-2"],
  );
  assert.equal(await archive.deleteSession("thread_1"), 2);
  assert.equal((await archive.list("thread_1")).length, 0);
  assert.equal(objects.size, 0);
});

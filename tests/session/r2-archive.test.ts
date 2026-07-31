import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  R2SessionArchive,
  SqliteSessionLedger,
} from "../../src/harness/session/index.ts";

test("seals cold records as encrypted R2 segments and keeps a hot SQLite window", async () => {
  const storage = sqlite();
  const ledger = new SqliteSessionLedger(storage.sql, { hotRecordLimit: 2 });
  for (let index = 1; index <= 5; index += 1) {
    await ledger.append({
      tenantId: "tenant",
      applicationId: "app",
      sessionId: "session",
      threadId: "thread",
      sourceCursor: `event:${index}`,
      recordType: "runtime.event",
      recordedAt: new Date(index * 1_000).toISOString(),
      attempt: 0,
      sourceRevision: "revision",
      publicPayload: { index },
    });
  }

  const objects = new Map<string, Uint8Array>();
  const archive = new R2SessionArchive({
    sql: storage.sql,
    secret: "0123456789abcdef0123456789abcdef",
    bucket: {
      async put(key, value) {
        const bytes =
          value instanceof ReadableStream
            ? new Uint8Array(await new Response(value).arrayBuffer())
            : ArrayBuffer.isView(value)
              ? new Uint8Array(
                  value.buffer.slice(
                    value.byteOffset,
                    value.byteOffset + value.byteLength,
                  ),
                )
              : new Uint8Array(value);
        objects.set(key, bytes);
      },
      async get(key) {
        const bytes = objects.get(key);
        return bytes
          ? { arrayBuffer: async () => bytes.slice().buffer as ArrayBuffer }
          : null;
      },
    },
  });

  assert.equal(await archive.sealColdRecords("session"), 3);
  assert.equal(
    storage.sql.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM flary_session_ledger_records",
    ).toArray()[0]!.count,
    2,
  );
  const records = await archive.read("session");
  assert.deepEqual(records.map((record) => record.sequence), [1, 2, 3]);
  assert.equal((await ledger.metadata("session"))?.sealedThroughSequence, 3);

  await ledger.append({
    tenantId: "tenant",
    applicationId: "app",
    sessionId: "session",
    threadId: "thread",
    sourceCursor: "event:6",
    recordType: "runtime.event",
    recordedAt: new Date(6_000).toISOString(),
    attempt: 0,
    sourceRevision: "revision",
    publicPayload: { index: 6 },
  });
  await ledger.verify("session");
});

function sqlite() {
  const database = new DatabaseSync(":memory:");
  return {
    sql: {
      exec<T>(query: string, ...bindings: unknown[]) {
        if (
          bindings.length === 0 &&
          !query.trimStart().toLowerCase().startsWith("select")
        ) {
          database.exec(query);
          return { toArray: () => [] as T[] };
        }
        const statement = database.prepare(query);
        if (
          query.trimStart().toLowerCase().startsWith("select") ||
          query.toLowerCase().includes(" returning ")
        ) {
          return { toArray: () => statement.all(...bindings) as T[] };
        }
        statement.run(...bindings);
        return { toArray: () => [] as T[] };
      },
      transactionSync<T>(closure: () => T): T {
        database.exec("BEGIN IMMEDIATE");
        try {
          const result = closure();
          database.exec("COMMIT");
          return result;
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      },
    },
  };
}

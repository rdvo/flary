import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  SqliteSessionLedger,
} from "../../src/harness/session/sqlite.ts";

type SqlDatabase = {
  exec(query: string): void;
  prepare(query: string): {
    all(...bindings: unknown[]): unknown[];
    run(...bindings: unknown[]): unknown;
  };
};

function sqlStore() {
  const database = new DatabaseSync(":memory:") as unknown as SqlDatabase;
  let transactionDepth = 0;
  return {
    database,
    sql: {
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

function appendInput(sequence: number) {
  return {
    tenantId: "tenant_1",
    applicationId: "app_1",
    sessionId: "session_sqlite",
    threadId: "thread_sqlite",
    sourceCursor: `flue:${sequence}`,
    recordType: "message.assistant" as const,
    recordedAt: `2026-07-30T12:00:0${sequence}.000Z`,
    attempt: 0,
    sourceRevision: "flue@1",
    publicPayload: { sequence },
  };
}

test("appends records and reads pages after a stable cursor", async () => {
  const { sql } = sqlStore();
  const first = new SqliteSessionLedger(sql, { hotRecordLimit: 2 });
  const one = await first.append(appendInput(1));
  const two = await first.append(appendInput(2));
  const three = await first.append(appendInput(3));

  assert.equal(one.sequence, 1);
  assert.equal(two.previousHash, one.recordHash);
  assert.equal(three.previousHash, two.recordHash);

  const pageOne = await first.list("session_sqlite", { limit: 2 });
  assert.deepEqual(pageOne.items.map(({ sequence }) => sequence), [1, 2]);
  assert.equal(pageOne.nextCursor, "v1:2");
  const pageTwo = await first.list("session_sqlite", {
    after: pageOne.nextCursor,
    limit: 2,
  });
  assert.deepEqual(pageTwo.items.map(({ sequence }) => sequence), [3]);
  assert.equal(pageTwo.nextCursor, undefined);
});

test("keeps ownership, chain data, and hot-record metadata after restart", async () => {
  const { sql } = sqlStore();
  const first = new SqliteSessionLedger(sql, { hotRecordLimit: 2 });
  await first.append(appendInput(1));
  await first.append(appendInput(2));
  await first.append(appendInput(3));

  const restarted = new SqliteSessionLedger(sql);
  await restarted.verify("session_sqlite");
  assert.deepEqual(await restarted.metadata("session_sqlite"), {
    tenantId: "tenant_1",
    applicationId: "app_1",
    sessionId: "session_sqlite",
    threadId: "thread_sqlite",
    recordCount: 3,
    latestSequence: 3,
    latestHash: (await restarted.list("session_sqlite", { limit: 3 }))
      .items[2]?.recordHash,
    hotRecordLimit: 2,
    hotStartSequence: 2,
    hotRecordCount: 2,
    recordsPastHotLimit: 1,
    archiveRequired: true,
    sealedThroughSequence: 0,
    updatedAt: "2026-07-30T12:00:03.000Z",
  });

  const sealed = await restarted.markSealedThrough("session_sqlite", 1);
  assert.equal(sealed.archiveRequired, false);
  await assert.rejects(
    restarted.append({
      ...appendInput(4),
      tenantId: "tenant_2",
    }),
    /different scope/i,
  );
});

test("detects a changed SQLite record", async () => {
  const { database, sql } = sqlStore();
  const ledger = new SqliteSessionLedger(sql);
  await ledger.append(appendInput(1));
  const row = database.prepare(
    `SELECT record_json FROM flary_session_ledger_records
     WHERE session_id = ? AND sequence = ?`,
  ).all("session_sqlite", 1)[0] as { record_json: string };
  const record = JSON.parse(row.record_json) as {
    publicPayload: Record<string, unknown>;
  };
  record.publicPayload = { changed: true };
  database.prepare(
    `UPDATE flary_session_ledger_records
     SET record_json = ? WHERE session_id = ? AND sequence = ?`,
  ).run(JSON.stringify(record), "session_sqlite", 1);

  await assert.rejects(ledger.verify("session_sqlite"), /record hash/i);
});

test("serializes concurrent appends into one valid chain", async () => {
  const { sql } = sqlStore();
  const ledger = new SqliteSessionLedger(sql);
  await Promise.all(
    Array.from({ length: 10 }, (_, index) =>
      ledger.append({
        ...appendInput((index % 9) + 1),
        sourceCursor: `concurrent:${index}`,
        recordedAt: "2026-07-30T12:00:00.000Z",
      })),
  );

  await ledger.verify("session_sqlite");
  assert.deepEqual(
    (await ledger.list("session_sqlite", { limit: 10 })).items.map(
      ({ sequence }) => sequence,
    ),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  );
});

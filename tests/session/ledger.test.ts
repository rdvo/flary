import assert from "node:assert/strict";
import test from "node:test";

import {
  SESSION_LEDGER_FORMAT,
  SESSION_LEDGER_SCHEMA_VERSION,
  type SessionRecordDraft,
} from "../../src/harness/session/contracts.ts";
import {
  sealSessionRecord,
  verifySessionChain,
} from "../../src/harness/session/integrity.ts";
import {
  exportSessionJsonl,
  importSessionJsonl,
  SessionJsonlError,
} from "../../src/harness/session/jsonl.ts";

const baseDraft: SessionRecordDraft = {
  schemaVersion: SESSION_LEDGER_SCHEMA_VERSION,
  format: SESSION_LEDGER_FORMAT,
  tenantId: "tenant_1",
  applicationId: "app_1",
  sessionId: "session_1",
  threadId: "thread_1",
  sourceCursor: "flue:1",
  recordType: "turn.started",
  recordedAt: "2026-07-30T12:00:00.000Z",
  attempt: 0,
  sourceRevision: "flue@1",
  publicPayload: { title: "Test" },
};

test("seals, verifies, and round-trips a deterministic session chain", async () => {
  const first = await sealSessionRecord(baseDraft, 1, null);
  const second = await sealSessionRecord(
    {
      ...baseDraft,
      sourceCursor: "flue:2",
      recordType: "turn.completed",
      publicPayload: { result: "done" },
    },
    2,
    first.recordHash,
  );
  await verifySessionChain([first, second]);

  const jsonl = exportSessionJsonl([first, second]);
  assert.deepEqual(await importSessionJsonl(jsonl), [first, second]);
  assert.equal(exportSessionJsonl(await importSessionJsonl(jsonl)), jsonl);
});

test("rejects a changed public payload and a broken previous hash", async () => {
  const first = await sealSessionRecord(baseDraft, 1, null);
  const changed = {
    ...first,
    publicPayload: { title: "Changed after sealing" },
  };
  await assert.rejects(
    verifySessionChain([changed]),
    /record hash does not match/i,
  );

  const second = await sealSessionRecord(
    { ...baseDraft, sourceCursor: "flue:2" },
    2,
    "a".repeat(64),
  );
  await assert.rejects(
    verifySessionChain([first, second]),
    /previous hash does not match/i,
  );
});

test("reports the JSONL line that has invalid data", async () => {
  const first = await sealSessionRecord(baseDraft, 1, null);
  await assert.rejects(
    importSessionJsonl(`${exportSessionJsonl([first])}{"bad":true}\n`),
    (error: unknown) =>
      error instanceof SessionJsonlError && error.lineNumber === 2,
  );
});

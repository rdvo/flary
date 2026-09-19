import assert from "node:assert/strict";

import {
  migrateSessionEngine,
  type SessionEngine,
  type SessionEngineCapabilities,
  type SessionEngineForkArchive,
} from "../../src/harness/session/engine.js";

const legacyRecords = [
  {
    v: 1,
    id: "record_conversation_created_conv_legacy_1",
    type: "conversation_created",
    conversationId: "conv_legacy_1",
    harness: "default",
    session: "default",
    affinityKey: "aff_legacy_1",
    kind: "root",
    timestamp: "2026-09-19T19:00:00.000Z",
  },
  {
    v: 1,
    id: "record_user_message_1",
    type: "user_message",
    conversationId: "conv_legacy_1",
    harness: "default",
    session: "default",
    messageId: "entry_user_1",
    parentId: null,
    submissionId: "submission_legacy_1",
    turnId: "turn_legacy_1",
    content: "hello",
    timestamp: "2026-09-19T19:00:01.000Z",
  },
  {
    v: 1,
    id: "record_assistant_started_1",
    type: "assistant_message_started",
    conversationId: "conv_legacy_1",
    harness: "default",
    session: "default",
    messageId: "entry_assistant_1",
    parentId: "entry_user_1",
    submissionId: "submission_legacy_1",
    turnId: "turn_legacy_1",
    timestamp: "2026-09-19T19:00:02.000Z",
    modelInfo: {
      api: "faux",
      provider: "fixture",
      model: "fixture-1",
    },
  },
  {
    v: 1,
    id: "record_assistant_text_1",
    type: "assistant_text_started",
    conversationId: "conv_legacy_1",
    harness: "default",
    session: "default",
    messageId: "entry_assistant_1",
    blockId: "block_1",
    blockIndex: 0,
    timestamp: "2026-09-19T19:00:02.000Z",
  },
  {
    v: 1,
    id: "record_assistant_delta_1",
    type: "assistant_text_delta",
    conversationId: "conv_legacy_1",
    harness: "default",
    session: "default",
    messageId: "entry_assistant_1",
    blockId: "block_1",
    delta: "hello back",
    deltaIndex: 0,
    timestamp: "2026-09-19T19:00:03.000Z",
  },
  {
    v: 1,
    id: "record_assistant_text_done_1",
    type: "assistant_text_completed",
    conversationId: "conv_legacy_1",
    harness: "default",
    session: "default",
    messageId: "entry_assistant_1",
    blockId: "block_1",
    deltaCount: 1,
    timestamp: "2026-09-19T19:00:04.000Z",
  },
  {
    v: 1,
    id: "record_assistant_completed_1",
    type: "assistant_message_completed",
    conversationId: "conv_legacy_1",
    harness: "default",
    session: "default",
    messageId: "entry_assistant_1",
    submissionId: "submission_legacy_1",
    turnId: "turn_legacy_1",
    stopReason: "stop",
    usage: {
      input: 1,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 3,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: "2026-09-19T19:00:04.000Z",
  },
  {
    v: 1,
    id: "record_submission_settled_1",
    type: "submission_settled",
    conversationId: "conv_legacy_1",
    harness: "default",
    session: "default",
    submissionId: "submission_legacy_1",
    outcome: "completed",
    timestamp: "2026-09-19T19:00:05.000Z",
  },
] as const;

const legacyArchivePayload = {
  format: "flue-canonical",
  version: 1,
  batches: [legacyRecords],
  throughTurnId: "turn_legacy_1",
};

const capabilities: SessionEngineCapabilities = {
  durableAdmission: true,
  durableObservation: true,
  manualCompaction: true,
  activePathRollback: true,
  exactCanonicalExport: true,
  exactCanonicalRestore: true,
  perSubmissionModelPin: true,
  approvalContinuation: true,
};

async function hashJson(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

let restored: unknown;
const archive: SessionEngineForkArchive = {
  format: "flary-session-engine",
  version: 1,
  source: {
    id: "flue-legacy",
    version: "1.0.0-beta.9",
    revision: "fixture-beta9-export",
  },
  threadId: "thread-legacy-1",
  sha256: await hashJson(legacyArchivePayload),
  payload: legacyArchivePayload,
};

const source: SessionEngine = {
  pin: archive.source,
  capabilities,
  submit: async () => {
    throw new Error("fixture source is export-only");
  },
  observe: async () => undefined,
  cancel: async () => {},
  compact: async () => undefined,
  rollback: async () => undefined,
  export: async () => archive,
  restore: async () => {},
  active: async () => false,
};

const target: SessionEngine = {
  pin: {
    id: "flue-2",
    version: "2.1.0",
    revision: "fixture-flue2-target",
  },
  capabilities,
  submit: async () => {
    throw new Error("fixture target is restore-only");
  },
  observe: async () => undefined,
  cancel: async () => {},
  compact: async () => undefined,
  rollback: async () => undefined,
  export: async () => archive,
  restore: async (input) => {
    restored = input.archive.payload;
  },
  active: async () => false,
};

const ledger = {
  records: [] as unknown[],
  append: async (record: unknown) => {
    ledger.records.push(record);
  },
};

const moduleLoadList =
  (process as NodeJS.Process & { moduleLoadList?: readonly string[] }).moduleLoadList ?? [];
assert.equal(
  moduleLoadList.some((entry) => entry.includes("@flue/runtime-legacy")),
  false,
);
const migration = await migrateSessionEngine({
  source,
  target,
  agentId: "agent-legacy",
  threadId: "thread-legacy-1",
  ledger,
});
assert.equal(migration.source.id, "flue-legacy");
assert.deepEqual(restored, legacyArchivePayload);
assert.equal(ledger.records.length, 1);

console.log(
  JSON.stringify({
    genericMigrationSeam: "works with a pre-exported archive",
    betaRuntimeLoaded: false,
    existingThreadReader: "missing",
    releaseGate: "BLOCKED",
    requiredRelease: "1.0.2 export sweep",
  }),
);

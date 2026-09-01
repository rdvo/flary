import assert from "node:assert/strict";
import test from "node:test";

import { importCodexRollout } from "../../src/harness/session/codex-import.ts";
import { verifySessionChain } from "../../src/harness/session/integrity.ts";

const rollout = [
  {
    timestamp: "2026-07-30T12:00:00.000Z",
    type: "session_meta",
    payload: {
      id: "thread_codex",
      session_id: "session_codex",
      api_key: "must-not-leak",
    },
  },
  {
    timestamp: "2026-07-30T12:00:01.000Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Build it" }],
      internal_chat_message_metadata_passthrough: { turn_id: "turn_1" },
    },
  },
  {
    timestamp: "2026-07-30T12:00:02.000Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { total_tokens: 12 },
    },
  },
  {
    timestamp: "2026-07-30T12:00:03.000Z",
    type: "future_codex_record",
    payload: {
      type: "not_known_yet",
      nested: { password: "must-not-leak" },
    },
  },
]
  .map((value) => JSON.stringify(value))
  .join("\n");

test("maps known Codex records and keeps unknown records as opaque data", async () => {
  const records = await importCodexRollout(rollout, {
    tenantId: "tenant_1",
    applicationId: "app_1",
  });

  assert.deepEqual(
    records.map(({ recordType }) => recordType),
    ["session.manifest", "message.user", "usage", "codex.opaque"]
  );
  assert.equal(records[0]?.sessionId, "session_codex");
  assert.equal(records[0]?.threadId, "thread_codex");
  assert.equal(records[1]?.turnId, "turn_1");
  assert.ok(records[0]);
  assert.ok(records[2]);
  assert.ok(records[3]);
  assert.equal(
    (
      records[0].publicPayload.source as {
        payload?: { api_key?: string };
      }
    ).payload?.api_key,
    "[REDACTED]"
  );
  assert.equal(
    (
      records[3].publicPayload.source as {
        payload?: { nested?: { password?: string } };
      }
    ).payload?.nested?.password,
    "[REDACTED]"
  );
  assert.equal(
    (
      records[2].publicPayload.source as {
        payload?: { info?: { total_tokens?: number } };
      }
    ).payload?.info?.total_tokens,
    12
  );
  await verifySessionChain(records);
});

test("produces the same hashes and can attach encrypted source references", async () => {
  const options = {
    tenantId: "tenant_1",
    applicationId: "app_1",
    storeEncryptedContent: async (_source: unknown, lineNumber: number) => ({
      storageKey: `sessions/source-${lineNumber}`,
      sha256: "a".repeat(64),
      size: 100,
    }),
  };
  const first = await importCodexRollout(rollout, options);
  const second = await importCodexRollout(rollout, options);

  assert.deepEqual(
    first.map(({ recordHash }) => recordHash),
    second.map(({ recordHash }) => recordHash)
  );
  assert.equal(first[0]?.encryptedContentRef?.storageKey, "sessions/source-1");
});

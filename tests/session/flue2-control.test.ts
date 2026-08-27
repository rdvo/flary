import assert from "node:assert/strict";
import test from "node:test";

import {
  InMemoryConversationStreamStore,
  type ConversationRecord,
} from "@flue/runtime-v2/adapter";
import {
  agentStreamPath,
  handleAgentConversationRead,
} from "@flue/runtime-v2/internal";

import { createFlue2CanonicalControl } from "../../src/harness/session/flue2-control.ts";
// Flue 2 pins this file name. This test exercises its real context builder.
// @ts-expect-error Flue's private compiled symbol is intentionally not typed.
import { rt as buildConversationContext } from "../../node_modules/@flue/runtime-v2/dist/dispatch-nU3cIlT-.mjs";

test("canonical rollback creates an active branch that survives store reattachment", async () => {
  const store = new InMemoryConversationStreamStore();
  const path = agentStreamPath("coder", "thread_rollback");
  await seed(store, path, [
    rootRecord(),
    userRecord("record_user_1", "turn_1", "entry_user_1", null, "first"),
  ]);
  await append(store, path, [
    userRecord("record_user_2", "turn_2", "entry_user_2", "entry_user_1", "second"),
  ]);
  const control = createFlue2CanonicalControl({
    store,
    compact: async () => {},
    active: async () => false,
    resumeApprovals: async () => {},
    createId: sequenceIds("marker", "record"),
    now: () => new Date("2026-08-27T12:00:00.000Z"),
  });
  await control.rollback({
    agentId: "coder",
    threadId: "thread_rollback",
    turnId: "turn_1",
  });

  // A new control instance models a fresh Worker isolate over the same store.
  createFlue2CanonicalControl({
    store,
    compact: async () => {},
    active: async () => false,
    resumeApprovals: async () => {},
  });
  const response = await handleAgentConversationRead({
    store,
    path,
    request: new Request("https://flue.internal/?view=history"),
  });
  assert.equal(response.status, 200);
  const snapshot = await response.json() as {
    messages: Array<{ id: string; signal?: { tagName?: string } }>;
  };
  assert.deepEqual(snapshot.messages.map((message) => message.id), [
    "entry_user_1",
    "entry_user_2",
    "entry_flary_rollback_marker",
  ]);
  assert.equal(snapshot.messages[2]?.signal?.tagName, "rollback");

  const entries = new Map<string, unknown>([
    ["entry_user_1", reducedUser("entry_user_1", null, "first")],
    ["entry_user_2", reducedUser("entry_user_2", "entry_user_1", "second")],
    ["entry_flary_rollback_marker", {
      id: "entry_flary_rollback_marker",
      parentId: "entry_user_2",
      timestamp: "2026-08-27T12:00:00.000Z",
      type: "message",
      message: {
        role: "signal",
        type: "flary_rollback",
        tagName: "rollback",
        content: "Rolled back",
        attributes: {
          targetEntryId: "entry_user_1",
          turnId: "turn_1",
          excludeTarget: "false",
        },
        timestamp: Date.parse("2026-08-27T12:00:00.000Z"),
      },
    }],
  ]);
  const context = buildConversationContext({
    entries,
    activeLeafId: "entry_flary_rollback_marker",
  }) as Array<{ content: Array<{ type: string; text?: string }> }>;
  const text = context.flatMap((message) => message.content)
    .map((part) => part.text ?? "")
    .join("\n");
  assert.match(text, /first/);
  assert.doesNotMatch(text, /second/);
});

test("canonical archive restores the exact record batches after eviction", async () => {
  const source = new InMemoryConversationStreamStore();
  const sourcePath = agentStreamPath("coder", "source");
  const first = [rootRecord(), userRecord("r1", "turn_1", "u1", null, "one")];
  const second = [userRecord("r2", "turn_2", "u2", "u1", "two")];
  await seed(source, sourcePath, first);
  await append(source, sourcePath, second);
  const sourceControl = createFlue2CanonicalControl({
    store: source,
    compact: async () => {},
    active: async () => false,
    resumeApprovals: async () => {},
  });
  const archive = await sourceControl.exportCanonical({
    agentId: "coder",
    threadId: "source",
  });

  const target = new InMemoryConversationStreamStore();
  const targetControl = createFlue2CanonicalControl({
    store: target,
    compact: async () => {},
    active: async () => false,
    resumeApprovals: async () => {},
  });
  await targetControl.restoreCanonical({
    agentId: "coder",
    threadId: "target",
    payload: archive,
  });
  const sourceRecords = await recordBatches(source, sourcePath);
  const targetRecords = await recordBatches(target, agentStreamPath("coder", "target"));
  assert.deepEqual(targetRecords, sourceRecords);

  await assert.rejects(
    targetControl.restoreCanonical({
      agentId: "coder",
      threadId: "target",
      payload: archive,
    }),
    /empty target session/,
  );
});

test("through-turn export preserves atomic batches and rejects a mixed boundary", async () => {
  const store = new InMemoryConversationStreamStore();
  const path = agentStreamPath("coder", "source_boundary");
  await seed(store, path, [
    rootRecord(),
    userRecord("r1", "turn_1", "u1", null, "one"),
  ]);
  const control = createFlue2CanonicalControl({
    store,
    compact: async () => {},
    active: async () => false,
    resumeApprovals: async () => {},
  });
  const archive = await control.exportCanonical({
    agentId: "coder",
    threadId: "source_boundary",
    throughTurnId: "turn_1",
  }) as { batches: readonly (readonly ConversationRecord[])[] };
  assert.equal(archive.batches.length, 1);
  assert.equal(archive.batches[0]?.length, 2);

  const mixed = new InMemoryConversationStreamStore();
  const mixedPath = agentStreamPath("coder", "mixed_boundary");
  await seed(mixed, mixedPath, [
    rootRecord(),
    userRecord("r1", "turn_1", "u1", null, "one"),
    userRecord("r2", "turn_2", "u2", "u1", "two"),
  ]);
  const mixedControl = createFlue2CanonicalControl({
    store: mixed,
    compact: async () => {},
    active: async () => false,
    resumeApprovals: async () => {},
  });
  await assert.rejects(
    mixedControl.exportCanonical({
      agentId: "coder",
      threadId: "mixed_boundary",
      throughTurnId: "turn_1",
    }),
    /atomic batch boundary/,
  );
});

test("manual compaction and approval recovery always cross the trusted control seam", async () => {
  const store = new InMemoryConversationStreamStore();
  const calls: string[] = [];
  const control = createFlue2CanonicalControl({
    store,
    compact: async ({ reason }) => {
      calls.push(`compact:${reason}`);
      return { ok: true };
    },
    active: async () => false,
    resumeApprovals: async ({ submissionId }) => {
      calls.push(`approval:${submissionId}`);
    },
  });
  await control.compact("coder", "thread_1", "manual");
  await control.resumeApprovals({
    agentId: "coder",
    threadId: "thread_1",
    submissionId: "sub_1",
  });
  assert.deepEqual(calls, ["compact:manual", "approval:sub_1"]);
});

async function seed(
  store: InMemoryConversationStreamStore,
  path: string,
  records: readonly ConversationRecord[],
): Promise<void> {
  await store.createStream(path, { agentName: "coder", instanceId: path.split("/").at(-1)! });
  await append(store, path, records);
}

async function append(
  store: InMemoryConversationStreamStore,
  path: string,
  records: readonly ConversationRecord[],
): Promise<void> {
  const producerId = "test-producer";
  const claim = await store.acquireProducer(path, producerId);
  await store.append({
    path,
    producerId,
    producerEpoch: claim.producerEpoch,
    incarnation: claim.incarnation,
    producerSequence: claim.nextProducerSequence,
    records,
  });
}

async function recordBatches(store: InMemoryConversationStreamStore, path: string) {
  const result = await store.read(path, { offset: "-1", limit: 1_000 });
  return result.batches.map((batch) => batch.records);
}

function rootRecord(): ConversationRecord {
  return {
    v: 1,
    id: "record_root",
    type: "conversation_created",
    conversationId: "conversation_1",
    harness: "default",
    session: "default",
    timestamp: "2026-08-27T11:00:00.000Z",
    affinityKey: "root",
    createdAt: "2026-08-27T11:00:00.000Z",
    kind: "root",
    uid: "uid_1",
  };
}

function userRecord(
  id: string,
  turnId: string,
  messageId: string,
  parentId: string | null,
  text: string,
): ConversationRecord {
  return {
    v: 1,
    id,
    type: "user_message",
    conversationId: "conversation_1",
    harness: "default",
    session: "default",
    timestamp: "2026-08-27T11:01:00.000Z",
    turnId,
    messageId,
    parentId,
    content: [{ type: "text", text }],
  };
}

function sequenceIds(...values: string[]): () => string {
  let index = 0;
  return () => values[index++] ?? `id_${index}`;
}

function reducedUser(id: string, parentId: string | null, text: string) {
  return {
    id,
    parentId,
    timestamp: "2026-08-27T11:00:00.000Z",
    type: "message",
    message: {
      role: "user",
      content: [{ type: "text", text }],
      timestamp: Date.parse("2026-08-27T11:00:00.000Z"),
    },
  };
}

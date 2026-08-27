import type {
  ConversationRecord,
  ConversationStreamStore,
} from "@flue/runtime-v2/adapter";
import { agentStreamPath } from "@flue/runtime-v2/internal";

import type { Flue2SessionEngineControl } from "./flue2-engine.js";

interface Flue2CanonicalArchive {
  readonly format: "flue-2-canonical";
  readonly version: 1;
  readonly batches: readonly (readonly ConversationRecord[])[];
  readonly throughTurnId?: string;
}

export interface CreateFlue2CanonicalControlOptions {
  readonly store: ConversationStreamStore;
  /** Invoke the root Flue session's own compact operation. */
  readonly compact: (input: {
    readonly agentId: string;
    readonly threadId: string;
    readonly reason?: string;
  }) => Promise<unknown>;
  readonly active: (agentId: string, threadId: string) => Promise<boolean>;
  readonly resumeApprovals: Flue2SessionEngineControl["resumeApprovals"];
  readonly createId?: () => string;
  readonly now?: () => Date;
}

/**
 * Direct canonical controls for a Flue 2 conversation stream.
 *
 * The stream remains the only transcript authority. Export copies canonical
 * record bodies and their atomic batch boundaries. Restore only accepts an
 * empty target stream. Rollback appends a reset marker and never deletes old
 * records.
 */
export function createFlue2CanonicalControl(
  options: CreateFlue2CanonicalControlOptions,
): Flue2SessionEngineControl {
  const createId = options.createId ?? (() => crypto.randomUUID().replaceAll("-", ""));
  const now = options.now ?? (() => new Date());

  return {
    compact(agentId, threadId, reason) {
      return options.compact({ agentId, threadId, ...(reason ? { reason } : {}) });
    },
    async rollback(input) {
      if (await options.active(input.agentId, input.threadId)) {
        throw new Error("An active session cannot be rolled back");
      }
      const path = agentStreamPath(input.agentId, input.threadId);
      const records = (await readAll(options.store, path)).flatMap((batch) => batch.records);
      const root = records.find(isRootConversation);
      if (!root) throw new Error("The root canonical conversation does not exist");
      const target = findTurnEntry(records, input.turnId);
      if (!target) throw new Error(`Rollback target '${input.turnId}' was not found`);
      const activeLeafId = findActiveLeaf(records);
      if (!activeLeafId) throw new Error("The canonical conversation has no active entry");
      const markerId = `entry_flary_rollback_${createId()}`;
      await appendRecords(options.store, path, `flary-control:${input.threadId}`, [{
        v: 1,
        id: `record_flary_rollback_${createId()}`,
        type: "signal",
        conversationId: root.conversationId,
        harness: root.harness,
        session: root.session,
        timestamp: now().toISOString(),
        messageId: markerId,
        parentId: activeLeafId,
        signalType: "flary_rollback",
        tagName: "rollback",
        content: input.reason ?? `Rolled back through ${input.turnId}.`,
        attributes: {
          targetEntryId: target.entryId,
          turnId: input.turnId,
          excludeTarget: String(input.excludeTarget === true),
        },
      }]);
      return { turnId: input.turnId, targetEntryId: target.entryId, markerId };
    },
    async exportCanonical(input) {
      if (await options.active(input.agentId, input.threadId)) {
        throw new Error("An active session cannot be exported");
      }
      const path = agentStreamPath(input.agentId, input.threadId);
      const all = await readAll(options.store, path);
      const batches = input.throughTurnId
        ? recordsThroughTurn(all, input.throughTurnId)
        : all.map((batch) => batch.records);
      return {
        format: "flue-2-canonical",
        version: 1,
        batches,
        ...(input.throughTurnId ? { throughTurnId: input.throughTurnId } : {}),
      } satisfies Flue2CanonicalArchive;
    },
    async restoreCanonical(input) {
      if (await options.active(input.agentId, input.threadId)) {
        throw new Error("An active session cannot be restored");
      }
      const archive = parseArchive(input.payload);
      const path = agentStreamPath(input.agentId, input.threadId);
      const existing = await options.store.getMeta(path);
      if (existing && existing.nextOffset !== "-1") {
        throw new Error("Canonical restore needs an empty target session");
      }
      if (!existing) {
        await options.store.createStream(path, {
          agentName: input.agentId,
          instanceId: input.threadId,
        });
      }
      const producerId = `flary-restore:${input.threadId}`;
      for (const batch of archive.batches) {
        if (batch.length > 0) {
          await appendRecords(options.store, path, producerId, batch);
        }
      }
    },
    active: options.active,
    resumeApprovals: options.resumeApprovals,
  };
}

async function readAll(store: ConversationStreamStore, path: string) {
  const batches: Array<{ offset: string; records: ConversationRecord[] }> = [];
  let offset = "-1";
  for (;;) {
    const page = await store.read(path, { offset, limit: 1_000 });
    batches.push(...page.batches.map((batch) => ({
      offset: batch.offset,
      records: [...batch.records],
    })));
    offset = page.nextOffset;
    if (page.upToDate) return batches;
  }
}

async function appendRecords(
  store: ConversationStreamStore,
  path: string,
  producerId: string,
  records: readonly ConversationRecord[],
): Promise<void> {
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

function isRootConversation(record: ConversationRecord): record is Extract<ConversationRecord, { type: "conversation_created" }> {
  return record.type === "conversation_created" && record.kind === "root";
}

function findTurnEntry(
  records: readonly ConversationRecord[],
  turnId: string,
): { entryId: string; parentId: string | null } | undefined {
  let result: { entryId: string; parentId: string | null } | undefined;
  for (const record of records) {
    if (record.turnId !== turnId) continue;
    if (record.type === "user_message" || record.type === "signal") {
      result = { entryId: record.messageId, parentId: record.parentId };
    } else if (record.type === "assistant_message_started") {
      result = { entryId: record.messageId, parentId: record.parentId };
    } else if (record.type === "compaction") {
      result = { entryId: record.entryId, parentId: record.parentId };
    }
  }
  return result;
}

function findActiveLeaf(records: readonly ConversationRecord[]): string | undefined {
  let result: string | undefined;
  for (const record of records) {
    if (record.type === "user_message" || record.type === "signal") {
      result = record.messageId;
    } else if (record.type === "assistant_message_started") {
      result = record.messageId;
    } else if (record.type === "compaction") {
      result = record.entryId;
    }
  }
  return result;
}

function recordsThroughTurn(
  batches: readonly { readonly records: readonly ConversationRecord[] }[],
  turnId: string,
): readonly (readonly ConversationRecord[])[] {
  let lastBatch = -1;
  for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
    const batch = batches[batchIndex]!;
    for (let recordIndex = 0; recordIndex < batch.records.length; recordIndex += 1) {
      if (batch.records[recordIndex]!.turnId === turnId) {
        lastBatch = batchIndex;
      }
    }
  }
  if (lastBatch === -1) throw new Error(`Canonical export turn '${turnId}' was not found`);
  const boundary = batches[lastBatch]!.records;
  const laterTurn = boundary.find((record) => record.turnId && record.turnId !== turnId);
  if (laterTurn) {
    throw new Error(`Canonical export turn '${turnId}' does not end on an atomic batch boundary`);
  }
  return batches.slice(0, lastBatch + 1).map((batch) => [...batch.records]);
}

function parseArchive(value: unknown): Flue2CanonicalArchive {
  if (!isRecord(value) || value.format !== "flue-2-canonical" || value.version !== 1) {
    throw new Error("The Flue 2 canonical archive is invalid");
  }
  if (!Array.isArray(value.batches) || value.batches.some((batch) => !Array.isArray(batch))) {
    throw new Error("The Flue 2 canonical archive batches are invalid");
  }
  return value as unknown as Flue2CanonicalArchive;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

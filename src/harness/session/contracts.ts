import { z } from "zod";

export const SESSION_LEDGER_SCHEMA_VERSION = 1 as const;
export const SESSION_LEDGER_FORMAT = "flary-jsonl" as const;
export const DEFAULT_SESSION_HOT_RECORD_LIMIT = 10_000;

export type SessionJsonPrimitive = string | number | boolean | null;
export type SessionJsonValue =
  | SessionJsonPrimitive
  | SessionJsonValue[]
  | { [key: string]: SessionJsonValue };

export const SessionJsonValueSchema: z.ZodType<SessionJsonValue> =
  z.json() as z.ZodType<SessionJsonValue>;
export const SessionJsonObjectSchema = z.record(
  z.string(),
  SessionJsonValueSchema,
);
export type SessionJsonObject = z.infer<typeof SessionJsonObjectSchema>;

export const SessionIdentifierSchema = z.string().trim().min(1).max(512);
export const SessionTimestampSchema = z.string().datetime({ offset: true });
export const SessionSha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

export const SessionRecordTypeSchema = z.enum([
  "session.manifest",
  "session.world_state",
  "session.lifecycle",
  "runtime.event",
  "runtime.migrated",
  "turn.started",
  "turn.completed",
  "turn.aborted",
  "turn.settings",
  "model.changed",
  "provider.segment.started",
  "provider.segment.completed",
  "provider.compatibility",
  "provider.cache_reset",
  "message.user",
  "message.assistant",
  "message.reasoning",
  "tool.search",
  "tool.describe",
  "tool.call",
  "tool.result",
  "tool.batch",
  "codemode.started",
  "codemode.paused",
  "codemode.completed",
  "codemode.failed",
  "approval.requested",
  "approval.resolved",
  "input.requested",
  "input.resolved",
  "subagent.spawned",
  "subagent.message",
  "subagent.status",
  "subagent.closed",
  "compaction.started",
  "compaction.completed",
  "compaction.window",
  "usage",
  "rate_limit",
  "goal.updated",
  "goal.cleared",
  "goal.completed",
  "rollback",
  "message.edited",
  "artifact.checkpoint",
  "artifact.restored",
  "process.started",
  "process.output",
  "process.control",
  "process.completed",
  "skill.discovered",
  "schedule.updated",
  "schedule.run",
  "terminal",
  "codex.opaque",
]);
export type SessionRecordType = z.infer<typeof SessionRecordTypeSchema>;

export const EncryptedSessionContentRefSchema = z
  .object({
    storageKey: z.string().trim().min(1).max(2048),
    sha256: SessionSha256Schema,
    size: z.number().int().nonnegative(),
    mediaType: z.string().trim().min(1).max(256).optional(),
    keyVersion: z.string().trim().min(1).max(128).optional(),
  })
  .strict();
export type EncryptedSessionContentRef = z.infer<
  typeof EncryptedSessionContentRefSchema
>;

const SessionRecordIdentityShape = {
  tenantId: SessionIdentifierSchema,
  applicationId: SessionIdentifierSchema,
  sessionId: SessionIdentifierSchema,
  threadId: SessionIdentifierSchema,
  turnId: SessionIdentifierSchema.optional(),
  runId: SessionIdentifierSchema.optional(),
  agentId: SessionIdentifierSchema.optional(),
  toolCallId: SessionIdentifierSchema.optional(),
  parentId: SessionIdentifierSchema.optional(),
};

export const SessionRecordDraftSchema = z
  .object({
    schemaVersion: z.literal(SESSION_LEDGER_SCHEMA_VERSION),
    format: z.literal(SESSION_LEDGER_FORMAT),
    ...SessionRecordIdentityShape,
    sourceCursor: z.string().min(1).max(2048),
    recordType: SessionRecordTypeSchema,
    recordedAt: SessionTimestampSchema,
    attempt: z.number().int().nonnegative(),
    sourceRevision: z.string().trim().min(1).max(512),
    /** Public producer identity. Provider-native state stays encrypted. */
    producer: z
      .object({
        provider: SessionIdentifierSchema,
        model: SessionIdentifierSchema,
        variant: SessionIdentifierSchema.optional(),
      })
      .strict()
      .optional(),
    publicPayload: SessionJsonObjectSchema,
    encryptedContentRef: EncryptedSessionContentRefSchema.optional(),
  })
  .strict();
export type SessionRecordDraft = z.infer<typeof SessionRecordDraftSchema>;

export const SessionRecordSchema = SessionRecordDraftSchema.extend({
  sequence: z.number().int().positive(),
  previousHash: SessionSha256Schema.nullable(),
  recordHash: SessionSha256Schema,
}).strict();
export type SessionRecord = z.infer<typeof SessionRecordSchema>;

export const SessionLedgerCursorSchema = z
  .string()
  .regex(/^v1:[1-9][0-9]*$/);
export type SessionLedgerCursor = z.infer<typeof SessionLedgerCursorSchema>;

export const SessionLedgerMetadataSchema = z
  .object({
    tenantId: SessionIdentifierSchema,
    applicationId: SessionIdentifierSchema,
    sessionId: SessionIdentifierSchema,
    threadId: SessionIdentifierSchema,
    recordCount: z.number().int().nonnegative(),
    latestSequence: z.number().int().nonnegative(),
    latestHash: SessionSha256Schema.nullable(),
    hotRecordLimit: z.number().int().positive(),
    hotStartSequence: z.number().int().positive(),
    hotRecordCount: z.number().int().nonnegative(),
    recordsPastHotLimit: z.number().int().nonnegative(),
    archiveRequired: z.boolean(),
    sealedThroughSequence: z.number().int().nonnegative(),
    updatedAt: SessionTimestampSchema,
  })
  .strict();
export type SessionLedgerMetadata = z.infer<
  typeof SessionLedgerMetadataSchema
>;

export const SessionRecordPageSchema = z
  .object({
    items: z.array(SessionRecordSchema),
    nextCursor: SessionLedgerCursorSchema.optional(),
  })
  .strict();
export type SessionRecordPage = z.infer<typeof SessionRecordPageSchema>;

export interface SessionRecordAppendInput
  extends Omit<SessionRecordDraft, "schemaVersion" | "format"> {
  schemaVersion?: typeof SESSION_LEDGER_SCHEMA_VERSION;
  format?: typeof SESSION_LEDGER_FORMAT;
}

import { z } from "zod";

import { BlobRefSchema, type BlobRef } from "./blobs";

export const STORAGE_SCHEMA_VERSION = 1 as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/** JSON data that can be safely written as one JSONL value. */
export const JsonValueSchema: z.ZodType<JsonValue> =
  z.json() as z.ZodType<JsonValue>;

export const JsonObjectSchema = z.record(z.string(), JsonValueSchema);
export type JsonObject = z.infer<typeof JsonObjectSchema>;

export const RecordIdSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/, "Record IDs must contain only safe identifier characters");

export const TimestampSchema = z.string().datetime({ offset: true });

export const RecordTypeSchema = z.enum([
  "thread",
  "turn",
  "operation",
  "event",
  "tool",
  "artifact",
]);
export type RecordType = z.infer<typeof RecordTypeSchema>;

const RecordBaseShape = {
  schemaVersion: z.literal(STORAGE_SCHEMA_VERSION),
  id: RecordIdSchema,
  createdAt: TimestampSchema,
};

export const ThreadStatusSchema = z.enum([
  "active",
  "paused",
  "completed",
  "failed",
  "cancelled",
  "archived",
]);
export type ThreadStatus = z.infer<typeof ThreadStatusSchema>;

export const ThreadRecordSchema = z
  .object({
    ...RecordBaseShape,
    recordType: z.literal("thread"),
    status: ThreadStatusSchema,
    title: z.string().max(4096).optional(),
    parentThreadId: RecordIdSchema.optional(),
    metadata: JsonObjectSchema.optional(),
    payload: JsonValueSchema.optional(),
  })
  .strict();
export type ThreadRecord = z.infer<typeof ThreadRecordSchema>;

export const TurnRoleSchema = z.enum(["system", "user", "assistant", "tool"]);
export type TurnRole = z.infer<typeof TurnRoleSchema>;

export const TurnStatusSchema = z.enum([
  "started",
  "completed",
  "paused",
  "failed",
  "cancelled",
]);
export type TurnStatus = z.infer<typeof TurnStatusSchema>;

export const TurnRecordSchema = z
  .object({
    ...RecordBaseShape,
    recordType: z.literal("turn"),
    threadId: RecordIdSchema,
    ordinal: z.number().int().nonnegative(),
    role: TurnRoleSchema,
    status: TurnStatusSchema,
    content: JsonValueSchema.optional(),
    metadata: JsonObjectSchema.optional(),
    payload: JsonValueSchema.optional(),
  })
  .strict();
export type TurnRecord = z.infer<typeof TurnRecordSchema>;

export const OperationStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "paused",
  "failed",
  "cancelled",
]);
export type OperationStatus = z.infer<typeof OperationStatusSchema>;

export const OperationRecordSchema = z
  .object({
    ...RecordBaseShape,
    recordType: z.literal("operation"),
    threadId: RecordIdSchema,
    turnId: RecordIdSchema.optional(),
    operationType: z.string().min(1).max(256),
    status: OperationStatusSchema,
    input: JsonValueSchema.optional(),
    output: JsonValueSchema.optional(),
    error: z.string().max(8192).optional(),
    metadata: JsonObjectSchema.optional(),
    payload: JsonValueSchema.optional(),
  })
  .strict();
export type OperationRecord = z.infer<typeof OperationRecordSchema>;

export const EventSeveritySchema = z.enum(["debug", "info", "warning", "error"]);
export type EventSeverity = z.infer<typeof EventSeveritySchema>;

export const EventStatusSchema = z.enum(["emitted", "paused", "handled"]);
export type EventStatus = z.infer<typeof EventStatusSchema>;

export const EventRecordSchema = z
  .object({
    ...RecordBaseShape,
    recordType: z.literal("event"),
    eventType: z.string().min(1).max(256),
    status: EventStatusSchema,
    severity: EventSeveritySchema,
    threadId: RecordIdSchema.optional(),
    turnId: RecordIdSchema.optional(),
    operationId: RecordIdSchema.optional(),
    payload: JsonValueSchema.optional(),
    metadata: JsonObjectSchema.optional(),
  })
  .strict();
export type EventRecord = z.infer<typeof EventRecordSchema>;

export const ToolStatusSchema = z.enum(["requested", "running", "completed", "failed"]);
export type ToolStatus = z.infer<typeof ToolStatusSchema>;

export const ToolRecordSchema = z
  .object({
    ...RecordBaseShape,
    recordType: z.literal("tool"),
    toolName: z.string().min(1).max(512),
    status: ToolStatusSchema,
    threadId: RecordIdSchema.optional(),
    turnId: RecordIdSchema.optional(),
    operationId: RecordIdSchema.optional(),
    input: JsonValueSchema.optional(),
    output: JsonValueSchema.optional(),
    error: z.string().max(8192).optional(),
    metadata: JsonObjectSchema.optional(),
    payload: JsonValueSchema.optional(),
  })
  .strict();
export type ToolRecord = z.infer<typeof ToolRecordSchema>;

export const ArtifactRecordSchema = z
  .object({
    ...RecordBaseShape,
    recordType: z.literal("artifact"),
    artifactType: z.string().min(1).max(256),
    threadId: RecordIdSchema.optional(),
    turnId: RecordIdSchema.optional(),
    operationId: RecordIdSchema.optional(),
    name: z.string().max(1024).optional(),
    blobRef: BlobRefSchema.optional(),
    content: JsonValueSchema.optional(),
    metadata: JsonObjectSchema.optional(),
  })
  .strict();
export type ArtifactRecord = z.infer<typeof ArtifactRecordSchema>;

/** The canonical union written by all durable record stores. */
export const StorageRecordSchema = z.union([
  ThreadRecordSchema,
  TurnRecordSchema,
  OperationRecordSchema,
  EventRecordSchema,
  ToolRecordSchema,
  ArtifactRecordSchema,
]);
export type StorageRecord = z.infer<typeof StorageRecordSchema>;

export type StorageRecordMap = {
  thread: ThreadRecord;
  turn: TurnRecord;
  operation: OperationRecord;
  event: EventRecord;
  tool: ToolRecord;
  artifact: ArtifactRecord;
};

export const RecordSchema = StorageRecordSchema;

export function parseStorageRecord(value: unknown): StorageRecord {
  return StorageRecordSchema.parse(value);
}

export function safeParseStorageRecord(value: unknown) {
  return StorageRecordSchema.safeParse(value);
}

export function nowIsoTimestamp(): string {
  return new Date().toISOString();
}

let recordIdCounter = 0;

/** Creates a non-secret identifier for a record or event. */
export function createRecordId(prefix = "record"): string {
  const cryptoApi = (globalThis as typeof globalThis & {
    crypto?: { randomUUID?: () => string };
  }).crypto;

  if (cryptoApi?.randomUUID) {
    return `${prefix}_${cryptoApi.randomUUID()}`;
  }

  recordIdCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${recordIdCounter.toString(36)}`;
}

export interface EventRecordInput {
  id?: string;
  createdAt?: string;
  eventType: string;
  status?: EventStatus;
  severity?: EventSeverity;
  threadId?: string;
  turnId?: string;
  operationId?: string;
  payload?: JsonValue;
  metadata?: JsonObject;
}

export function createEventRecord(input: EventRecordInput): EventRecord {
  return EventRecordSchema.parse({
    schemaVersion: STORAGE_SCHEMA_VERSION,
    recordType: "event",
    id: input.id ?? createRecordId("event"),
    createdAt: input.createdAt ?? nowIsoTimestamp(),
    eventType: input.eventType,
    status: input.status ?? "emitted",
    severity: input.severity ?? "info",
    threadId: input.threadId,
    turnId: input.turnId,
    operationId: input.operationId,
    payload: input.payload,
    metadata: input.metadata,
  });
}

export type { BlobRef };

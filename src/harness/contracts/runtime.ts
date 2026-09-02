import { z } from "zod";

import {
  IdentifierSchema,
  JsonObjectSchema,
  MetadataSchema,
  NonEmptyStringSchema,
  NonNegativeIntegerSchema,
  TimestampSchema,
} from "./common.js";
import { AgentModeIdSchema } from "./modes.js";
import { NormalizedUsageSchema } from "./telemetry.js";
import { StorageScopeSchema, ThreadRefSchema } from "./tenancy.js";

/**
 * A capability handle is safe to pass through model context. It is not a
 * secret and it does not contain an executable function.
 */
export const CapabilityHandleSchema = z
  .object({
    id: IdentifierSchema,
    toolId: IdentifierSchema,
    scope: StorageScopeSchema.optional(),
    operations: z.array(IdentifierSchema).min(1).max(64),
    requiresApproval: z.boolean().default(false),
    expiresAt: TimestampSchema.optional(),
    metadata: MetadataSchema.optional(),
  })
  .strict();
export type CapabilityHandle = z.infer<typeof CapabilityHandleSchema>;

export const SandboxJobStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
export type SandboxJobStatus = z.infer<typeof SandboxJobStatusSchema>;

/** A durable record for an explicit build, test, deploy, or notebook job. */
export const SandboxJobSchema = z
  .object({
    id: IdentifierSchema,
    runId: IdentifierSchema,
    workspaceId: IdentifierSchema.optional(),
    engine: z.enum(["dynamic-worker", "sandbox"]),
    operation: NonEmptyStringSchema,
    status: SandboxJobStatusSchema,
    submittedAt: TimestampSchema,
    startedAt: TimestampSchema.optional(),
    completedAt: TimestampSchema.optional(),
    resultReference: IdentifierSchema.optional(),
    errorCode: IdentifierSchema.optional(),
    metadata: MetadataSchema.optional(),
  })
  .strict();
export type SandboxJob = z.infer<typeof SandboxJobSchema>;

/** Provider continuation metadata. Secret values never belong here. */
export const ProviderSessionSchema = z
  .object({
    id: IdentifierSchema,
    provider: IdentifierSchema,
    model: IdentifierSchema,
    nativeSessionId: IdentifierSchema.optional(),
    status: z.enum(["active", "waiting", "completed", "failed", "unknown"]),
    lastProviderCursor: z.string().max(1_024).optional(),
    handoffRevision: NonNegativeIntegerSchema.default(0),
    updatedAt: TimestampSchema,
    metadata: MetadataSchema.optional(),
  })
  .strict();
export type ProviderSession = z.infer<typeof ProviderSessionSchema>;

/** Normalized usage accumulated for one Flary thread. */
export const UsageRecordSchema = z
  .object({
    id: IdentifierSchema,
    threadId: IdentifierSchema,
    runId: IdentifierSchema.optional(),
    provider: IdentifierSchema.optional(),
    model: IdentifierSchema.optional(),
    usage: NormalizedUsageSchema,
    durationMs: NonNegativeIntegerSchema.optional(),
    recordedAt: TimestampSchema,
    metadata: MetadataSchema.optional(),
  })
  .strict();
export type UsageRecord = z.infer<typeof UsageRecordSchema>;

/**
 * Flary's public event contract. Flue's canonical transcript events are
 * normalized into RunEvent before they cross the Flary API boundary.
 */
export { RunEventSchema as FlaryEventSchema } from "./events.js";
export type { RunEvent as FlaryEvent } from "./events.js";

export const ThreadCursorSchema = z
  .object({
    thread: ThreadRefSchema,
    flueOffset: z.string().max(1_024).default("0"),
    flarySequence: NonNegativeIntegerSchema.default(0),
    updatedAt: TimestampSchema,
  })
  .strict();
export type ThreadCursor = z.infer<typeof ThreadCursorSchema>;

/** Operational state kept beside, never instead of, Flue's transcript. */
export const ThreadOperationalStateSchema = z
  .object({
    thread: ThreadRefSchema,
    mode: AgentModeIdSchema,
    status: z.enum(["idle", "running", "waiting", "failed", "closed"]),
    activeRunId: IdentifierSchema.optional(),
    cursor: ThreadCursorSchema,
    providerSession: ProviderSessionSchema.optional(),
    metadata: JsonObjectSchema.optional(),
    updatedAt: TimestampSchema,
  })
  .strict();
export type ThreadOperationalState = z.infer<typeof ThreadOperationalStateSchema>;

export const ThreadMetadataPatchSchema = z
  .object({
    mode: AgentModeIdSchema.optional(),
    status: ThreadOperationalStateSchema.shape.status.optional(),
    activeRunId: IdentifierSchema.nullable().optional(),
    flueOffset: z.string().max(1_024).optional(),
    flarySequence: NonNegativeIntegerSchema.optional(),
    providerSession: ProviderSessionSchema.nullable().optional(),
    metadata: JsonObjectSchema.optional(),
  })
  .strict();
export type ThreadMetadataPatch = z.infer<typeof ThreadMetadataPatchSchema>;

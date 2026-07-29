import { z } from "zod";

import {
  ErrorInfoSchema,
  IdentifierSchema,
  JsonValueSchema,
  MetadataSchema,
  NonNegativeIntegerSchema,
  TimestampSchema,
} from "./common";
import {
  CacheUsageSchema,
  MicroUnitCostSchema,
  NormalizedUsageSchema,
  TraceContextSchema,
} from "./telemetry";

// Select an agent or a flow as the run target.
export const RunTargetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("agent"),
      agentId: IdentifierSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("flow"),
      flowId: IdentifierSchema,
    })
    .strict(),
]);
export type RunTarget = z.infer<typeof RunTargetSchema>;

// Select the durable runtime that owns one run.
export const RunExecutionSchema = z.enum(["agent", "workflow"]);
export type RunExecution = z.infer<typeof RunExecutionSchema>;

// Identify the state of one run.
export const RunStatusSchema = z.enum([
  "queued",
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

// This is the tenant-neutral request body for POST /runs. The mounting product
// supplies tenantId and agentId through trusted server context.
export const CreateRunRequestSchema = z
  .object({
    requestId: IdentifierSchema,
    channelId: IdentifierSchema,
    input: JsonValueSchema,
    execution: RunExecutionSchema.default("agent"),
    profileId: IdentifierSchema.optional(),
    idempotencyKey: IdentifierSchema.optional(),
    requestedAt: TimestampSchema.optional(),
    traceContext: TraceContextSchema.optional(),
    metadata: MetadataSchema.optional(),
  })
  .strict();
export type CreateRunRequest = z.infer<typeof CreateRunRequestSchema>;
export type CreateRunRequestInput = z.input<typeof CreateRunRequestSchema>;

// Accept external input while a durable run waits.
export const RunInputSchema = z
  .object({
    input: JsonValueSchema,
    idempotencyKey: IdentifierSchema,
    requestedAt: TimestampSchema.optional(),
    metadata: MetadataSchema.optional(),
  })
  .strict();
export type RunInput = z.infer<typeof RunInputSchema>;

export const CancelRunRequestSchema = z
  .object({
    idempotencyKey: IdentifierSchema,
    reason: z.string().trim().min(1).max(4_096).optional(),
    requestedAt: TimestampSchema.optional(),
    metadata: MetadataSchema.optional(),
  })
  .strict();
export type CancelRunRequest = z.infer<typeof CancelRunRequestSchema>;

// Request one agent or flow run.
export const RunRequestSchema = z
  .object({
    requestId: IdentifierSchema,
    target: RunTargetSchema,
    input: JsonValueSchema,
    execution: RunExecutionSchema.default("agent"),
    profileId: IdentifierSchema.optional(),
    identityId: IdentifierSchema.optional(),
    channelId: IdentifierSchema.optional(),
    scheduleId: IdentifierSchema.optional(),
    parentRunId: IdentifierSchema.optional(),
    idempotencyKey: IdentifierSchema.optional(),
    requestedAt: TimestampSchema.optional(),
    traceContext: TraceContextSchema.optional(),
    metadata: MetadataSchema.optional(),
  })
  .strict();
export type RunRequest = z.infer<typeof RunRequestSchema>;

// Resume a Flary event stream after the last stored event.
export const StreamCursorSchema = z
  .object({
    runId: IdentifierSchema,
    afterSequence: NonNegativeIntegerSchema.default(0),
  })
  .strict();
export type StreamCursor = z.infer<typeof StreamCursorSchema>;

// Return durable acceptance. This contract contains no provider data.
export const RunHandleSchema = z
  .object({
    runId: IdentifierSchema,
    requestId: IdentifierSchema,
    status: RunStatusSchema,
    eventsUrl: z.string().min(1),
    inputUrl: z.string().min(1),
    cancelUrl: z.string().min(1),
    cursor: StreamCursorSchema,
  })
  .strict();
export type RunHandle = z.infer<typeof RunHandleSchema>;

// Record usage for one run.
export const RunUsageSchema = z
  .object({
    inputTokens: NonNegativeIntegerSchema.optional(),
    outputTokens: NonNegativeIntegerSchema.optional(),
    totalTokens: NonNegativeIntegerSchema.optional(),
    toolCalls: NonNegativeIntegerSchema.optional(),
    durationMs: NonNegativeIntegerSchema.optional(),
    cache: CacheUsageSchema.optional(),
    reasoning: NormalizedUsageSchema.shape.reasoning,
    media: NormalizedUsageSchema.shape.media,
    providerExtensions: NormalizedUsageSchema.shape.providerExtensions,
    cost: MicroUnitCostSchema.optional(),
    costUsd: z.number().finite().nonnegative().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.inputTokens !== undefined &&
      value.outputTokens !== undefined &&
      value.totalTokens !== undefined &&
      value.inputTokens + value.outputTokens > value.totalTokens
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["totalTokens"],
        message: "totalTokens must cover inputTokens and outputTokens",
      });
    }
  });
export type RunUsage = z.infer<typeof RunUsageSchema>;

// Return the state and output of one run.
export const RunResultSchema = z
  .object({
    runId: IdentifierSchema,
    requestId: IdentifierSchema,
    status: RunStatusSchema,
    channelId: IdentifierSchema.optional(),
    execution: RunExecutionSchema.optional(),
    lastSequence: NonNegativeIntegerSchema.optional(),
    output: JsonValueSchema.optional(),
    error: ErrorInfoSchema.optional(),
    usage: RunUsageSchema.optional(),
    traceContext: TraceContextSchema.optional(),
    startedAt: TimestampSchema.optional(),
    completedAt: TimestampSchema.optional(),
    metadata: MetadataSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === "completed" && value.output === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["output"],
        message: "A completed run needs output",
      });
    }
    if (value.status === "failed" && value.error === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["error"],
        message: "A failed run needs error",
      });
    }
  });
export type RunResult = z.infer<typeof RunResultSchema>;

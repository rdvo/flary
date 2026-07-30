import { z } from "zod";

import {
  ErrorInfoSchema,
  IdentifierSchema,
  JsonObjectSchema,
  MetadataSchema,
  NonEmptyStringSchema,
  ReferenceSchema,
  TimestampSchema,
} from "./common";
import {
  RedactedReferenceSchema,
  SpanKindSchema,
  TraceContextSchema,
  TelemetryIntegerSchema,
} from "./telemetry";

// Identify how a tool is hosted.
export const ToolKindSchema = z.enum(["function", "http", "mcp", "native"]);
export type ToolKind = z.infer<typeof ToolKindSchema>;

export const ToolOperationSchema = z.enum(["read", "write"]);
export type ToolOperation = z.infer<typeof ToolOperationSchema>;

// Describe the input and output of one tool.
export const ToolDefinitionSchema = z
  .object({
    id: IdentifierSchema,
    name: NonEmptyStringSchema,
    description: NonEmptyStringSchema.optional(),
    kind: ToolKindSchema,
    inputSchema: JsonObjectSchema.optional(),
    outputSchema: JsonObjectSchema.optional(),
    operation: ToolOperationSchema.default("read"),
    concurrencyKey: IdentifierSchema.optional(),
    requiresApproval: z.boolean().optional(),
    secretRefs: z.array(IdentifierSchema).max(32).optional(),
    metadata: MetadataSchema.optional(),
  })
  .strict();
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;

// Catalog metadata is safe to return to a model or client. It describes a
// capability, but it never contains a secret value or an executable handler.
export const ToolCatalogDefinitionSchema = ToolDefinitionSchema.extend({
  tags: z.array(IdentifierSchema).max(64).default([]),
  capabilities: z.array(IdentifierSchema).max(64).default([]),
}).strict();
export type ToolCatalogDefinition = z.infer<typeof ToolCatalogDefinitionSchema>;
export type ToolCatalogDefinitionInput = z.input<
  typeof ToolCatalogDefinitionSchema
>;

export const ToolCatalogSearchRequestSchema = z
  .object({
    query: NonEmptyStringSchema.max(500).optional(),
    kinds: z.array(ToolKindSchema).max(8).default([]),
    capabilities: z.array(IdentifierSchema).max(64).default([]),
    tags: z.array(IdentifierSchema).max(64).default([]),
    limit: z.number().int().positive().max(100).default(20),
    cursor: z.string().trim().max(500).optional(),
  })
  .strict()
  .superRefine((request, context) => {
    if (request.cursor && !/^\d+$/.test(request.cursor)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cursor"],
        message: "cursor must be an opaque numeric page token",
      });
    }
  });
export type ToolCatalogSearchRequest = z.infer<
  typeof ToolCatalogSearchRequestSchema
>;
export type ToolCatalogSearchRequestInput = z.input<
  typeof ToolCatalogSearchRequestSchema
>;

export const ToolCatalogMatchFieldSchema = z.enum([
  "id",
  "name",
  "description",
  "kind",
  "tag",
  "capability",
]);
export type ToolCatalogMatchField = z.infer<typeof ToolCatalogMatchFieldSchema>;

export const ToolCatalogSearchResultSchema = z
  .object({
    tool: ToolCatalogDefinitionSchema,
    score: z.number().finite().min(0).max(1),
    matchedOn: z.array(ToolCatalogMatchFieldSchema).min(1).max(6),
  })
  .strict();
export type ToolCatalogSearchResult = z.infer<
  typeof ToolCatalogSearchResultSchema
>;

export const ToolCatalogSearchResponseSchema = z
  .object({
    results: z.array(ToolCatalogSearchResultSchema),
    nextCursor: z.string().trim().max(500).optional(),
  })
  .strict();
export type ToolCatalogSearchResponse = z.infer<
  typeof ToolCatalogSearchResponseSchema
>;

export const ToolCapabilityDescriptorSchema = z
  .object({
    id: IdentifierSchema,
    toolId: IdentifierSchema,
    kind: ToolKindSchema,
    capabilities: z.array(IdentifierSchema).max(64),
    secretRefs: z.array(IdentifierSchema).max(32),
    operation: ToolOperationSchema,
    concurrencyKey: IdentifierSchema.optional(),
    requiresApproval: z.boolean(),
  })
  .strict();
export type ToolCapabilityDescriptor = z.infer<
  typeof ToolCapabilityDescriptorSchema
>;

export const ToolCatalogLoadRequestSchema = z
  .object({
    id: IdentifierSchema,
  })
  .strict();
export type ToolCatalogLoadRequest = z.infer<
  typeof ToolCatalogLoadRequestSchema
>;
export type ToolCatalogLoadRequestInput = z.input<
  typeof ToolCatalogLoadRequestSchema
>;

export const ToolCatalogLoadResponseSchema = z
  .object({
    tool: ToolCatalogDefinitionSchema,
    capability: ToolCapabilityDescriptorSchema,
  })
  .strict();
export type ToolCatalogLoadResponse = z.infer<
  typeof ToolCatalogLoadResponseSchema
>;

export const LazyToolCallSchema = z
  .object({
    id: IdentifierSchema,
    arguments: JsonObjectSchema.default({}),
    callId: IdentifierSchema.optional(),
    idempotencyKey: IdentifierSchema.optional(),
    dependsOn: z.array(IdentifierSchema).max(64).default([]),
  })
  .strict();
export type LazyToolCall = z.infer<typeof LazyToolCallSchema>;
export type LazyToolCallInput = z.input<typeof LazyToolCallSchema>;

export const LazyToolBatchSchema = z
  .object({
    calls: z.array(LazyToolCallSchema).min(1).max(64),
  })
  .strict();
export type LazyToolBatch = z.infer<typeof LazyToolBatchSchema>;
export type LazyToolBatchInput = z.input<typeof LazyToolBatchSchema>;

// Reference a tool by ID.
export const ToolReferenceSchema = z.union([IdentifierSchema, ReferenceSchema]);
export type ToolReference = z.infer<typeof ToolReferenceSchema>;

// Identify the state of one tool call.
export const ToolCallStatusSchema = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed",
  "outcome_unknown",
  "rejected",
  "cancelled",
]);
export type ToolCallStatus = z.infer<typeof ToolCallStatusSchema>;

// Record the input sent to a tool.
export const ToolCallSchema = z
  .object({
    id: IdentifierSchema,
    toolId: IdentifierSchema,
    arguments: JsonObjectSchema,
    runId: IdentifierSchema.optional(),
    agentId: IdentifierSchema.optional(),
    nodeId: IdentifierSchema.optional(),
    requestedAt: TimestampSchema.optional(),
    traceContext: TraceContextSchema.optional(),
    spanKind: SpanKindSchema.optional(),
    attempt: z.number().int().positive().optional(),
    dependencyId: IdentifierSchema.optional(),
    idempotencyKey: IdentifierSchema.optional(),
    inputReference: RedactedReferenceSchema.optional(),
    inputBytes: TelemetryIntegerSchema.optional(),
    metadata: MetadataSchema.optional(),
  })
  .strict();
export type ToolCall = z.infer<typeof ToolCallSchema>;

// Record the result returned by a tool.
export const ToolResultSchema = z
  .object({
    id: IdentifierSchema,
    callId: IdentifierSchema,
    toolId: IdentifierSchema,
    status: ToolCallStatusSchema,
    output: JsonObjectSchema.optional(),
    error: ErrorInfoSchema.optional(),
    startedAt: TimestampSchema.optional(),
    completedAt: TimestampSchema.optional(),
    traceContext: TraceContextSchema.optional(),
    attempt: z.number().int().positive().optional(),
    durationMs: TelemetryIntegerSchema.optional(),
    outputReference: RedactedReferenceSchema.optional(),
    outputBytes: TelemetryIntegerSchema.optional(),
    retryCount: z.number().int().nonnegative().optional(),
    metadata: MetadataSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === "succeeded" && value.output === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["output"],
        message: "A successful tool result needs output",
      });
    }
    if (
      ["failed", "outcome_unknown", "rejected", "cancelled"].includes(
        value.status,
      ) &&
      value.error === undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["error"],
        message: "A non-successful tool result needs error",
      });
    }
  });
export type ToolResult = z.infer<typeof ToolResultSchema>;

// Keep the call and result names close to common API terms.
export const ToolCallResultSchema = ToolResultSchema;
export type ToolCallResult = ToolResult;

// Persist this journal before and after each tool side effect.
export const ToolExecutionStateSchema = z.enum([
  "started",
  "completed",
  "failed",
  "outcome_unknown",
]);
export type ToolExecutionState = z.infer<typeof ToolExecutionStateSchema>;

export const ToolExecutionJournalRecordSchema = z
  .object({
    runId: IdentifierSchema,
    callId: IdentifierSchema,
    toolId: IdentifierSchema,
    operation: z.enum(["read", "write"]),
    state: ToolExecutionStateSchema,
    idempotencyKey: IdentifierSchema.optional(),
    input: JsonObjectSchema.optional(),
    output: JsonObjectSchema.optional(),
    error: ErrorInfoSchema.optional(),
    startedAt: TimestampSchema,
    completedAt: TimestampSchema.optional(),
    metadata: MetadataSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.operation === "write" && !value.idempotencyKey) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["idempotencyKey"],
        message: "A state-changing tool needs an idempotency key",
      });
    }
    if (
      ["failed", "outcome_unknown"].includes(value.state) &&
      value.error === undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["error"],
        message: "A failed or unknown tool outcome needs an error",
      });
    }
  });
export type ToolExecutionJournalRecord = z.infer<
  typeof ToolExecutionJournalRecordSchema
>;

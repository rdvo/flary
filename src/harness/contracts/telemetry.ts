import { z } from "zod";

import {
  IdentifierSchema,
  JsonObjectSchema,
  JsonValueSchema,
  MetadataSchema,
  NonEmptyStringSchema,
  PositiveIntegerSchema,
  TimestampSchema,
} from "./common";
import { PromptCacheRetentionSchema } from "./provider";

const LowerHex32Schema = z
  .string()
  .regex(/^[0-9a-f]{32}$/, "Expected 32 lowercase hexadecimal characters")
  .refine((value) => !/^0+$/.test(value), "The trace ID cannot be all zeroes");

const LowerHex16Schema = z
  .string()
  .regex(/^[0-9a-f]{16}$/, "Expected 16 lowercase hexadecimal characters")
  .refine((value) => !/^0+$/.test(value), "The span ID cannot be all zeroes");

/** A W3C trace ID. The all-zero value is not valid. */
export const TraceIdSchema = LowerHex32Schema;
export type TraceId = z.infer<typeof TraceIdSchema>;

/** A W3C span ID. The all-zero value is not valid. */
export const SpanIdSchema = LowerHex16Schema;
export type SpanId = z.infer<typeof SpanIdSchema>;

/** The two hexadecimal W3C trace flags. */
export const TraceFlagsSchema = z
  .string()
  .regex(/^[0-9a-f]{2}$/, "Expected two lowercase hexadecimal trace flags");
export type TraceFlags = z.infer<typeof TraceFlagsSchema>;

const TraceStateKeyPattern =
  /^[a-z][_0-9a-z-]{0,255}(?:@[a-z][_0-9a-z-]{0,255})?$/;
const TraceStateValuePattern = /^[\x21-\x2b\x2d-\x3c\x3e-\x7e]{1,256}$/;

/** The W3C tracestate header value. */
export const TraceStateSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      value.split(",").every((member) => {
        const separator = member.indexOf("=");
        if (separator < 1) return false;
        const key = member.slice(0, separator).trim();
        const stateValue = member.slice(separator + 1).trim();
        return (
          TraceStateKeyPattern.test(key) &&
          TraceStateValuePattern.test(stateValue)
        );
      }),
    "Expected a valid W3C tracestate list"
  );
export type TraceState = z.infer<typeof TraceStateSchema>;

const TraceParentPattern =
  /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(?:-([0-9a-f]+))?$/;

/**
 * A W3C traceparent value. Version 00 uses the exact four-field format.
 * Future versions may add lowercase hexadecimal fields.
 */
export const TraceParentSchema = z
  .string()
  .regex(TraceParentPattern, "Expected a valid W3C traceparent value")
  .superRefine((value, context) => {
    const match = TraceParentPattern.exec(value);
    if (!match) return;

    const [, version, traceId, spanId] = match;
    if (version === "ff") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "The W3C traceparent version ff is reserved",
      });
    }
    if (traceId === "0".repeat(32)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "The traceparent trace ID cannot be all zeroes",
      });
    }
    if (spanId === "0".repeat(16)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "The traceparent span ID cannot be all zeroes",
      });
    }
    if (version === "00" && match[5] !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Version 00 cannot contain extra traceparent fields",
      });
    }
  });
export type TraceParent = z.infer<typeof TraceParentSchema>;

/** W3C propagation headers. */
export const W3CTraceContextSchema = z
  .object({
    traceparent: TraceParentSchema,
    tracestate: TraceStateSchema.optional(),
  })
  .strict();
export type W3CTraceContext = z.infer<typeof W3CTraceContextSchema>;

/** The structured span context used by telemetry records. */
export const SpanContextSchema = z
  .object({
    traceId: TraceIdSchema,
    spanId: SpanIdSchema,
    traceFlags: TraceFlagsSchema,
    traceState: TraceStateSchema.optional(),
    isRemote: z.boolean().optional(),
  })
  .strict();
export type SpanContext = z.infer<typeof SpanContextSchema>;

/** A span context with the parent span kept as a separate safe ID. */
export const TraceContextSchema = SpanContextSchema.extend({
  parentSpanId: SpanIdSchema.optional(),
}).strict();
export type TraceContext = z.infer<typeof TraceContextSchema>;

export const TraceSpanContextSchema = TraceContextSchema;
export type TraceSpanContext = TraceContext;

// Keep OpenTelemetry-style names available to callers that use that term.
export const W3CTraceParentSchema = TraceParentSchema;
export type W3CTraceParent = TraceParent;

/** The kind of work represented by a span. */
export const SpanKindSchema = z.enum([
  "internal",
  "server",
  "client",
  "producer",
  "consumer",
]);
export type SpanKind = z.infer<typeof SpanKindSchema>;

/** The W3C/OpenTelemetry-compatible span status code. */
export const SpanStatusSchema = z.enum(["unset", "ok", "error"]);
export type SpanStatus = z.infer<typeof SpanStatusSchema>;
export const SpanStatusCodeSchema = SpanStatusSchema;
export type SpanStatusCode = SpanStatus;

/** A status with an optional safe message for a span record. */
export const SpanStatusDetailSchema = z
  .object({
    code: SpanStatusSchema,
    message: NonEmptyStringSchema.max(1_024).optional(),
  })
  .strict();
export type SpanStatusDetail = z.infer<typeof SpanStatusDetailSchema>;

/** A complete span record that can be stored with a telemetry event. */
export const TelemetrySpanSchema = z
  .object({
    context: TraceContextSchema,
    name: NonEmptyStringSchema.max(256),
    kind: SpanKindSchema,
    status: SpanStatusSchema.default("unset"),
    statusMessage: NonEmptyStringSchema.max(1_024).optional(),
    startedAt: TimestampSchema,
    endedAt: TimestampSchema.optional(),
    attributes: MetadataSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.endedAt !== undefined &&
      Date.parse(value.endedAt) < Date.parse(value.startedAt)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endedAt"],
        message: "A span cannot end before it starts",
      });
    }
  });
export type TelemetrySpan = z.infer<typeof TelemetrySpanSchema>;
export const SpanSchema = TelemetrySpanSchema;
export type Span = TelemetrySpan;

/** A safe non-negative integer used for token, byte, time, and count values. */
export const TelemetryIntegerSchema = z
  .number()
  .int()
  .nonnegative()
  .refine(Number.isSafeInteger, "The integer must be safe to store exactly");
export type TelemetryInteger = z.infer<typeof TelemetryIntegerSchema>;

/** Token and lookup details reported by a model provider cache. */
export const EffectiveCacheRetentionSchema = z.enum([
  "none",
  "provider-default",
  "provider-controlled",
  "5m",
  "1h",
  "24h",
]);
export type EffectiveCacheRetention = z.infer<
  typeof EffectiveCacheRetentionSchema
>;

export const CacheUsageSchema = z
  .object({
    hit: z.boolean().optional(),
    readTokens: TelemetryIntegerSchema.optional(),
    writeTokens: TelemetryIntegerSchema.optional(),
    readInputTokens: TelemetryIntegerSchema.optional(),
    writeInputTokens: TelemetryIntegerSchema.optional(),
    requestedRetention: PromptCacheRetentionSchema.optional(),
    effectiveRetention: EffectiveCacheRetentionSchema.optional(),
    provider: IdentifierSchema.optional(),
    model: IdentifierSchema.optional(),
    billingMode: z.enum(["subscription", "byok", "managed"]).optional(),
  })
  .strict();
export type CacheUsage = z.infer<typeof CacheUsageSchema>;

/** Reasoning token details that are not part of visible output tokens. */
export const ReasoningUsageSchema = z
  .object({
    tokens: TelemetryIntegerSchema.optional(),
    effort: z
      .enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"])
      .optional(),
  })
  .strict();
export type ReasoningUsage = z.infer<typeof ReasoningUsageSchema>;

/** One media measurement for one direction. */
export const MediaUsageMeasureSchema = z
  .object({
    count: TelemetryIntegerSchema.optional(),
    tokens: TelemetryIntegerSchema.optional(),
    bytes: TelemetryIntegerSchema.optional(),
    seconds: z.number().finite().nonnegative().optional(),
  })
  .strict();
export type MediaUsageMeasure = z.infer<typeof MediaUsageMeasureSchema>;

/** Input and output media usage grouped by media kind. */
export const MediaUsageSchema = z
  .object({
    audio: z
      .object({
        input: MediaUsageMeasureSchema.optional(),
        output: MediaUsageMeasureSchema.optional(),
      })
      .strict()
      .optional(),
    image: z
      .object({
        input: MediaUsageMeasureSchema.optional(),
        output: MediaUsageMeasureSchema.optional(),
      })
      .strict()
      .optional(),
    video: z
      .object({
        input: MediaUsageMeasureSchema.optional(),
        output: MediaUsageMeasureSchema.optional(),
      })
      .strict()
      .optional(),
    file: z
      .object({
        input: MediaUsageMeasureSchema.optional(),
        output: MediaUsageMeasureSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type MediaUsage = z.infer<typeof MediaUsageSchema>;

/** Provider-specific values kept under named extension keys. */
export const ProviderUsageExtensionsSchema = z.record(
  z.string().trim().min(1).max(128),
  JsonValueSchema
);
export type ProviderUsageExtensions = z.infer<
  typeof ProviderUsageExtensionsSchema
>;

/** A cost value measured in integer micro-units, or an explicit unknown value. */
const CostUnitSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z][A-Za-z0-9._-]*$/);

export const CostStateSchema = z.enum(["known", "unknown"]);
export type CostState = z.infer<typeof CostStateSchema>;

export const KnownMicroUnitCostSchema = z
  .object({
    state: z.literal("known"),
    microUnits: TelemetryIntegerSchema,
    unit: CostUnitSchema,
  })
  .strict();
export type KnownMicroUnitCost = z.infer<typeof KnownMicroUnitCostSchema>;

export const UnknownMicroUnitCostSchema = z
  .object({
    state: z.literal("unknown"),
    unit: CostUnitSchema.optional(),
    reason: NonEmptyStringSchema.max(256).optional(),
  })
  .strict();
export type UnknownMicroUnitCost = z.infer<typeof UnknownMicroUnitCostSchema>;

export const MicroUnitCostSchema = z.discriminatedUnion("state", [
  KnownMicroUnitCostSchema,
  UnknownMicroUnitCostSchema,
]);
export type MicroUnitCost = z.infer<typeof MicroUnitCostSchema>;
export const CostSchema = MicroUnitCostSchema;
export type Cost = MicroUnitCost;
export const KnownCostSchema = KnownMicroUnitCostSchema;
export const UnknownCostSchema = UnknownMicroUnitCostSchema;
export const MicroCostSchema = MicroUnitCostSchema;

/**
 * A reference that contains only an opaque identifier and optional digest.
 * It has no field for prompt text, tool input, command text, or secret data.
 */
export const RedactedReferenceKindSchema = z.enum([
  "run",
  "model",
  "provider",
  "tool",
  "tool-call",
  "retry",
  "approval",
  "cache",
  "cache-entry",
  "sandbox",
  "execution",
  "artifact",
  "prompt",
  "request",
  "response",
  "span",
]);
export type RedactedReferenceKind = z.infer<typeof RedactedReferenceKindSchema>;

const SafeReferenceIdSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/,
    "Reference IDs must be opaque path-safe identifiers"
  );

export const ReferenceDigestSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "Expected a lowercase SHA-256 digest");
export type ReferenceDigest = z.infer<typeof ReferenceDigestSchema>;

export const RedactedReferenceSchema = z
  .object({
    redacted: z.literal(true).default(true),
    kind: RedactedReferenceKindSchema,
    id: SafeReferenceIdSchema,
    version: SafeReferenceIdSchema.optional(),
    digest: ReferenceDigestSchema.optional(),
  })
  .strict();
export type RedactedReference = z.infer<typeof RedactedReferenceSchema>;
export const TelemetryReferenceSchema = RedactedReferenceSchema;
export type TelemetryReference = RedactedReference;
export const SafeReferenceSchema = RedactedReferenceSchema;
export type SafeReference = RedactedReference;

/** Normalized usage shared by model events and model results. */
export const NormalizedUsageSchema = z
  .object({
    inputTokens: TelemetryIntegerSchema.optional(),
    outputTokens: TelemetryIntegerSchema.optional(),
    totalTokens: TelemetryIntegerSchema.optional(),
    cache: CacheUsageSchema.optional(),
    reasoning: ReasoningUsageSchema.optional(),
    media: MediaUsageSchema.optional(),
    providerExtensions: ProviderUsageExtensionsSchema.optional(),
    cost: MicroUnitCostSchema.optional(),
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
export type NormalizedUsage = z.infer<typeof NormalizedUsageSchema>;
export const TelemetryUsageSchema = NormalizedUsageSchema;
export type TelemetryUsage = NormalizedUsage;
export const UsageSchema = NormalizedUsageSchema;
export type Usage = NormalizedUsage;

const TelemetryEventBaseFields = {
  id: IdentifierSchema,
  occurredAt: TimestampSchema,
  runId: IdentifierSchema.optional(),
  parentRunId: IdentifierSchema.optional(),
  threadId: IdentifierSchema.optional(),
  turnId: IdentifierSchema.optional(),
  operationId: IdentifierSchema.optional(),
  traceContext: TraceContextSchema,
  spanKind: SpanKindSchema,
  spanStatus: SpanStatusSchema.default("unset"),
  attempt: PositiveIntegerSchema.optional(),
  startedAt: TimestampSchema.optional(),
  endedAt: TimestampSchema.optional(),
  errorCode: IdentifierSchema.optional(),
  metadata: MetadataSchema.optional(),
};

/** The event families emitted by the telemetry contract. */
export const TelemetryEventTypeSchema = z.enum([
  "run",
  "agent",
  "model",
  "tool",
  "retry",
  "approval",
  "cache",
  "sandbox",
  "artifact",
  "prompt.selection",
]);
export type TelemetryEventType = z.infer<typeof TelemetryEventTypeSchema>;

export const RunTelemetryActionSchema = z.enum([
  "queued",
  "started",
  "waiting",
  "completed",
  "failed",
  "cancelled",
]);
export type RunTelemetryAction = z.infer<typeof RunTelemetryActionSchema>;

export const RunTelemetryPayloadSchema = z
  .object({
    action: RunTelemetryActionSchema,
    run: RedactedReferenceSchema,
    parent: RedactedReferenceSchema.optional(),
    errorCode: IdentifierSchema.optional(),
  })
  .strict();
export type RunTelemetryPayload = z.infer<typeof RunTelemetryPayloadSchema>;

export const RunTelemetryEventSchema = z
  .object({
    ...TelemetryEventBaseFields,
    type: z.literal("run"),
    payload: RunTelemetryPayloadSchema,
  })
  .strict();
export type RunTelemetryEvent = z.infer<typeof RunTelemetryEventSchema>;

export const AgentTelemetryActionSchema = z.enum([
  "started",
  "completed",
  "failed",
  "cancelled",
  "spawned",
  "handoff",
]);
export type AgentTelemetryAction = z.infer<typeof AgentTelemetryActionSchema>;

export const AgentTelemetryPayloadSchema = z
  .object({
    action: AgentTelemetryActionSchema,
    agent: RedactedReferenceSchema,
    parentAgent: RedactedReferenceSchema.optional(),
    errorCode: IdentifierSchema.optional(),
  })
  .strict();
export type AgentTelemetryPayload = z.infer<typeof AgentTelemetryPayloadSchema>;

export const AgentTelemetryEventSchema = z
  .object({
    ...TelemetryEventBaseFields,
    type: z.literal("agent"),
    payload: AgentTelemetryPayloadSchema,
  })
  .strict();
export type AgentTelemetryEvent = z.infer<typeof AgentTelemetryEventSchema>;

export const ModelTelemetryActionSchema = z.enum([
  "requested",
  "started",
  "completed",
  "failed",
  "cancelled",
]);
export type ModelTelemetryAction = z.infer<typeof ModelTelemetryActionSchema>;

export const ModelTelemetryPayloadSchema = z
  .object({
    action: ModelTelemetryActionSchema,
    model: RedactedReferenceSchema,
    provider: RedactedReferenceSchema.optional(),
    deployment: RedactedReferenceSchema.optional(),
    variant: RedactedReferenceSchema.optional(),
    promptRevision: RedactedReferenceSchema.optional(),
    promptVariant: RedactedReferenceSchema.optional(),
    apiStyle: IdentifierSchema.optional(),
    resolvedRoute: IdentifierSchema.optional(),
    request: RedactedReferenceSchema.optional(),
    response: RedactedReferenceSchema.optional(),
    usage: NormalizedUsageSchema.optional(),
    cost: MicroUnitCostSchema.optional(),
    durationMs: TelemetryIntegerSchema.optional(),
    finishReason: IdentifierSchema.optional(),
    errorCode: IdentifierSchema.optional(),
  })
  .strict();
export type ModelTelemetryPayload = z.infer<typeof ModelTelemetryPayloadSchema>;

export const ModelTelemetryEventSchema = z
  .object({
    ...TelemetryEventBaseFields,
    type: z.literal("model"),
    payload: ModelTelemetryPayloadSchema,
  })
  .strict();
export type ModelTelemetryEvent = z.infer<typeof ModelTelemetryEventSchema>;

export const ToolTelemetryActionSchema = z.enum([
  "requested",
  "started",
  "completed",
  "failed",
  "cancelled",
  "skipped",
]);
export type ToolTelemetryAction = z.infer<typeof ToolTelemetryActionSchema>;

export const ToolTelemetryStatusSchema = z.enum([
  "fulfilled",
  "rejected",
  "blocked",
  "denied",
  "skipped",
  "cancelled",
]);
export type ToolTelemetryStatus = z.infer<typeof ToolTelemetryStatusSchema>;

export const ToolTelemetryPayloadSchema = z
  .object({
    action: ToolTelemetryActionSchema,
    tool: RedactedReferenceSchema,
    call: RedactedReferenceSchema.optional(),
    result: RedactedReferenceSchema.optional(),
    attempt: PositiveIntegerSchema.optional(),
    status: ToolTelemetryStatusSchema.optional(),
    durationMs: TelemetryIntegerSchema.optional(),
    errorCode: IdentifierSchema.optional(),
    dependencyId: IdentifierSchema.optional(),
    idempotencyKey: IdentifierSchema.optional(),
    inputReference: RedactedReferenceSchema.optional(),
    outputReference: RedactedReferenceSchema.optional(),
    inputBytes: TelemetryIntegerSchema.optional(),
    outputBytes: TelemetryIntegerSchema.optional(),
    retryCount: TelemetryIntegerSchema.optional(),
    approval: RedactedReferenceSchema.optional(),
  })
  .strict();
export type ToolTelemetryPayload = z.infer<typeof ToolTelemetryPayloadSchema>;

export const ToolTelemetryEventSchema = z
  .object({
    ...TelemetryEventBaseFields,
    type: z.literal("tool"),
    payload: ToolTelemetryPayloadSchema,
  })
  .strict();
export type ToolTelemetryEvent = z.infer<typeof ToolTelemetryEventSchema>;

export const RetryTelemetryActionSchema = z.enum([
  "scheduled",
  "started",
  "succeeded",
  "failed",
  "exhausted",
]);
export type RetryTelemetryAction = z.infer<typeof RetryTelemetryActionSchema>;

export const RetryTelemetryPayloadSchema = z
  .object({
    action: RetryTelemetryActionSchema,
    retry: RedactedReferenceSchema,
    target: RedactedReferenceSchema,
    attempt: PositiveIntegerSchema,
    maxAttempts: PositiveIntegerSchema.optional(),
    delayMs: TelemetryIntegerSchema.optional(),
    reasonCode: IdentifierSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.maxAttempts !== undefined && value.attempt > value.maxAttempts) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["attempt"],
        message: "attempt must not exceed maxAttempts",
      });
    }
  });
export type RetryTelemetryPayload = z.infer<typeof RetryTelemetryPayloadSchema>;

export const RetryTelemetryEventSchema = z
  .object({
    ...TelemetryEventBaseFields,
    type: z.literal("retry"),
    payload: RetryTelemetryPayloadSchema,
  })
  .strict();
export type RetryTelemetryEvent = z.infer<typeof RetryTelemetryEventSchema>;

export const ApprovalTelemetryActionSchema = z.enum([
  "requested",
  "approved",
  "rejected",
  "expired",
  "cancelled",
]);
export type ApprovalTelemetryAction = z.infer<
  typeof ApprovalTelemetryActionSchema
>;

export const ApprovalTelemetryPayloadSchema = z
  .object({
    action: ApprovalTelemetryActionSchema,
    approval: RedactedReferenceSchema,
    actor: RedactedReferenceSchema.optional(),
    reasonCode: IdentifierSchema.optional(),
  })
  .strict();
export type ApprovalTelemetryPayload = z.infer<
  typeof ApprovalTelemetryPayloadSchema
>;

export const ApprovalTelemetryEventSchema = z
  .object({
    ...TelemetryEventBaseFields,
    type: z.literal("approval"),
    payload: ApprovalTelemetryPayloadSchema,
  })
  .strict();
export type ApprovalTelemetryEvent = z.infer<
  typeof ApprovalTelemetryEventSchema
>;

export const CacheTelemetryActionSchema = z.enum([
  "lookup",
  "hit",
  "miss",
  "read",
  "write",
  "evicted",
]);
export type CacheTelemetryAction = z.infer<typeof CacheTelemetryActionSchema>;

export const CacheTelemetryPayloadSchema = z
  .object({
    action: CacheTelemetryActionSchema,
    cache: RedactedReferenceSchema,
    key: RedactedReferenceSchema.optional(),
    entry: RedactedReferenceSchema.optional(),
    bytes: TelemetryIntegerSchema.optional(),
    ttlMs: TelemetryIntegerSchema.optional(),
  })
  .strict();
export type CacheTelemetryPayload = z.infer<typeof CacheTelemetryPayloadSchema>;

export const CacheTelemetryEventSchema = z
  .object({
    ...TelemetryEventBaseFields,
    type: z.literal("cache"),
    payload: CacheTelemetryPayloadSchema,
  })
  .strict();
export type CacheTelemetryEvent = z.infer<typeof CacheTelemetryEventSchema>;

export const SandboxTelemetryActionSchema = z.enum([
  "requested",
  "started",
  "completed",
  "failed",
  "terminated",
]);
export type SandboxTelemetryAction = z.infer<
  typeof SandboxTelemetryActionSchema
>;

export const SandboxTelemetryPayloadSchema = z
  .object({
    action: SandboxTelemetryActionSchema,
    sandbox: RedactedReferenceSchema,
    execution: RedactedReferenceSchema.optional(),
    engine: z.enum(["dynamic-worker", "sandbox"]).optional(),
    exitCode: z.number().int().safe().optional(),
    durationMs: TelemetryIntegerSchema.optional(),
    errorCode: IdentifierSchema.optional(),
  })
  .strict();
export type SandboxTelemetryPayload = z.infer<
  typeof SandboxTelemetryPayloadSchema
>;

export const SandboxTelemetryEventSchema = z
  .object({
    ...TelemetryEventBaseFields,
    type: z.literal("sandbox"),
    payload: SandboxTelemetryPayloadSchema,
  })
  .strict();
export type SandboxTelemetryEvent = z.infer<typeof SandboxTelemetryEventSchema>;

export const ArtifactTelemetryActionSchema = z.enum([
  "created",
  "read",
  "written",
  "deleted",
  "committed",
]);
export type ArtifactTelemetryAction = z.infer<
  typeof ArtifactTelemetryActionSchema
>;

export const ArtifactTelemetryPayloadSchema = z
  .object({
    action: ArtifactTelemetryActionSchema,
    artifact: RedactedReferenceSchema,
    bytes: TelemetryIntegerSchema.optional(),
    mediaType: z.string().trim().min(1).max(255).optional(),
    digest: ReferenceDigestSchema.optional(),
  })
  .strict();
export type ArtifactTelemetryPayload = z.infer<
  typeof ArtifactTelemetryPayloadSchema
>;

export const ArtifactTelemetryEventSchema = z
  .object({
    ...TelemetryEventBaseFields,
    type: z.literal("artifact"),
    payload: ArtifactTelemetryPayloadSchema,
  })
  .strict();
export type ArtifactTelemetryEvent = z.infer<
  typeof ArtifactTelemetryEventSchema
>;

export const PromptSelectionTelemetryActionSchema = z.enum([
  "requested",
  "selected",
  "fallback",
  "rejected",
]);
export type PromptSelectionTelemetryAction = z.infer<
  typeof PromptSelectionTelemetryActionSchema
>;

export const PromptSelectionTelemetryPayloadSchema = z
  .object({
    action: PromptSelectionTelemetryActionSchema,
    prompt: RedactedReferenceSchema,
    selected: RedactedReferenceSchema.optional(),
    candidates: z.array(RedactedReferenceSchema).max(256).optional(),
    assignmentKeyHash: ReferenceDigestSchema.optional(),
    rank: PositiveIntegerSchema.optional(),
    reasonCode: IdentifierSchema.optional(),
  })
  .strict();
export type PromptSelectionTelemetryPayload = z.infer<
  typeof PromptSelectionTelemetryPayloadSchema
>;

export const PromptSelectionTelemetryEventSchema = z
  .object({
    ...TelemetryEventBaseFields,
    type: z.literal("prompt.selection"),
    payload: PromptSelectionTelemetryPayloadSchema,
  })
  .strict();
export type PromptSelectionTelemetryEvent = z.infer<
  typeof PromptSelectionTelemetryEventSchema
>;

/** Validate any supported telemetry event while keeping its payload type. */
export const TelemetryEventSchema = z.discriminatedUnion("type", [
  RunTelemetryEventSchema,
  AgentTelemetryEventSchema,
  ModelTelemetryEventSchema,
  ToolTelemetryEventSchema,
  RetryTelemetryEventSchema,
  ApprovalTelemetryEventSchema,
  CacheTelemetryEventSchema,
  SandboxTelemetryEventSchema,
  ArtifactTelemetryEventSchema,
  PromptSelectionTelemetryEventSchema,
]);
export type TelemetryEvent = z.infer<typeof TelemetryEventSchema>;

export const ModelEventSchema = ModelTelemetryEventSchema;
export const TelemetryRunEventSchema = RunTelemetryEventSchema;
export const TelemetryAgentEventSchema = AgentTelemetryEventSchema;
export const ToolEventSchema = ToolTelemetryEventSchema;
export const RetryEventSchema = RetryTelemetryEventSchema;
export const ApprovalEventSchema = ApprovalTelemetryEventSchema;
export const CacheEventSchema = CacheTelemetryEventSchema;
export const SandboxEventSchema = SandboxTelemetryEventSchema;
export const ArtifactEventSchema = ArtifactTelemetryEventSchema;
export const PromptSelectionEventSchema = PromptSelectionTelemetryEventSchema;

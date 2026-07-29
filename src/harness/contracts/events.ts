import { z } from "zod";

import {
  ErrorInfoSchema,
  IdentifierSchema,
  JsonValueSchema,
  MetadataSchema,
  NonEmptyStringSchema,
  NonNegativeIntegerSchema,
  TimestampSchema,
} from "./common";
import { ApprovalDecisionSchema, ApprovalRequestSchema } from "./approvals";
import { PromptRoleSchema } from "./prompts";
import { PromptCacheRetentionSchema } from "./provider";
import { ProviderBillingModeSchema } from "./connections";
import { RunTargetSchema } from "./runs";
import { ToolCallSchema, ToolResultSchema } from "./tools";
import {
  NormalizedUsageSchema,
  SpanKindSchema,
  SpanStatusSchema,
  TraceContextSchema,
} from "./telemetry";

const EventBaseFields = {
  id: IdentifierSchema,
  runId: IdentifierSchema,
  sequence: NonNegativeIntegerSchema,
  occurredAt: TimestampSchema,
  traceContext: TraceContextSchema.optional(),
  spanKind: SpanKindSchema.optional(),
  spanStatus: SpanStatusSchema.optional(),
  parentRunId: IdentifierSchema.optional(),
  operationId: IdentifierSchema.optional(),
  attempt: NonNegativeIntegerSchema.optional(),
  startedAt: TimestampSchema.optional(),
  completedAt: TimestampSchema.optional(),
  nodeId: IdentifierSchema.optional(),
  metadata: MetadataSchema.optional(),
};

// Identify the event sent by the harness.
export const EventTypeSchema = z.enum([
  "run.queued",
  "run.started",
  "run.input.accepted",
  "run.waiting",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "agent.started",
  "agent.completed",
  "agent.failed",
  "message.created",
  "message.delta",
  "reasoning.delta",
  "model.completed",
  "tool.call",
  "tool.result",
  "approval.requested",
  "approval.resolved",
]);
export type EventType = z.infer<typeof EventTypeSchema>;

// Record that a run entered the queue.
export const RunQueuedEventSchema = z
  .object({
    ...EventBaseFields,
    type: z.literal("run.queued"),
    payload: z
      .object({
        requestId: IdentifierSchema,
        target: RunTargetSchema,
      })
      .strict(),
  })
  .strict();
export type RunQueuedEvent = z.infer<typeof RunQueuedEventSchema>;

// Record that a run started.
export const RunStartedEventSchema = z
  .object({
    ...EventBaseFields,
    type: z.literal("run.started"),
    payload: z
      .object({
        requestId: IdentifierSchema,
      })
      .strict(),
  })
  .strict();
export type RunStartedEvent = z.infer<typeof RunStartedEventSchema>;

// Record durable admission of external input for a waiting run.
export const RunInputAcceptedEventSchema = z
  .object({
    ...EventBaseFields,
    type: z.literal("run.input.accepted"),
    payload: z
      .object({
        idempotencyKey: IdentifierSchema,
      })
      .strict(),
  })
  .strict();
export type RunInputAcceptedEvent = z.infer<
  typeof RunInputAcceptedEventSchema
>;

// Record that a run waits for an external action.
export const RunWaitingEventSchema = z
  .object({
    ...EventBaseFields,
    type: z.literal("run.waiting"),
    payload: z
      .object({
        reason: NonEmptyStringSchema,
        approvalId: IdentifierSchema.optional(),
      })
      .strict(),
  })
  .strict();
export type RunWaitingEvent = z.infer<typeof RunWaitingEventSchema>;

// Record that a run completed.
export const RunCompletedEventSchema = z
  .object({
    ...EventBaseFields,
    type: z.literal("run.completed"),
    payload: z
      .object({
        output: JsonValueSchema,
      })
      .strict(),
  })
  .strict();
export type RunCompletedEvent = z.infer<typeof RunCompletedEventSchema>;

// Record that a run failed.
export const RunFailedEventSchema = z
  .object({
    ...EventBaseFields,
    type: z.literal("run.failed"),
    payload: z
      .object({
        error: ErrorInfoSchema,
      })
      .strict(),
  })
  .strict();
export type RunFailedEvent = z.infer<typeof RunFailedEventSchema>;

// Record that a run was cancelled.
export const RunCancelledEventSchema = z
  .object({
    ...EventBaseFields,
    type: z.literal("run.cancelled"),
    payload: z
      .object({
        reason: NonEmptyStringSchema.optional(),
      })
      .strict(),
  })
  .strict();
export type RunCancelledEvent = z.infer<typeof RunCancelledEventSchema>;

// Record that an agent started.
export const AgentStartedEventSchema = z
  .object({
    ...EventBaseFields,
    type: z.literal("agent.started"),
    payload: z
      .object({
        agentId: IdentifierSchema,
      })
      .strict(),
  })
  .strict();
export type AgentStartedEvent = z.infer<typeof AgentStartedEventSchema>;

// Record that an agent completed.
export const AgentCompletedEventSchema = z
  .object({
    ...EventBaseFields,
    type: z.literal("agent.completed"),
    payload: z
      .object({
        agentId: IdentifierSchema,
        output: JsonValueSchema.optional(),
      })
      .strict(),
  })
  .strict();
export type AgentCompletedEvent = z.infer<typeof AgentCompletedEventSchema>;

// Record that an agent failed.
export const AgentFailedEventSchema = z
  .object({
    ...EventBaseFields,
    type: z.literal("agent.failed"),
    payload: z
      .object({
        agentId: IdentifierSchema,
        error: ErrorInfoSchema,
      })
      .strict(),
  })
  .strict();
export type AgentFailedEvent = z.infer<typeof AgentFailedEventSchema>;

// Record one user or agent message.
export const MessageEventSchema = z
  .object({
    ...EventBaseFields,
    type: z.literal("message.created"),
    payload: z
      .object({
        role: PromptRoleSchema,
        content: NonEmptyStringSchema,
        messageId: IdentifierSchema.optional(),
      })
      .strict(),
  })
  .strict();
export type MessageEvent = z.infer<typeof MessageEventSchema>;

// Normalize provider and Flue text streaming into a stable Flary event.
export const MessageDeltaEventSchema = z
  .object({
    ...EventBaseFields,
    type: z.literal("message.delta"),
    payload: z
      .object({
        delta: z.string().min(1),
        messageId: IdentifierSchema.optional(),
      })
      .strict(),
  })
  .strict();
export type MessageDeltaEvent = z.infer<typeof MessageDeltaEventSchema>;

export const ReasoningDeltaEventSchema = z
  .object({
    ...EventBaseFields,
    type: z.literal("reasoning.delta"),
    payload: z
      .object({
        delta: z.string().min(1),
        messageId: IdentifierSchema.optional(),
      })
      .strict(),
  })
  .strict();
export type ReasoningDeltaEvent = z.infer<typeof ReasoningDeltaEventSchema>;

export const ModelCompletedEventSchema = z
  .object({
    ...EventBaseFields,
    type: z.literal("model.completed"),
    payload: z
      .object({
        provider: IdentifierSchema.optional(),
        model: IdentifierSchema.optional(),
        billingMode: ProviderBillingModeSchema.optional(),
        cacheRetention: PromptCacheRetentionSchema.optional(),
        credentialConnectionRef: IdentifierSchema.max(200).optional(),
        usage: NormalizedUsageSchema.optional(),
        durationMs: NonNegativeIntegerSchema.optional(),
        retryCount: NonNegativeIntegerSchema.optional(),
      })
      .strict(),
  })
  .strict();
export type ModelCompletedEvent = z.infer<
  typeof ModelCompletedEventSchema
>;

// Record a tool call.
export const ToolCallEventSchema = z
  .object({
    ...EventBaseFields,
    type: z.literal("tool.call"),
    payload: z
      .object({
        call: ToolCallSchema,
      })
      .strict(),
  })
  .strict();
export type ToolCallEvent = z.infer<typeof ToolCallEventSchema>;

// Record a tool result.
export const ToolResultEventSchema = z
  .object({
    ...EventBaseFields,
    type: z.literal("tool.result"),
    payload: z
      .object({
        result: ToolResultSchema,
      })
      .strict(),
  })
  .strict();
export type ToolResultEvent = z.infer<typeof ToolResultEventSchema>;

// Record an approval request.
export const ApprovalRequestedEventSchema = z
  .object({
    ...EventBaseFields,
    type: z.literal("approval.requested"),
    payload: z
      .object({
        request: ApprovalRequestSchema,
      })
      .strict(),
  })
  .strict();
export type ApprovalRequestedEvent = z.infer<
  typeof ApprovalRequestedEventSchema
>;

// Record an approval decision.
export const ApprovalResolvedEventSchema = z
  .object({
    ...EventBaseFields,
    type: z.literal("approval.resolved"),
    payload: z
      .object({
        decision: ApprovalDecisionSchema,
      })
      .strict(),
  })
  .strict();
export type ApprovalResolvedEvent = z.infer<typeof ApprovalResolvedEventSchema>;

// Validate every event with its event-specific payload.
export const RunEventSchema = z.discriminatedUnion("type", [
  RunQueuedEventSchema,
  RunStartedEventSchema,
  RunInputAcceptedEventSchema,
  RunWaitingEventSchema,
  RunCompletedEventSchema,
  RunFailedEventSchema,
  RunCancelledEventSchema,
  AgentStartedEventSchema,
  AgentCompletedEventSchema,
  AgentFailedEventSchema,
  MessageEventSchema,
  MessageDeltaEventSchema,
  ReasoningDeltaEventSchema,
  ModelCompletedEventSchema,
  ToolCallEventSchema,
  ToolResultEventSchema,
  ApprovalRequestedEventSchema,
  ApprovalResolvedEventSchema,
]);
export type RunEvent = z.infer<typeof RunEventSchema>;

// Keep the short event name available for consumers.
export const EventSchema = RunEventSchema;
export type Event = RunEvent;

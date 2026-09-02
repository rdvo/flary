import { z } from "zod";

import {
  ErrorInfoSchema,
  IdentifierSchema,
  JsonValueSchema,
  MetadataSchema,
  NonEmptyStringSchema,
  NonNegativeIntegerSchema,
  PositiveIntegerSchema,
  TimestampSchema,
} from "./common.js";
import { ModelSelectionSchema, ReasoningEffortSchema, TextVerbositySchema } from "./provider.js";
import { PromptMessageSchema } from "./prompts.js";
import { AgentModeIdSchema } from "./modes.js";

export const MAX_SEEDED_TURNS = 64 as const;

// These roles are provider-neutral. A provider adapter can map `explorer` to
// Codex explorer, a Claude Agent SDK AgentDefinition, or a Flary-native agent.
export const SubagentRoleSchema = z.enum([
  "default",
  "worker",
  "explorer",
  "reader",
  "reviewer",
  "researcher",
  "custom",
]);
export type SubagentRole = z.infer<typeof SubagentRoleSchema>;

export const SubagentThreadStatusSchema = z.enum([
  "queued",
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
  "closed",
]);
export type SubagentThreadStatus = z.infer<typeof SubagentThreadStatusSchema>;

export const SubagentMessageModeSchema = z.enum(["queue", "interrupt"]);
export type SubagentMessageMode = z.infer<typeof SubagentMessageModeSchema>;

export const SubagentMessageKindSchema = z.enum([
  "instruction",
  "progress",
  "question",
  "result",
  "control",
]);
export type SubagentMessageKind = z.infer<typeof SubagentMessageKindSchema>;

// A value of zero gives the child only its task and agent instructions.
// A positive value copies the most recent complete turns from the parent.
export const SeedTurnsSchema = z.number().int().min(0).max(MAX_SEEDED_TURNS).default(0);
export type SeedTurns = z.infer<typeof SeedTurnsSchema>;

export const SubagentContextSeedSchema = z
  .object({
    turns: SeedTurnsSchema,
    includeSystem: z.boolean().default(true),
    includeArtifacts: z.boolean().default(true),
  })
  .strict();
export type SubagentContextSeed = z.infer<typeof SubagentContextSeedSchema>;

export const DelegationPolicySchema = z
  .object({
    mode: z.enum(["disabled", "explicit", "auto"]).default("explicit"),
    maxConcurrentChildren: PositiveIntegerSchema.max(32).default(4),
    maxTotalChildren: PositiveIntegerSchema.max(256).default(16),
    maxDepth: NonNegativeIntegerSchema.max(8).default(1),
    allowPeerMessaging: z.boolean().default(false),
  })
  .strict();
export type DelegationPolicy = z.infer<typeof DelegationPolicySchema>;

// A conversation turn is the unit used by `seedTurns`. One turn can contain
// several model messages, such as one assistant tool call and its tool result.
export const SubagentConversationTurnSchema = z
  .object({
    id: IdentifierSchema,
    sessionId: IdentifierSchema,
    threadId: IdentifierSchema,
    ordinal: NonNegativeIntegerSchema,
    messages: z.array(PromptMessageSchema).min(1).max(256),
    createdAt: TimestampSchema,
    metadata: MetadataSchema.optional(),
  })
  .strict();
export type SubagentConversationTurn = z.infer<typeof SubagentConversationTurnSchema>;

export const SpawnSubagentRequestSchema = z
  .object({
    requestId: IdentifierSchema,
    sessionId: IdentifierSchema,
    parentThreadId: IdentifierSchema,
    agentId: IdentifierSchema,
    role: SubagentRoleSchema.default("default"),
    mode: AgentModeIdSchema.optional(),
    task: NonEmptyStringSchema,
    seedTurns: SeedTurnsSchema,
    model: ModelSelectionSchema.optional(),
    reasoningEffort: ReasoningEffortSchema.optional(),
    verbosity: TextVerbositySchema.optional(),
    nickname: z.string().trim().min(1).max(80).optional(),
    idempotencyKey: IdentifierSchema.optional(),
    metadata: MetadataSchema.optional(),
  })
  .strict();
export type SpawnSubagentRequest = z.infer<typeof SpawnSubagentRequestSchema>;
export type SpawnSubagentRequestInput = z.input<typeof SpawnSubagentRequestSchema>;

export const SubagentThreadSchema = z
  .object({
    threadId: IdentifierSchema,
    sessionId: IdentifierSchema,
    rootThreadId: IdentifierSchema,
    parentThreadId: IdentifierSchema.optional(),
    agentId: IdentifierSchema,
    role: SubagentRoleSchema,
    mode: AgentModeIdSchema.default("ask"),
    agentPath: NonEmptyStringSchema,
    depth: NonNegativeIntegerSchema,
    status: SubagentThreadStatusSchema,
    task: NonEmptyStringSchema,
    contextSeed: SubagentContextSeedSchema,
    seededTurnIds: z.array(IdentifierSchema).max(MAX_SEEDED_TURNS),
    model: ModelSelectionSchema.optional(),
    reasoningEffort: ReasoningEffortSchema.optional(),
    verbosity: TextVerbositySchema.optional(),
    nickname: z.string().trim().min(1).max(80).optional(),
    output: JsonValueSchema.optional(),
    error: ErrorInfoSchema.optional(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    completedAt: TimestampSchema.optional(),
    metadata: MetadataSchema.optional(),
  })
  .strict();
export type SubagentThread = z.infer<typeof SubagentThreadSchema>;

/** Durable result sent from a completed child to its parent thread. */
export const SubagentResultSchema = z
  .object({
    summary: NonEmptyStringSchema,
    checkpoint: JsonValueSchema.optional(),
    changedFiles: z.array(z.string().min(1).max(4_096)).max(10_000),
    checks: z
      .array(
        z
          .object({
            command: z.string().min(1).max(16_384),
            status: z.enum(["passed", "failed", "skipped"]),
          })
          .strict(),
      )
      .max(1_000),
    usage: z
      .object({
        steps: NonNegativeIntegerSchema,
        toolCalls: NonNegativeIntegerSchema,
        tokens: NonNegativeIntegerSchema,
        costUsd: z.number().finite().nonnegative(),
        sandboxSeconds: NonNegativeIntegerSchema,
        browserSeconds: NonNegativeIntegerSchema,
      })
      .strict(),
    errors: z.array(z.string().min(1).max(16_384)).max(1_000),
    output: JsonValueSchema.optional(),
  })
  .strict();
export type SubagentResult = z.infer<typeof SubagentResultSchema>;

export const SpawnSubagentResponseSchema = z
  .object({
    thread: SubagentThreadSchema,
    accepted: z.literal(true),
  })
  .strict();
export type SpawnSubagentResponse = z.infer<typeof SpawnSubagentResponseSchema>;

export const SubagentMailboxMessageSchema = z
  .object({
    id: IdentifierSchema,
    sessionId: IdentifierSchema,
    fromThreadId: IdentifierSchema,
    toThreadId: IdentifierSchema,
    sequence: PositiveIntegerSchema,
    kind: SubagentMessageKindSchema,
    mode: SubagentMessageModeSchema,
    content: NonEmptyStringSchema,
    createdAt: TimestampSchema,
    deliveredAt: TimestampSchema.optional(),
    metadata: MetadataSchema.optional(),
  })
  .strict();
export type SubagentMailboxMessage = z.infer<typeof SubagentMailboxMessageSchema>;

export const SendSubagentMessageRequestSchema = z
  .object({
    requestId: IdentifierSchema,
    sessionId: IdentifierSchema,
    fromThreadId: IdentifierSchema,
    toThreadId: IdentifierSchema,
    kind: SubagentMessageKindSchema.default("instruction"),
    mode: SubagentMessageModeSchema.default("queue"),
    content: NonEmptyStringSchema,
    idempotencyKey: IdentifierSchema.optional(),
    metadata: MetadataSchema.optional(),
  })
  .strict();
export type SendSubagentMessageRequest = z.infer<typeof SendSubagentMessageRequestSchema>;
export type SendSubagentMessageRequestInput = z.input<typeof SendSubagentMessageRequestSchema>;

export const WaitForSubagentsRequestSchema = z
  .object({
    sessionId: IdentifierSchema,
    threadIds: z.array(IdentifierSchema).min(1).max(32),
    afterSequence: NonNegativeIntegerSchema.default(0),
    timeoutMs: PositiveIntegerSchema.max(3_600_000).default(120_000),
  })
  .strict();
export type WaitForSubagentsRequest = z.infer<typeof WaitForSubagentsRequestSchema>;
export type WaitForSubagentsRequestInput = z.input<typeof WaitForSubagentsRequestSchema>;

export const WaitForSubagentsResponseSchema = z
  .object({
    threads: z.array(SubagentThreadSchema),
    sequence: NonNegativeIntegerSchema,
    timedOut: z.boolean(),
  })
  .strict();
export type WaitForSubagentsResponse = z.infer<typeof WaitForSubagentsResponseSchema>;

export const SubagentControlActionSchema = z.enum([
  "start",
  "wait",
  "complete",
  "fail",
  "cancel",
  "close",
  "resume",
  "handoff",
]);
export type SubagentControlAction = z.infer<typeof SubagentControlActionSchema>;

export const SubagentControlRequestSchema = z
  .object({
    requestId: IdentifierSchema,
    sessionId: IdentifierSchema,
    threadId: IdentifierSchema,
    action: SubagentControlActionSchema,
    output: JsonValueSchema.optional(),
    error: ErrorInfoSchema.optional(),
    targetThreadId: IdentifierSchema.optional(),
    reason: z.string().trim().max(4096).optional(),
    idempotencyKey: IdentifierSchema.optional(),
    metadata: MetadataSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.action === "complete" && value.output === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["output"],
        message: "A completed subagent needs output",
      });
    }
    if (value.action === "fail" && value.error === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["error"],
        message: "A failed subagent needs an error",
      });
    }
    if (value.action === "handoff" && value.targetThreadId === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["targetThreadId"],
        message: "A handoff needs a target thread",
      });
    }
  });
export type SubagentControlRequest = z.infer<typeof SubagentControlRequestSchema>;

export const SubagentActivityKindSchema = z.enum([
  "spawned",
  "started",
  "interacted",
  "waiting",
  "completed",
  "failed",
  "cancelled",
  "closed",
  "resumed",
  "handed_off",
  "mode_changed",
]);
export type SubagentActivityKind = z.infer<typeof SubagentActivityKindSchema>;

export const SubagentActivityEventSchema = z
  .object({
    id: IdentifierSchema,
    sessionId: IdentifierSchema,
    sequence: PositiveIntegerSchema,
    threadId: IdentifierSchema,
    parentThreadId: IdentifierSchema.optional(),
    agentPath: NonEmptyStringSchema,
    kind: SubagentActivityKindSchema,
    occurredAt: TimestampSchema,
    triggerMessageId: IdentifierSchema.optional(),
    payload: JsonValueSchema.optional(),
    metadata: MetadataSchema.optional(),
  })
  .strict();
export type SubagentActivityEvent = z.infer<typeof SubagentActivityEventSchema>;

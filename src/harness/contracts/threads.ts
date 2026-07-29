import { z } from "zod";

import {
  AgentModeIdSchema,
  type AgentModeId,
} from "./modes";
import {
  ModelSelectionSchema,
  PromptCacheRetentionSchema,
  ReasoningEffortSchema,
  type ModelSelection,
  type PromptCacheRetention,
  type ReasoningEffort,
} from "./provider";
import {
  IdentifierSchema,
  JsonObjectSchema,
  MetadataSchema,
  NonEmptyStringSchema,
  TimestampSchema,
} from "./common";
import { IdentityReferenceSchema, type IdentityReference } from "./identity";
import {
  ThreadRefSchema,
  WorkspaceRefSchema,
  type ThreadRef,
  type WorkspaceRef,
} from "./tenancy";
import {
  ArtifactCommitSummarySchema,
  ArtifactDiffSchema,
} from "../storage/artifacts";

export const ThreadLifecycleStatusSchema = z.enum([
  "active",
  "archived",
  "forked",
]);
export type ThreadLifecycleStatus = z.infer<
  typeof ThreadLifecycleStatusSchema
>;

/**
 * The durable identity of one Flary thread.
 *
 * `workspace` is immutable. A caller that needs another workspace must create
 * or fork a new thread. Mode and connection grants are mutable operational
 * settings and are kept here so the Durable Object can enforce them.
 */
export const ThreadBindingSchema = z
  .object({
    thread: ThreadRefSchema,
    workspace: WorkspaceRefSchema,
    agentId: IdentifierSchema,
    persona: IdentifierSchema.optional(),
    defaultMode: AgentModeIdSchema,
    defaultModel: ModelSelectionSchema.optional(),
    defaultThinkingLevel: ReasoningEffortSchema.default("medium"),
    connectionIds: z.array(IdentifierSchema).max(256).default([]),
    createdBy: IdentityReferenceSchema,
    status: ThreadLifecycleStatusSchema.default("active"),
    parentThread: ThreadRefSchema.optional(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    metadata: MetadataSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.agentId !== value.thread.agentId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["agentId"],
        message: "agentId must match thread.agentId",
      });
    }
    if (
      value.parentThread &&
      value.parentThread.organizationId !== value.thread.organizationId
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["parentThread"],
        message: "A fork parent must stay inside the same organization",
      });
    }
  });
export type ThreadBinding = z.infer<typeof ThreadBindingSchema>;

export const ThreadCreateRequestSchema = z
  .object({
    threadId: IdentifierSchema.optional(),
    agentId: IdentifierSchema.default("flary-thread"),
    workspace: WorkspaceRefSchema,
    persona: IdentifierSchema.optional(),
    mode: AgentModeIdSchema.default("ask"),
    model: ModelSelectionSchema.optional(),
    thinkingLevel: ReasoningEffortSchema.default("medium"),
    connectionIds: z.array(IdentifierSchema).max(256).default([]),
    metadata: MetadataSchema.optional(),
  })
  .strict();
export type ThreadCreateRequest = z.input<typeof ThreadCreateRequestSchema>;

export const ThreadForkRequestSchema = z
  .object({
    threadId: IdentifierSchema.optional(),
    mode: AgentModeIdSchema.optional(),
    model: ModelSelectionSchema.optional(),
    thinkingLevel: ReasoningEffortSchema.optional(),
    metadata: MetadataSchema.optional(),
  })
  .strict();
export type ThreadForkRequest = z.infer<typeof ThreadForkRequestSchema>;

export const ThreadModeRequestSchema = z
  .object({
    mode: AgentModeIdSchema,
    reason: z.string().trim().max(4_096).optional(),
    metadata: MetadataSchema.optional(),
  })
  .strict();
export type ThreadModeRequest = z.infer<typeof ThreadModeRequestSchema>;

export const ThreadConnectionsRequestSchema = z
  .object({
    connectionIds: z.array(IdentifierSchema).max(256),
  })
  .strict();
export type ThreadConnectionsRequest = z.infer<
  typeof ThreadConnectionsRequestSchema
>;

export const ThreadMessageImageSchema = z
  .object({
    type: z.literal("image"),
    data: NonEmptyStringSchema,
    mimeType: NonEmptyStringSchema,
    filename: IdentifierSchema.optional(),
  })
  .strict();

export const ThreadMessageRequestSchema = z
  .object({
    message: NonEmptyStringSchema.max(1_000_000),
    images: z.array(ThreadMessageImageSchema).max(16).optional(),
    model: ModelSelectionSchema.optional(),
    thinkingLevel: ReasoningEffortSchema.optional(),
    cacheRetention: PromptCacheRetentionSchema.default("short"),
    idempotencyKey: IdentifierSchema.optional(),
  })
  .strict();
export type ThreadMessageRequest = z.input<typeof ThreadMessageRequestSchema>;

export const ThreadApprovalRecordSchema = z
  .object({
    request: z.record(z.string(), z.unknown()),
    decision: z.record(z.string(), z.unknown()).nullable(),
  })
  .strict();

export const ThreadBindingResponseSchema = z
  .object({
    binding: ThreadBindingSchema,
    currentMode: AgentModeIdSchema,
    approvals: z.array(ThreadApprovalRecordSchema).optional(),
  })
  .strict();
export type ThreadBindingResponse = z.infer<
  typeof ThreadBindingResponseSchema
>;

export type ThreadModel = ModelSelection;
export type ThreadThinkingLevel = ReasoningEffort;
export type ThreadCacheRetention = PromptCacheRetention;
export type ThreadMode = AgentModeId;
export type ThreadCreator = IdentityReference;
export type ThreadWorkspace = WorkspaceRef;
export type ThreadIdentity = ThreadRef;

export const ThreadOverrideSchema = z
  .object({
    model: ModelSelectionSchema.optional(),
    thinkingLevel: ReasoningEffortSchema.optional(),
    cacheRetention: PromptCacheRetentionSchema.optional(),
  })
  .strict();
export type ThreadOverride = z.infer<typeof ThreadOverrideSchema>;

export const ThreadListResponseSchema = z
  .object({
    threads: z.array(ThreadBindingSchema),
  })
  .strict();

export const ThreadHistoryListResponseSchema = z
  .object({
    repository: NonEmptyStringSchema.max(500),
    branch: NonEmptyStringSchema.max(200),
    checkpoints: z.array(ArtifactCommitSummarySchema).max(100),
  })
  .strict();
export type ThreadHistoryListResponse = z.infer<
  typeof ThreadHistoryListResponseSchema
>;

export const ThreadHistoryListRequestSchema = z
  .object({
    limit: z.coerce.number().int().positive().max(100).default(30),
  })
  .strict();
export type ThreadHistoryListRequest = z.input<
  typeof ThreadHistoryListRequestSchema
>;

export const ThreadHistoryDiffRequestSchema = z
  .object({
    baseCommitId: IdentifierSchema.optional(),
    headCommitId: IdentifierSchema,
  })
  .strict();
export type ThreadHistoryDiffRequest = z.infer<
  typeof ThreadHistoryDiffRequestSchema
>;

export const ThreadHistoryDiffResponseSchema = z
  .object({ diff: ArtifactDiffSchema })
  .strict();
export type ThreadHistoryDiffResponse = z.infer<
  typeof ThreadHistoryDiffResponseSchema
>;

export const ThreadMutationResponseSchema = z
  .object({
    ok: z.literal(true),
    binding: ThreadBindingSchema.optional(),
    thread: ThreadRefSchema.optional(),
  })
  .strict();

export const ThreadCursorQuerySchema = z
  .object({
    flueOffset: z.string().max(1_024).optional(),
    flarySequence: z.coerce.number().int().nonnegative().optional(),
  })
  .strict();

export const ThreadStatusPatchSchema = z
  .object({
    status: ThreadLifecycleStatusSchema,
    metadata: JsonObjectSchema.optional(),
  })
  .strict();

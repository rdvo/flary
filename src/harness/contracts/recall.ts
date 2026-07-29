import { z } from "zod";

import {
  IdentifierSchema,
  MetadataSchema,
  NonEmptyStringSchema,
  TimestampSchema,
} from "./common";

export const RecallScopeKindSchema = z.enum([
  "session",
  "project",
  "app",
  "organization",
]);
export type RecallScopeKind = z.infer<typeof RecallScopeKindSchema>;

// A document can carry parent scope IDs even when its primary scope is a
// session. This lets project and organization searches include session data.
export const RecallScopeSchema = z
  .object({
    kind: RecallScopeKindSchema,
    organizationId: IdentifierSchema.optional(),
    appId: IdentifierSchema.optional(),
    projectId: IdentifierSchema.optional(),
    sessionId: IdentifierSchema.optional(),
  })
  .strict()
  .superRefine((scope, context) => {
    const required: Record<RecallScopeKind, keyof typeof scope | undefined> = {
      session: "sessionId",
      project: "projectId",
      app: "appId",
      organization: "organizationId",
    };
    const requiredKey = required[scope.kind];
    if (requiredKey && !scope[requiredKey]) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [requiredKey],
        message: scope.kind + " scope requires " + requiredKey,
      });
    }
    if (scope.kind === "project" && !scope.appId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["appId"],
        message: "project scope requires appId",
      });
    }
  });
export type RecallScope = z.infer<typeof RecallScopeSchema>;

export const RecallSearchModeSchema = z.enum([
  "exact",
  "semantic",
  "hybrid",
]);
export type RecallSearchMode = z.infer<typeof RecallSearchModeSchema>;

export const RecallKindSchema = z.enum([
  "message",
  "plan",
  "decision",
  "file",
  "tool",
  "run",
  "event",
]);
export type RecallKind = z.infer<typeof RecallKindSchema>;

export const RecallReferenceSchema = z
  .object({
    id: IdentifierSchema,
    kind: RecallKindSchema,
    organizationId: IdentifierSchema.optional(),
    appId: IdentifierSchema.optional(),
    projectId: IdentifierSchema.optional(),
    sessionId: IdentifierSchema.optional(),
    turnId: IdentifierSchema.optional(),
    repository: z.string().trim().max(500).optional(),
    commit: z.string().trim().max(200).optional(),
    path: z.string().trim().max(2000).optional(),
    lineStart: z.number().int().positive().optional(),
    lineEnd: z.number().int().positive().optional(),
    offset: z.number().int().nonnegative().optional(),
    createdAt: TimestampSchema.optional(),
  })
  .strict()
  .superRefine((reference, context) => {
    if (
      reference.lineStart !== undefined &&
      reference.lineEnd !== undefined &&
      reference.lineEnd < reference.lineStart
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["lineEnd"],
        message: "lineEnd must not be before lineStart",
      });
    }
  });
export type RecallReference = z.infer<typeof RecallReferenceSchema>;

export const RecallDocumentSchema = z
  .object({
    id: IdentifierSchema,
    content: NonEmptyStringSchema,
    kind: RecallKindSchema,
    scope: RecallScopeSchema,
    reference: RecallReferenceSchema,
    metadata: MetadataSchema.optional(),
    vector: z.array(z.number().finite()).min(1).optional(),
    sourceHash: z.string().trim().max(256).optional(),
    createdAt: TimestampSchema,
    deleted: z.boolean().default(false),
  })
  .strict();
export type RecallDocument = z.infer<typeof RecallDocumentSchema>;
export type RecallDocumentInput = z.input<typeof RecallDocumentSchema>;

export const RecallSearchRequestSchema = z
  .object({
    query: NonEmptyStringSchema.max(20_000),
    scope: RecallScopeSchema,
    mode: RecallSearchModeSchema.default("hybrid"),
    kinds: z.array(RecallKindSchema).min(1).max(8).optional(),
    limit: z.number().int().positive().max(100).default(10),
    cursor: z.string().trim().max(500).optional(),
    includeContent: z.boolean().default(true),
  })
  .strict();
export type RecallSearchRequest = z.infer<typeof RecallSearchRequestSchema>;
export type RecallSearchRequestInput = z.input<
  typeof RecallSearchRequestSchema
>;

export const RecallResultSchema = z
  .object({
    id: IdentifierSchema,
    snippet: NonEmptyStringSchema,
    reference: RecallReferenceSchema,
    score: z.number().finite(),
    matchType: z.enum(["exact", "semantic", "hybrid"]),
    metadata: MetadataSchema.optional(),
  })
  .strict();
export type RecallResult = z.infer<typeof RecallResultSchema>;

export const RecallSearchResponseSchema = z
  .object({
    results: z.array(RecallResultSchema),
    nextCursor: z.string().trim().max(500).optional(),
  })
  .strict();
export type RecallSearchResponse = z.infer<typeof RecallSearchResponseSchema>;

export const RecallOpenRequestSchema = z
  .object({
    scope: RecallScopeSchema,
    id: IdentifierSchema.optional(),
    reference: RecallReferenceSchema.optional(),
  })
  .strict()
  .superRefine((request, context) => {
    if (!request.id && !request.reference) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["id"],
        message: "id or reference is required",
      });
    }
    if (request.id && request.reference) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reference"],
        message: "Use id or reference, not both",
      });
    }
  });
export type RecallOpenRequest = z.infer<typeof RecallOpenRequestSchema>;

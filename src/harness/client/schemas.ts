import { z } from "zod";
import {
  ConnectionSchema,
  ConnectionSecretMetadataSchema,
  ProviderCredentialLifecycleSchema,
  ProviderOAuthSessionSchema,
} from "../contracts";

const ApiTimestampSchema = z.union([
  z.number().int().nonnegative(),
  z.string().datetime({ offset: true }),
]);

export const PromptRevisionSummarySchema = z.object({
  id: z.string().min(1),
  revision: z.number().int().positive(),
  sourceHash: z.string().regex(/^[0-9a-f]{64}$/),
  sourceKey: z.string().min(1),
  sourceCommit: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  thinking: z.string().nullable().optional(),
  createdBy: z.string().min(1),
  createdAt: ApiTimestampSchema.nullable().optional(),
});

export const PromptRevisionsResponseSchema = z.object({
  revisions: z.array(PromptRevisionSummarySchema),
});

export const PromptRevisionSourceResponseSchema = z.object({
  revision: PromptRevisionSummarySchema,
  source: z.string(),
});

export const PromptVariantSummarySchema = z.object({
  id: z.string().min(1),
  rolloutId: z.string().min(1),
  scope: z.enum([
    "global",
    "organization",
    "project",
    "user",
    "session",
    "request",
  ]),
  variantId: z.string().min(1),
  revisionId: z.string().min(1),
  allocationBasisPoints: z.number().int().nonnegative(),
  enabled: z.boolean(),
  createdBy: z.string().min(1),
  createdAt: ApiTimestampSchema.nullable().optional(),
});

export const PromptVariantsResponseSchema = z.object({
  variants: z.array(PromptVariantSummarySchema),
});

export const CreatePromptRolloutInputSchema = z.object({
  rolloutId: z.string().trim().min(1).max(160),
  scope: z
    .enum(["global", "organization", "project", "user", "session", "request"])
    .default("user"),
  variants: z
    .array(
      z.object({
        id: z.string().trim().min(1).max(160),
        revisionId: z.string().trim().min(1).max(200),
        allocationBasisPoints: z.number().int().min(0).max(10_000),
        enabled: z.boolean().default(true),
      })
    )
    .min(1),
});

export const CreatePromptRolloutResponseSchema = z.object({
  ok: z.literal(true),
  rolloutId: z.string().min(1),
});

export const SavePromptInputSchema = z.object({
  slug: z.string().trim().min(1).max(160),
  source: z.string().min(1).max(1_000_000),
  sourceHash: z.string().regex(/^[0-9a-f]{64}$/),
  sourceCommit: z.string().max(200).optional(),
  model: z.string().max(200).optional(),
  thinking: z.string().max(64).optional(),
});

export const SavePromptResponseSchema = z.object({
  ok: z.literal(true),
  created: z.boolean(),
  promptId: z.string().min(1),
  revisionId: z.string().min(1).optional(),
  revision: z.number().int().positive().optional(),
  sourceKey: z.string().min(1),
  sourceHash: z.string().regex(/^[0-9a-f]{64}$/),
});

export const ConnectionsResponseSchema = z.object({
  connections: z.array(ConnectionSchema),
});

export const ConnectionResponseSchema = z.object({
  connection: ConnectionSchema,
});

export const ConnectionDetailResponseSchema = z.object({
  connection: ConnectionSchema,
  secrets: z.array(ConnectionSecretMetadataSchema),
});

export const ConnectionSecretResponseSchema = z.object({
  ok: z.literal(true),
  secret: ConnectionSecretMetadataSchema,
});

export const ProviderOAuthResponseSchema = z.object({
  oauth: ProviderOAuthSessionSchema,
});

export const ProviderCredentialHandoffResponseSchema = z.object({
  credential: ProviderCredentialLifecycleSchema,
});

export type SavePromptInput = z.input<typeof SavePromptInputSchema>;
export type SavePromptResponse = z.infer<typeof SavePromptResponseSchema>;
export type Connection = z.infer<typeof ConnectionSchema>;
export type ConnectionSecretMetadata = z.infer<
  typeof ConnectionSecretMetadataSchema
>;
export type ConnectionDetailResponse = z.infer<
  typeof ConnectionDetailResponseSchema
>;
export type ProviderOAuthResponse = z.infer<
  typeof ProviderOAuthResponseSchema
>;
export type PromptRevisionSummary = z.infer<typeof PromptRevisionSummarySchema>;
export type PromptRevisionSourceResponse = z.infer<
  typeof PromptRevisionSourceResponseSchema
>;
export type PromptVariantSummary = z.infer<typeof PromptVariantSummarySchema>;
export type CreatePromptRolloutInput = z.input<
  typeof CreatePromptRolloutInputSchema
>;

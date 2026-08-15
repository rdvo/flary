import { z } from "zod";

import {
  IdentifierSchema,
  JsonObjectSchema,
  MetadataSchema,
  NonNegativeIntegerSchema,
  NonEmptyStringSchema,
  PositiveIntegerSchema,
} from "./common";

// Control how much prose a model returns when the provider supports it.
// Providers that do not expose a native verbosity option can use this value
// as prompt guidance.
export const TextVerbositySchema = z.enum(["low", "medium", "high"]);
export type TextVerbosity = z.infer<typeof TextVerbositySchema>;

// Control provider-native prompt cache retention. Adapters map these values to
// the provider's supported TTL and ignore unsupported values.
export const PromptCacheRetentionSchema = z.enum(["none", "short", "long"]);
export type PromptCacheRetention = z.infer<
  typeof PromptCacheRetentionSchema
>;

// Keep reasoning levels provider-neutral. Adapters must reject or reduce a
// level when a selected model does not support it.
export const ReasoningEffortSchema = z.enum([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;

// Identify the provider family.
export const ProviderKindSchema = z.enum([
  "openai",
  "openai-codex",
  "anthropic",
  "google",
  "google-vertex",
  "amazon-bedrock",
  "mistral",
  "cohere",
  "deepseek",
  "xai",
  "openrouter",
  "moonshot",
  "cloudflare",
  "custom",
]);
export type ProviderKind = z.infer<typeof ProviderKindSchema>;

// Describe features that a model can provide.
export const ModelCapabilitySchema = z.enum([
  "chat",
  "reasoning",
  "tools",
  "vision",
  "audio",
  "embeddings",
  "structured-output",
]);
export type ModelCapability = z.infer<typeof ModelCapabilitySchema>;

// Describe a configured model provider.
export const ProviderSchema = z
  .object({
    id: IdentifierSchema,
    kind: ProviderKindSchema,
    name: NonEmptyStringSchema,
    baseUrl: z.string().url().optional(),
    region: IdentifierSchema.optional(),
    secretRefs: z.array(IdentifierSchema).max(32).optional(),
    capabilities: z.array(ModelCapabilitySchema).max(32).optional(),
    metadata: MetadataSchema.optional(),
  })
  .strict();
export type Provider = z.infer<typeof ProviderSchema>;

// Select one model from one provider.
export const ModelSelectionSchema = z
  .object({
    provider: IdentifierSchema,
    model: IdentifierSchema,
    deployment: IdentifierSchema.optional(),
    variant: IdentifierSchema.optional(),
    capabilities: z.array(ModelCapabilitySchema).max(32).optional(),
    reasoningEffort: ReasoningEffortSchema.optional(),
    verbosity: TextVerbositySchema.optional(),
    parameters: JsonObjectSchema.optional(),
    maxOutputTokens: PositiveIntegerSchema.optional(),
    timeoutMs: PositiveIntegerSchema.optional(),
    cacheRetention: PromptCacheRetentionSchema.optional(),
  })
  .strict();
export type ModelSelection = z.infer<typeof ModelSelectionSchema>;

/** A model selected by a caller. Strings use the `provider/model` form. */
export const ModelInputSchema = z.union([
  ModelSelectionSchema,
  z.string().trim().min(3).max(400).regex(/^[^/\s]+\/.+$/, {
    message: "A model string must use the provider/model form",
  }),
]);
export type ModelInput = z.infer<typeof ModelInputSchema>;

/** Convert the compact model form into the canonical selection object. */
export function normalizeModelInput(input: ModelInput): ModelSelection {
  if (typeof input !== "string") return ModelSelectionSchema.parse(input);
  const separator = input.indexOf("/");
  return ModelSelectionSchema.parse({
    provider: input.slice(0, separator),
    model: input.slice(separator + 1),
  });
}

/** Immutable, secret-free model and credential identity stored with a turn. */
export const ResolvedModelPinSchema = z
  .object({
    selection: ModelSelectionSchema,
    /** Secret-free, thread-unique provider alias used only for runtime dispatch. */
    runtimeSelection: ModelSelectionSchema.optional(),
    provider: IdentifierSchema,
    model: IdentifierSchema,
    deployment: IdentifierSchema.optional(),
    variant: IdentifierSchema.optional(),
    reasoning: ReasoningEffortSchema.optional(),
    capabilitySnapshot: z.array(ModelCapabilitySchema).max(32).default([]),
    modelCatalogRevision: IdentifierSchema.optional(),
    adapterRevision: IdentifierSchema.optional(),
    connectionReference: IdentifierSchema.optional(),
    credentialGeneration: IdentifierSchema.optional(),
    billingMode: z.enum(["managed", "subscription", "byok"]).optional(),
    cachePolicy: PromptCacheRetentionSchema.default("short"),
  })
  .strict();
export type ResolvedModelPin = z.infer<typeof ResolvedModelPinSchema>;

/** One consecutive provider/credential run in a portable thread. */
export const ProviderSegmentSchema = z
  .object({
    segmentId: IdentifierSchema,
    threadSequenceStart: z.number().int().positive(),
    threadSequenceEnd: z.number().int().positive().optional(),
    pin: ResolvedModelPinSchema,
    nativeSessionReference: IdentifierSchema.optional(),
    startedAt: z.string().datetime({ offset: true }),
    completedAt: z.string().datetime({ offset: true }).optional(),
    completionReason: z.enum([
      "active",
      "completed",
      "switched",
      "aborted",
      "failed",
      "compacted",
    ]).default("active"),
  })
  .strict();
export type ProviderSegment = z.infer<typeof ProviderSegmentSchema>;

// Keep provider and model selection names easy to discover.
export const ProviderSelectionSchema = ModelSelectionSchema;
export type ProviderSelection = ModelSelection;
export const ProviderModelSelectionSchema = ModelSelectionSchema;
export type ProviderModelSelection = ModelSelection;

// Describe a model response budget.
export const ModelBudgetSchema = z
  .object({
    maxInputTokens: NonNegativeIntegerSchema.optional(),
    maxOutputTokens: PositiveIntegerSchema.optional(),
    maxTotalTokens: PositiveIntegerSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.maxInputTokens !== undefined &&
      value.maxTotalTokens !== undefined &&
      value.maxInputTokens > value.maxTotalTokens
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["maxInputTokens"],
        message: "maxInputTokens must not exceed maxTotalTokens",
      });
    }
  });
export type ModelBudget = z.infer<typeof ModelBudgetSchema>;

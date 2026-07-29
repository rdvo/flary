import { z } from "zod";

import {
  IdentifierSchema,
  JsonObjectSchema,
  MetadataSchema,
  NonEmptyStringSchema,
  PositiveIntegerSchema,
} from "../contracts/common.js";
import {
  ReasoningEffortSchema,
  TextVerbositySchema,
} from "../contracts/provider.js";

export const ProviderMessageRoleSchema = z.enum([
  "system",
  "developer",
  "user",
  "assistant",
  "tool",
]);
export type ProviderMessageRole = z.infer<typeof ProviderMessageRoleSchema>;

export const ProviderTextPartSchema = z
  .object({
    type: z.literal("text"),
    text: z.string(),
  })
  .strict();

export const ProviderImagePartSchema = z
  .object({
    type: z.literal("image"),
    url: NonEmptyStringSchema,
    mimeType: NonEmptyStringSchema.optional(),
    detail: z.enum(["auto", "low", "high"]).optional(),
  })
  .strict();

export const ProviderContentPartSchema = z.discriminatedUnion("type", [
  ProviderTextPartSchema,
  ProviderImagePartSchema,
]);
export type ProviderContentPart = z.infer<typeof ProviderContentPartSchema>;

export const ProviderToolCallSchema = z
  .object({
    id: NonEmptyStringSchema,
    name: NonEmptyStringSchema,
    arguments: JsonObjectSchema,
    rawArguments: z.string().optional(),
  })
  .strict();
export type ProviderToolCall = z.infer<typeof ProviderToolCallSchema>;

export const ProviderMessageSchema = z
  .object({
    role: ProviderMessageRoleSchema,
    content: z.union([z.string(), z.array(ProviderContentPartSchema)]),
    name: NonEmptyStringSchema.optional(),
    toolCallId: NonEmptyStringSchema.optional(),
    toolCalls: z.array(ProviderToolCallSchema).max(128).optional(),
  })
  .strict();
export type ProviderMessage = z.infer<typeof ProviderMessageSchema>;

export const ProviderToolDefinitionSchema = z
  .object({
    name: NonEmptyStringSchema,
    description: NonEmptyStringSchema.optional(),
    inputSchema: JsonObjectSchema,
  })
  .strict();
export type ProviderToolDefinition = z.infer<
  typeof ProviderToolDefinitionSchema
>;

export const ProviderToolChoiceSchema = z.union([
  z.enum(["auto", "none", "required"]),
  z
    .object({
      name: NonEmptyStringSchema,
    })
    .strict(),
]);
export type ProviderToolChoice = z.infer<typeof ProviderToolChoiceSchema>;

export const ProviderResponseFormatSchema = z.union([
  z.literal("text"),
  z
    .object({
      type: z.literal("json_object"),
      schema: JsonObjectSchema.optional(),
    })
    .strict(),
]);
export type ProviderResponseFormat = z.infer<
  typeof ProviderResponseFormatSchema
>;

export const NormalizedModelRequestSchema = z
  .object({
    model: NonEmptyStringSchema,
    messages: z.array(ProviderMessageSchema).min(1).max(10000),
    tools: z.array(ProviderToolDefinitionSchema).max(128).optional(),
    toolChoice: ProviderToolChoiceSchema.optional(),
    maxOutputTokens: PositiveIntegerSchema.optional(),
    temperature: z.number().finite().min(0).max(2).optional(),
    topP: z.number().finite().min(0).max(1).optional(),
    stop: z.union([z.string(), z.array(z.string()).max(16)]).optional(),
    reasoningEffort: ReasoningEffortSchema.optional(),
    verbosity: TextVerbositySchema.optional(),
    responseFormat: ProviderResponseFormatSchema.optional(),
    parameters: JsonObjectSchema.optional(),
    metadata: MetadataSchema.optional(),
  })
  .strict();
export type NormalizedModelRequest = z.infer<
  typeof NormalizedModelRequestSchema
>;

export const ProviderUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    totalTokens: z.number().int().nonnegative().optional(),
    cachedInputTokens: z.number().int().nonnegative().optional(),
  })
  .strict();
export type ProviderUsage = z.infer<typeof ProviderUsageSchema>;

export const NormalizedFinishReasonSchema = z.enum([
  "stop",
  "length",
  "tool_call",
  "content_filter",
  "error",
  "unknown",
]);
export type NormalizedFinishReason = z.infer<
  typeof NormalizedFinishReasonSchema
>;

export const NormalizedModelResponseSchema = z
  .object({
    id: NonEmptyStringSchema,
    model: NonEmptyStringSchema,
    content: z.string(),
    reasoning: z.string().optional(),
    toolCalls: z.array(ProviderToolCallSchema).max(128),
    finishReason: NormalizedFinishReasonSchema,
    usage: ProviderUsageSchema.optional(),
    provider: IdentifierSchema.optional(),
    metadata: MetadataSchema.optional(),
  })
  .strict();
export type NormalizedModelResponse = z.infer<
  typeof NormalizedModelResponseSchema
>;

export const ProviderErrorSchema = z
  .object({
    code: NonEmptyStringSchema,
    message: NonEmptyStringSchema,
    status: z.number().int().positive().optional(),
    retryable: z.boolean().optional(),
    provider: IdentifierSchema.optional(),
    details: JsonObjectSchema.optional(),
  })
  .strict();
export type ProviderError = z.infer<typeof ProviderErrorSchema>;

export const ProviderStreamStartEventSchema = z
  .object({
    type: z.literal("start"),
    responseId: NonEmptyStringSchema,
    model: NonEmptyStringSchema,
  })
  .strict();

export const ProviderTextDeltaEventSchema = z
  .object({
    type: z.literal("text_delta"),
    responseId: NonEmptyStringSchema,
    delta: z.string(),
  })
  .strict();

export const ProviderReasoningDeltaEventSchema = z
  .object({
    type: z.literal("reasoning_delta"),
    responseId: NonEmptyStringSchema,
    delta: z.string(),
  })
  .strict();

export const ProviderToolCallDeltaEventSchema = z
  .object({
    type: z.literal("tool_call_delta"),
    responseId: NonEmptyStringSchema,
    index: z.number().int().nonnegative(),
    toolCallId: NonEmptyStringSchema.optional(),
    name: NonEmptyStringSchema.optional(),
    argumentsDelta: z.string().optional(),
  })
  .strict();

export const ProviderUsageEventSchema = z
  .object({
    type: z.literal("usage"),
    responseId: NonEmptyStringSchema,
    usage: ProviderUsageSchema,
  })
  .strict();

export const ProviderFinishEventSchema = z
  .object({
    type: z.literal("finish"),
    responseId: NonEmptyStringSchema,
    response: NormalizedModelResponseSchema,
  })
  .strict();

export const ProviderErrorEventSchema = z
  .object({
    type: z.literal("error"),
    responseId: NonEmptyStringSchema.optional(),
    error: ProviderErrorSchema,
  })
  .strict();

export const ProviderStreamEventSchema = z.discriminatedUnion("type", [
  ProviderStreamStartEventSchema,
  ProviderTextDeltaEventSchema,
  ProviderReasoningDeltaEventSchema,
  ProviderToolCallDeltaEventSchema,
  ProviderUsageEventSchema,
  ProviderFinishEventSchema,
  ProviderErrorEventSchema,
]);
export type ProviderStreamEvent = z.infer<typeof ProviderStreamEventSchema>;

// Short aliases keep adapter call sites readable while the longer names make
// the public contract explicit in generated documentation.
export const ModelRequestSchema = NormalizedModelRequestSchema;
export const ModelResponseSchema = NormalizedModelResponseSchema;
export const ModelStreamEventSchema = ProviderStreamEventSchema;
export type ModelRequest = NormalizedModelRequest;
export type ModelResponse = NormalizedModelResponse;
export type ModelStreamEvent = ProviderStreamEvent;

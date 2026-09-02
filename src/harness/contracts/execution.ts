import { z } from "zod";

import {
  IdentifierSchema,
  MetadataSchema,
  NonNegativeIntegerSchema,
  NonEmptyStringSchema,
  PositiveIntegerSchema,
  ReferenceSchema,
} from "./common.js";
import { ModelSelectionSchema } from "./provider.js";

// Select how a run returns its result.
export const ExecutionModeSchema = z.enum(["sync", "async", "stream"]);
export type ExecutionMode = z.infer<typeof ExecutionModeSchema>;

// Limit retries for one execution step.
export const RetryPolicySchema = z
  .object({
    maxAttempts: PositiveIntegerSchema,
    backoffMs: NonNegativeIntegerSchema.optional(),
    maxBackoffMs: NonNegativeIntegerSchema.optional(),
    jitter: z.number().min(0).max(1).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.backoffMs !== undefined &&
      value.maxBackoffMs !== undefined &&
      value.backoffMs > value.maxBackoffMs
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["backoffMs"],
        message: "backoffMs must not exceed maxBackoffMs",
      });
    }
  });
export type RetryPolicy = z.infer<typeof RetryPolicySchema>;

// Limit the tools that an execution can use.
export const ToolPolicySchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("all"),
    })
    .strict(),
  z
    .object({
      mode: z.literal("none"),
    })
    .strict(),
  z
    .object({
      mode: z.literal("allowlist"),
      toolIds: z.array(IdentifierSchema).min(1).max(256),
    })
    .strict(),
  z
    .object({
      mode: z.literal("denylist"),
      toolIds: z.array(IdentifierSchema).min(1).max(256),
    })
    .strict(),
]);
export type ToolPolicy = z.infer<typeof ToolPolicySchema>;

// Set hard limits for one execution.
export const ExecutionLimitsSchema = z
  .object({
    maxSteps: PositiveIntegerSchema.optional(),
    maxDurationMs: PositiveIntegerSchema.optional(),
    maxInputTokens: NonNegativeIntegerSchema.optional(),
    maxOutputTokens: PositiveIntegerSchema.optional(),
    maxTotalTokens: PositiveIntegerSchema.optional(),
    maxToolCalls: NonNegativeIntegerSchema.optional(),
    maxParallelToolCalls: PositiveIntegerSchema.optional(),
    maxRetries: NonNegativeIntegerSchema.optional(),
    maxCostUsd: z.number().finite().nonnegative().optional(),
    maxEventBytes: PositiveIntegerSchema.optional(),
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
    if (
      value.maxOutputTokens !== undefined &&
      value.maxTotalTokens !== undefined &&
      value.maxOutputTokens > value.maxTotalTokens
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["maxOutputTokens"],
        message: "maxOutputTokens must not exceed maxTotalTokens",
      });
    }
  });
export type ExecutionLimits = z.infer<typeof ExecutionLimitsSchema>;

// Reference an execution profile by ID.
export const ExecutionProfileReferenceSchema = ReferenceSchema;
export type ExecutionProfileReference = z.infer<typeof ExecutionProfileReferenceSchema>;

// Define the model and limits for one execution.
export const ExecutionProfileSchema = z
  .object({
    id: IdentifierSchema,
    name: NonEmptyStringSchema.optional(),
    description: NonEmptyStringSchema.optional(),
    model: ModelSelectionSchema,
    mode: ExecutionModeSchema.optional(),
    limits: ExecutionLimitsSchema.optional(),
    retry: RetryPolicySchema.optional(),
    toolPolicy: ToolPolicySchema.optional(),
    metadata: MetadataSchema.optional(),
  })
  .strict();
export type ExecutionProfile = z.infer<typeof ExecutionProfileSchema>;

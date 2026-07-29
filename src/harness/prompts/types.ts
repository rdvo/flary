import { z } from "zod";

export const PromptModelSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !/[\r\n]/.test(value), "Model cannot contain new lines");

export const PromptThinkingSchema = z.enum([
  "inherit",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);

export const PromptInputTypeSchema = z.enum([
  "any",
  "string",
  "number",
  "boolean",
  "object",
  "array",
  "json",
]);

export const PromptInputPathSchema = z
  .string()
  .min(1)
  .regex(
    /^[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*$/,
    "Input paths must contain names separated by dots",
  );

export const PromptInputSpecSchema = z.union([
  PromptInputTypeSchema,
  z
    .object({
      type: PromptInputTypeSchema.default("any"),
      required: z.boolean().default(true),
      description: z.string().optional(),
    })
    .strict(),
]);

export const PromptLimitsSchema = z
  .object({
    steps: z.number().int().positive().optional(),
    tools: z.number().int().nonnegative().optional(),
    parallelTools: z.number().int().positive().optional(),
    subagents: z.number().int().nonnegative().optional(),
    minutes: z.number().positive().optional(),
    tokens: z.number().int().positive().optional(),
    costUsd: z.number().finite().nonnegative().optional(),
  })
  .strict();

const PromptFrontmatterCanonicalSchema = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    model: z.union([z.literal("inherit"), PromptModelSchema]).default("inherit"),
    thinking: PromptThinkingSchema.default("inherit"),
    profile: z.string().min(1).optional(),
    tools: z.array(z.string().min(1)).default([]),
    input: z.record(PromptInputPathSchema, PromptInputSpecSchema).default({}),
    limits: PromptLimitsSchema.optional(),
  })
  .strict();

export const PromptFrontmatterSchema = z.preprocess((value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const input = value as Record<string, unknown>;
  const { inputs, ...rest } = input;
  return {
    ...rest,
    input: input.input ?? inputs,
  };
}, PromptFrontmatterCanonicalSchema);

export const PromptSourceSchema = z
  .object({
    path: z.string().min(1),
    content: z.string(),
  })
  .strict();

export const PromptCompileOptionsSchema = z
  .object({
    values: z.record(z.string(), z.unknown()).optional(),
    callerModel: PromptModelSchema.optional(),
    rootDir: z.string().min(1).optional(),
  })
  .strict();

export const PromptInputDefinitionSchema = z
  .object({
    path: PromptInputPathSchema,
    type: PromptInputTypeSchema,
    required: z.boolean(),
    description: z.string().optional(),
  })
  .strict();

export const PromptDiagnosticSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    severity: z.literal("error"),
    file: z.string().optional(),
    line: z.number().int().positive().optional(),
    column: z.number().int().positive().optional(),
  })
  .strict();

export const CompiledPromptSchema = z
  .object({
    slug: z.string().min(1),
    path: z.string().min(1),
    name: z.string().optional(),
    description: z.string().optional(),
    modelMode: z.enum(["inherit", "fixed"]),
    fixedModel: PromptModelSchema.optional(),
    resolvedModel: PromptModelSchema.optional(),
    thinking: PromptThinkingSchema,
    profile: z.string().optional(),
    tools: z.array(z.string()),
    limits: PromptLimitsSchema.optional(),
    template: z.string(),
    rendered: z.string(),
    inputs: z.record(z.string(), PromptInputDefinitionSchema),
    sourceHash: z.string().regex(/^[0-9a-f]{64}$/),
    renderedHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export const PromptManifestSchema = z
  .object({
    version: z.literal(1),
    prompts: z.record(z.string(), CompiledPromptSchema),
  })
  .strict();

export type PromptFrontmatter = z.infer<typeof PromptFrontmatterCanonicalSchema>;
export type PromptSource = z.infer<typeof PromptSourceSchema>;
export type PromptCompileOptions = z.input<typeof PromptCompileOptionsSchema>;
export type PromptInputDefinition = z.infer<typeof PromptInputDefinitionSchema>;
export type PromptDiagnostic = z.infer<typeof PromptDiagnosticSchema>;
export type CompiledPrompt = z.infer<typeof CompiledPromptSchema>;
export type PromptManifest = z.infer<typeof PromptManifestSchema>;

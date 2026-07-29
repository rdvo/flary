import { z } from "zod";

import {
  ErrorInfoSchema,
  IdentifierSchema,
  JsonValueSchema,
  MetadataSchema,
  NonEmptyStringSchema,
  PositiveIntegerSchema,
  TimestampSchema,
} from "./common";

// Select the isolated runtime for one operation.
export const CodeExecutionEngineSchema = z.enum([
  "dynamic-worker",
  "sandbox",
]);
export type CodeExecutionEngine = z.infer<typeof CodeExecutionEngineSchema>;

// Let the router select the smallest runtime that can complete the operation.
export const CodeExecutionEngineRequestSchema = z.union([
  z.literal("auto"),
  CodeExecutionEngineSchema,
]);
export type CodeExecutionEngineRequest = z.infer<
  typeof CodeExecutionEngineRequestSchema
>;

// State the minimum runtime needed by the operation.
export const CodeExecutionRuntimeSchema = z.enum([
  "auto",
  "isolate",
  "linux",
]);
export type CodeExecutionRuntime = z.infer<
  typeof CodeExecutionRuntimeSchema
>;

export const CodeExecutionLimitsSchema = z
  .object({
    timeoutMs: PositiveIntegerSchema.max(60 * 60 * 1000).default(60_000),
    maxOutputBytes: PositiveIntegerSchema.max(10 * 1024 * 1024).default(
      512 * 1024,
    ),
  })
  .strict();
export type CodeExecutionLimits = z.output<typeof CodeExecutionLimitsSchema>;

// This request is safe to store. Runtime callbacks and secret values belong
// to the execution context and never enter this value.
export const CodeExecutionRequestSchema = z
  .object({
    executionId: IdentifierSchema,
    runId: IdentifierSchema,
    engine: CodeExecutionEngineRequestSchema.default("auto"),
    runtime: CodeExecutionRuntimeSchema.default("auto"),
    operation: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/),
    input: JsonValueSchema,
    limits: CodeExecutionLimitsSchema.default({
      timeoutMs: 60_000,
      maxOutputBytes: 512 * 1024,
    }),
    metadata: MetadataSchema.optional(),
  })
  .strict();
export type CodeExecutionRequestInput = z.input<
  typeof CodeExecutionRequestSchema
>;
export type CodeExecutionRequest = z.output<
  typeof CodeExecutionRequestSchema
>;

export const CodeExecutionStatusSchema = z.enum(["completed", "failed"]);
export type CodeExecutionStatus = z.infer<
  typeof CodeExecutionStatusSchema
>;

export const CodeExecutionResultSchema = z
  .object({
    executionId: IdentifierSchema,
    runId: IdentifierSchema,
    engine: CodeExecutionEngineSchema,
    operation: NonEmptyStringSchema,
    status: CodeExecutionStatusSchema,
    output: JsonValueSchema.optional(),
    error: ErrorInfoSchema.optional(),
    logs: z.array(z.string()).max(10_000).default([]),
    startedAt: TimestampSchema,
    completedAt: TimestampSchema,
    durationMs: z.number().int().nonnegative(),
    metadata: MetadataSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === "failed" && !value.error) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["error"],
        message: "A failed execution needs an error",
      });
    }
  });
export type CodeExecutionResult = z.output<
  typeof CodeExecutionResultSchema
>;

export const CodeExecutionEventSchema = z
  .object({
    id: IdentifierSchema,
    executionId: IdentifierSchema,
    runId: IdentifierSchema,
    engine: CodeExecutionEngineSchema,
    operation: NonEmptyStringSchema,
    type: z.enum([
      "execution.started",
      "execution.output",
      "execution.completed",
      "execution.failed",
    ]),
    occurredAt: TimestampSchema,
    payload: JsonValueSchema.optional(),
    metadata: MetadataSchema.optional(),
  })
  .strict();
export type CodeExecutionEvent = z.output<
  typeof CodeExecutionEventSchema
>;

export const CodeModeInputSchema = z
  .object({
    code: z.string().trim().min(1).max(500_000),
  })
  .strict();
export type CodeModeInput = z.output<typeof CodeModeInputSchema>;

export const SandboxFileSchema = z
  .object({
    path: z
      .string()
      .trim()
      .min(1)
      .max(1_024)
      .refine(
        (value) =>
          !value.startsWith("/") &&
          !value.includes("\\") &&
          !value.split("/").includes(".."),
        "File paths must stay inside the workspace",
      ),
    content: z.string().max(5 * 1024 * 1024),
    encoding: z.enum(["utf8", "base64"]).default("utf8"),
  })
  .strict();
export type SandboxFile = z.output<typeof SandboxFileSchema>;

export const SandboxInputSchema = z
  .object({
    sandboxId: IdentifierSchema,
    command: z.string().trim().min(1).max(100_000),
    files: z.array(SandboxFileSchema).max(2_000).default([]),
    cwd: z
      .string()
      .trim()
      .min(1)
      .max(1_024)
      .default("/workspace")
      .refine(
        (value) =>
          value === "/workspace" || value.startsWith("/workspace/"),
        "cwd must stay inside /workspace",
      ),
    destroyAfter: z.boolean().default(false),
  })
  .strict();
export type SandboxInput = z.output<typeof SandboxInputSchema>;

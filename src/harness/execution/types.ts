import { z } from "zod";
import type { AgentMode } from "../contracts/modes.js";
import type { ToolExecutionJournal } from "./tool-journal.js";

export const nonEmptyStringSchema = z.string().trim().min(1);

export const executionOperationSchema = z.enum(["read", "write"]);

const nonNegativeIntegerSchema = z.number().int().nonnegative();
const positiveIntegerSchema = z.number().int().positive();

export const executionLimitsSchema = z
  .object({
    maxToolCalls: nonNegativeIntegerSchema.optional(),
    maxDurationMs: nonNegativeIntegerSchema.optional(),
    maxResultBytes: nonNegativeIntegerSchema.optional(),
    maxConcurrency: positiveIntegerSchema.optional(),
    readParallelism: positiveIntegerSchema.optional(),
    batchSize: positiveIntegerSchema.optional(),
  })
  .strict();

export type ExecutionLimitsInput = z.input<typeof executionLimitsSchema>;
export type ExecutionLimits = z.output<typeof executionLimitsSchema>;

export const approvalPolicySchema = z
  .object({
    requireForWrites: z.boolean().default(false),
    requiredTools: z.array(nonEmptyStringSchema).default([]),
  })
  .strict();

export type ApprovalPolicyInput = z.input<typeof approvalPolicySchema>;
export type ApprovalPolicy = z.output<typeof approvalPolicySchema>;

export const modelDescriptorInputSchema = z.union([
  nonEmptyStringSchema,
  z
    .object({
      id: nonEmptyStringSchema,
      aliases: z.array(nonEmptyStringSchema).optional(),
      capabilities: z.array(nonEmptyStringSchema).optional(),
      priority: z.number().int().optional(),
      order: z.number().int().nonnegative().optional(),
    })
    .strict(),
]);

export type ModelDescriptorInput = z.input<typeof modelDescriptorInputSchema>;

export const modelDescriptorSchema = z
  .object({
    id: nonEmptyStringSchema,
    aliases: z.array(nonEmptyStringSchema),
    capabilities: z.array(nonEmptyStringSchema),
    priority: z.number().int(),
    order: z.number().int().nonnegative().optional(),
  })
  .strict();

export type ModelDescriptor = z.output<typeof modelDescriptorSchema>;

export interface ResolvedModel extends ModelDescriptor {
  requested?: string;
  matchedBy: "id" | "alias" | "fallback" | "priority";
}

export const modelResolutionRequestSchema = z
  .object({
    requested: nonEmptyStringSchema.optional(),
    model: nonEmptyStringSchema.optional(),
    capabilities: z.array(nonEmptyStringSchema).default([]),
    exclude: z.array(nonEmptyStringSchema).default([]),
    fallback: nonEmptyStringSchema.optional(),
    candidates: z.array(modelDescriptorInputSchema).min(1),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.requested && value.model && value.requested !== value.model) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["model"],
        message: "requested and model must identify the same model",
      });
    }
  });

export type ModelResolutionRequest = z.output<
  typeof modelResolutionRequestSchema
>;

export const toolTaskInputSchema = z
  .object({
    id: nonEmptyStringSchema,
    name: nonEmptyStringSchema,
    input: z.unknown().optional(),
    operation: executionOperationSchema.optional(),
    kind: executionOperationSchema.optional(),
    type: executionOperationSchema.optional(),
    resourceKey: nonEmptyStringSchema.optional(),
    dependsOn: z.array(nonEmptyStringSchema).default([]),
    idempotencyKey: nonEmptyStringSchema.optional(),
    requiresApproval: z.boolean().optional(),
    approvalKey: nonEmptyStringSchema.optional(),
    concurrencyKey: nonEmptyStringSchema.optional(),
    execute: z.unknown().optional(),
    handler: z.unknown().optional(),
  })
  .passthrough()
  .superRefine((value, context) => {
    const operations = [value.operation, value.kind, value.type].filter(
      (operation): operation is "read" | "write" => operation !== undefined
    );

    if (new Set(operations).size > 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["operation"],
        message: "operation, kind, and type must agree when more than one is set",
      });
    }

    if (value.dependsOn.includes(value.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dependsOn"],
        message: "a task cannot depend on itself",
      });
    }
  });

export type ToolTaskInput = z.input<typeof toolTaskInputSchema>;

export type ExecutionOperation = z.infer<typeof executionOperationSchema>;

export interface ExecutionSignal {
  readonly aborted: boolean;
  readonly reason?: unknown;
}

export interface ToolTask {
  readonly id: string;
  readonly name: string;
  readonly input?: unknown;
  readonly operation: ExecutionOperation;
  readonly resourceKey?: string;
  readonly dependsOn: readonly string[];
  readonly idempotencyKey?: string;
  readonly requiresApproval: boolean;
  readonly approvalKey?: string;
  readonly concurrencyKey?: string;
  readonly execute?: ToolHandler;
  readonly handler?: ToolHandler;
  readonly [key: string]: unknown;
}

export interface ToolExecutionContext {
  readonly task: ToolTask;
  readonly signal: ExecutionSignal;
  readonly attempt: number;
}

export type ToolHandler = (
  input: unknown,
  context: ToolExecutionContext
) => unknown | Promise<unknown>;

export type ResourceKeyResolver =
  | string
  | ((task: ToolTask) => string | undefined);

export interface ToolDefinition {
  readonly execute: ToolHandler;
  readonly operation?: ExecutionOperation;
  readonly resourceKey?: ResourceKeyResolver;
  readonly requiresApproval?: boolean;
  readonly concurrencyKey?: string;
}

export type ToolRegistryEntry = ToolHandler | ToolDefinition;
export type ToolRegistry = Readonly<Record<string, ToolRegistryEntry>>;

export const toolResultStatusSchema = z.enum([
  "fulfilled",
  "rejected",
  "blocked",
  "denied",
  "skipped",
  "cancelled",
  "outcome_unknown",
]);

export type ToolResultStatus = z.infer<typeof toolResultStatusSchema>;

export const executionErrorSchema = z
  .object({
    name: nonEmptyStringSchema,
    message: z.string(),
    code: nonEmptyStringSchema.optional(),
  })
  .strict();

export type ExecutionError = z.infer<typeof executionErrorSchema>;

export const toolExecutionResultSchema = z
  .object({
    id: nonEmptyStringSchema,
    name: nonEmptyStringSchema,
    operation: executionOperationSchema,
    resourceKey: nonEmptyStringSchema.optional(),
    dependsOn: z.array(nonEmptyStringSchema),
    status: toolResultStatusSchema,
    value: z.unknown().optional(),
    error: executionErrorSchema.optional(),
    reason: z.string().optional(),
    blockedBy: z.array(nonEmptyStringSchema).optional(),
    idempotencyKey: nonEmptyStringSchema.optional(),
    deduplicated: z.boolean().optional(),
  })
  .strict();

export type ToolExecutionResult = z.output<typeof toolExecutionResultSchema>;

export const resultBatchOptionsSchema = z
  .object({
    batchSize: positiveIntegerSchema,
  })
  .strict();

export interface ApprovalRequest {
  readonly key: string;
  readonly task: ToolTask;
}

export const approvalDecisionSchema = z.union([
  z.boolean(),
  z
    .object({
      approved: z.boolean(),
      reason: z.string().optional(),
    })
    .strict(),
]);

export type ApprovalDecisionInput = z.input<typeof approvalDecisionSchema>;
export type ApprovalDecision = z.output<typeof approvalDecisionSchema>;

export type ApprovalHandler = (
  request: ApprovalRequest
) => ApprovalDecisionInput | Promise<ApprovalDecisionInput>;

export interface ApprovalGateLike {
  request(task: ToolTask): ApprovalDecision | Promise<ApprovalDecision>;
}

export const executionProfileInputSchema = z
  .object({
    name: nonEmptyStringSchema,
    model: nonEmptyStringSchema.optional(),
    limits: executionLimitsSchema.optional(),
    maxToolCalls: nonNegativeIntegerSchema.optional(),
    maxDurationMs: nonNegativeIntegerSchema.optional(),
    maxResultBytes: nonNegativeIntegerSchema.optional(),
    maxConcurrency: positiveIntegerSchema.optional(),
    readParallelism: positiveIntegerSchema.optional(),
    batchSize: positiveIntegerSchema.optional(),
    approval: approvalPolicySchema.optional(),
  })
  .strict();

export type ExecutionProfileInput = z.input<
  typeof executionProfileInputSchema
>;

export interface ExecutionProfile {
  readonly name: string;
  readonly model?: string;
  readonly limits: ExecutionLimits;
  readonly approval: ApprovalPolicy;
}

export interface SchedulerApprovalOptions {
  readonly policy?: ApprovalPolicyInput;
  readonly handler?: ApprovalHandler;
}

export interface SchedulerOptions {
  readonly mode?: AgentMode;
  readonly handlers?: ToolRegistry;
  readonly tools?: ToolRegistry;
  readonly profile?: string | ExecutionProfileInput | ExecutionProfile;
  readonly profiles?: Readonly<Record<string, ExecutionProfileInput | ExecutionProfile>>;
  readonly limits?: ExecutionLimitsInput;
  readonly maxConcurrency?: number;
  readonly readParallelism?: number;
  readonly batchSize?: number;
  readonly concurrencyCaps?: Readonly<Record<string, number>>;
  readonly approvalGate?: ApprovalGateLike | ApprovalHandler;
  readonly approval?: SchedulerApprovalOptions;
  readonly idempotencyStore?: unknown;
  readonly enableAutomaticIdempotency?: boolean;
  readonly requireWriteIdempotency?: boolean;
  readonly runId?: string;
  readonly toolJournal?: ToolExecutionJournal;
  readonly isUnknownToolOutcome?: (error: unknown, task: ToolTask) => boolean;
  readonly onBatch?: (batch: readonly ToolExecutionResult[]) => void | Promise<void>;
  readonly model?: string;
  readonly models?: readonly ModelDescriptorInput[];
  readonly signal?: ExecutionSignal;
}

export interface ExecutionReport {
  readonly results: readonly ToolExecutionResult[];
  readonly batches: readonly (readonly ToolExecutionResult[])[];
  readonly profile: ExecutionProfile;
  readonly limits: ExecutionLimits;
  readonly resolvedModel?: ResolvedModel;
}

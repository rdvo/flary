import { z, type ZodType } from "zod";

export const EvaluationCaseSchema = z
  .object({
    id: z.string().min(1).max(256),
    input: z.unknown(),
    expected: z.unknown().optional(),
    metadata: z.record(z.string().max(128), z.unknown()).optional(),
  })
  .strict();
export type EvaluationCase = z.infer<typeof EvaluationCaseSchema>;

export const EvaluationDatasetSchema = z
  .object({
    id: z.string().min(1).max(256),
    revision: z.string().min(1).max(256),
    cases: z.array(EvaluationCaseSchema).min(1).max(100_000),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.cases.map((item) => item.id)).size !== value.cases.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cases"],
        message: "Evaluation case IDs must be unique",
      });
    }
  });
export type EvaluationDataset = z.infer<typeof EvaluationDatasetSchema>;

export const EvaluationGraderSchema = z
  .object({
    id: z.string().min(1).max(256),
    kind: z.enum(["exact", "contains", "schema", "custom", "llm_judge"]),
    weight: z.number().finite().positive().default(1),
  })
  .strict();
export type EvaluationGrader = z.infer<typeof EvaluationGraderSchema>;

export const EvaluationScoreSchema = z
  .object({
    graderId: z.string().min(1),
    score: z.number().finite().min(0).max(1),
    passed: z.boolean(),
    reason: z.string().max(4_096).optional(),
  })
  .strict();
export type EvaluationScore = z.infer<typeof EvaluationScoreSchema>;

export const EvaluationCaseResultSchema = z
  .object({
    caseId: z.string().min(1),
    output: z.unknown().optional(),
    error: z.string().optional(),
    scores: z.array(EvaluationScoreSchema),
    score: z.number().finite().min(0).max(1),
    latencyMs: z.number().finite().nonnegative(),
    costUsd: z.number().finite().nonnegative().optional(),
  })
  .strict();
export type EvaluationCaseResult = z.infer<typeof EvaluationCaseResultSchema>;

export const EvaluationComparisonCaseSchema = z
  .object({
    caseId: z.string().min(1),
    candidateScore: z.number().finite().min(0).max(1),
    controlScore: z.number().finite().min(0).max(1),
    scoreDelta: z.number().finite().min(-1).max(1),
    candidatePassed: z.boolean(),
    controlPassed: z.boolean(),
    winner: z.enum(["candidate", "control", "tie"]),
  })
  .strict();
export type EvaluationComparisonCase = z.infer<typeof EvaluationComparisonCaseSchema>;

export const EvaluationComparisonSchema = z
  .object({
    controlAggregateScore: z.number().finite().min(0).max(1),
    scoreDelta: z.number().finite().min(-1).max(1),
    candidateBetter: z.boolean(),
    cases: z.array(EvaluationComparisonCaseSchema),
  })
  .strict();
export type EvaluationComparison = z.infer<typeof EvaluationComparisonSchema>;

export const EvaluationReportSchema = z
  .object({
    evaluationId: z.string().min(1),
    datasetId: z.string().min(1),
    datasetRevision: z.string().min(1),
    candidateRevision: z.string().min(1),
    controlRevision: z.string().optional(),
    results: z.array(EvaluationCaseResultSchema),
    controlResults: z.array(EvaluationCaseResultSchema).optional(),
    comparison: EvaluationComparisonSchema.optional(),
    aggregateScore: z.number().finite().min(0).max(1),
    passed: z.boolean(),
    usage: z
      .object({
        costUsd: z.number().finite().nonnegative().optional(),
        latencyMs: z.number().finite().nonnegative(),
      })
      .strict(),
    completedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type EvaluationReport = z.infer<typeof EvaluationReportSchema>;

export interface EvaluationExecutionContext {
  readonly evaluationId: string;
  readonly caseId: string;
  readonly revision: string;
  readonly signal?: AbortSignal;
}

export interface EvaluationExecutor {
  run(input: unknown, context: EvaluationExecutionContext): Promise<unknown>;
}

/**
 * An executor may return this envelope when it can report provider cost. Raw
 * values remain valid executor results for backwards compatibility.
 */
export interface EvaluationExecutionResult {
  readonly output: unknown;
  readonly costUsd?: number;
  readonly usage?: {
    readonly costUsd?: number;
    readonly cost?: { readonly total?: number };
  };
}

export interface EvaluationJudgeContext {
  readonly input: unknown;
  readonly expected: unknown;
  readonly output: unknown;
  readonly error?: string;
  readonly caseId: string;
}

export interface EvaluationGraderDefinition {
  readonly id: string;
  readonly kind: EvaluationGrader["kind"];
  readonly weight?: number;
  readonly schema?: ZodType;
  readonly value?: unknown;
  readonly judge?: (context: EvaluationJudgeContext) => Promise<{ score: number; reason?: string }>;
}

export interface EvaluationRunOptions {
  readonly evaluationId?: string;
  readonly candidateRevision: string;
  readonly control?: EvaluationExecutor;
  readonly controlRevision?: string;
  readonly graders: readonly EvaluationGraderDefinition[];
  readonly passThreshold?: number;
  readonly signal?: AbortSignal;
}

export class EvaluationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "EvaluationError";
    this.code = code;
  }
}

/** Validate and freeze an evaluation dataset revision. */
export function defineEvaluationDataset(input: {
  readonly id: string;
  readonly revision?: string;
  readonly cases: readonly EvaluationCase[];
}): EvaluationDataset {
  return EvaluationDatasetSchema.parse({
    id: input.id,
    revision: input.revision ?? revisionOf(input),
    cases: input.cases,
  });
}

/**
 * Run deterministic and optional judge graders against one candidate. The
 * control executor is evaluated with the same cases for regression comparison.
 */
export async function runEvaluation(
  datasetInput: EvaluationDataset,
  candidate: EvaluationExecutor,
  options: EvaluationRunOptions,
): Promise<EvaluationReport> {
  const dataset = EvaluationDatasetSchema.parse(datasetInput);
  if (options.graders.length === 0) {
    throw new EvaluationError("graders_missing", "An evaluation needs at least one grader");
  }
  const evaluationId = options.evaluationId ?? `eval_${crypto.randomUUID().replaceAll("-", "")}`;
  const started = Date.now();
  const results: EvaluationCaseResult[] = [];
  const controlResults: EvaluationCaseResult[] = [];
  const comparisonCases: EvaluationComparisonCase[] = [];
  let totalCost = 0;
  let hasCost = false;
  for (const item of dataset.cases) {
    if (options.signal?.aborted)
      throw options.signal.reason ?? new EvaluationError("aborted", "Evaluation was aborted");
    const candidateCase = await executeCase(candidate, item, {
      evaluationId,
      revision: options.candidateRevision,
      graders: options.graders,
      signal: options.signal,
    });
    results.push(candidateCase.result);
    if (candidateCase.costUsd !== undefined) {
      totalCost += candidateCase.costUsd;
      hasCost = true;
    }
    if (options.control) {
      const controlCase = await executeCase(options.control, item, {
        evaluationId,
        revision: options.controlRevision ?? "control",
        graders: options.graders,
        signal: options.signal,
      });
      controlResults.push(controlCase.result);
      if (controlCase.costUsd !== undefined) {
        totalCost += controlCase.costUsd;
        hasCost = true;
      }
      const scoreDelta = candidateCase.result.score - controlCase.result.score;
      comparisonCases.push(
        EvaluationComparisonCaseSchema.parse({
          caseId: item.id,
          candidateScore: candidateCase.result.score,
          controlScore: controlCase.result.score,
          scoreDelta,
          candidatePassed: candidateCase.result.score >= 0.5,
          controlPassed: controlCase.result.score >= 0.5,
          winner: scoreDelta === 0 ? "tie" : scoreDelta > 0 ? "candidate" : "control",
        }),
      );
    }
  }
  const aggregateScore = results.reduce((sum, result) => sum + result.score, 0) / results.length;
  const controlAggregateScore =
    controlResults.length > 0
      ? controlResults.reduce((sum, result) => sum + result.score, 0) / controlResults.length
      : undefined;
  const report = EvaluationReportSchema.parse({
    evaluationId,
    datasetId: dataset.id,
    datasetRevision: dataset.revision,
    candidateRevision: options.candidateRevision,
    ...(options.control
      ? { controlRevision: options.controlRevision ?? "control" }
      : options.controlRevision
        ? { controlRevision: options.controlRevision }
        : {}),
    results,
    ...(options.control ? { controlResults } : {}),
    ...(options.control && controlAggregateScore !== undefined
      ? {
          comparison: EvaluationComparisonSchema.parse({
            controlAggregateScore,
            scoreDelta: aggregateScore - controlAggregateScore,
            candidateBetter: aggregateScore > controlAggregateScore,
            cases: comparisonCases,
          }),
        }
      : {}),
    aggregateScore,
    passed: aggregateScore >= (options.passThreshold ?? 0.8),
    usage: {
      latencyMs: Date.now() - started,
      ...(hasCost ? { costUsd: totalCost } : {}),
    },
    completedAt: new Date().toISOString(),
  });
  return report;
}

async function executeCase(
  executor: EvaluationExecutor,
  item: EvaluationCase,
  options: {
    readonly evaluationId: string;
    readonly revision: string;
    readonly graders: readonly EvaluationGraderDefinition[];
    readonly signal?: AbortSignal;
  },
): Promise<{ readonly result: EvaluationCaseResult; readonly costUsd?: number }> {
  const caseStarted = Date.now();
  let raw: unknown;
  let output: unknown;
  let error: string | undefined;
  let costUsd: number | undefined;
  try {
    raw = await executor.run(item.input, {
      evaluationId: options.evaluationId,
      caseId: item.id,
      revision: options.revision,
      signal: options.signal,
    });
    const normalized = normalizeExecutionResult(raw);
    output = normalized.output;
    costUsd = normalized.costUsd;
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }
  const scores = await Promise.all(
    options.graders.map((grader) =>
      grade(grader, {
        input: item.input,
        expected: item.expected,
        output,
        ...(error ? { error } : {}),
        caseId: item.id,
      }),
    ),
  );
  const totalWeight = options.graders.reduce((sum, grader) => sum + (grader.weight ?? 1), 0);
  const score =
    scores.reduce(
      (sum, value, index) => sum + value.score * (options.graders[index]!.weight ?? 1),
      0,
    ) / totalWeight;
  return {
    result: EvaluationCaseResultSchema.parse({
      caseId: item.id,
      ...(output !== undefined ? { output } : {}),
      ...(error ? { error } : {}),
      scores,
      score,
      latencyMs: Date.now() - caseStarted,
      ...(costUsd !== undefined ? { costUsd } : {}),
    }),
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
}

function normalizeExecutionResult(value: unknown): {
  readonly output: unknown;
  readonly costUsd?: number;
} {
  if (!isRecord(value)) return { output: value };
  const usage = isRecord(value.usage) ? value.usage : undefined;
  const nestedCost = usage && isRecord(usage.cost) ? usage.cost.total : undefined;
  const costUsd = firstNonNegativeNumber(value.costUsd, usage?.costUsd, nestedCost);
  if (
    Object.prototype.hasOwnProperty.call(value, "output") &&
    (costUsd !== undefined || Object.prototype.hasOwnProperty.call(value, "usage"))
  ) {
    return { output: value.output, ...(costUsd !== undefined ? { costUsd } : {}) };
  }
  if (
    Object.prototype.hasOwnProperty.call(value, "value") &&
    (costUsd !== undefined || Object.prototype.hasOwnProperty.call(value, "usage"))
  ) {
    return { output: value.value, ...(costUsd !== undefined ? { costUsd } : {}) };
  }
  return { output: value, ...(costUsd !== undefined ? { costUsd } : {}) };
}

function firstNonNegativeNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function grade(
  grader: EvaluationGraderDefinition,
  context: EvaluationJudgeContext,
): Promise<EvaluationScore> {
  const weight = grader.weight ?? 1;
  if (!Number.isFinite(weight) || weight <= 0)
    throw new EvaluationError("grader_invalid", `Grader '${grader.id}' has an invalid weight`);
  let score = 0;
  let reason: string | undefined;
  if (context.error) {
    score = 0;
    reason = "candidate_error";
  } else if (grader.kind === "exact") {
    score = stableJson(context.output) === stableJson(grader.value ?? context.expected) ? 1 : 0;
    reason = score === 1 ? "exact_match" : "exact_mismatch";
  } else if (grader.kind === "contains") {
    const source = typeof context.output === "string" ? context.output : stableJson(context.output);
    const expected = String(grader.value ?? context.expected ?? "");
    score = expected.length > 0 && source.includes(expected) ? 1 : 0;
    reason = score === 1 ? "contains" : "missing_content";
  } else if (grader.kind === "schema") {
    if (!grader.schema)
      throw new EvaluationError(
        "grader_invalid",
        `Schema grader '${grader.id}' needs a Zod schema`,
      );
    const result = grader.schema.safeParse(context.output);
    score = result.success ? 1 : 0;
    reason = result.success ? "schema_valid" : "schema_invalid";
  } else if (grader.kind === "custom") {
    if (!grader.judge)
      throw new EvaluationError("grader_invalid", `Custom grader '${grader.id}' needs a judge`);
    const result = await grader.judge(context);
    score = clamp(result.score);
    reason = result.reason;
  } else {
    if (!grader.judge)
      throw new EvaluationError("grader_invalid", `LLM judge '${grader.id}' needs a judge`);
    const result = await grader.judge(context);
    score = clamp(result.score);
    reason = result.reason;
  }
  return EvaluationScoreSchema.parse({
    graderId: grader.id,
    score,
    passed: score >= 0.5,
    ...(reason ? { reason } : {}),
  });
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function stableJson(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
}

function revisionOf(input: unknown): string {
  const value = stableJson(input);
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193) >>> 0;
  }
  return `dataset_${hash.toString(16).padStart(8, "0")}`;
}

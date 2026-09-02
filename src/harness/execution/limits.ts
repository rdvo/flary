import { z } from "zod";
import { executionLimitsSchema, type ExecutionLimits, type ExecutionLimitsInput } from "./types.js";

const LIMIT_NAMES: readonly (keyof ExecutionLimits)[] = [
  "maxToolCalls",
  "maxDurationMs",
  "maxResultBytes",
  "maxConcurrency",
  "readParallelism",
  "batchSize",
];

type LimitSource = ExecutionLimitsInput | undefined;

function flattenLimitSources(
  sources: readonly (LimitSource | readonly LimitSource[])[],
): readonly LimitSource[] {
  if (sources.length === 1 && Array.isArray(sources[0])) {
    return sources[0];
  }

  return sources as readonly LimitSource[];
}

/**
 * Return the most restrictive value for every limit.
 *
 * An omitted value does not reduce a limit. This allows a profile to set a
 * default and a caller to reduce only one field.
 */
export function reduceLimits(
  ...sources: (LimitSource | readonly LimitSource[])[]
): ExecutionLimits {
  const parsedSources = flattenLimitSources(sources).map((source) =>
    executionLimitsSchema.parse(source ?? {}),
  );
  const reduced: Partial<ExecutionLimits> = {};

  for (const name of LIMIT_NAMES) {
    const values = parsedSources
      .map((source) => source[name])
      .filter((value): value is number => value !== undefined);

    if (values.length > 0) {
      reduced[name] = Math.min(...values) as never;
    }
  }

  return executionLimitsSchema.parse(reduced);
}

/** Alias with the full name for callers that prefer explicit APIs. */
export const reduceExecutionLimits = reduceLimits;

/** Reduce one limit without constructing an object at the call site. */
export function reduceLimit(
  name: keyof ExecutionLimits,
  ...values: (number | undefined)[]
): number | undefined {
  const parsedName = z
    .enum([
      "maxToolCalls",
      "maxDurationMs",
      "maxResultBytes",
      "maxConcurrency",
      "readParallelism",
      "batchSize",
    ])
    .parse(name);
  const defined = values.filter((value): value is number => value !== undefined);

  if (defined.length === 0) {
    return undefined;
  }

  const minimum = Math.min(...defined);
  const fieldSchema = executionLimitsSchema.shape[parsedName];
  fieldSchema.parse(minimum);
  return minimum;
}

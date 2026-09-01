import { z } from "zod";

import {
  PromptAssignmentSchema,
  PromptOverrideSchema,
  PromptRolloutSchema,
  PromptVariantListSchema,
  ROLLOUT_BASIS_POINTS_TOTAL,
  type AssignmentScope,
  type PromptAssignment,
  type PromptOverride,
  type PromptRollout,
  type PromptVariant,
  type PromptVariantList,
} from "../contracts/prompt-revisions.js";
import {
  PromptSelectionTelemetryEventSchema,
  type PromptSelectionTelemetryEvent,
  type TraceContext,
} from "../contracts/telemetry.js";

/** A rollout bucket is one of the 10,000 integer basis-point positions. */
export const RolloutBucketSchema = z
  .number()
  .int()
  .min(0)
  .max(ROLLOUT_BASIS_POINTS_TOTAL - 1);
export type RolloutBucket = z.infer<typeof RolloutBucketSchema>;

const StableHashSchema = z
  .string()
  .regex(/^[0-9a-f]{16}$/, "Expected a 64-bit lowercase hexadecimal hash");

/**
 * Serialize JSON-like values with sorted object keys.
 *
 * Arrays keep their order. This prevents object insertion order from changing
 * an assignment while keeping the input format independent of a runtime.
 */
export function stableStringify(value: unknown): string {
  return stableSerialize(value, new Set<object>());
}

function stableSerialize(value: unknown, seen: Set<object>): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "undefined":
      return "undefined";
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (Number.isNaN(value)) return "number:NaN";
      if (value === Infinity) return "number:Infinity";
      if (value === -Infinity) return "number:-Infinity";
      if (Object.is(value, -0)) return "number:-0";
      return `number:${String(value)}`;
    case "bigint":
      return `bigint:${String(value)}`;
    case "symbol":
      throw new TypeError("Cannot hash a symbol");
    case "function":
      throw new TypeError("Cannot hash a function");
  }

  if (seen.has(value)) {
    throw new TypeError("Cannot hash a cyclic value");
  }
  seen.add(value);

  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => stableSerialize(item, seen)).join(",")}]`;
    }

    if (value instanceof Date) {
      return `date:${value.toISOString()}`;
    }

    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${stableSerialize(record[key], seen)}`
      )
      .join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

const FNV64_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV64_PRIME = 0x100000001b3n;
const UINT64_MASK = 0xffffffffffffffffn;

/**
 * Return a stable 64-bit FNV-1a hash encoded as lowercase hexadecimal.
 *
 * This is a synchronous, platform-neutral hash for assignment. It is not a
 * security boundary and must not replace a cryptographic content hash.
 */
export function stableHash(value: unknown): string {
  const bytes = new TextEncoder().encode(stableStringify(value));
  let hash = FNV64_OFFSET_BASIS;

  for (const byte of bytes) {
    hash = (hash ^ BigInt(byte)) * FNV64_PRIME;
    hash &= UINT64_MASK;
  }

  return hash.toString(16).padStart(16, "0");
}

/** Convert a stable hash to a uniform rollout bucket. */
export function bucketFromStableHash(hashInput: string): RolloutBucket {
  const hash = StableHashSchema.parse(hashInput);
  return Number(BigInt(`0x${hash}`) % BigInt(ROLLOUT_BASIS_POINTS_TOTAL));
}

/** Hash an assignment key and map it to the rollout basis-point range. */
export function hashToBasisPoints(value: unknown): RolloutBucket {
  return bucketFromStableHash(stableHash(value));
}

export const stableHashToBasisPoints = hashToBasisPoints;

/** Validate and select the variant at one exact rollout boundary. */
export function selectVariantAtBucket(
  variantsInput: z.input<typeof PromptVariantListSchema>,
  bucketInput: number
): PromptVariant {
  const variants = PromptVariantListSchema.parse(variantsInput).filter(
    (variant) => variant.enabled
  );
  const bucket = RolloutBucketSchema.parse(bucketInput);
  let upperBound = 0;

  for (const variant of variants) {
    upperBound += variant.allocationBasisPoints;
    if (bucket < upperBound) {
      return variant;
    }
  }

  // PromptVariantListSchema guarantees that the upper bound is 10,000 and
  // RolloutBucketSchema guarantees that the bucket is below 10,000.
  throw new Error("No prompt variant owns the rollout bucket");
}

export const selectVariantByBucket = selectVariantAtBucket;

function parseAssignment(
  rollout: PromptRollout,
  assignmentInput: string | z.input<typeof PromptAssignmentSchema>
): PromptAssignment {
  if (typeof assignmentInput === "string") {
    return PromptAssignmentSchema.parse({
      scope: rollout.scope,
      subject: assignmentInput,
    });
  }

  return PromptAssignmentSchema.parse(assignmentInput);
}

function assignmentKey(
  rollout: PromptRollout,
  assignment: PromptAssignment
): Record<string, unknown> {
  if (assignment.scope !== rollout.scope) {
    throw new Error(
      `Assignment scope '${assignment.scope}' does not match rollout scope '${rollout.scope}'`
    );
  }

  return {
    promptId: rollout.promptId,
    rolloutId: rollout.rolloutId,
    scope: assignment.scope,
    subject: assignment.scope === "global" ? "" : assignment.subject,
  };
}

function variantForOverride(
  rollout: PromptRollout,
  assignment: PromptAssignment,
  overrideInput: z.input<typeof PromptOverrideSchema>
): PromptVariant {
  const override = PromptOverrideSchema.parse(overrideInput);

  if (override.scope !== undefined && override.scope !== assignment.scope) {
    throw new Error(
      `Override scope '${override.scope}' does not match assignment scope '${assignment.scope}'`
    );
  }

  const variant = rollout.variants.find(({ id }) => id === override.variantId);
  if (variant === undefined) {
    throw new Error(
      `Override variant '${override.variantId}' is not part of rollout '${rollout.rolloutId}'`
    );
  }
  return variant;
}

/** Select one prompt variant with a stable assignment or an authorized override. */
export function selectPromptVariant(
  rolloutInput: z.input<typeof PromptRolloutSchema>,
  assignmentInput: string | z.input<typeof PromptAssignmentSchema>,
  overrideInput?: z.input<typeof PromptOverrideSchema>
): PromptVariant {
  const rollout = PromptRolloutSchema.parse(rolloutInput);
  const assignment = parseAssignment(rollout, assignmentInput);

  if (overrideInput !== undefined) {
    return variantForOverride(rollout, assignment, overrideInput);
  }

  return selectVariantAtBucket(
    rollout.variants,
    hashToBasisPoints(assignmentKey(rollout, assignment))
  );
}

export const selectVariant = selectPromptVariant;

/**
 * Select a variant and create a safe telemetry event for the decision.
 * The raw assignment subject is never put into the event.
 */
export async function selectPromptVariantWithTelemetry(
  rolloutInput: z.input<typeof PromptRolloutSchema>,
  assignmentInput: string | z.input<typeof PromptAssignmentSchema>,
  options: {
    traceContext: TraceContext;
    runId?: string;
    now?: string;
  },
  overrideInput?: z.input<typeof PromptOverrideSchema>
): Promise<{ variant: PromptVariant; event: PromptSelectionTelemetryEvent }> {
  const rollout = PromptRolloutSchema.parse(rolloutInput);
  const assignment = parseAssignment(rollout, assignmentInput);
  const variant = selectPromptVariant(rollout, assignment, overrideInput);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      stableStringify(assignmentKey(rollout, assignment))
    )
  );
  const assignmentKeyHash = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const event = PromptSelectionTelemetryEventSchema.parse({
    id: `prompt_selection_${crypto.randomUUID()}`,
    occurredAt: options.now ?? new Date().toISOString(),
    runId: options.runId,
    traceContext: options.traceContext,
    spanKind: "internal",
    type: "prompt.selection",
    payload: {
      action: "selected",
      prompt: {
        redacted: true,
        kind: "prompt",
        id: rollout.promptId ?? rollout.rolloutId,
      },
      selected: {
        redacted: true,
        kind: "prompt",
        id: variant.revisionId,
      },
      candidates: rollout.variants.map((candidate) => ({
        redacted: true,
        kind: "prompt" as const,
        id: candidate.revisionId,
      })),
      assignmentKeyHash,
    },
  });
  return { variant, event };
}

/** Return the assignment scope that a rollout uses. */
export function rolloutAssignmentScope(
  rolloutInput: z.input<typeof PromptRolloutSchema>
): AssignmentScope {
  return PromptRolloutSchema.parse(rolloutInput).scope;
}

export type {
  AssignmentScope,
  PromptAssignment,
  PromptOverride,
  PromptRollout,
  PromptVariant,
  PromptVariantList,
};

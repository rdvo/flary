import { z } from "zod";

import {
  IdentifierSchema,
  PositiveIntegerSchema,
  NonEmptyStringSchema,
  TimestampSchema,
} from "./common.js";

/** The fixed denominator used for all rollout allocations. */
export const ROLLOUT_BASIS_POINTS_TOTAL = 10_000 as const;

/** A single non-negative allocation in basis points. */
export const RolloutBasisPointSchema = z
  .number()
  .int()
  .min(0)
  .max(ROLLOUT_BASIS_POINTS_TOTAL);
export type RolloutBasisPoint = z.infer<typeof RolloutBasisPointSchema>;

/** Keep the plural name available for callers that store one allocation. */
export const RolloutBasisPointsSchema = RolloutBasisPointSchema;
export type RolloutBasisPoints = RolloutBasisPoint;

/** The only valid total for a complete rollout allocation. */
export const RolloutBasisPointTotalSchema = z.literal(
  ROLLOUT_BASIS_POINTS_TOTAL
);

/** A lowercase SHA-256 digest for an immutable prompt source snapshot. */
export const PromptContentHashSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "Expected a lowercase SHA-256 content hash");
export type PromptContentHash = z.infer<typeof PromptContentHashSchema>;

export const PromptSourceHashSchema = PromptContentHashSchema;
export type PromptSourceHash = PromptContentHash;

/**
 * Store one prompt revision as a content-addressed, append-only record.
 *
 * The schema is readonly so parsed records are frozen at the top level. A
 * revision has creation data only. It has no update or deletion state.
 */
export const PromptRevisionSchema = z
  .object({
    id: IdentifierSchema,
    promptId: IdentifierSchema,
    revision: PositiveIntegerSchema,
    sourceHash: PromptSourceHashSchema,
    sourceKey: NonEmptyStringSchema.max(1_024),
    sourceCommit: z.string().max(200).optional(),
    model: z.string().trim().min(1).max(200).optional(),
    thinking: z.string().trim().min(1).max(64).optional(),
    createdBy: IdentifierSchema,
    createdAt: TimestampSchema,
  })
  .strict()
  .readonly();
export type PromptRevision = z.infer<typeof PromptRevisionSchema>;

/** A stable alias that makes the immutability guarantee explicit. */
export const ImmutablePromptRevisionSchema = PromptRevisionSchema;
export type ImmutablePromptRevision = PromptRevision;

/** Describe one immutable revision in a weighted prompt rollout. */
export const PromptVariantSchema = z
  .object({
    id: IdentifierSchema,
    revisionId: IdentifierSchema,
    allocationBasisPoints: RolloutBasisPointSchema,
    enabled: z.boolean().default(true),
  })
  .strict()
  .readonly();
export type PromptVariant = z.infer<typeof PromptVariantSchema>;

/** Select the identity level that receives a stable assignment. */
export const AssignmentScopeSchema = z.enum([
  "global",
  "organization",
  "project",
  "user",
  "session",
  "request",
]);
export type AssignmentScope = z.infer<typeof AssignmentScopeSchema>;

const AssignmentSubjectSchema = NonEmptyStringSchema.max(512);

/** Identify the subject used to create a stable rollout assignment. */
export const PromptAssignmentSchema = z
  .object({
    scope: AssignmentScopeSchema,
    subject: AssignmentSubjectSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.scope !== "global" && value.subject === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["subject"],
        message: "A non-global assignment needs a subject",
      });
    }
  });
export type PromptAssignment = z.infer<typeof PromptAssignmentSchema>;

/**
 * Validate a complete variant allocation. Variant IDs must be unique and the
 * allocation must cover exactly 10,000 basis points.
 */
export const PromptVariantListSchema = z
  .array(PromptVariantSchema)
  .min(1)
  .max(128)
  .superRefine((variants, context) => {
    const ids = new Set<string>();
    let total = 0;

    for (const [index, variant] of variants.entries()) {
      if (ids.has(variant.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, "id"],
          message: "Variant IDs must be unique",
        });
      }
      ids.add(variant.id);
      if (!variant.enabled && variant.allocationBasisPoints !== 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, "allocationBasisPoints"],
          message: "A disabled variant must have zero allocation",
        });
      }
      total += variant.allocationBasisPoints;
    }

    if (total !== ROLLOUT_BASIS_POINTS_TOTAL) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message: `Variant weights must total ${ROLLOUT_BASIS_POINTS_TOTAL} basis points`,
      });
    }
  })
  .readonly();
export type PromptVariantList = z.infer<typeof PromptVariantListSchema>;

/** Define the immutable variants and scope for one prompt rollout. */
export const PromptRolloutSchema = z
  .object({
    rolloutId: IdentifierSchema,
    promptId: IdentifierSchema.optional(),
    scope: AssignmentScopeSchema.default("user"),
    variants: PromptVariantListSchema,
  })
  .strict()
  .readonly();
export type PromptRollout = z.infer<typeof PromptRolloutSchema>;

/** A test override must carry an explicit test identity and authorization. */
const AuthorizedTestOverrideObjectSchema = z
  .object({
    kind: z.literal("test"),
    authorized: z.literal(true),
    testId: IdentifierSchema,
    variantId: IdentifierSchema,
    scope: AssignmentScopeSchema.optional(),
    expiresAt: TimestampSchema.optional(),
  })
  .strict();

export const AuthorizedTestOverrideSchema =
  AuthorizedTestOverrideObjectSchema.readonly();
export type AuthorizedTestOverride = z.infer<
  typeof AuthorizedTestOverrideSchema
>;

/** An operator override must identify the operator and give a reason. */
const AuthorizedOperatorOverrideObjectSchema = z
  .object({
    kind: z.literal("operator"),
    authorized: z.literal(true),
    operatorId: IdentifierSchema,
    variantId: IdentifierSchema,
    reason: NonEmptyStringSchema,
    scope: AssignmentScopeSchema.optional(),
    expiresAt: TimestampSchema.optional(),
  })
  .strict();

export const AuthorizedOperatorOverrideSchema =
  AuthorizedOperatorOverrideObjectSchema.readonly();
export type AuthorizedOperatorOverride = z.infer<
  typeof AuthorizedOperatorOverrideSchema
>;

/** Accept only the two explicitly authorized override forms. */
export const AuthorizedPromptOverrideSchema = z
  .discriminatedUnion("kind", [
    AuthorizedTestOverrideObjectSchema,
    AuthorizedOperatorOverrideObjectSchema,
  ])
  .readonly();
export type AuthorizedPromptOverride = z.infer<
  typeof AuthorizedPromptOverrideSchema
>;

export const PromptOverrideSchema = AuthorizedPromptOverrideSchema;
export type PromptOverride = AuthorizedPromptOverride;

export const TestPromptOverrideSchema = AuthorizedTestOverrideSchema;
export type TestPromptOverride = AuthorizedTestOverride;

export const OperatorPromptOverrideSchema = AuthorizedOperatorOverrideSchema;
export type OperatorPromptOverride = AuthorizedOperatorOverride;

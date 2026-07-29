import { z } from "zod";

import {
  IdentifierSchema,
  JsonObjectSchema,
  MetadataSchema,
  NonEmptyStringSchema,
  TimestampSchema,
} from "./common";
import { IdentityReferenceSchema } from "./identity";

// Identify the action that needs approval.
export const ApprovalActionSchema = z.enum([
  "tool-call",
  "run",
  "secret-access",
  "channel-send",
]);
export type ApprovalAction = z.infer<typeof ApprovalActionSchema>;

// Identify the final state of an approval.
export const ApprovalStatusSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "expired",
  "cancelled",
]);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

// Ask an identity to approve one action.
export const ApprovalRequestSchema = z
  .object({
    id: IdentifierSchema,
    runId: IdentifierSchema,
    action: ApprovalActionSchema,
    reason: NonEmptyStringSchema,
    requestedBy: IdentityReferenceSchema,
    resourceId: IdentifierSchema.optional(),
    toolCallId: IdentifierSchema.optional(),
    requestedAt: TimestampSchema,
    expiresAt: TimestampSchema.optional(),
    context: JsonObjectSchema.optional(),
    metadata: MetadataSchema.optional(),
  })
  .strict();
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

// Record the answer to an approval request.
export const ApprovalDecisionSchema = z
  .object({
    requestId: IdentifierSchema,
    status: z.enum(["approved", "rejected", "expired", "cancelled"]),
    decidedBy: IdentityReferenceSchema,
    decidedAt: TimestampSchema,
    comment: NonEmptyStringSchema.optional(),
    metadata: MetadataSchema.optional(),
  })
  .strict();
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

// Keep the request name available for simple approval APIs.
export const ApprovalSchema = ApprovalRequestSchema;
export type Approval = ApprovalRequest;
export const ApprovalResolutionSchema = ApprovalDecisionSchema;
export type ApprovalResolution = ApprovalDecision;

/**
 * A short-lived capability issued after an approval. The lease is an
 * invocation credential, not a provider secret. Hosts must validate its
 * expiry and scope before executing a state-changing operation.
 */
export const CapabilityLeaseSchema = z
  .object({
    id: IdentifierSchema,
    approvalId: IdentifierSchema,
    toolId: IdentifierSchema,
    issuedAt: TimestampSchema,
    expiresAt: TimestampSchema,
  })
  .strict();
export type CapabilityLease = z.infer<typeof CapabilityLeaseSchema>;

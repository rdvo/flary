import { z } from "zod";

import {
  IdentifierSchema,
  MetadataSchema,
  NonEmptyStringSchema,
  TimestampSchema,
  VersionSchema,
} from "./common.js";

// Limit where a secret can be used.
export const SecretScopeSchema = z.enum([
  "run",
  "agent",
  "flow",
  "workspace",
  "project",
  "organization",
]);
export type SecretScope = z.infer<typeof SecretScopeSchema>;

// Reference a secret without exposing its value.
export const SecretReferenceSchema = z
  .object({
    name: IdentifierSchema,
    version: VersionSchema.optional(),
    scope: SecretScopeSchema.optional(),
  })
  .strict();
export type SecretReference = z.infer<typeof SecretReferenceSchema>;

// Bind a secret reference to a run input name.
export const SecretBindingSchema = z
  .object({
    name: IdentifierSchema,
    secret: SecretReferenceSchema,
    envName: IdentifierSchema.optional(),
    required: z.boolean().optional(),
  })
  .strict();
export type SecretBinding = z.infer<typeof SecretBindingSchema>;

// Store safe metadata for one secret version.
export const SecretMetadataSchema = z
  .object({
    id: IdentifierSchema,
    name: IdentifierSchema,
    scope: SecretScopeSchema,
    version: VersionSchema,
    description: NonEmptyStringSchema.optional(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    expiresAt: TimestampSchema.optional(),
    metadata: MetadataSchema.optional(),
  })
  .strict();
export type SecretMetadata = z.infer<typeof SecretMetadataSchema>;

// Accept a secret value only at a write boundary.
export const SecretInputSchema = z
  .object({
    name: IdentifierSchema,
    value: NonEmptyStringSchema,
    scope: SecretScopeSchema,
    description: NonEmptyStringSchema.optional(),
    expiresAt: TimestampSchema.optional(),
    metadata: MetadataSchema.optional(),
  })
  .strict();
export type SecretInput = z.infer<typeof SecretInputSchema>;

// Request a secret through a product UI without placing the value in a model
// message, tool result, transcript, or prompt. The runtime should pause the
// run and resume it after the application stores the value.
export const CollectApiKeyRequestSchema = z
  .object({
    connectionId: IdentifierSchema,
    secretName: IdentifierSchema,
    label: NonEmptyStringSchema.max(120),
    provider: IdentifierSchema.optional(),
    docsUrl: z.string().url().max(2_000).optional(),
    scope: SecretScopeSchema.default("organization"),
  })
  .strict();
export type CollectApiKeyRequest = z.infer<typeof CollectApiKeyRequestSchema>;
export type CollectApiKeyRequestRaw = z.input<typeof CollectApiKeyRequestSchema>;

/**
 * Safe metadata placed on the durable input request created by
 * `request_secret`. It contains no secret value or ciphertext.
 */
export const SecretRequestMetadataSchema = z
  .object({
    kind: z.literal("secret-request"),
    connectionId: IdentifierSchema,
    secretName: IdentifierSchema,
    label: NonEmptyStringSchema.max(120),
    provider: IdentifierSchema.optional(),
    docsUrl: z.string().url().max(2_000).optional(),
    scope: SecretScopeSchema,
    inputHash: NonEmptyStringSchema.max(128),
  })
  .strict();
export type SecretRequestMetadata = z.infer<typeof SecretRequestMetadataSchema>;

/** A secret value accepted only by the protected secret-fulfillment route. */
export const SecretRequestFulfillmentInputSchema = z
  .object({
    value: NonEmptyStringSchema.max(100_000),
    description: NonEmptyStringSchema.max(500).optional(),
    expiresAt: TimestampSchema.optional(),
  })
  .strict();
export type SecretRequestFulfillmentInput = z.infer<typeof SecretRequestFulfillmentInputSchema>;

/** Safe result returned to the agent after the vault stores the credential. */
export const SecretRequestResultSchema = z
  .object({
    status: z.literal("stored"),
    connectionId: IdentifierSchema,
    name: IdentifierSchema,
    scope: SecretScopeSchema,
    version: z.number().int().positive(),
  })
  .strict();
export type SecretRequestResult = z.infer<typeof SecretRequestResultSchema>;

// The value is accepted only by an authenticated secret write endpoint. It is
// deliberately separate from CollectApiKeyRequestSchema.
export const ConnectionSecretInputSchema = z
  .object({
    name: IdentifierSchema,
    value: NonEmptyStringSchema.max(100_000),
    scope: SecretScopeSchema,
    description: NonEmptyStringSchema.max(500).optional(),
    expiresAt: TimestampSchema.optional(),
  })
  .strict();
export type ConnectionSecretInput = z.infer<typeof ConnectionSecretInputSchema>;

// Keep the persisted secret shape free of secret values.
export const SecretSchema = SecretMetadataSchema;
export type Secret = SecretMetadata;
export const SecretRecordSchema = SecretMetadataSchema;
export type SecretRecord = SecretMetadata;

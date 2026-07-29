import { z } from "zod";

import {
  IdentifierSchema,
  NonEmptyStringSchema,
  TimestampSchema,
} from "./common";
import { SecretScopeSchema } from "./secrets";

// Describe the two connection families that Flary can expose to an agent.
export const ConnectionTypeSchema = z.enum(["api", "mcp"]);
export type ConnectionType = z.infer<typeof ConnectionTypeSchema>;

// Keep the transport explicit. Stdio is valid for self-hosted MCP only.
export const ConnectionProtocolSchema = z.enum(["http", "sse", "stdio"]);
export type ConnectionProtocol = z.infer<typeof ConnectionProtocolSchema>;

// These values describe how a connection obtains credentials. The credential
// itself is never part of a connection contract.
export const ConnectionAuthTypeSchema = z.enum([
  "none",
  "api_key",
  "bearer",
  "basic",
  "oauth2",
]);
export type ConnectionAuthType = z.infer<typeof ConnectionAuthTypeSchema>;

export const ProviderBillingModeSchema = z.enum([
  "subscription",
  "byok",
  "managed",
]);
export type ProviderBillingMode = z.infer<
  typeof ProviderBillingModeSchema
>;

export const ProviderCredentialSourceSchema = z.enum([
  "subscription",
  "tenant_byok",
  "managed",
]);
export type ProviderCredentialSource = z.infer<
  typeof ProviderCredentialSourceSchema
>;

/**
 * The safe credential identity admitted for one model turn.
 *
 * This object never contains a token or a vault key. `connectionRef` is a
 * one-way reference that is safe to use in telemetry.
 */
export const AdmittedProviderCredentialSchema = z
  .object({
    provider: IdentifierSchema,
    source: ProviderCredentialSourceSchema,
    billingMode: ProviderBillingModeSchema,
    connectionId: IdentifierSchema.optional(),
    version: z.number().int().positive(),
    generation: IdentifierSchema.max(200),
    connectionRef: IdentifierSchema.max(200),
  })
  .strict();
export type AdmittedProviderCredential = z.infer<
  typeof AdmittedProviderCredentialSchema
>;

export const ProviderCredentialStatusSchema = z.enum([
  "active",
  "refreshing",
  "expired",
  "revoked",
  "error",
]);
export type ProviderCredentialStatus = z.infer<
  typeof ProviderCredentialStatusSchema
>;

export const SubscriptionProviderSchema = z.enum([
  "anthropic",
  "openai-codex",
]);
export type SubscriptionProvider = z.infer<
  typeof SubscriptionProviderSchema
>;

export const ProviderOAuthLoginMethodSchema = z.enum([
  "device_code",
  "authorization_code",
  "browser_callback",
]);
export type ProviderOAuthLoginMethod = z.infer<
  typeof ProviderOAuthLoginMethodSchema
>;

export const ProviderOAuthStatusSchema = z.enum([
  "pending",
  "ready",
  "expired",
  "cancelled",
  "error",
]);
export type ProviderOAuthStatus = z.infer<
  typeof ProviderOAuthStatusSchema
>;

/**
 * Public state for one provider login.
 *
 * PKCE verifiers, device authorization IDs, access tokens, and refresh tokens
 * are intentionally absent from this contract.
 */
export const ProviderOAuthSessionSchema = z
  .object({
    id: IdentifierSchema,
    appId: IdentifierSchema,
    organizationId: IdentifierSchema,
    userId: IdentifierSchema,
    connectionId: IdentifierSchema,
    provider: SubscriptionProviderSchema,
    method: ProviderOAuthLoginMethodSchema,
    status: ProviderOAuthStatusSchema,
    authorizationUrl: z.string().url().max(4_000).optional(),
    verificationUri: z.string().url().max(2_000).optional(),
    userCode: NonEmptyStringSchema.max(200).optional(),
    intervalSeconds: z.number().int().positive().max(300).optional(),
    accountSubject: NonEmptyStringSchema.max(500).optional(),
    errorCode: IdentifierSchema.max(120).optional(),
    expiresAt: TimestampSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export type ProviderOAuthSession = z.infer<
  typeof ProviderOAuthSessionSchema
>;

export const ProviderOAuthStartInputSchema = z
  .object({
    provider: SubscriptionProviderSchema,
    connectionId: IdentifierSchema.optional(),
    method: ProviderOAuthLoginMethodSchema.optional(),
  })
  .strict();
export type ProviderOAuthStartInput = z.input<
  typeof ProviderOAuthStartInputSchema
>;

export const ProviderOAuthCompleteInputSchema = z
  .object({
    authorizationResult: NonEmptyStringSchema.max(8_000),
  })
  .strict();
export type ProviderOAuthCompleteInput = z.infer<
  typeof ProviderOAuthCompleteInputSchema
>;

export const ProviderEncryptedCredentialHandoffSchema = z
  .object({
    connectionId: IdentifierSchema,
    provider: SubscriptionProviderSchema,
    ownerUserId: IdentifierSchema,
    grant: z.enum(["user", "organization"]).default("user"),
    envelope: z
      .object({
        algorithm: z.literal("A256GCM"),
        keyId: IdentifierSchema,
        ciphertext: NonEmptyStringSchema.max(500_000),
        iv: NonEmptyStringSchema.max(2_000),
      })
      .strict(),
    subject: NonEmptyStringSchema.max(500).optional(),
    scopes: z.array(NonEmptyStringSchema.max(200)).max(128).default([]),
    expiresAt: TimestampSchema.optional(),
    version: z.number().int().positive(),
  })
  .strict();
export type ProviderEncryptedCredentialHandoff = z.infer<
  typeof ProviderEncryptedCredentialHandoffSchema
>;

/**
 * Safe lifecycle metadata for one provider credential.
 *
 * Secret values use opaque vault references. They must never enter an API
 * response, model input, tool argument, event, or transcript.
 */
export const ProviderCredentialLifecycleSchema = z
  .object({
    connectionId: IdentifierSchema,
    provider: IdentifierSchema,
    billingMode: ProviderBillingModeSchema.default("byok"),
    status: ProviderCredentialStatusSchema,
    accessSecretRef: IdentifierSchema.optional(),
    refreshSecretRef: IdentifierSchema.optional(),
    subject: NonEmptyStringSchema.max(500).optional(),
    issuer: z.string().url().max(2_000).optional(),
    scopes: z.array(NonEmptyStringSchema.max(200)).max(128).default([]),
    expiresAt: TimestampSchema.optional(),
    refreshedAt: TimestampSchema.optional(),
    revokedAt: TimestampSchema.optional(),
    version: z.number().int().positive(),
  })
  .strict();
export type ProviderCredentialLifecycle = z.infer<
  typeof ProviderCredentialLifecycleSchema
>;

export const ConnectionStatusSchema = z.enum([
  "needs_auth",
  "configured",
  "ready",
  "error",
  "disabled",
]);
export type ConnectionStatus = z.infer<typeof ConnectionStatusSchema>;

const ConnectionSlugSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase letters, numbers, and hyphens");

const ConnectionUrlSchema = z.string().url().max(2_000);

// Safe connection metadata accepted from an application. Do not add a raw
// token, password, cookie, or arbitrary headers to this object.
export const ConnectionCreateInputSchema = z
  .object({
    name: NonEmptyStringSchema.max(120),
    slug: ConnectionSlugSchema,
    provider: IdentifierSchema,
    type: ConnectionTypeSchema,
    protocol: ConnectionProtocolSchema.default("http"),
    baseUrl: ConnectionUrlSchema.nullable().optional(),
    docsUrl: ConnectionUrlSchema.nullable().optional(),
    authType: ConnectionAuthTypeSchema.default("none"),
    billingMode: ProviderBillingModeSchema.optional(),
    authHeader: IdentifierSchema.max(120).optional(),
    description: NonEmptyStringSchema.max(500).optional(),
    iconUrl: ConnectionUrlSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.type === "api" && !value.baseUrl) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["baseUrl"],
        message: "API connections require baseUrl",
      });
    }
    if (value.protocol === "stdio" && value.type !== "mcp") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["protocol"],
        message: "stdio is only valid for MCP connections",
      });
    }
    if (
      value.billingMode === "subscription" &&
      value.authType !== "oauth2"
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["billingMode"],
        message: "Subscription connections require oauth2 authentication",
      });
    }
  });
export type ConnectionCreateInput = z.infer<typeof ConnectionCreateInputSchema>;
export type ConnectionCreateInputRaw = z.input<typeof ConnectionCreateInputSchema>;

// This is the redacted connection shape returned by Flary Cloud.
export const ConnectionSchema = z
  .object({
    id: IdentifierSchema,
    appId: IdentifierSchema,
    organizationId: IdentifierSchema,
    name: NonEmptyStringSchema,
    slug: ConnectionSlugSchema,
    provider: IdentifierSchema,
    type: ConnectionTypeSchema,
    protocol: ConnectionProtocolSchema,
    baseUrl: ConnectionUrlSchema.optional(),
    docsUrl: ConnectionUrlSchema.optional(),
    authType: ConnectionAuthTypeSchema,
    billingMode: ProviderBillingModeSchema.default("byok"),
    authHeader: IdentifierSchema.nullable().optional(),
    description: NonEmptyStringSchema.nullable().optional(),
    iconUrl: ConnectionUrlSchema.nullable().optional(),
    status: ConnectionStatusSchema,
    createdBy: IdentifierSchema,
    ownerUserId: IdentifierSchema.nullable().optional(),
    ownerName: NonEmptyStringSchema.max(200).nullable().optional(),
    credentialSubject: NonEmptyStringSchema.max(500).nullable().optional(),
    credentialScopes: z.array(NonEmptyStringSchema.max(200)).max(128).default([]),
    credentialExpiresAt: TimestampSchema.nullable().optional(),
    credentialRefreshedAt: TimestampSchema.nullable().optional(),
    credentialRevokedAt: TimestampSchema.nullable().optional(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export type Connection = z.infer<typeof ConnectionSchema>;

// Secret metadata can be shown in settings or a collect_api_key prompt. It
// contains no ciphertext and no secret value.
export const ConnectionSecretMetadataSchema = z
  .object({
    id: IdentifierSchema,
    connectionId: IdentifierSchema,
    name: IdentifierSchema,
    scope: SecretScopeSchema,
    version: z.number().int().positive(),
    keyId: IdentifierSchema,
    description: NonEmptyStringSchema.nullable().optional(),
    expiresAt: TimestampSchema.nullable().optional(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export type ConnectionSecretMetadata = z.infer<
  typeof ConnectionSecretMetadataSchema
>;

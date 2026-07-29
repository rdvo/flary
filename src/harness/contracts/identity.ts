import { z } from "zod";

import {
  IdentifierSchema,
  MetadataSchema,
  NonEmptyStringSchema,
  ReferenceSchema,
  TimestampSchema,
} from "./common";

// Identify the owner type for a run.
export const IdentityKindSchema = z.enum(["user", "service", "agent", "system"]);
export type IdentityKind = z.infer<typeof IdentityKindSchema>;

// Reference a persistent identity without private claims.
export const IdentityReferenceSchema = z
  .object({
    id: IdentifierSchema,
    kind: IdentityKindSchema.optional(),
    version: ReferenceSchema.shape.version,
  })
  .strict();
export type IdentityReference = z.infer<typeof IdentityReferenceSchema>;

// Store the stable identity for a run or resource.
export const PersistentIdentitySchema = z
  .object({
    id: IdentifierSchema,
    kind: IdentityKindSchema,
    subject: NonEmptyStringSchema,
    provider: IdentifierSchema.optional(),
    displayName: NonEmptyStringSchema.optional(),
    email: z.string().email().optional(),
    tenantId: IdentifierSchema.optional(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    metadata: MetadataSchema.optional(),
  })
  .strict();
export type PersistentIdentity = z.infer<typeof PersistentIdentitySchema>;

// Keep the short identity name available for callers.
export const IdentitySchema = PersistentIdentitySchema;
export type Identity = PersistentIdentity;

import { z } from "zod";

/** IDs used in storage keys must be opaque, single path segments. */
export const StorageIdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, "Expected an opaque storage identifier");
export type StorageIdentifier = z.infer<typeof StorageIdentifierSchema>;

export const TenantContextSchema = z
  .object({
    organizationId: StorageIdentifierSchema,
    appId: StorageIdentifierSchema,
    userId: StorageIdentifierSchema.optional(),
    roles: z.array(StorageIdentifierSchema).max(32).default([]),
  })
  .strict();
export type TenantContext = z.infer<typeof TenantContextSchema>;
export type TenantContextInput = z.input<typeof TenantContextSchema>;

export const ThreadRefSchema = z
  .object({
    organizationId: StorageIdentifierSchema,
    appId: StorageIdentifierSchema,
    agentId: StorageIdentifierSchema,
    threadId: StorageIdentifierSchema,
  })
  .strict();
export type ThreadRef = z.infer<typeof ThreadRefSchema>;

export const WorkspaceRefSchema = z
  .object({
    organizationId: StorageIdentifierSchema,
    appId: StorageIdentifierSchema,
    projectId: StorageIdentifierSchema,
    workspaceId: StorageIdentifierSchema,
    branch: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .default("main")
      .refine((value) => !/[\\\u0000-\u001f\u007f]/.test(value), {
        message: "Branch names cannot contain control characters",
      }),
  })
  .strict();
export type WorkspaceRef = z.infer<typeof WorkspaceRefSchema>;
export type WorkspaceRefInput = z.input<typeof WorkspaceRefSchema>;

export const StorageScopeSchema = WorkspaceRefSchema.pick({
  organizationId: true,
  appId: true,
  projectId: true,
  workspaceId: true,
})
  .extend({ branch: WorkspaceRefSchema.shape.branch })
  .strict();
export type StorageScope = z.infer<typeof StorageScopeSchema>;

export const StorageCapabilitySchema = z
  .object({
    scope: StorageScopeSchema,
    operations: z
      .array(z.enum(["read", "write", "delete", "share"]))
      .min(1)
      .max(4),
    expiresAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
export type StorageCapability = z.infer<typeof StorageCapabilitySchema>;

export function workspaceRefFromStorageScope(scope: StorageScope, branch = "main"): WorkspaceRef {
  return WorkspaceRefSchema.parse({ ...scope, branch });
}

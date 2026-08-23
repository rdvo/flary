import { z } from "zod";

const ProjectPathTextSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), {
    message: "Paths cannot contain control characters",
  })
  .refine((value) => !value.startsWith("/"), {
    message: "Paths must be relative to the project root",
  })
  .refine((value) => !value.includes("\\"), {
    message: "Paths must use forward slashes",
  })
  .refine(
    (value) =>
      value.split("/").every((part) => part.length > 0 && part !== "." && part !== ".."),
    { message: "Paths must be canonical and stay inside the project root" },
  );

/** A canonical file path relative to a project root. */
export const ProjectFilePathSchema = ProjectPathTextSchema;
export type ProjectFilePath = z.infer<typeof ProjectFilePathSchema>;

/** A canonical directory prefix. An empty value selects the project root. */
export const ProjectDirectoryPathSchema = z.union([
  z.literal(""),
  ProjectPathTextSchema,
]);
export type ProjectDirectoryPath = z.infer<typeof ProjectDirectoryPathSchema>;

export const ProjectFileEncodingSchema = z.enum(["utf8", "base64"]);
export type ProjectFileEncoding = z.infer<typeof ProjectFileEncodingSchema>;

export const ProjectFileStorageSchema = z.enum(["inline", "r2"]);
export type ProjectFileStorage = z.infer<typeof ProjectFileStorageSchema>;

export const Sha256HexSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "Expected a lowercase SHA-256 digest");

export const ProjectFileEntrySchema = z
  .object({
    path: ProjectFilePathSchema,
    size: z.number().int().nonnegative(),
    sha256: Sha256HexSchema,
    mediaType: z.string().trim().min(1).max(255),
    storage: ProjectFileStorageSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type ProjectFileEntry = z.infer<typeof ProjectFileEntrySchema>;

// Workspace is the public name used by the durable branch filesystem.
export const WorkspaceFileSchema = ProjectFileEntrySchema;
export type WorkspaceFile = ProjectFileEntry;

export const ProjectFileWriteRequestSchema = z
  .object({
    path: ProjectFilePathSchema,
    content: z.string().max(32 * 1024 * 1024),
    encoding: ProjectFileEncodingSchema.default("utf8"),
    mediaType: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .default("application/octet-stream"),
    expectedSha256: Sha256HexSchema.optional(),
  })
  .strict();
export type ProjectFileWriteRequestInput = z.input<
  typeof ProjectFileWriteRequestSchema
>;
export type ProjectFileWriteRequest = z.output<
  typeof ProjectFileWriteRequestSchema
>;

export const ProjectFileReadRequestSchema = z
  .object({
    path: ProjectFilePathSchema,
    encoding: ProjectFileEncodingSchema.optional(),
  })
  .strict();
export type ProjectFileReadRequest = z.infer<
  typeof ProjectFileReadRequestSchema
>;

export const ProjectFileReadResponseSchema = z
  .object({
    file: ProjectFileEntrySchema,
    content: z.string(),
    encoding: ProjectFileEncodingSchema,
  })
  .strict();
export type ProjectFileReadResponse = z.infer<
  typeof ProjectFileReadResponseSchema
>;

export const ProjectFileListRequestSchema = z
  .object({
    prefix: ProjectDirectoryPathSchema.default(""),
    recursive: z.boolean().default(true),
    limit: z.number().int().min(1).max(10_000).default(1_000),
  })
  .strict();
export type ProjectFileListRequestInput = z.input<
  typeof ProjectFileListRequestSchema
>;
export type ProjectFileListRequest = z.output<
  typeof ProjectFileListRequestSchema
>;

export const ProjectFileListResponseSchema = z
  .object({
    files: z.array(ProjectFileEntrySchema),
  })
  .strict();
export type ProjectFileListResponse = z.infer<
  typeof ProjectFileListResponseSchema
>;

export const ProjectFileDeleteRequestSchema = z
  .object({
    path: ProjectDirectoryPathSchema,
    recursive: z.boolean().default(false),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.path === "" && !value.recursive) {
      context.addIssue({
        code: "custom",
        path: ["recursive"],
        message: "Deleting the project root needs recursive: true",
      });
    }
  });
export type ProjectFileDeleteRequestInput = z.input<
  typeof ProjectFileDeleteRequestSchema
>;
export type ProjectFileDeleteRequest = z.output<
  typeof ProjectFileDeleteRequestSchema
>;

export const ProjectFileDeleteResponseSchema = z
  .object({
    deleted: z.array(ProjectFilePathSchema),
  })
  .strict();
export type ProjectFileDeleteResponse = z.infer<
  typeof ProjectFileDeleteResponseSchema
>;

export const ProjectFileMoveRequestSchema = z
  .object({
    from: ProjectFilePathSchema,
    to: ProjectFilePathSchema,
    overwrite: z.boolean().default(false),
  })
  .strict()
  .refine((value) => value.from !== value.to, {
    message: "Source and destination paths must be different",
  });
export type ProjectFileMoveRequestInput = z.input<
  typeof ProjectFileMoveRequestSchema
>;
export type ProjectFileMoveRequest = z.output<
  typeof ProjectFileMoveRequestSchema
>;

export const ProjectFileCopyRequestSchema = ProjectFileMoveRequestSchema;
export type ProjectFileCopyRequestInput = z.input<
  typeof ProjectFileCopyRequestSchema
>;
export type ProjectFileCopyRequest = z.output<
  typeof ProjectFileCopyRequestSchema
>;

export const ProjectTextEditSchema = z
  .object({
    oldText: z.string().min(1).max(2 * 1024 * 1024),
    newText: z.string().max(2 * 1024 * 1024),
    replaceAll: z.boolean().default(false),
  })
  .strict();
export type ProjectTextEdit = z.output<typeof ProjectTextEditSchema>;

export const ProjectFileEditRequestSchema = z
  .object({
    path: ProjectFilePathSchema,
    edits: z.array(ProjectTextEditSchema).min(1).max(100),
    expectedSha256: Sha256HexSchema.optional(),
  })
  .strict();
export type ProjectFileEditRequestInput = z.input<
  typeof ProjectFileEditRequestSchema
>;
export type ProjectFileEditRequest = z.output<
  typeof ProjectFileEditRequestSchema
>;

export const ProjectFilePatchRequestSchema = z
  .object({
    path: ProjectFilePathSchema,
    patch: z.string().min(1).max(8 * 1024 * 1024),
    expectedSha256: Sha256HexSchema.optional(),
  })
  .strict();
export type ProjectFilePatchRequestInput = z.input<
  typeof ProjectFilePatchRequestSchema
>;
export type ProjectFilePatchRequest = z.output<
  typeof ProjectFilePatchRequestSchema
>;

export const ProjectFileMutationResponseSchema = z
  .object({
    file: ProjectFileEntrySchema,
  })
  .strict();
export type ProjectFileMutationResponse = z.infer<
  typeof ProjectFileMutationResponseSchema
>;

export const ProjectFileEditResponseSchema =
  ProjectFileMutationResponseSchema.extend({
    replacementCount: z.number().int().nonnegative(),
  }).strict();
export type ProjectFileEditResponse = z.infer<
  typeof ProjectFileEditResponseSchema
>;

export const ProjectFilePatchResponseSchema =
  ProjectFileMutationResponseSchema.extend({
    hunkCount: z.number().int().positive(),
  }).strict();
export type ProjectFilePatchResponse = z.infer<
  typeof ProjectFilePatchResponseSchema
>;

export const WorkspaceMutationSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("write"),
      request: ProjectFileWriteRequestSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal("read"),
      request: ProjectFileReadRequestSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal("list"),
      request: ProjectFileListRequestSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal("delete"),
      request: ProjectFileDeleteRequestSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal("move"),
      request: ProjectFileMoveRequestSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal("copy"),
      request: ProjectFileCopyRequestSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal("edit"),
      request: ProjectFileEditRequestSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal("applyPatch"),
      request: ProjectFilePatchRequestSchema,
    })
    .strict(),
]);
export type WorkspaceMutation = z.infer<typeof WorkspaceMutationSchema>;

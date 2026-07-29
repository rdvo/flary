import { z } from "zod";

import {
  IdentifierSchema,
  NonEmptyStringSchema,
  PositiveIntegerSchema,
} from "./common";
import {
  ProjectDirectoryPathSchema,
  ProjectFileEditRequestSchema,
  ProjectFileEntrySchema,
  ProjectFilePathSchema,
  ProjectFileReadRequestSchema,
  ProjectFileWriteRequestSchema,
  ProjectFileMutationResponseSchema,
} from "./filesystem";

/** A safe relative glob. It is never allowed to select outside a workspace. */
export const WorkspaceGlobPatternSchema = z
  .string()
  .trim()
  .min(1)
  .max(1_024)
  .refine((value) => !value.startsWith("/"), {
    message: "Workspace patterns must be relative",
  })
  .refine((value) => !value.includes("\\"), {
    message: "Workspace patterns must use forward slashes",
  })
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), {
    message: "Workspace patterns cannot contain control characters",
  })
  .refine(
    (value) =>
      value.split("/").every((part) => part.length > 0 && part !== "." && part !== ".."),
    { message: "Workspace patterns cannot contain empty, . or .. segments" },
  );
export type WorkspaceGlobPattern = z.infer<typeof WorkspaceGlobPatternSchema>;

export const WorkspaceGlobRequestSchema = z
  .object({
    pattern: WorkspaceGlobPatternSchema,
    limit: PositiveIntegerSchema.max(10_000).default(1_000),
  })
  .strict();
export type WorkspaceGlobRequestInput = z.input<
  typeof WorkspaceGlobRequestSchema
>;
export type WorkspaceGlobRequest = z.output<typeof WorkspaceGlobRequestSchema>;

export const WorkspaceGlobResponseSchema = z
  .object({
    paths: z.array(ProjectFilePathSchema).max(10_000),
  })
  .strict();
export type WorkspaceGlobResponse = z.infer<typeof WorkspaceGlobResponseSchema>;

export const WorkspaceGrepRequestSchema = z
  .object({
    query: NonEmptyStringSchema.max(10_000),
    pattern: WorkspaceGlobPatternSchema.default("**/*"),
    caseSensitive: z.boolean().default(false),
    regex: z.boolean().default(false),
    wholeWord: z.boolean().default(false),
    contextBefore: z.number().int().nonnegative().max(10).default(0),
    contextAfter: z.number().int().nonnegative().max(10).default(0),
    maxMatches: PositiveIntegerSchema.max(10_000).default(200),
  })
  .strict();
export type WorkspaceGrepRequestInput = z.input<
  typeof WorkspaceGrepRequestSchema
>;
export type WorkspaceGrepRequest = z.output<typeof WorkspaceGrepRequestSchema>;

export const WorkspaceTextMatchSchema = z
  .object({
    line: PositiveIntegerSchema,
    column: PositiveIntegerSchema,
    match: z.string(),
    lineText: z.string(),
    beforeLines: z.array(z.string()).max(10).optional(),
    afterLines: z.array(z.string()).max(10).optional(),
  })
  .strict();
export type WorkspaceTextMatch = z.infer<typeof WorkspaceTextMatchSchema>;

export const WorkspaceGrepFileSchema = z
  .object({
    path: ProjectFilePathSchema,
    matches: z.array(WorkspaceTextMatchSchema).min(1),
  })
  .strict();
export type WorkspaceGrepFile = z.infer<typeof WorkspaceGrepFileSchema>;

export const WorkspaceGrepResponseSchema = z
  .object({
    files: z.array(WorkspaceGrepFileSchema),
  })
  .strict();
export type WorkspaceGrepResponse = z.infer<typeof WorkspaceGrepResponseSchema>;

export const WorkspaceDiffRequestSchema = z
  .object({
    path: ProjectFilePathSchema,
    compareToPath: ProjectFilePathSchema.optional(),
    newContent: z.string().max(32 * 1024 * 1024).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.compareToPath === undefined && value.newContent === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["compareToPath"],
        message: "Provide compareToPath or newContent",
      });
    }
    if (value.compareToPath !== undefined && value.newContent !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["newContent"],
        message: "Use compareToPath or newContent, not both",
      });
    }
    if (value.compareToPath === value.path) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["compareToPath"],
        message: "A file cannot be diffed against itself",
      });
    }
  });
export type WorkspaceDiffRequestInput = z.input<
  typeof WorkspaceDiffRequestSchema
>;
export type WorkspaceDiffRequest = z.output<typeof WorkspaceDiffRequestSchema>;

export const WorkspaceDiffResponseSchema = z
  .object({
    path: ProjectFilePathSchema,
    compareToPath: ProjectFilePathSchema.optional(),
    diff: z.string(),
  })
  .strict();
export type WorkspaceDiffResponse = z.infer<typeof WorkspaceDiffResponseSchema>;

export const WorkspaceBatchEditRequestSchema = z
  .object({
    edits: z.array(ProjectFileEditRequestSchema).min(1).max(100),
    rollbackOnError: z.boolean().default(true),
  })
  .strict();
export type WorkspaceBatchEditRequestInput = z.input<
  typeof WorkspaceBatchEditRequestSchema
>;
export type WorkspaceBatchEditRequest = z.output<
  typeof WorkspaceBatchEditRequestSchema
>;

export const WorkspaceBatchEditResultSchema = z
  .object({
    path: ProjectFilePathSchema,
    file: ProjectFileEntrySchema,
    replacementCount: z.number().int().nonnegative(),
  })
  .strict();
export type WorkspaceBatchEditResult = z.infer<
  typeof WorkspaceBatchEditResultSchema
>;

export const WorkspaceBatchEditResponseSchema = z
  .object({
    results: z.array(WorkspaceBatchEditResultSchema),
    totalReplacementCount: z.number().int().nonnegative(),
  })
  .strict();
export type WorkspaceBatchEditResponse = z.infer<
  typeof WorkspaceBatchEditResponseSchema
>;

export const WorkspaceGitDirectorySchema = ProjectDirectoryPathSchema;

export const GitAuthorSchema = z
  .object({
    name: NonEmptyStringSchema.max(200),
    email: z.string().trim().email().max(320),
  })
  .strict();
export type GitAuthor = z.infer<typeof GitAuthorSchema>;

export const GitStatusRequestSchema = z
  .object({ dir: WorkspaceGitDirectorySchema.default("") })
  .strict();
export type GitStatusRequest = z.output<typeof GitStatusRequestSchema>;

export const GitStatusEntrySchema = z
  .object({
    filepath: ProjectFilePathSchema,
    head: z.number().int().min(0).max(1),
    workdir: z.number().int().min(0).max(2),
    stage: z.number().int().min(0).max(3),
    status: NonEmptyStringSchema.max(64),
  })
  .strict();
export type GitStatusEntry = z.infer<typeof GitStatusEntrySchema>;

export const GitStatusResponseSchema = z
  .object({ entries: z.array(GitStatusEntrySchema) })
  .strict();
export type GitStatusResponse = z.infer<typeof GitStatusResponseSchema>;

export const GitDiffRequestSchema = GitStatusRequestSchema;
export type GitDiffRequest = GitStatusRequest;

export const GitDiffEntrySchema = z
  .object({
    filepath: ProjectFilePathSchema,
    status: NonEmptyStringSchema.max(64),
  })
  .strict();
export type GitDiffEntry = z.infer<typeof GitDiffEntrySchema>;

export const GitDiffResponseSchema = z
  .object({ entries: z.array(GitDiffEntrySchema) })
  .strict();
export type GitDiffResponse = z.infer<typeof GitDiffResponseSchema>;

export const GitBranchRequestSchema = z
  .object({
    name: IdentifierSchema.optional(),
    delete: IdentifierSchema.optional(),
    dir: WorkspaceGitDirectorySchema.default(""),
  })
  .strict()
  .refine((value) => !(value.name && value.delete), {
    message: "Use name or delete, not both",
  });
export type GitBranchRequest = z.output<typeof GitBranchRequestSchema>;

export const GitBranchResponseSchema = z
  .object({
    branches: z.array(IdentifierSchema).optional(),
    current: IdentifierSchema.nullable().optional(),
    created: IdentifierSchema.optional(),
    deleted: IdentifierSchema.optional(),
  })
  .strict();
export type GitBranchResponse = z.infer<typeof GitBranchResponseSchema>;

export const GitCommitRequestSchema = z
  .object({
    message: NonEmptyStringSchema.max(10_000),
    author: GitAuthorSchema.optional(),
    dir: WorkspaceGitDirectorySchema.default(""),
  })
  .strict();
export type GitCommitRequest = z.output<typeof GitCommitRequestSchema>;

export const GitCommitResponseSchema = z
  .object({
    oid: z.string().regex(/^[0-9a-f]{7,64}$/i),
    message: NonEmptyStringSchema.max(10_000),
  })
  .strict();
export type GitCommitResponse = z.infer<typeof GitCommitResponseSchema>;

export const GitMergeRequestSchema = z
  .object({
    ref: IdentifierSchema,
    message: NonEmptyStringSchema.max(10_000).optional(),
    author: GitAuthorSchema.optional(),
    dir: WorkspaceGitDirectorySchema.default(""),
  })
  .strict();
export type GitMergeRequest = z.output<typeof GitMergeRequestSchema>;

export const GitMergeResponseSchema = z
  .object({
    oid: z.string().regex(/^[0-9a-f]{7,64}$/i),
    message: NonEmptyStringSchema.max(10_000),
  })
  .strict();
export type GitMergeResponse = z.infer<typeof GitMergeResponseSchema>;

export const WorkspaceToolInputSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("read"), request: ProjectFileReadRequestSchema }).strict(),
  z.object({ operation: z.literal("write"), request: ProjectFileWriteRequestSchema }).strict(),
  z.object({ operation: z.literal("edit"), request: ProjectFileEditRequestSchema }).strict(),
  z.object({ operation: z.literal("glob"), request: WorkspaceGlobRequestSchema }).strict(),
  z.object({ operation: z.literal("grep"), request: WorkspaceGrepRequestSchema }).strict(),
  z.object({ operation: z.literal("diff"), request: WorkspaceDiffRequestSchema }).strict(),
]);
export type WorkspaceToolInput = z.infer<typeof WorkspaceToolInputSchema>;

export const WorkspaceToolMutationResponseSchema = ProjectFileMutationResponseSchema;

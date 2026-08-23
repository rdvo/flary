import {
  GitBranchRequestSchema,
  GitBranchResponseSchema,
  GitCommitRequestSchema,
  GitCommitResponseSchema,
  GitDiffRequestSchema,
  GitDiffResponseSchema,
  GitMergeRequestSchema,
  GitMergeResponseSchema,
  GitStatusRequestSchema,
  GitStatusResponseSchema,
  ProjectFileDeleteRequestSchema,
  ProjectFileCopyRequestSchema,
  ProjectFileEditRequestSchema,
  ProjectFileListRequestSchema,
  ProjectFileMoveRequestSchema,
  ProjectFilePatchRequestSchema,
  ProjectFilePatchResponseSchema,
  ProjectFileReadRequestSchema,
  ProjectFileWriteRequestSchema,
  WorkspaceBatchEditRequestSchema,
  WorkspaceBatchEditResponseSchema,
  WorkspaceDiffRequestSchema,
  WorkspaceDiffResponseSchema,
  WorkspaceGlobRequestSchema,
  WorkspaceGlobResponseSchema,
  WorkspaceGrepRequestSchema,
  WorkspaceGrepResponseSchema,
  type GitBranchRequest,
  type GitBranchResponse,
  type GitCommitRequest,
  type GitCommitResponse,
  type GitDiffRequest,
  type GitDiffResponse,
  type GitMergeRequest,
  type GitMergeResponse,
  type GitStatusRequest,
  type GitStatusResponse,
  type ProjectFileDeleteRequest,
  type ProjectFileCopyRequest,
  type ProjectFileEditRequest,
  type ProjectFileListRequest,
  type ProjectFileMoveRequest,
  type ProjectFileReadRequest,
  type ProjectFileReadResponse,
  type ProjectFileWriteRequestInput,
  type WorkspaceBatchEditRequestInput,
  type WorkspaceBatchEditResponse,
  type WorkspaceDiffRequestInput,
  type WorkspaceDiffResponse,
  type WorkspaceGlobRequestInput,
  type WorkspaceGlobResponse,
  type WorkspaceGrepRequestInput,
  type WorkspaceGrepResponse,
} from "../contracts";
import {
  ProjectFileDeleteResponseSchema,
  ProjectFileEditResponseSchema,
  ProjectFileEntrySchema,
  ProjectFileListResponseSchema,
  ProjectFileMutationResponseSchema,
  ProjectFileReadResponseSchema,
  type ProjectFileEditResponse,
  type ProjectFileEntry,
  type ProjectFileListResponse,
  type ProjectFileMutationResponse,
  type ProjectFileDeleteResponse,
  type ProjectFileMoveRequestInput,
  type ProjectFilePatchRequest,
  type ProjectFilePatchResponse,
} from "../contracts/filesystem";
import type { JsonObject } from "../contracts/common";
import type {
  CapabilityHandle,
  ToolCatalog,
} from "./catalog";
import type { ToolCatalogDefinitionInput } from "../contracts/tools";
import { z } from "zod";

export interface WorkspaceToolTarget {
  read(input: ProjectFileReadRequest): Promise<ProjectFileReadResponse>;
  write(input: ProjectFileWriteRequestInput): Promise<ProjectFileMutationResponse>;
  edit(input: ProjectFileEditRequest): Promise<ProjectFileEditResponse>;
  applyPatch(input: ProjectFilePatchRequest): Promise<ProjectFilePatchResponse>;
  copy(input: ProjectFileCopyRequest): Promise<ProjectFileMutationResponse>;
  delete(input: ProjectFileDeleteRequest): Promise<ProjectFileDeleteResponse>;
  move(input: ProjectFileMoveRequestInput): Promise<ProjectFileMutationResponse>;
  list(input: ProjectFileListRequest): Promise<ProjectFileListResponse>;
  stat(path: string): Promise<ProjectFileEntry>;
  glob(input: WorkspaceGlobRequestInput): Promise<WorkspaceGlobResponse>;
  grep(input: WorkspaceGrepRequestInput): Promise<WorkspaceGrepResponse>;
  diff(input: WorkspaceDiffRequestInput): Promise<WorkspaceDiffResponse>;
  batchEdit(
    input: WorkspaceBatchEditRequestInput,
  ): Promise<WorkspaceBatchEditResponse>;
  git?: WorkspaceGitOperations;
}

/**
 * Git operations are supplied by the host. Credentials are deliberately not
 * part of these inputs; the host binds them through a private capability.
 */
export interface WorkspaceGitOperations {
  status(input: GitStatusRequest): Promise<GitStatusResponse>;
  diff(input: GitDiffRequest): Promise<GitDiffResponse>;
  branch(input: GitBranchRequest): Promise<GitBranchResponse>;
  commit(input: GitCommitRequest): Promise<GitCommitResponse>;
  merge(input: GitMergeRequest): Promise<GitMergeResponse>;
}

export interface WorkspaceToolRegistrationOptions {
  /** Prefix tool IDs when several workspaces are exposed to one agent. */
  prefix?: string;
  /** Mark all mutations as requiring an application approval. */
  requireApprovalForWrites?: boolean;
}

export interface RegisteredWorkspaceTools {
  descriptors: Array<CapabilityHandle["descriptor"]>;
}

const OBJECT_SCHEMA: JsonObject = { type: "object" };

function definition(
  id: string,
  name: string,
  description: string,
  capabilities: string[],
  inputSchema: JsonObject = OBJECT_SCHEMA,
  outputSchema?: JsonObject,
  requiresApproval = false,
): ToolCatalogDefinitionInput {
  const operation = capabilities.some(
    (capability) =>
      capability.endsWith(".write") ||
      capability.endsWith(".delete") ||
      capability.includes("commit") ||
      capability.includes("merge"),
  )
    ? "write"
    : "read";
  return {
    id,
    name,
    description,
    kind: "function",
    inputSchema,
    ...(outputSchema ? { outputSchema } : {}),
    operation,
    concurrencyKey: operation === "write" ? "workspace.write" : "workspace.read",
    capabilities,
    tags: ["workspace", "flary"],
    requiresApproval,
  };
}

function inputId(prefix: string, id: string): string {
  return prefix ? `${prefix}.${id}` : id;
}

function workspaceResourceKey(id: string, input: unknown): string {
  if (typeof input !== "object" || input === null) return `workspace:${id}`;
  const value = input as Record<string, unknown>;
  if (typeof value.path === "string") return `workspace:file:${value.path}`;
  if (typeof value.from === "string") return `workspace:file:${value.from}`;
  if (typeof value.fromPath === "string") {
    return `workspace:file:${value.fromPath}`;
  }
  if (id.startsWith("workspace.git.")) return "workspace:git";
  return "workspace:mutation";
}

function requireGit(target: WorkspaceToolTarget): WorkspaceGitOperations {
  if (!target.git) {
    throw new Error("Git capabilities are not configured for this workspace");
  }
  return target.git;
}

/**
 * Register Flary-owned workspace tools on a lazy ToolCatalog.
 *
 * The catalog returns only redacted descriptors. The target is retained by
 * the private capability closure and is never serialized into tool metadata.
 */
export function registerWorkspaceTools(
  catalog: ToolCatalog,
  target: WorkspaceToolTarget,
  options: WorkspaceToolRegistrationOptions = {},
): RegisteredWorkspaceTools {
  const prefix = options.prefix ?? "";
  const approval = options.requireApprovalForWrites ?? true;
  const descriptors: Array<CapabilityHandle["descriptor"]> = [];

  const register = <TInput, TOutput>(
    id: string,
    name: string,
    description: string,
    capabilities: string[],
    execute: (input: TInput) => TOutput | Promise<TOutput>,
    inputSchema: z.ZodType,
    outputSchema: z.ZodType,
    requiresApproval = false,
  ) => {
    const write = capabilities.some(
      (capability) =>
        capability.endsWith(".write") ||
        capability.endsWith(".delete") ||
        capability.includes("commit") ||
        capability.includes("merge"),
    );
    descriptors.push(
      catalog.register({
        definition: definition(
          inputId(prefix, id),
          name,
          description,
          capabilities,
          z.toJSONSchema(inputSchema) as JsonObject,
          z.toJSONSchema(outputSchema) as JsonObject,
          requiresApproval,
        ),
        execute: async (input) =>
          outputSchema.parse(await execute(input as TInput)),
        ...(write
          ? {
              resourceKey: (input: unknown) =>
                workspaceResourceKey(inputId(prefix, id), input),
            }
          : {}),
      }),
    );
  };

  register(
    "workspace.file.read",
    "Read workspace file",
    "Read a validated file from the current tenant workspace.",
    ["workspace.read"],
    (input) => target.read(ProjectFileReadRequestSchema.parse(input)),
    ProjectFileReadRequestSchema,
    ProjectFileReadResponseSchema,
  );
  register(
    "workspace.file.write",
    "Write workspace file",
    "Create or replace a file in the current tenant workspace.",
    ["workspace.write"],
    (input) => target.write(ProjectFileWriteRequestSchema.parse(input)),
    ProjectFileWriteRequestSchema,
    ProjectFileMutationResponseSchema,
    approval,
  );
  register(
    "workspace.file.edit",
    "Edit workspace file",
    "Apply exact text replacements to a workspace file.",
    ["workspace.write"],
    (input) => target.edit(ProjectFileEditRequestSchema.parse(input)),
    ProjectFileEditRequestSchema,
    ProjectFileEditResponseSchema,
    approval,
  );
  register(
    "workspace.file.apply-patch",
    "Apply workspace patch",
    "Apply a unified diff to one workspace text file.",
    ["workspace.write"],
    (input) => target.applyPatch(ProjectFilePatchRequestSchema.parse(input)),
    ProjectFilePatchRequestSchema,
    ProjectFilePatchResponseSchema,
    approval,
  );
  register(
    "workspace.file.delete",
    "Delete workspace file",
    "Delete one file or a validated directory tree.",
    ["workspace.delete"],
    (input) => target.delete(ProjectFileDeleteRequestSchema.parse(input)),
    ProjectFileDeleteRequestSchema,
    ProjectFileDeleteResponseSchema,
    approval,
  );
  register(
    "workspace.file.move",
    "Move workspace file",
    "Move a file inside the current workspace.",
    ["workspace.write"],
    (input) => target.move(ProjectFileMoveRequestSchema.parse(input)),
    ProjectFileMoveRequestSchema,
    ProjectFileMutationResponseSchema,
    approval,
  );
  register(
    "workspace.file.copy",
    "Copy workspace file",
    "Copy a file inside the current workspace.",
    ["workspace.write"],
    (input) => target.copy(ProjectFileCopyRequestSchema.parse(input)),
    ProjectFileCopyRequestSchema,
    ProjectFileMutationResponseSchema,
    approval,
  );
  register(
    "workspace.file.list",
    "List workspace files",
    "List files below a validated workspace prefix.",
    ["workspace.read"],
    (input) => target.list(ProjectFileListRequestSchema.parse(input)),
    ProjectFileListRequestSchema,
    ProjectFileListResponseSchema,
  );
  register(
    "workspace.file.stat",
    "Stat workspace file",
    "Read safe metadata for one workspace file.",
    ["workspace.read"],
    async (input) => {
      const request = ProjectFileReadRequestSchema.parse(input);
      return { file: await target.stat(request.path) };
    },
    ProjectFileReadRequestSchema,
    z.object({ file: ProjectFileEntrySchema }).strict(),
  );
  register(
    "workspace.file.glob",
    "Glob workspace files",
    "Find workspace files using a relative, path-safe glob.",
    ["workspace.read"],
    (input) => target.glob(WorkspaceGlobRequestSchema.parse(input)),
    WorkspaceGlobRequestSchema,
    WorkspaceGlobResponseSchema,
  );
  register(
    "workspace.file.grep",
    "Grep workspace files",
    "Search workspace text and return bounded line matches.",
    ["workspace.read"],
    (input) => target.grep(WorkspaceGrepRequestSchema.parse(input)),
    WorkspaceGrepRequestSchema,
    WorkspaceGrepResponseSchema,
  );
  register(
    "workspace.file.diff",
    "Diff workspace file",
    "Compare a workspace file with another file or proposed text.",
    ["workspace.read"],
    (input) => target.diff(WorkspaceDiffRequestSchema.parse(input)),
    WorkspaceDiffRequestSchema,
    WorkspaceDiffResponseSchema,
  );
  register(
    "workspace.file.batch-edit",
    "Batch edit workspace files",
    "Apply bounded text edits across workspace files with optional rollback.",
    ["workspace.write"],
    (input) => target.batchEdit(WorkspaceBatchEditRequestSchema.parse(input)),
    WorkspaceBatchEditRequestSchema,
    WorkspaceBatchEditResponseSchema,
    approval,
  );

  if (target.git) {
    register(
      "workspace.git.status",
      "Git status",
      "Inspect changed files in the current workspace branch.",
      ["workspace.git", "workspace.read"],
      (input) => requireGit(target).status(GitStatusRequestSchema.parse(input)),
      GitStatusRequestSchema,
      GitStatusResponseSchema,
    );
    register(
      "workspace.git.diff",
      "Git diff",
      "List the changed files in the current workspace branch.",
      ["workspace.git", "workspace.read"],
      (input) => requireGit(target).diff(GitDiffRequestSchema.parse(input)),
      GitDiffRequestSchema,
      GitDiffResponseSchema,
    );
    register(
      "workspace.git.branch",
      "Git branch",
      "List, create, or delete a branch in the current workspace.",
      ["workspace.git", "workspace.write"],
      (input) => requireGit(target).branch(GitBranchRequestSchema.parse(input)),
      GitBranchRequestSchema,
      GitBranchResponseSchema,
      approval,
    );
    register(
      "workspace.git.commit",
      "Git commit",
      "Create a commit in the current workspace branch.",
      ["workspace.git", "workspace.write"],
      (input) => requireGit(target).commit(GitCommitRequestSchema.parse(input)),
      GitCommitRequestSchema,
      GitCommitResponseSchema,
      approval,
    );
    register(
      "workspace.git.merge",
      "Git merge",
      "Merge a validated ref into the current workspace branch.",
      ["workspace.git", "workspace.write"],
      (input) => requireGit(target).merge(GitMergeRequestSchema.parse(input)),
      GitMergeRequestSchema,
      GitMergeResponseSchema,
      approval,
    );
  }

  return { descriptors };
}

export const WorkspaceToolResponseSchemas = {
  batchEdit: WorkspaceBatchEditResponseSchema,
  diff: WorkspaceDiffResponseSchema,
  glob: WorkspaceGlobResponseSchema,
  grep: WorkspaceGrepResponseSchema,
  gitBranch: GitBranchResponseSchema,
  gitCommit: GitCommitResponseSchema,
  gitDiff: GitDiffResponseSchema,
  gitMerge: GitMergeResponseSchema,
  gitStatus: GitStatusResponseSchema,
};

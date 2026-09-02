import { z } from "zod";

import {
  IdentifierSchema,
  MetadataSchema,
  NonEmptyStringSchema,
  TimestampSchema,
} from "../contracts/common.js";
import { RecallScopeSchema, type RecallScope } from "../contracts/recall.js";

const ArtifactPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      !path.split("/").some((segment) => segment === ".." || segment === ""),
    "Artifact paths must be relative and canonical",
  );

export const ArtifactBranchNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine(
    (branch) =>
      !branch.startsWith("/") && !branch.split("/").some((part) => part === ".." || part === ""),
    "Artifact branch names must be relative and canonical",
  );

export const ArtifactBranchSchema = z
  .object({
    repository: NonEmptyStringSchema.max(500),
    scope: RecallScopeSchema,
    branch: ArtifactBranchNameSchema.default("main"),
    headCommitId: IdentifierSchema.optional(),
    createdAt: TimestampSchema,
  })
  .strict();
export type ArtifactBranch = z.infer<typeof ArtifactBranchSchema>;

export const ArtifactRepositorySchema = z
  .object({
    repository: NonEmptyStringSchema.max(500),
    scope: RecallScopeSchema,
    createdAt: TimestampSchema,
  })
  .strict();
export type ArtifactRepository = z.infer<typeof ArtifactRepositorySchema>;

export const ArtifactFileSchema = z
  .object({
    path: ArtifactPathSchema,
    content: z.string().max(64 * 1024 * 1024),
    mediaType: z.string().trim().min(1).max(255).default("text/plain"),
    sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/i)
      .optional(),
    metadata: MetadataSchema.optional(),
  })
  .strict();
export type ArtifactFile = z.infer<typeof ArtifactFileSchema>;

export const ArtifactCommitSchema = z
  .object({
    id: IdentifierSchema,
    repository: NonEmptyStringSchema.max(500),
    scope: RecallScopeSchema,
    branch: ArtifactBranchNameSchema.default("main"),
    parentId: IdentifierSchema.optional(),
    files: z.array(ArtifactFileSchema).max(10_000),
    createdAt: TimestampSchema,
    metadata: MetadataSchema.optional(),
  })
  .strict()
  .superRefine((commit, context) => {
    const paths = commit.files.map((file) => file.path);
    if (new Set(paths).size !== paths.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["files"],
        message: "An artifact commit cannot contain duplicate paths",
      });
    }
  });
export type ArtifactCommit = z.infer<typeof ArtifactCommitSchema>;
export type ArtifactCommitInput = z.input<typeof ArtifactCommitSchema>;

// A history list never needs to send file contents. Keep the file descriptor
// so a client can show changed paths without opening the full commit.
export const ArtifactFileSummarySchema = z
  .object({
    path: ArtifactPathSchema,
    mediaType: z.string().trim().min(1).max(255),
    sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/i)
      .optional(),
    metadata: MetadataSchema.optional(),
  })
  .strict();
export type ArtifactFileSummary = z.infer<typeof ArtifactFileSummarySchema>;

export const ArtifactCommitSummarySchema = z
  .object({
    id: IdentifierSchema,
    repository: NonEmptyStringSchema.max(500),
    scope: RecallScopeSchema,
    branch: ArtifactBranchNameSchema.default("main"),
    parentId: IdentifierSchema.optional(),
    files: z.array(ArtifactFileSummarySchema).max(10_000),
    createdAt: TimestampSchema,
    metadata: MetadataSchema.optional(),
  })
  .strict();
export type ArtifactCommitSummary = z.infer<typeof ArtifactCommitSummarySchema>;

export function summarizeArtifactCommit(commit: ArtifactCommit): ArtifactCommitSummary {
  return ArtifactCommitSummarySchema.parse({
    id: commit.id,
    repository: commit.repository,
    scope: commit.scope,
    branch: commit.branch,
    ...(commit.parentId ? { parentId: commit.parentId } : {}),
    files: commit.files.map((file) => ({
      path: file.path,
      mediaType: file.mediaType,
      ...(file.sha256 ? { sha256: file.sha256 } : {}),
      ...(file.metadata ? { metadata: file.metadata } : {}),
    })),
    createdAt: commit.createdAt,
    ...(commit.metadata ? { metadata: commit.metadata } : {}),
  });
}

export const ArtifactDiffFileSchema = z
  .object({
    path: ArtifactPathSchema,
    status: z.enum(["added", "modified", "deleted", "unchanged"]),
    beforeSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/i)
      .optional(),
    afterSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/i)
      .optional(),
    beforeContent: z
      .string()
      .max(64 * 1024 * 1024)
      .optional(),
    afterContent: z
      .string()
      .max(64 * 1024 * 1024)
      .optional(),
  })
  .strict();
export type ArtifactDiffFile = z.infer<typeof ArtifactDiffFileSchema>;

export const ArtifactDiffSchema = z
  .object({
    repository: NonEmptyStringSchema.max(500),
    scope: RecallScopeSchema,
    branch: ArtifactBranchNameSchema.default("main"),
    baseCommitId: IdentifierSchema.optional(),
    headCommitId: IdentifierSchema,
    files: z.array(ArtifactDiffFileSchema).max(10_000),
  })
  .strict();
export type ArtifactDiff = z.infer<typeof ArtifactDiffSchema>;

export const ArtifactSearchHitSchema = z
  .object({
    commitId: IdentifierSchema,
    repository: NonEmptyStringSchema,
    scope: RecallScopeSchema,
    path: ArtifactPathSchema,
    snippet: NonEmptyStringSchema,
    lineStart: z.number().int().positive(),
    lineEnd: z.number().int().positive(),
    createdAt: TimestampSchema,
  })
  .strict();
export type ArtifactSearchHit = z.infer<typeof ArtifactSearchHitSchema>;

export interface ArtifactHistoryStore {
  commit(input: ArtifactCommitInput): Promise<ArtifactCommit>;
  read(repository: string, commitId: string): Promise<ArtifactCommit | undefined>;
  list(
    repository: string,
    scope: RecallScope,
    branch?: string,
    limit?: number,
  ): Promise<ArtifactCommit[]>;
  latest(
    repository: string,
    scope: RecallScope,
    branch?: string,
  ): Promise<ArtifactCommit | undefined>;
  repository(repository: string, scope: RecallScope): Promise<ArtifactRepository>;
  branch(repository: string, scope: RecallScope, branch?: string): Promise<ArtifactBranch>;
  checkpoint(input: ArtifactCommitInput): Promise<ArtifactCommit>;
  diff(
    repository: string,
    scope: RecallScope,
    baseCommitId: string | undefined,
    headCommitId: string,
    branch?: string,
  ): Promise<ArtifactDiff>;
  fork(
    repository: string,
    scope: RecallScope,
    sourceBranch: string,
    targetBranch: string,
    commitId?: string,
  ): Promise<ArtifactBranch>;
  merge(
    repository: string,
    scope: RecallScope,
    sourceBranch: string,
    targetBranch: string,
  ): Promise<ArtifactCommit>;
  searchExact(
    repository: string,
    scope: RecallScope,
    query: string,
    limit?: number,
  ): Promise<ArtifactSearchHit[]>;
}

function scopeKey(scope: RecallScope): string {
  return JSON.stringify(scope);
}

function snippet(
  content: string,
  query: string,
):
  | {
      value: string;
      lineStart: number;
      lineEnd: number;
    }
  | undefined {
  const lines = content.split(/\r?\n/);
  const needle = query.toLocaleLowerCase();
  const index = lines.findIndex((line) => line.toLocaleLowerCase().includes(needle));
  if (index < 0) return undefined;
  const start = Math.max(0, index - 1);
  const end = Math.min(lines.length, index + 2);
  return {
    value: lines.slice(start, end).join("\n").slice(0, 500),
    lineStart: start + 1,
    lineEnd: end,
  };
}

export class InMemoryArtifactHistoryStore implements ArtifactHistoryStore {
  readonly #commits = new Map<string, ArtifactCommit>();
  readonly #latest = new Map<string, string>();
  readonly #branches = new Map<string, ArtifactBranch>();

  async commit(input: ArtifactCommitInput): Promise<ArtifactCommit> {
    const commit = ArtifactCommitSchema.parse(input);
    const key = branchKey(commit.repository, commit.scope, commit.branch);
    if (this.#commits.has(commit.id)) {
      const existing = this.#commits.get(commit.id)!;
      if (JSON.stringify(existing) !== JSON.stringify(commit)) {
        throw new Error("Artifact commit IDs are immutable");
      }
      return existing;
    }
    this.#commits.set(commit.id, commit);
    this.#latest.set(key, commit.id);
    this.#branches.set(key, {
      repository: commit.repository,
      scope: commit.scope,
      branch: commit.branch,
      headCommitId: commit.id,
      createdAt: commit.createdAt,
    });
    return commit;
  }

  async read(repository: string, commitId: string): Promise<ArtifactCommit | undefined> {
    const commit = this.#commits.get(commitId);
    return commit?.repository === repository ? commit : undefined;
  }

  async list(
    repository: string,
    scope: RecallScope,
    branch = "main",
    limit = 50,
  ): Promise<ArtifactCommit[]> {
    const parsedScope = RecallScopeSchema.parse(scope);
    const parsedBranch = ArtifactBranchNameSchema.parse(branch);
    const boundedLimit = listLimit(limit);
    return [...this.#commits.values()]
      .filter(
        (commit) =>
          commit.repository === repository &&
          scopeKey(commit.scope) === scopeKey(parsedScope) &&
          commit.branch === parsedBranch,
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, boundedLimit);
  }

  async latest(
    repository: string,
    scope: RecallScope,
    branch = "main",
  ): Promise<ArtifactCommit | undefined> {
    const id = this.#latest.get(branchKey(repository, scope, branch));
    return id ? this.read(repository, id) : undefined;
  }

  async repository(repository: string, scope: RecallScope): Promise<ArtifactRepository> {
    return ArtifactRepositorySchema.parse({
      repository: NonEmptyStringSchema.parse(repository),
      scope: RecallScopeSchema.parse(scope),
      createdAt: new Date().toISOString(),
    });
  }

  async branch(repository: string, scope: RecallScope, branch = "main"): Promise<ArtifactBranch> {
    const parsedBranch = ArtifactBranchNameSchema.parse(branch);
    const key = branchKey(repository, scope, parsedBranch);
    const existing = this.#branches.get(key);
    if (existing) return existing;
    return ArtifactBranchSchema.parse({
      repository: NonEmptyStringSchema.parse(repository),
      scope: RecallScopeSchema.parse(scope),
      branch: parsedBranch,
      createdAt: new Date().toISOString(),
    });
  }

  async checkpoint(input: ArtifactCommitInput): Promise<ArtifactCommit> {
    return this.commit(input);
  }

  async diff(
    repository: string,
    scope: RecallScope,
    baseCommitId: string | undefined,
    headCommitId: string,
    branch = "main",
  ): Promise<ArtifactDiff> {
    const head = await this.requireCommit(repository, headCommitId, scope);
    const parsedBranch = ArtifactBranchNameSchema.parse(branch);
    if (head.branch !== parsedBranch) {
      throw new Error("Artifact diff branch does not match the head commit");
    }
    const base = baseCommitId
      ? await this.requireCommit(repository, baseCommitId, scope)
      : undefined;
    return buildArtifactDiff(repository, scope, parsedBranch, base, head);
  }

  async fork(
    repository: string,
    scope: RecallScope,
    sourceBranch: string,
    targetBranch: string,
    commitId?: string,
  ): Promise<ArtifactBranch> {
    const source = await this.branch(repository, scope, sourceBranch);
    const headCommitId = commitId ?? source.headCommitId;
    if (headCommitId) await this.requireCommit(repository, headCommitId, scope);
    const target = ArtifactBranchSchema.parse({
      repository,
      scope,
      branch: targetBranch,
      headCommitId,
      createdAt: new Date().toISOString(),
    });
    this.#branches.set(branchKey(repository, scope, target.branch), target);
    if (headCommitId) {
      this.#latest.set(branchKey(repository, scope, target.branch), headCommitId);
    }
    return target;
  }

  async merge(
    repository: string,
    scope: RecallScope,
    sourceBranch: string,
    targetBranch: string,
  ): Promise<ArtifactCommit> {
    const source = await this.branch(repository, scope, sourceBranch);
    if (!source.headCommitId) throw new Error("The source artifact branch is empty");
    const target = await this.branch(repository, scope, targetBranch);
    const sourceHead = await this.requireCommit(repository, source.headCommitId, scope);
    const id = `${target.branch}-merge-${sourceHead.id}`.slice(0, 200);
    return this.commit({
      ...sourceHead,
      id,
      branch: target.branch,
      parentId: target.headCommitId,
      createdAt: new Date().toISOString(),
      metadata: { ...sourceHead.metadata, mergeSourceBranch: source.branch },
    });
  }

  async searchExact(
    repository: string,
    scope: RecallScope,
    query: string,
    limit = 10,
  ): Promise<ArtifactSearchHit[]> {
    const needle = NonEmptyStringSchema.parse(query);
    const matches: ArtifactSearchHit[] = [];
    for (const commit of this.#commits.values()) {
      if (commit.repository !== repository) continue;
      if (scopeKey(commit.scope) !== scopeKey(scope)) continue;
      for (const file of commit.files) {
        const found = snippet(file.content, needle);
        if (!found) continue;
        matches.push(
          ArtifactSearchHitSchema.parse({
            commitId: commit.id,
            repository: commit.repository,
            scope: commit.scope,
            path: file.path,
            snippet: found.value,
            lineStart: found.lineStart,
            lineEnd: found.lineEnd,
            createdAt: commit.createdAt,
          }),
        );
      }
    }
    return matches
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit);
  }

  private async requireCommit(
    repository: string,
    commitId: string,
    scope: RecallScope,
  ): Promise<ArtifactCommit> {
    const commit = await this.read(repository, commitId);
    if (!commit || scopeKey(commit.scope) !== scopeKey(scope)) {
      throw new Error("Artifact commit was not found in the requested scope");
    }
    return commit;
  }
}

function branchKey(repository: string, scope: RecallScope, branch: string): string {
  return repository + ":" + scopeKey(scope) + ":" + ArtifactBranchNameSchema.parse(branch);
}

function listLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error("Artifact history limit must be an integer from 1 to 100");
  }
  return value;
}

export function buildArtifactDiff(
  repository: string,
  scope: RecallScope,
  branch: string,
  base: ArtifactCommit | undefined,
  head: ArtifactCommit,
): ArtifactDiff {
  const before = new Map((base?.files ?? []).map((file) => [file.path, file]));
  const after = new Map(head.files.map((file) => [file.path, file]));
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  const files = paths.map((path) => {
    const oldFile = before.get(path);
    const newFile = after.get(path);
    const status = !oldFile
      ? "added"
      : !newFile
        ? "deleted"
        : oldFile.content === newFile.content
          ? "unchanged"
          : "modified";
    return ArtifactDiffFileSchema.parse({
      path,
      status,
      ...(oldFile ? { beforeContent: oldFile.content, beforeSha256: oldFile.sha256 } : {}),
      ...(newFile ? { afterContent: newFile.content, afterSha256: newFile.sha256 } : {}),
    });
  });
  return ArtifactDiffSchema.parse({
    repository,
    scope,
    branch,
    ...(base ? { baseCommitId: base.id } : {}),
    headCommitId: head.id,
    files,
  });
}

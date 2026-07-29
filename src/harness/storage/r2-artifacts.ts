import {
  ArtifactCommitSchema,
  ArtifactBranchSchema,
  ArtifactRepositorySchema,
  ArtifactBranchNameSchema,
  buildArtifactDiff,
  type ArtifactBranch,
  type ArtifactDiff,
  type ArtifactHistoryStore,
  type ArtifactCommit,
  type ArtifactCommitInput,
  type ArtifactRepository,
  type ArtifactSearchHit,
} from "./artifacts";
import { RecallScopeSchema, type RecallScope } from "../contracts/recall";
import type { StorageScope } from "../contracts/tenancy";
import { tenantStoragePrefix } from "./scopes";

export interface ArtifactR2ObjectBody {
  text(): Promise<string>;
}

export interface ArtifactR2Bucket {
  put(
    key: string,
    value: string,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
  get(key: string): Promise<ArtifactR2ObjectBody | null>;
  list?(options?: {
    prefix?: string;
    cursor?: string;
    limit?: number;
  }): Promise<{
    objects: Array<{ key: string }>;
    truncated?: boolean;
    cursor?: string;
  }>;
}

export interface R2ArtifactHistoryStoreOptions {
  bucket: ArtifactR2Bucket;
  scope: StorageScope;
  repository?: string;
}

/**
 * Immutable ArtifactHistoryStore backed by tenant-scoped R2 JSON objects.
 *
 * Cloudflare Artifacts can replace this adapter when the binding is available.
 * The contract stays the same, and R2 remains a safe self-hosted fallback.
 */
export class R2ArtifactHistoryStore implements ArtifactHistoryStore {
  readonly #bucket: ArtifactR2Bucket;
  readonly #scope: StorageScope;
  readonly #repository: string | undefined;

  constructor(options: R2ArtifactHistoryStoreOptions) {
    this.#bucket = options.bucket;
    this.#scope = options.scope;
    this.#repository = options.repository;
  }

  async commit(input: ArtifactCommitInput): Promise<ArtifactCommit> {
    const commit = ArtifactCommitSchema.parse(input);
    this.assertScope(commit.scope);
    this.assertRepository(commit.repository);
    const key = this.commitKey(commit.repository, commit.id);
    const existing = await this.readObject(key);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(commit)) {
        throw new Error("Artifact commit IDs are immutable");
      }
      return existing;
    }

    await this.#bucket.put(key, JSON.stringify(commit), {
      httpMetadata: { contentType: "application/json" },
    });
    await this.#bucket.put(
      this.latestKey(commit.repository, commit.scope, commit.branch),
      JSON.stringify({ commitId: commit.id }),
      { httpMetadata: { contentType: "application/json" } },
    );
    return commit;
  }

  async read(
    repository: string,
    commitId: string,
  ): Promise<ArtifactCommit | undefined> {
    this.assertRepository(repository);
    const object = await this.readObject(this.commitKey(repository, commitId));
    return object;
  }

  async list(
    repository: string,
    scope: RecallScope,
    branch = "main",
    limit = 50,
  ): Promise<ArtifactCommit[]> {
    const parsedScope = RecallScopeSchema.parse(scope);
    const parsedBranch = ArtifactBranchNameSchema.parse(branch);
    this.assertScope(parsedScope);
    this.assertRepository(repository);
    if (!this.#bucket.list) {
      throw new Error("R2 list is required for artifact history");
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("Artifact history limit must be an integer from 1 to 100");
    }
    const objects = await this.listAll(this.commitPrefix(repository));
    const commits = await Promise.all(
      objects.map((object) => this.readObject(object.key)),
    );
    return commits
      .filter(
        (commit): commit is ArtifactCommit =>
          commit !== undefined &&
          commit.repository === repository &&
          commit.branch === parsedBranch &&
          JSON.stringify(commit.scope) === JSON.stringify(parsedScope),
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit);
  }

  async latest(
    repository: string,
    scope: RecallScope,
    branch = "main",
  ): Promise<ArtifactCommit | undefined> {
    const parsedScope = RecallScopeSchema.parse(scope);
    this.assertScope(parsedScope);
    this.assertRepository(repository);
    const pointerObject = await this.#bucket.get(
      this.latestKey(repository, parsedScope, branch),
    );
    if (!pointerObject) return undefined;
    const pointer = JSON.parse(await pointerObject.text()) as {
      commitId?: string;
    };
    if (!pointer.commitId) return undefined;
    return this.read(repository, pointer.commitId);
  }

  async repository(
    repository: string,
    scope: RecallScope,
  ): Promise<ArtifactRepository> {
    this.assertScope(scope);
    this.assertRepository(repository);
    return ArtifactRepositorySchema.parse({
      repository,
      scope,
      createdAt: new Date().toISOString(),
    });
  }

  async branch(
    repository: string,
    scope: RecallScope,
    branch = "main",
  ): Promise<ArtifactBranch> {
    const parsedScope = RecallScopeSchema.parse(scope);
    const parsedBranch = ArtifactBranchNameSchema.parse(branch);
    this.assertScope(parsedScope);
    this.assertRepository(repository);
    const pointerObject = await this.#bucket.get(
      this.latestKey(repository, parsedScope, parsedBranch),
    );
    let headCommitId: string | undefined;
    if (pointerObject) {
      const pointer = JSON.parse(await pointerObject.text()) as { commitId?: string };
      headCommitId = pointer.commitId;
    }
    return ArtifactBranchSchema.parse({
      repository,
      scope: parsedScope,
      branch: parsedBranch,
      ...(headCommitId ? { headCommitId } : {}),
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
    const parsedScope = RecallScopeSchema.parse(scope);
    const parsedBranch = ArtifactBranchNameSchema.parse(branch);
    const head = await this.requireCommit(repository, headCommitId, parsedScope);
    if (head.branch !== parsedBranch) {
      throw new Error("Artifact diff branch does not match the head commit");
    }
    const base = baseCommitId
      ? await this.requireCommit(repository, baseCommitId, parsedScope)
      : undefined;
    return buildArtifactDiff(repository, parsedScope, parsedBranch, base, head);
  }

  async fork(
    repository: string,
    scope: RecallScope,
    sourceBranch: string,
    targetBranch: string,
    commitId?: string,
  ): Promise<ArtifactBranch> {
    const parsedScope = RecallScopeSchema.parse(scope);
    const source = await this.branch(repository, parsedScope, sourceBranch);
    const headCommitId = commitId ?? source.headCommitId;
    if (headCommitId) await this.requireCommit(repository, headCommitId, parsedScope);
    const target = ArtifactBranchSchema.parse({
      repository,
      scope: parsedScope,
      branch: targetBranch,
      ...(headCommitId ? { headCommitId } : {}),
      createdAt: new Date().toISOString(),
    });
    await this.#bucket.put(
      this.latestKey(repository, parsedScope, target.branch),
      JSON.stringify({ commitId: headCommitId }),
      { httpMetadata: { contentType: "application/json" } },
    );
    return target;
  }

  async merge(
    repository: string,
    scope: RecallScope,
    sourceBranch: string,
    targetBranch: string,
  ): Promise<ArtifactCommit> {
    const parsedScope = RecallScopeSchema.parse(scope);
    const source = await this.branch(repository, parsedScope, sourceBranch);
    if (!source.headCommitId) throw new Error("The source artifact branch is empty");
    const target = await this.branch(repository, parsedScope, targetBranch);
    const sourceHead = await this.requireCommit(repository, source.headCommitId, parsedScope);
    return this.commit({
      ...sourceHead,
      id: `${target.branch}-merge-${sourceHead.id}`.slice(0, 200),
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
    const parsedScope = RecallScopeSchema.parse(scope);
    this.assertScope(parsedScope);
    this.assertRepository(repository);
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error("Artifact search limit must be a positive integer");
    }
    if (!this.#bucket.list) {
      throw new Error("R2 list is required for exact artifact search");
    }
    const objects = await this.listAll(this.commitPrefix(repository));
    const commits = await Promise.all(
      objects.map((object) => this.readObject(object.key)),
    );
    const hits: ArtifactSearchHit[] = [];
    for (const commit of commits) {
      if (!commit || commit.repository !== repository) continue;
      if (commit.branch !== this.#scope.branch) continue;
      // A project or app search includes documents committed from a narrower
      // session scope. The tenant prefix still isolates the workspace.
      if (!scopeContains(parsedScope, commit.scope)) continue;
      for (const file of commit.files) {
        const found = findSnippet(file.content, query);
        if (!found) continue;
        hits.push({
          commitId: commit.id,
          repository: commit.repository,
          scope: commit.scope,
          path: file.path,
          snippet: found.snippet,
          lineStart: found.lineStart,
          lineEnd: found.lineEnd,
          createdAt: commit.createdAt,
        });
      }
    }
    return hits
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit);
  }

  private async readObject(key: string): Promise<ArtifactCommit | undefined> {
    const object = await this.#bucket.get(key);
    if (!object) return undefined;
    return ArtifactCommitSchema.parse(JSON.parse(await object.text()));
  }

  private async listAll(prefix: string): Promise<Array<{ key: string }>> {
    const objects: Array<{ key: string }> = [];
    let cursor: string | undefined;
    do {
      const page = await this.#bucket.list!({ prefix, cursor, limit: 1_000 });
      objects.push(...page.objects);
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return objects;
  }

  private commitPrefix(repository: string): string {
    return `${tenantStoragePrefix(this.#scope)}/history/commits/${encodeURIComponent(repository)}/`;
  }

  private commitKey(repository: string, commitId: string): string {
    return `${this.commitPrefix(repository)}${encodeURIComponent(commitId)}.json`;
  }

  private latestKey(repository: string, scope: RecallScope, branch = "main"): string {
    return `${tenantStoragePrefix(this.#scope)}/history/latest/${encodeURIComponent(repository)}/${encodeURIComponent(ArtifactBranchNameSchema.parse(branch))}/${encodeURIComponent(JSON.stringify(scope))}.json`;
  }

  private async requireCommit(
    repository: string,
    commitId: string,
    scope: RecallScope,
  ): Promise<ArtifactCommit> {
    const commit = await this.read(repository, commitId);
    if (!commit || JSON.stringify(commit.scope) !== JSON.stringify(scope)) {
      throw new Error("Artifact commit was not found in the requested scope");
    }
    return commit;
  }

  private assertScope(scope: RecallScope): void {
    if (
      scope.organizationId !== this.#scope.organizationId ||
      (scope.appId !== undefined && scope.appId !== this.#scope.appId) ||
      (scope.projectId !== undefined && scope.projectId !== this.#scope.projectId)
    ) {
      throw new Error("Artifact scope does not match the workspace tenant");
    }
  }

  private assertRepository(repository: string): void {
    if (this.#repository && repository !== this.#repository) {
      throw new Error("Artifact repository is not available in this store");
    }
  }
}

function scopeContains(parent: RecallScope, child: RecallScope): boolean {
  if (parent.organizationId !== child.organizationId) return false;
  if (parent.kind === "organization") return true;
  if (parent.appId !== child.appId) return false;
  if (parent.kind === "app") return true;
  if (parent.projectId !== child.projectId) return false;
  if (parent.kind === "project") return true;
  return parent.sessionId === child.sessionId;
}

function findSnippet(
  content: string,
  query: string,
): { snippet: string; lineStart: number; lineEnd: number } | undefined {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return undefined;
  const lines = content.split(/\r?\n/);
  const index = lines.findIndex((line) => line.toLocaleLowerCase().includes(needle));
  if (index < 0) return undefined;
  const start = Math.max(0, index - 1);
  const end = Math.min(lines.length, index + 2);
  return {
    snippet: lines.slice(start, end).join("\n").slice(0, 500),
    lineStart: start + 1,
    lineEnd: end,
  };
}

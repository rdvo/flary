import { InMemoryFs } from "@cloudflare/shell";
import { createGit } from "@cloudflare/shell/git";
import {
  ArtifactBranchNameSchema,
  ArtifactBranchSchema,
  ArtifactCommitSchema,
  ArtifactRepositorySchema,
  buildArtifactDiff,
  type ArtifactBranch,
  type ArtifactCommit,
  type ArtifactCommitInput,
  type ArtifactDiff,
  type ArtifactHistoryStore,
  type ArtifactRepository,
  type ArtifactSearchHit,
} from "flary/storage";
import { RecallScopeSchema, type RecallScope } from "flary/contracts";
import type { StorageScope } from "flary/contracts";

const INTERNAL_METADATA_PATH = ".flary/commit.json";
const GIT_DIR = "/flary-repository";
const TOKEN_TTL_SECONDS = 300;

export interface ArtifactsRepositoryHandle {
  name: string;
  remote: string;
  lastPushAt?: string | null;
  createToken(
    scope?: "write" | "read",
    ttl?: number,
  ): Promise<{ plaintext: string }>;
}

export interface ArtifactsBinding {
  create(
    name: string,
    options?: {
      readOnly?: boolean;
      description?: string;
      setDefaultBranch?: string;
    },
  ): Promise<{
    name: string;
    remote: string;
    token: string;
    tokenExpiresAt?: string;
  }>;
  get(name: string): Promise<ArtifactsRepositoryHandle>;
}

interface CommitMetadata {
  version: 1;
  logicalId: string;
  repository: string;
  scope: RecallScope;
  branch: string;
  parentId?: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
  files: Array<{
    path: string;
    mediaType: string;
    sha256?: string;
    metadata?: Record<string, unknown>;
  }>;
}

interface GitContext {
  fs: InMemoryFs;
  git: ReturnType<typeof createGit>;
  repository: ArtifactsRepositoryHandle;
  token: string;
  branch: string;
}

/**
 * ArtifactHistoryStore backed by a Cloudflare Artifacts Git repository.
 *
 * Artifacts owns the repository and Git objects. Flary keeps its own stable
 * commit metadata in a hidden file so retries remain idempotent and the
 * public history contract stays independent from Git implementation details.
 */
export class CloudflareArtifactHistoryStore implements ArtifactHistoryStore {
  readonly #artifacts: ArtifactsBinding;
  readonly #scope: StorageScope;
  readonly #repository: string;

  constructor(options: {
    artifacts: ArtifactsBinding;
    scope: StorageScope;
    repository: string;
  }) {
    this.#artifacts = options.artifacts;
    this.#scope = options.scope;
    this.#repository = options.repository;
  }

  async commit(input: ArtifactCommitInput): Promise<ArtifactCommit> {
    const requested = ArtifactCommitSchema.parse(input);
    this.assertScope(requested.scope);
    this.assertRepository(requested.repository);
    const context = await this.open(requested.branch, true);
    const existing = await this.findLogicalCommit(context, requested.id);
    if (existing) return existing;

    await this.replaceFiles(context, requested.files);
    const parentId = requested.parentId ?? (await this.head(context));
    const metadata: CommitMetadata = {
      version: 1,
      logicalId: requested.id,
      repository: requested.repository,
      scope: requested.scope,
      branch: requested.branch,
      ...(parentId ? { parentId } : {}),
      createdAt: requested.createdAt,
      ...(requested.metadata ? { metadata: requested.metadata } : {}),
      files: requested.files.map((file) => ({
        path: file.path,
        mediaType: file.mediaType,
        ...(file.sha256 ? { sha256: file.sha256 } : {}),
        ...(file.metadata ? { metadata: file.metadata } : {}),
      })),
    };
    await context.fs.writeFile(
      `${GIT_DIR}/${INTERNAL_METADATA_PATH}`,
      JSON.stringify(metadata),
    );
    await context.git.add({ dir: GIT_DIR, filepath: "." });
    const result = await context.git.commit({
      dir: GIT_DIR,
      message: `Flary checkpoint ${requested.id}`,
      author: { name: "Flary", email: "system@flary.dev" },
    });
    await context.git.push({
      dir: GIT_DIR,
      ref: requested.branch,
      username: "x",
      password: context.token,
    });
    return this.readCommittedTree(context, result.oid);
  }

  async checkpoint(input: ArtifactCommitInput): Promise<ArtifactCommit> {
    return this.commit(input);
  }

  async read(
    repository: string,
    commitId: string,
  ): Promise<ArtifactCommit | undefined> {
    this.assertRepository(repository);
    const context = await this.open(this.#scope.branch, false);
    if (!(await this.hasCommits(context))) return undefined;
    const oid = await this.resolveCommit(context, commitId);
    if (!oid) return undefined;
    const commit = await this.readCommittedTree(context, oid);
    return sameStorageScope(commit.scope, this.#scope)
      ? commit
      : undefined;
  }

  async list(
    repository: string,
    scope: RecallScope,
    branch = "main",
    limit = 50,
  ): Promise<ArtifactCommit[]> {
    this.assertRepository(repository);
    this.assertScope(scope);
    const parsedBranch = ArtifactBranchNameSchema.parse(branch);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("Artifact history limit must be an integer from 1 to 100");
    }
    const context = await this.open(parsedBranch, false);
    const entries = await context.git
      .log({
        dir: GIT_DIR,
        ref: parsedBranch,
        depth: Math.max(limit, 100),
      })
      .catch(() => []);
    const commits: ArtifactCommit[] = [];
    for (const entry of entries) {
      try {
        const commit = await this.readCommittedTree(context, entry.oid);
        if (commit.repository !== repository) continue;
        if (commit.branch !== parsedBranch) continue;
        if (JSON.stringify(commit.scope) !== JSON.stringify(scope)) continue;
        commits.push(commit);
        if (commits.length >= limit) break;
      } catch {
        // Ignore commits that are not Flary history records.
      }
    }
    return commits;
  }

  async latest(
    repository: string,
    scope: RecallScope,
    branch = "main",
  ): Promise<ArtifactCommit | undefined> {
    this.assertRepository(repository);
    this.assertScope(scope);
    const context = await this.open(branch, false);
    const oid = await this.head(context);
    if (!oid) return undefined;
    const commit = await this.readCommittedTree(context, oid);
    return scopeContains(scope, commit.scope) ? commit : undefined;
  }

  async repository(
    repository: string,
    scope: RecallScope,
  ): Promise<ArtifactRepository> {
    this.assertRepository(repository);
    this.assertScope(scope);
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
    const parsedBranch = ArtifactBranchNameSchema.parse(branch);
    const head = await this.latest(repository, scope, parsedBranch);
    return ArtifactBranchSchema.parse({
      repository,
      scope,
      branch: parsedBranch,
      ...(head ? { headCommitId: head.id } : {}),
      createdAt: head?.createdAt ?? new Date().toISOString(),
    });
  }

  async diff(
    repository: string,
    scope: RecallScope,
    baseCommitId: string | undefined,
    headCommitId: string,
    branch = "main",
  ): Promise<ArtifactDiff> {
    const head = await this.requireCommit(repository, scope, headCommitId);
    const base = baseCommitId
      ? await this.requireCommit(repository, scope, baseCommitId)
      : undefined;
    if (head.branch !== ArtifactBranchNameSchema.parse(branch)) {
      throw new Error("Artifact diff branch does not match the head commit");
    }
    if (base && base.branch !== head.branch) {
      throw new Error("Artifact diff base branch does not match the head commit");
    }
    return buildArtifactDiff(repository, scope, head.branch, base, head);
  }

  async fork(
    repository: string,
    scope: RecallScope,
    sourceBranch: string,
    targetBranch: string,
    commitId?: string,
  ): Promise<ArtifactBranch> {
    this.assertRepository(repository);
    this.assertScope(scope);
    const source = await this.branch(repository, scope, sourceBranch);
    const sourceHead = commitId ?? source.headCommitId;
    if (!sourceHead) {
      return ArtifactBranchSchema.parse({
        repository,
        scope,
        branch: targetBranch,
        createdAt: new Date().toISOString(),
      });
    }
    const context = await this.open(sourceBranch, true);
    const branches = await context.git.branch({ dir: GIT_DIR, list: true });
    if (branchNames(branches, []).includes(targetBranch)) {
      await context.git.checkout({ dir: GIT_DIR, ref: targetBranch, force: true });
    } else {
      await context.git.checkout({ dir: GIT_DIR, branch: targetBranch, force: true });
    }
    await context.git.push({
      dir: GIT_DIR,
      ref: targetBranch,
      username: "x",
      password: context.token,
    });
    return ArtifactBranchSchema.parse({
      repository,
      scope,
      branch: targetBranch,
      headCommitId: sourceHead,
      createdAt: new Date().toISOString(),
    });
  }

  async merge(
    repository: string,
    scope: RecallScope,
    sourceBranch: string,
    targetBranch: string,
  ): Promise<ArtifactCommit> {
    const source = await this.branch(repository, scope, sourceBranch);
    if (!source.headCommitId) throw new Error("The source artifact branch is empty");
    const sourceHead = await this.requireCommit(repository, scope, source.headCommitId);
    const target = await this.branch(repository, scope, targetBranch);
    const id = `merge-${sourceBranch}-${sourceHead.id}`.slice(0, 200);
    return this.commit({
      id,
      repository,
      scope,
      branch: targetBranch,
      ...(target.headCommitId ? { parentId: target.headCommitId } : {}),
      files: sourceHead.files,
      createdAt: new Date().toISOString(),
      metadata: { ...sourceHead.metadata, mergeSourceBranch: sourceBranch },
    });
  }

  async searchExact(
    repository: string,
    scope: RecallScope,
    query: string,
    limit = 10,
  ): Promise<ArtifactSearchHit[]> {
    this.assertRepository(repository);
    this.assertScope(scope);
    const context = await this.open(this.#scope.branch, false);
    const names = [this.#scope.branch];
    const commits = new Map<string, ArtifactCommit>();
    for (const branch of names) {
      const entries = await context.git.log({ dir: GIT_DIR, ref: branch, depth: 5000 });
      for (const entry of entries) {
        if (commits.has(entry.oid)) continue;
        try {
          const commit = await this.readCommittedTree(context, entry.oid);
          if (scopeContains(scope, commit.scope)) commits.set(entry.oid, commit);
        } catch {
          // Ignore commits created outside Flary's history format.
        }
      }
    }
    const hits: ArtifactSearchHit[] = [];
    const needle = query.toLocaleLowerCase();
    for (const commit of commits.values()) {
      for (const file of commit.files) {
        const lines = file.content.split(/\r?\n/);
        const index = lines.findIndex((line) => line.toLocaleLowerCase().includes(needle));
        if (index < 0) continue;
        hits.push({
          commitId: commit.id,
          repository,
          scope: commit.scope,
          path: file.path,
          snippet: lines.slice(Math.max(0, index - 1), index + 2).join("\n").slice(0, 500),
          lineStart: index + 1,
          lineEnd: Math.min(lines.length, index + 2),
          createdAt: commit.createdAt,
        });
        if (hits.length >= limit) return hits;
      }
    }
    return hits;
  }

  private async open(branch: string, write: boolean): Promise<GitContext> {
    const repository = await this.getRepository();
    const tokenResult = await repository.createToken(
      write ? "write" : "read",
      TOKEN_TTL_SECONDS,
    );
    const token = tokenSecret(tokenResult.plaintext);
    const fs = new InMemoryFs();
    const git = createGit(fs, GIT_DIR);
    const hasRemoteHistory = Boolean(repository.lastPushAt);
    if (hasRemoteHistory) {
      await git.clone({
        dir: GIT_DIR,
        url: repository.remote,
        singleBranch: false,
        username: "x",
        password: token,
      });
    } else {
      await git.init({ dir: GIT_DIR, defaultBranch: branch });
      await git.remote({
        dir: GIT_DIR,
        add: { name: "origin", url: repository.remote },
      });
    }
    const branches = await git.branch({ dir: GIT_DIR, list: true });
    const names = branchNames(branches, []);
    if (names.length > 0 && !names.includes(branch)) {
      await git.checkout({ dir: GIT_DIR, branch, force: true });
    } else if (names.includes(branch)) {
      await git.checkout({ dir: GIT_DIR, ref: branch, force: true });
    }
    return { fs, git, repository, token, branch };
  }

  private async getRepository(): Promise<ArtifactsRepositoryHandle> {
    try {
      return await this.#artifacts.get(this.#repository);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      const created = await this.#artifacts.create(this.#repository, {
        description: "Flary project history",
        setDefaultBranch: "main",
      });
      return {
        name: created.name,
        remote: created.remote,
        lastPushAt: null,
        createToken: async () => ({ plaintext: created.token }),
      };
    }
  }

  private async head(context: GitContext): Promise<string | undefined> {
    const entries = await context.git
      .log({
        dir: GIT_DIR,
        ref: context.branch,
        depth: 1,
      })
      .catch(() => []);
    return entries[0]?.oid;
  }

  private async hasCommits(context: GitContext): Promise<boolean> {
    return Boolean(await this.head(context));
  }

  private async resolveCommit(
    context: GitContext,
    requestedId: string,
  ): Promise<string | undefined> {
    try {
      await context.git.checkout({ dir: GIT_DIR, ref: requestedId, force: true });
      return requestedId;
    } catch {
      const branches = await context.git.branch({ dir: GIT_DIR, list: true });
      const names = branchNames(branches, [context.branch]);
      for (const branch of names) {
        const entries = await context.git.log({ dir: GIT_DIR, ref: branch, depth: 5000 });
        const match = entries.find((entry) => entry.message.includes(`Flary checkpoint ${requestedId}`));
        if (match) return match.oid;
      }
      return undefined;
    }
  }

  private async findLogicalCommit(
    context: GitContext,
    logicalId: string,
  ): Promise<ArtifactCommit | undefined> {
    const entries = await context.git.log({ dir: GIT_DIR, ref: context.branch, depth: 5000 }).catch(() => []);
    for (const entry of entries) {
      if (!entry.message.includes(`Flary checkpoint ${logicalId}`)) continue;
      return this.readCommittedTree(context, entry.oid);
    }
    return undefined;
  }

  private async replaceFiles(
    context: GitContext,
    files: ArtifactCommit["files"],
  ): Promise<void> {
    const current = await collectFiles(context.fs, GIT_DIR);
    const nextPaths = new Set(files.map((file) => file.path));
    for (const path of current) {
      if (!nextPaths.has(path)) {
        await context.git.rm({ dir: GIT_DIR, filepath: path });
      }
    }
    for (const file of files) {
      await context.fs.writeFile(`${GIT_DIR}/${file.path}`, file.content);
    }
  }

  private async readCommittedTree(
    context: GitContext,
    oid: string,
  ): Promise<ArtifactCommit> {
    await context.git.checkout({ dir: GIT_DIR, ref: oid, force: true });
    const metadataText = await context.fs.readFile(
      `${GIT_DIR}/${INTERNAL_METADATA_PATH}`,
    );
    const metadata = parseMetadata(metadataText);
    const files = await collectFileEntries(context.fs, GIT_DIR);
    const descriptors = new Map(metadata.files.map((file) => [file.path, file]));
    return ArtifactCommitSchema.parse({
      id: oid,
      repository: metadata.repository,
      scope: metadata.scope,
      branch: metadata.branch,
      ...(metadata.parentId ? { parentId: metadata.parentId } : {}),
      files: files.map((file) => ({
        ...file,
        ...(descriptors.get(file.path) ?? {}),
      })),
      createdAt: metadata.createdAt,
      ...(metadata.metadata ? { metadata: metadata.metadata } : {}),
    });
  }

  private async requireCommit(
    repository: string,
    scope: RecallScope,
    id: string,
  ): Promise<ArtifactCommit> {
    const commit = await this.read(repository, id);
    if (!commit || !scopeContains(scope, commit.scope)) {
      throw new Error("Artifact commit was not found in the requested scope");
    }
    return commit;
  }

  private assertScope(scope: RecallScope): void {
    const parsed = RecallScopeSchema.parse(scope);
    if (!sameStorageScope(parsed, this.#scope)) {
      throw new Error("Artifact scope does not match this store");
    }
  }

  private assertRepository(repository: string): void {
    if (repository !== this.#repository) {
      throw new Error("Artifact repository is not available in this store");
    }
  }

}

async function collectFiles(fs: InMemoryFs, root: string, prefix = ""): Promise<string[]> {
  const files = await collectFileEntries(fs, root, prefix);
  return files.map((file) => file.path);
}

async function collectFileEntries(
  fs: InMemoryFs,
  root: string,
  prefix = "",
): Promise<Array<{ path: string; content: string }>> {
  const names = await fs.readdir(prefix ? `${root}/${prefix}` : root);
  const files: Array<{ path: string; content: string }> = [];
  for (const name of names) {
    if (name === ".git" || (prefix === ".flary" && name === "commit.json")) continue;
    const relative = prefix ? `${prefix}/${name}` : name;
    const absolute = `${root}/${relative}`;
    const stat = await fs.stat(absolute);
    if (stat.type === "directory") {
      files.push(...(await collectFileEntries(fs, root, relative)));
    } else if (stat.type === "file") {
      files.push({
        path: relative,
        content: await fs.readFile(absolute),
      });
    }
  }
  return files;
}

function parseMetadata(value: string): CommitMetadata {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object") throw new Error("Invalid Artifacts metadata");
  const record = parsed as Record<string, unknown>;
  return {
    version: 1,
    logicalId: String(record.logicalId),
    repository: String(record.repository),
    scope: RecallScopeSchema.parse(record.scope),
    branch: ArtifactBranchNameSchema.parse(record.branch),
    ...(record.parentId ? { parentId: String(record.parentId) } : {}),
    createdAt: String(record.createdAt),
    ...(record.metadata && typeof record.metadata === "object"
      ? { metadata: record.metadata as Record<string, unknown> }
      : {}),
    files: Array.isArray(record.files)
      ? record.files.map((value) => {
          const file = value as Record<string, unknown>;
          return {
            path: String(file.path),
            mediaType: String(file.mediaType ?? "text/plain"),
            ...(file.sha256 ? { sha256: String(file.sha256) } : {}),
            ...(file.metadata && typeof file.metadata === "object"
              ? { metadata: file.metadata as Record<string, unknown> }
              : {}),
          };
        })
      : [],
  };
}

function tokenSecret(value: string): string {
  return value.split("?expires=")[0];
}

function branchNames(value: unknown, fallback: string[]): string[] {
  if (
    value &&
    typeof value === "object" &&
    "branches" in value &&
    Array.isArray((value as { branches?: unknown }).branches)
  ) {
    return (value as { branches: string[] }).branches;
  }
  return fallback;
}

function isNotFound(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "NOT_FOUND",
  );
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

function sameStorageScope(scope: RecallScope, storage: StorageScope): boolean {
  return (
    scope.organizationId === storage.organizationId &&
    scope.appId === storage.appId &&
    scope.projectId === storage.projectId
  );
}

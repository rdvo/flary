import { WorkspaceRefSchema, type WorkspaceRef } from "../contracts/tenancy.js";
import {
  ProjectFileCopyRequestSchema,
  ProjectFileDeleteRequestSchema,
  ProjectFileEditRequestSchema,
  ProjectFileListRequestSchema,
  ProjectFileMoveRequestSchema,
  ProjectFilePatchRequestSchema,
  ProjectFileReadRequestSchema,
  ProjectFileWriteRequestSchema,
} from "../contracts/filesystem.js";
import {
  WorkspaceBatchEditRequestSchema,
  WorkspaceDiffRequestSchema,
  WorkspaceGlobRequestSchema,
  WorkspaceGrepRequestSchema,
} from "../contracts/workspace-tools.js";
import { redactErrorMessage, redactSecrets } from "../execution/redaction.js";
import type { FlaryToolScope, FlaryWorkspaceTargetResolver } from "../flue/toolset.js";
import type { ShellWorkspace } from "../storage/shell-workspace.js";
import type { WorkspaceToolTarget } from "../tools/workspace.js";
import { tenantStoragePrefix } from "../storage/scopes.js";
import { FlaryHistoryProjector } from "../history/index.js";
import { R2ArtifactHistoryStore, type ArtifactR2Bucket } from "../storage/r2-artifacts.js";
import { summarizeArtifactCommit } from "../storage/artifacts.js";
import { z } from "zod";

type ResolvedWorkspaceScope = Required<
  Pick<FlaryToolScope, "tenantId" | "appId" | "projectId" | "workspaceId" | "branch">
>;

export interface CloudflareWorkspaceObjectId {
  toString(): string;
}

export interface CloudflareWorkspaceObjectStub {
  fetch(request: Request): Promise<Response>;
}

export interface CloudflareWorkspaceObjectNamespace {
  idFromName(name: string): CloudflareWorkspaceObjectId;
  get(id: CloudflareWorkspaceObjectId): CloudflareWorkspaceObjectStub;
}

export interface FlaryWorkspaceSeedInput {
  readonly requestId: string;
  readonly files: readonly {
    readonly path: string;
    readonly content: string;
    readonly encoding?: "utf8" | "base64";
    readonly mediaType?: string;
    readonly expectedSha256?: string;
  }[];
}

export interface FlaryWorkspaceAttachmentImportInput {
  readonly requestId: string;
  readonly attachmentId: string;
  readonly path: string;
  readonly content: string;
  readonly encoding?: "utf8" | "base64";
  readonly mediaType?: string;
  readonly expectedSha256?: string;
}

/** Trusted host controls. These methods are not included in agent tool descriptors. */
export interface FlaryWorkspaceHostControl {
  read(input: { readonly path: string; readonly encoding?: "utf8" | "base64" }): Promise<unknown>;
  seed(input: FlaryWorkspaceSeedInput): Promise<{ seeded: true; files: unknown[] }>;
  checkpoint(input: {
    readonly requestId: string;
    readonly id: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
  }): Promise<{
    commit: unknown;
    reused: boolean;
    treeHash: string;
    changedFiles: string[];
    diffReference: Readonly<Record<string, unknown>>;
  }>;
  importAttachment(
    input: FlaryWorkspaceAttachmentImportInput,
  ): Promise<{ imported: true; attachmentId: string; file: unknown }>;
  destroy(input: { readonly requestId: string }): Promise<{ destroyed: true }>;
}

/** Create the retry-safe, host-only lifecycle API for one workspace. */
export async function createCloudflareWorkspaceHostControl(
  namespace: CloudflareWorkspaceObjectNamespace,
  scopeInput: WorkspaceRef,
): Promise<FlaryWorkspaceHostControl> {
  const scope = WorkspaceRefSchema.parse(scopeInput);
  const stub = namespace.get(namespace.idFromName(await cloudflareWorkspaceObjectName(scope)));
  const call = async <T>(method: string, input: unknown): Promise<T> => {
    const response = await stub.fetch(
      new Request(`https://flary.internal/workspace/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope, input }),
      }),
    );
    const body = await response.json().catch(() => undefined);
    if (!response.ok || !isRecord(body) || !("output" in body)) {
      throw new Error(
        isRecord(body) && isRecord(body.error) && typeof body.error.message === "string"
          ? body.error.message
          : "The workspace host operation failed",
      );
    }
    return body.output as T;
  };
  return {
    read: (input) => call("read", input),
    seed: (input) => call("__seed", input),
    checkpoint: (input) =>
      call("__checkpoint", {
        id: input.id,
        sessionId: scope.workspaceId,
        metadata: {
          ...input.metadata,
          hostRequestId: input.requestId,
        },
      }),
    importAttachment: (input) => call("__attachment_import", input),
    destroy: (input) => call("__destroy", input),
  };
}

export interface CloudflareWorkspaceBindingResolver {
  resolve(scope: WorkspaceRef, blobs?: unknown): WorkspaceToolTarget | Promise<WorkspaceToolTarget>;
}

export interface CreateCloudflareWorkspaceTargetOptions {
  /**
   * A Durable Object namespace, a host resolver, or a local Durable Object
   * state. A local state must expose SQLite as `storage.sql` or `sql`.
   */
  readonly binding:
    | CloudflareWorkspaceObjectNamespace
    | CloudflareWorkspaceBindingResolver
    | { readonly storage: { readonly sql: unknown } }
    | { readonly sql: unknown };
  readonly blobs?: unknown;
  readonly requireR2ForLargeFiles?: boolean;
}

/**
 * Create a scope-aware workspace target for `createFlaryToolset()`.
 *
 * A Durable Object namespace uses one object per tenant, app, project,
 * workspace, and branch. A direct state is useful inside the current Flue
 * Durable Object. The target never puts a storage binding in a tool
 * descriptor.
 */
export function createCloudflareWorkspaceTarget(
  options: CreateCloudflareWorkspaceTargetOptions,
): FlaryWorkspaceTargetResolver {
  return {
    async resolve(scopeInput: ResolvedWorkspaceScope) {
      const scope = workspaceRef(scopeInput);
      if (isBindingResolver(options.binding)) {
        return options.binding.resolve(scope, options.blobs);
      }
      const sql = directSql(options.binding);
      if (sql) {
        const { ShellWorkspace } = await import("../storage/shell-workspace.js");
        return new ShellWorkspace({
          sql: sql as never,
          scope,
          ...(options.blobs ? { r2: options.blobs } : {}),
          requireR2ForLargeFiles: options.requireR2ForLargeFiles ?? true,
        });
      }
      if (isNamespace(options.binding)) {
        const name = await cloudflareWorkspaceObjectName(scope);
        const stub = options.binding.get(options.binding.idFromName(name));
        return workspaceProxy(stub, scope);
      }
      throw new Error("The Cloudflare workspace binding is invalid");
    },
  };
}

export interface FlaryWorkspaceObjectState {
  readonly storage: {
    readonly sql: unknown;
    readonly deleteAll?: () => Promise<void>;
  };
}

export interface HandleFlaryWorkspaceObjectRequestOptions<TEnv> {
  readonly state: FlaryWorkspaceObjectState;
  readonly env: TEnv;
  readonly request: Request;
  readonly blobs?: unknown | ((env: TEnv) => unknown);
  readonly requireR2ForLargeFiles?: boolean;
}

/**
 * Handle the private workspace RPC protocol inside a Durable Object.
 *
 * The Worker must expose the object only through a trusted binding. Public
 * requests must not route directly to this handler.
 */
export async function handleFlaryWorkspaceObjectRequest<TEnv>(
  options: HandleFlaryWorkspaceObjectRequestOptions<TEnv>,
): Promise<Response> {
  try {
    if (options.request.method !== "POST") {
      return workspaceJson({ error: { code: "method_not_allowed", message: "Use POST" } }, 405);
    }
    const method = new URL(options.request.url).pathname.split("/").filter(Boolean).at(-1);
    if (!method || (!WORKSPACE_METHODS.has(method) && !method.startsWith("git_"))) {
      return workspaceJson(
        {
          error: {
            code: "workspace_method_not_found",
            message: "The workspace operation is not available",
          },
        },
        404,
      );
    }
    const body = (await options.request.json()) as {
      scope?: unknown;
      input?: unknown;
    };
    const scope = WorkspaceRefSchema.parse(body.scope);
    ensureWorkspaceOwner(options.state.storage.sql, scope);
    const blobs = typeof options.blobs === "function" ? options.blobs(options.env) : options.blobs;
    const { ShellWorkspace } = await import("../storage/shell-workspace.js");
    const workspace = new ShellWorkspace({
      sql: options.state.storage.sql as never,
      scope,
      ...(blobs ? { r2: blobs } : {}),
      requireR2ForLargeFiles: options.requireR2ForLargeFiles ?? true,
    });
    if (blobs && destructiveWorkspaceOperation(method)) {
      await callWorkspaceControl(
        workspace,
        "__checkpoint",
        {
          id: `before_${method}_${crypto.randomUUID().replaceAll("-", "")}`.slice(0, 200),
          sessionId: scope.workspaceId,
          metadata: { beforeOperation: method },
        },
        scope,
        blobs,
        options.state.storage,
      );
    }
    const output = method.startsWith("git_")
      ? await callGit(workspace, method.slice(4), body.input, options.env)
      : method.startsWith("__")
        ? await callWorkspaceControl(
            workspace,
            method,
            body.input,
            scope,
            blobs,
            options.state.storage,
          )
        : await callWorkspace(workspace, method, body.input);
    return workspaceJson({ output: redactSecrets(output) });
  } catch (error) {
    return workspaceJson(
      {
        error: {
          code: "workspace_operation_failed",
          message: redactErrorMessage(error, "The workspace operation failed").slice(0, 500),
        },
      },
      400,
    );
  }
}

/**
 * Default Durable Object entry for workspace storage.
 *
 * It reads large-file storage from `WORKSPACE_BLOBS`. Hosts that use another
 * binding name can call `handleFlaryWorkspaceObjectRequest()` in a small
 * subclass.
 */
export class FlaryWorkspaceDurableObject<TEnv = Record<string, unknown>> {
  constructor(
    protected readonly state: FlaryWorkspaceObjectState,
    protected readonly env: TEnv,
  ) {}

  fetch(request: Request): Promise<Response> {
    return handleFlaryWorkspaceObjectRequest({
      state: this.state,
      env: this.env,
      request,
      blobs: (env: TEnv) => (isRecord(env) ? env.WORKSPACE_BLOBS : undefined),
    });
  }
}

const WORKSPACE_METHODS = new Set([
  "read",
  "write",
  "edit",
  "applyPatch",
  "delete",
  "move",
  "copy",
  "list",
  "stat",
  "glob",
  "grep",
  "diff",
  "batchEdit",
  "__checkpoint",
  "__history",
  "__diff",
  "__restore",
  "__fork",
  "__destroy",
  "__seed",
  "__attachment_import",
]);

const GIT_METHODS = new Set([
  "clone",
  "status",
  "add",
  "rm",
  "commit",
  "log",
  "branch",
  "checkout",
  "fetch",
  "pull",
  "push",
  "diff",
  "init",
  "remote",
]);

/** Build the connector used by app.workspace() in the generated host. */
export async function createCloudflareWorkspaceConnection(
  namespace: CloudflareWorkspaceObjectNamespace,
  scopeInput: WorkspaceRef,
  options: {
    readonly approveWrites?: boolean;
    readonly hiddenPaths?: readonly string[];
  } = {},
) {
  const scope = WorkspaceRefSchema.parse(scopeInput);
  const stub = namespace.get(namespace.idFromName(await cloudflareWorkspaceObjectName(scope)));
  const hiddenPaths = (options.hiddenPaths ?? []).map((path) => path.replace(/^\/+|\/+$/g, ""));
  const hidden = (path: unknown): boolean =>
    typeof path === "string" &&
    hiddenPaths.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
  const call = async (name: string, input: unknown): Promise<unknown> => {
    if (isRecord(input)) {
      const directPaths = [input.path, input.from, input.to, input.compareToPath];
      const editPaths = Array.isArray(input.edits)
        ? input.edits.flatMap((edit) => (isRecord(edit) ? [edit.path] : []))
        : [];
      if ([...directPaths, ...editPaths].some(hidden)) {
        throw new Error("The workspace file is not available");
      }
    }
    const response = await stub.fetch(
      new Request(`https://flary.internal/workspace/${encodeURIComponent(name)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope, input }),
      }),
    );
    const body = await response.json().catch(() => undefined);
    if (!response.ok || !isRecord(body) || !("output" in body)) {
      throw new Error(
        isRecord(body) && isRecord(body.error) && typeof body.error.message === "string"
          ? body.error.message
          : "The workspace operation failed",
      );
    }
    const output = body.output;
    if (name === "list" && isRecord(output) && Array.isArray(output.files)) {
      return {
        ...output,
        files: output.files.filter((file) => !isRecord(file) || !hidden(file.path)),
      };
    }
    if (name === "glob" && isRecord(output) && Array.isArray(output.paths)) {
      return { ...output, paths: output.paths.filter((path) => !hidden(path)) };
    }
    if (name === "grep" && isRecord(output) && Array.isArray(output.files)) {
      return {
        ...output,
        files: output.files.filter((file) => !isRecord(file) || !hidden(file.path)),
      };
    }
    return output;
  };
  const fileTools = [
    ["read", "Read one workspace file", "read"],
    ["list", "List workspace files", "read"],
    ["stat", "Read safe metadata for one workspace file", "read"],
    ["glob", "Find workspace files by glob", "read"],
    ["grep", "Search workspace file contents", "read"],
    ["diff", "Compare workspace files or content", "read"],
    ["write", "Write one workspace file", "write"],
    ["edit", "Apply text edits to one workspace file", "write"],
    ["applyPatch", "Apply a unified diff to one workspace file", "write"],
    ["batchEdit", "Apply a group of workspace edits", "write"],
    ["move", "Move a workspace file", "write"],
    ["copy", "Copy a workspace file", "write"],
    ["delete", "Delete a workspace file", "write"],
  ] as const;
  const fileInputSchemas = {
    read: ProjectFileReadRequestSchema,
    list: ProjectFileListRequestSchema,
    stat: ProjectFileReadRequestSchema.pick({ path: true }),
    glob: WorkspaceGlobRequestSchema,
    grep: WorkspaceGrepRequestSchema,
    diff: WorkspaceDiffRequestSchema,
    write: ProjectFileWriteRequestSchema,
    edit: ProjectFileEditRequestSchema,
    applyPatch: ProjectFilePatchRequestSchema,
    batchEdit: WorkspaceBatchEditRequestSchema,
    move: ProjectFileMoveRequestSchema,
    copy: ProjectFileCopyRequestSchema,
    delete: ProjectFileDeleteRequestSchema,
  } as const;
  const readGit = new Set(["status", "log", "diff", "remote"]);
  return {
    descriptors: [
      ...fileTools.map(([name, description, operation]) => ({
        name,
        description,
        operation,
        requiresApproval: operation === "write" && options.approveWrites !== false,
        inputSchema: z.toJSONSchema(fileInputSchemas[name]),
      })),
      ...[...GIT_METHODS].map((name) => ({
        name: `git_${name}`,
        description: `Run git ${name} in the durable workspace`,
        operation: readGit.has(name) ? ("read" as const) : ("write" as const),
        requiresApproval: !readGit.has(name),
        inputSchema: { type: "object", additionalProperties: true },
      })),
    ],
    call,
  };
}

function workspaceRef(scope: ResolvedWorkspaceScope): WorkspaceRef {
  return WorkspaceRefSchema.parse({
    organizationId: scope.tenantId,
    appId: scope.appId,
    projectId: scope.projectId,
    workspaceId: scope.workspaceId,
    branch: scope.branch,
  });
}

function workspaceProxy(
  stub: CloudflareWorkspaceObjectStub,
  scope: WorkspaceRef,
): WorkspaceToolTarget {
  const call = async (method: string, input: unknown): Promise<unknown> => {
    const response = await stub.fetch(
      new Request(`https://flary.internal/workspace/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope, input }),
      }),
    );
    const body = await response.json().catch(() => undefined);
    if (!response.ok) {
      throw new Error(
        isRecord(body) && isRecord(body.error) && typeof body.error.message === "string"
          ? body.error.message
          : "The workspace operation failed",
      );
    }
    if (!isRecord(body) || !("output" in body)) {
      throw new Error("The workspace response is invalid");
    }
    return body.output;
  };
  return {
    read: (input) => call("read", input) as ReturnType<WorkspaceToolTarget["read"]>,
    write: (input) => call("write", input) as ReturnType<WorkspaceToolTarget["write"]>,
    edit: (input) => call("edit", input) as ReturnType<WorkspaceToolTarget["edit"]>,
    applyPatch: (input) =>
      call("applyPatch", input) as ReturnType<WorkspaceToolTarget["applyPatch"]>,
    delete: (input) => call("delete", input) as ReturnType<WorkspaceToolTarget["delete"]>,
    move: (input) => call("move", input) as ReturnType<WorkspaceToolTarget["move"]>,
    copy: (input) => call("copy", input) as ReturnType<WorkspaceToolTarget["copy"]>,
    list: (input) => call("list", input) as ReturnType<WorkspaceToolTarget["list"]>,
    stat: (path) => call("stat", path) as ReturnType<WorkspaceToolTarget["stat"]>,
    glob: (input) => call("glob", input) as ReturnType<WorkspaceToolTarget["glob"]>,
    grep: (input) => call("grep", input) as ReturnType<WorkspaceToolTarget["grep"]>,
    diff: (input) => call("diff", input) as ReturnType<WorkspaceToolTarget["diff"]>,
    batchEdit: (input) => call("batchEdit", input) as ReturnType<WorkspaceToolTarget["batchEdit"]>,
  };
}

async function callWorkspace(
  workspace: ShellWorkspace,
  method: string,
  input: unknown,
): Promise<unknown> {
  const operation = workspace[method as keyof ShellWorkspace];
  if (typeof operation !== "function") {
    throw new Error("The workspace operation is not available");
  }
  const normalizedInput = method === "stat" && isRecord(input) ? input.path : input;
  return (operation as (value: unknown) => Promise<unknown>).call(workspace, normalizedInput);
}

async function callGit(
  workspace: ShellWorkspace,
  method: string,
  input: unknown,
  env: unknown,
): Promise<unknown> {
  if (!GIT_METHODS.has(method)) {
    throw new Error("The Git operation is not available");
  }
  const record = isRecord(env) ? env : {};
  const token =
    typeof record.FLARY_GIT_TOKEN === "string"
      ? record.FLARY_GIT_TOKEN
      : typeof record.GITHUB_TOKEN === "string"
        ? record.GITHUB_TOKEN
        : undefined;
  const provider = workspace.gitTools(token ? { token } : undefined);
  const tool = (
    provider.tools as Record<
      string,
      {
        execute?: (value: unknown) => Promise<unknown>;
      }
    >
  )[method];
  if (!tool?.execute) throw new Error("The Git operation is not executable");
  return tool.execute(input ?? {});
}

async function callWorkspaceControl(
  workspace: ShellWorkspace,
  method: string,
  inputValue: unknown,
  scope: WorkspaceRef,
  blobs: unknown,
  storage?: { readonly sql?: unknown; readonly deleteAll?: () => Promise<void> },
): Promise<unknown> {
  const input = isRecord(inputValue) ? inputValue : {};
  if (method === "__seed") {
    return retrySafeHostOperation(storage?.sql, method, input, async () => {
      if (!Array.isArray(input.files)) throw new Error("Workspace seed needs files");
      const files = [];
      for (const value of input.files) {
        if (!isRecord(value)) throw new Error("A workspace seed file is invalid");
        files.push(
          await workspace.write({
            path: value.path,
            content: value.content,
            encoding: value.encoding,
            mediaType: value.mediaType,
            expectedSha256: value.expectedSha256,
          } as never),
        );
      }
      return { seeded: true as const, files };
    });
  }
  if (method === "__attachment_import") {
    return retrySafeHostOperation(storage?.sql, method, input, async () => {
      if (typeof input.attachmentId !== "string" || !input.attachmentId) {
        throw new Error("Attachment import needs attachmentId");
      }
      const file = await workspace.write({
        path: input.path,
        content: input.content,
        encoding: input.encoding,
        mediaType: input.mediaType,
        expectedSha256: input.expectedSha256,
      } as never);
      return {
        imported: true as const,
        attachmentId: input.attachmentId,
        file,
      };
    });
  }
  const repository = typeof input.repository === "string" ? input.repository : scope.projectId;
  const recallScope = {
    kind: "session" as const,
    organizationId: scope.organizationId,
    appId: scope.appId,
    projectId: scope.projectId,
    sessionId: typeof input.sessionId === "string" ? input.sessionId : scope.workspaceId,
  };
  if (method === "__destroy") {
    await workspace.delete({ path: "", recursive: true });
    if (blobs) await deleteR2Prefix(blobs, tenantStoragePrefix(scope));
    await storage?.deleteAll?.();
    return { destroyed: true as const };
  }
  if (!blobs) throw new Error("Workspace history needs WORKSPACE_BLOBS");
  const store = new R2ArtifactHistoryStore({
    bucket: blobs as ArtifactR2Bucket,
    scope: {
      organizationId: scope.organizationId,
      appId: scope.appId,
      projectId: scope.projectId,
      workspaceId: scope.workspaceId,
      branch: scope.branch,
    },
    repository,
  });
  if (method === "__fork") {
    const sourceScope = WorkspaceRefSchema.parse(input.sourceScope);
    if (
      sourceScope.organizationId !== scope.organizationId ||
      sourceScope.appId !== scope.appId ||
      sourceScope.projectId !== scope.projectId ||
      sourceScope.workspaceId !== scope.workspaceId
    ) {
      throw new Error("A workspace fork must stay inside the same workspace");
    }
    if (typeof input.commitId !== "string") {
      throw new Error("Workspace fork needs commitId");
    }
    const sourceStore = new R2ArtifactHistoryStore({
      bucket: blobs as ArtifactR2Bucket,
      scope: sourceScope,
      repository,
    });
    const commit = await sourceStore.read(repository, input.commitId);
    if (!commit) throw new Error("The workspace checkpoint was not found");
    const existing = await workspace.list({});
    for (const file of existing.files) {
      if (!file.path.startsWith("sessions/")) {
        await workspace.delete({ path: file.path });
      }
    }
    for (const file of commit.files) {
      if (file.path.startsWith("sessions/")) continue;
      await workspace.write({
        path: file.path,
        content: file.content,
        encoding: file.metadata?.encoding === "base64" ? "base64" : "utf8",
        mediaType: file.mediaType,
      });
    }
    const forkId = typeof input.id === "string" ? input.id : `fork_${input.commitId}`.slice(0, 200);
    const result = await new FlaryHistoryProjector(store).checkpoint({
      id: forkId,
      repository,
      scope: recallScope,
      branch: scope.branch,
      reason: "explicit_commit",
      files: commit.files,
      metadata: {
        forkedFromCommitId: commit.id,
        forkedFromBranch: sourceScope.branch,
        ...(typeof input.parentThreadId === "string"
          ? { parentThreadId: input.parentThreadId }
          : {}),
      },
    });
    return {
      forked: true,
      source: summarizeArtifactCommit(commit),
      checkpoint: summarizeArtifactCommit(result.commit),
    };
  }
  if (method === "__history") {
    const commits = await store.list(
      repository,
      recallScope,
      scope.branch,
      typeof input.limit === "number" ? input.limit : 30,
    );
    return {
      repository,
      branch: scope.branch,
      checkpoints: commits.map(summarizeArtifactCommit),
    };
  }
  if (method === "__diff") {
    if (typeof input.headCommitId !== "string") {
      throw new Error("History diff needs headCommitId");
    }
    return {
      diff: await store.diff(
        repository,
        recallScope,
        typeof input.baseCommitId === "string" ? input.baseCommitId : undefined,
        input.headCommitId,
        scope.branch,
      ),
    };
  }
  if (method === "__restore") {
    if (typeof input.commitId !== "string") {
      throw new Error("Workspace restore needs commitId");
    }
    const commit = await store.read(repository, input.commitId);
    if (!commit) throw new Error("The workspace checkpoint was not found");
    const existing = await workspace.list({});
    const kept = new Set(
      commit.files.filter((file) => !file.path.startsWith("sessions/")).map((file) => file.path),
    );
    for (const file of existing.files) {
      if (!kept.has(file.path)) await workspace.delete({ path: file.path });
    }
    for (const file of commit.files) {
      if (file.path.startsWith("sessions/")) continue;
      await workspace.write({
        path: file.path,
        content: file.content,
        encoding: file.metadata?.encoding === "base64" ? "base64" : "utf8",
        mediaType: file.mediaType,
      });
    }
    return { restored: true, commit: summarizeArtifactCommit(commit) };
  }
  if (method === "__checkpoint") {
    if (typeof input.id !== "string") {
      throw new Error("Workspace checkpoint needs an id");
    }
    const listing = await workspace.list({});
    const files = await Promise.all(
      listing.files.map(async (file) => {
        const text =
          file.mediaType.startsWith("text/") ||
          file.mediaType.includes("json") ||
          file.mediaType.includes("javascript") ||
          file.mediaType.includes("typescript") ||
          file.mediaType.includes("yaml") ||
          file.mediaType.includes("xml");
        const opened = await workspace.read({
          path: file.path,
          encoding: text ? "utf8" : "base64",
        });
        return {
          path: file.path,
          content: opened.content,
          mediaType: file.mediaType,
          sha256: file.sha256,
          ...(!text ? { metadata: { encoding: "base64" } } : {}),
        };
      }),
    );
    const latest = await store.latest(repository, recallScope, scope.branch);
    const prior = new Map(
      (latest?.files ?? []).map((file) => [file.path, file.sha256 ?? file.content]),
    );
    const current = new Map(files.map((file) => [file.path, file.sha256 ?? file.content]));
    const changedFiles = [
      ...new Set([
        ...files
          .filter((file) => prior.get(file.path) !== (file.sha256 ?? file.content))
          .map((file) => file.path),
        ...[...prior.keys()].filter((path) => !current.has(path)),
      ]),
    ].sort();
    const treeHash = await sha256Text(
      files
        .map((file) => `${file.path}\u0000${file.sha256 ?? file.content}`)
        .sort()
        .join("\u0000"),
    );
    const git = await readGitCheckpoint(workspace);
    const previousMetadata = isRecord(latest?.metadata) ? latest.metadata : {};
    const previousGit = isRecord(previousMetadata.git) ? previousMetadata.git : {};
    const baseGitCommit =
      typeof previousGit.baseCommit === "string" ? previousGit.baseCommit : git.currentCommit;
    const gitMetadata = {
      ...(baseGitCommit ? { baseCommit: baseGitCommit } : {}),
      ...(git.currentCommit ? { currentCommit: git.currentCommit } : {}),
      branch: git.branch ?? scope.branch,
      status: git.status,
      diff: git.diff,
    };
    const result = await new FlaryHistoryProjector(store).checkpoint({
      id: input.id,
      repository,
      scope: recallScope,
      branch: scope.branch,
      ...(latest ? { parentId: latest.id } : {}),
      reason: "dirty_turn",
      files,
      metadata: {
        ...(typeof input.submissionId === "string" ? { submissionId: input.submissionId } : {}),
        ...(isRecord(input.modelPin) ? { modelPin: input.modelPin } : {}),
        treeHash,
        changedFiles,
        diffReference: {
          ...(latest ? { baseCommitId: latest.id } : {}),
          headCommitId: input.id,
        },
        git: gitMetadata,
        ...(isRecord(input.metadata) ? input.metadata : {}),
        ...(Array.isArray(input.checks) ? { checks: input.checks } : {}),
      },
    });
    return {
      commit: summarizeArtifactCommit(result.commit),
      reused: result.reused,
      treeHash,
      changedFiles,
      git: gitMetadata,
      diffReference: {
        ...(latest ? { baseCommitId: latest.id } : {}),
        headCommitId: result.commit.id,
      },
    };
  }
  throw new Error("The workspace control operation is not available");
}

function destructiveWorkspaceOperation(method: string): boolean {
  if (["delete", "move", "batchEdit"].includes(method)) return true;
  if (!method.startsWith("git_")) return false;
  return new Set(["git_clone", "git_rm", "git_commit", "git_checkout", "git_pull", "git_init"]).has(
    method,
  );
}

async function readGitCheckpoint(workspace: ShellWorkspace): Promise<{
  readonly currentCommit?: string;
  readonly branch?: string;
  readonly status: unknown[];
  readonly diff: unknown[];
}> {
  const provider = workspace.gitTools();
  const execute = async (name: string, input: unknown): Promise<unknown> => {
    const tool = (
      provider.tools as Record<
        string,
        {
          execute?: (value: unknown) => Promise<unknown>;
        }
      >
    )[name];
    if (!tool?.execute) return undefined;
    return tool.execute(input).catch(() => undefined);
  };
  const [log, branch, status, diff] = await Promise.all([
    execute("log", { depth: 1 }),
    execute("branch", { list: true }),
    execute("status", {}),
    execute("diff", {}),
  ]);
  const logs = Array.isArray(log) ? log : [];
  const head = isRecord(logs[0]) ? logs[0] : {};
  const branchValue = isRecord(branch) ? branch : {};
  return {
    ...(typeof head.oid === "string" ? { currentCommit: head.oid } : {}),
    ...(typeof branchValue.current === "string" ? { branch: branchValue.current } : {}),
    status: Array.isArray(status) ? status : [],
    diff: Array.isArray(diff) ? diff : [],
  };
}

async function sha256Text(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function deleteR2Prefix(bucket: unknown, prefix: string): Promise<void> {
  if (
    !isRecord(bucket) ||
    typeof bucket.list !== "function" ||
    typeof bucket.delete !== "function"
  ) {
    return;
  }
  let cursor: string | undefined;
  do {
    const page = await (
      bucket.list as (input: { prefix: string; cursor?: string; limit?: number }) => Promise<{
        objects?: Array<{ key?: unknown }>;
        truncated?: boolean;
        cursor?: string;
      }>
    )({ prefix, ...(cursor ? { cursor } : {}), limit: 1000 });
    for (const object of page.objects ?? []) {
      if (typeof object.key === "string")
        await (bucket.delete as (key: string) => Promise<unknown>)(object.key);
    }
    cursor = page.truncated && typeof page.cursor === "string" ? page.cursor : undefined;
  } while (cursor);
}

type WorkspaceHostSql = {
  exec(query: string, ...bindings: unknown[]): { toArray(): unknown[] };
};

async function retrySafeHostOperation<T>(
  sqlValue: unknown,
  operation: string,
  input: Record<string, unknown>,
  execute: () => Promise<T>,
): Promise<T> {
  const requestId = requireHostRequestId(input);
  const sql = sqlValue as WorkspaceHostSql | undefined;
  if (!sql || typeof sql.exec !== "function") {
    throw new Error("Workspace host operations need Durable Object SQLite");
  }
  sql.exec(`CREATE TABLE IF NOT EXISTS flary_workspace_host_operation (
    request_id TEXT PRIMARY KEY,
    operation TEXT NOT NULL,
    input_sha256 TEXT NOT NULL,
    output_json TEXT,
    created_at TEXT NOT NULL
  )`);
  const inputSha256 = await sha256Text(JSON.stringify(sortJson(input)));
  const rows = sql
    .exec(
      "SELECT operation, input_sha256, output_json FROM flary_workspace_host_operation WHERE request_id = ?",
      requestId,
    )
    .toArray() as Array<{
    operation: string;
    input_sha256: string;
    output_json: string | null;
  }>;
  const prior = rows[0];
  if (prior) {
    if (prior.operation !== operation || prior.input_sha256 !== inputSha256) {
      throw new Error("Workspace requestId was reused with different input");
    }
    if (prior.output_json !== null) return JSON.parse(prior.output_json) as T;
  } else {
    sql.exec(
      `INSERT INTO flary_workspace_host_operation
        (request_id, operation, input_sha256, output_json, created_at)
       VALUES (?, ?, ?, NULL, ?)`,
      requestId,
      operation,
      inputSha256,
      new Date().toISOString(),
    );
  }
  const output = await execute();
  sql.exec(
    "UPDATE flary_workspace_host_operation SET output_json = ? WHERE request_id = ?",
    JSON.stringify(output),
    requestId,
  );
  return output;
}

function requireHostRequestId(input: Record<string, unknown>): string {
  if (typeof input.requestId !== "string" || !input.requestId.trim()) {
    throw new Error("Workspace host operation needs requestId");
  }
  return input.requestId;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortJson(value[key])]),
  );
}

export async function cloudflareWorkspaceObjectName(scope: WorkspaceRef): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      [scope.organizationId, scope.appId, scope.projectId, scope.workspaceId, scope.branch].join(
        "\u0000",
      ),
    ),
  );
  return `workspace_${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

function isNamespace(
  value: CreateCloudflareWorkspaceTargetOptions["binding"],
): value is CloudflareWorkspaceObjectNamespace {
  return (
    "idFromName" in value &&
    typeof value.idFromName === "function" &&
    "get" in value &&
    typeof value.get === "function"
  );
}

function isBindingResolver(
  value: CreateCloudflareWorkspaceTargetOptions["binding"],
): value is CloudflareWorkspaceBindingResolver {
  return "resolve" in value && typeof value.resolve === "function";
}

function directSql(value: CreateCloudflareWorkspaceTargetOptions["binding"]): unknown | undefined {
  if ("sql" in value) return value.sql;
  if ("storage" in value && isRecord(value.storage)) return value.storage.sql;
  return undefined;
}

function workspaceJson(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function ensureWorkspaceOwner(sqlValue: unknown, scope: WorkspaceRef): void {
  const sql = sqlValue as {
    exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): { toArray(): T[] };
  };
  sql.exec(`
    CREATE TABLE IF NOT EXISTS flary_workspace_owner (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      scope_json TEXT NOT NULL
    )
  `);
  const row = sql
    .exec<{ scope_json: string }>(
      "SELECT scope_json FROM flary_workspace_owner WHERE singleton = 1",
    )
    .toArray()[0];
  const serialized = JSON.stringify(scope);
  if (!row) {
    sql.exec("INSERT INTO flary_workspace_owner (singleton, scope_json) VALUES (1, ?)", serialized);
    return;
  }
  if (row.scope_json !== serialized) {
    throw new Error("The workspace does not belong to this tenant scope");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

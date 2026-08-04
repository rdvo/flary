import {
  WorkspaceRefSchema,
  type WorkspaceRef,
} from "../contracts/tenancy.js";
import { redactSecrets } from "../execution/redaction.js";
import type {
  FlaryToolScope,
  FlaryWorkspaceTargetResolver,
} from "../flue/toolset.js";
import type { ShellWorkspace } from "../storage/shell-workspace.js";
import type { WorkspaceToolTarget } from "../tools/workspace.js";
import { FlaryHistoryProjector } from "../history/index.js";
import {
  R2ArtifactHistoryStore,
  type ArtifactR2Bucket,
} from "../storage/r2-artifacts.js";
import { summarizeArtifactCommit } from "../storage/artifacts.js";

type ResolvedWorkspaceScope = Required<
  Pick<
    FlaryToolScope,
    "tenantId" | "appId" | "projectId" | "workspaceId" | "branch"
  >
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

export interface CloudflareWorkspaceBindingResolver {
  resolve(
    scope: WorkspaceRef,
    blobs?: unknown,
  ): WorkspaceToolTarget | Promise<WorkspaceToolTarget>;
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
        const { ShellWorkspace } = await import(
          "../storage/shell-workspace.js"
        );
        return new ShellWorkspace({
          sql: sql as never,
          scope,
          ...(options.blobs ? { r2: options.blobs } : {}),
          requireR2ForLargeFiles:
            options.requireR2ForLargeFiles ?? true,
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
  readonly storage: { readonly sql: unknown };
}

export interface HandleFlaryWorkspaceObjectRequestOptions<TEnv> {
  readonly state: FlaryWorkspaceObjectState;
  readonly env: TEnv;
  readonly request: Request;
  readonly blobs?:
    | unknown
    | ((env: TEnv) => unknown);
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
      return workspaceJson(
        { error: { code: "method_not_allowed", message: "Use POST" } },
        405,
      );
    }
    const method = new URL(options.request.url).pathname
      .split("/")
      .filter(Boolean)
      .at(-1);
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
    const body = await options.request.json() as {
      scope?: unknown;
      input?: unknown;
    };
    const scope = WorkspaceRefSchema.parse(body.scope);
    ensureWorkspaceOwner(options.state.storage.sql, scope);
    const blobs =
      typeof options.blobs === "function"
        ? options.blobs(options.env)
        : options.blobs;
    const { ShellWorkspace } = await import("../storage/shell-workspace.js");
    const workspace = new ShellWorkspace({
      sql: options.state.storage.sql as never,
      scope,
      ...(blobs ? { r2: blobs } : {}),
      requireR2ForLargeFiles:
        options.requireR2ForLargeFiles ?? true,
    });
    const output = method.startsWith("git_")
      ? await callGit(workspace, method.slice(4), body.input, options.env)
      : method.startsWith("__")
        ? await callWorkspaceControl(
            workspace,
            method,
            body.input,
            scope,
            blobs,
          )
        : method === "stat"
          ? await workspace.stat(String(body.input ?? ""))
          : await callWorkspace(workspace, method, body.input);
    return workspaceJson({ output: redactSecrets(output) });
  } catch {
    return workspaceJson(
      {
        error: {
          code: "workspace_operation_failed",
          message: "The workspace operation failed",
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
      blobs: (env: TEnv) =>
        isRecord(env)
          ? env.WORKSPACE_BLOBS
          : undefined,
    });
  }
}

const WORKSPACE_METHODS = new Set([
  "read",
  "write",
  "edit",
  "delete",
  "move",
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
) {
  const scope = WorkspaceRefSchema.parse(scopeInput);
  const stub = namespace.get(
    namespace.idFromName(await cloudflareWorkspaceObjectName(scope)),
  );
  const call = async (name: string, input: unknown): Promise<unknown> => {
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
        isRecord(body) && isRecord(body.error) &&
            typeof body.error.message === "string"
          ? body.error.message
          : "The workspace operation failed",
      );
    }
    return body.output;
  };
  const fileTools = [
    ["read", "Read one workspace file", "read"],
    ["list", "List workspace files", "read"],
    ["glob", "Find workspace files by glob", "read"],
    ["grep", "Search workspace file contents", "read"],
    ["diff", "Compare workspace files or content", "read"],
    ["write", "Write one workspace file", "write"],
    ["edit", "Apply text edits to one workspace file", "write"],
    ["batchEdit", "Apply a group of workspace edits", "write"],
    ["move", "Move a workspace file", "write"],
    ["delete", "Delete a workspace file", "write"],
  ] as const;
  const readGit = new Set(["status", "log", "diff", "remote"]);
  return {
    descriptors: [
      ...fileTools.map(([name, description, operation]) => ({
        name,
        description,
        operation,
        requiresApproval: operation === "write",
        inputSchema: { type: "object", additionalProperties: true },
      })),
      ...[...GIT_METHODS].map((name) => ({
        name: `git_${name}`,
        description: `Run git ${name} in the durable workspace`,
        operation: readGit.has(name) ? "read" as const : "write" as const,
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
        isRecord(body) &&
            isRecord(body.error) &&
            typeof body.error.message === "string"
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
    delete: (input) => call("delete", input) as ReturnType<WorkspaceToolTarget["delete"]>,
    move: (input) => call("move", input) as ReturnType<WorkspaceToolTarget["move"]>,
    list: (input) => call("list", input) as ReturnType<WorkspaceToolTarget["list"]>,
    stat: (path) => call("stat", path) as ReturnType<WorkspaceToolTarget["stat"]>,
    glob: (input) => call("glob", input) as ReturnType<WorkspaceToolTarget["glob"]>,
    grep: (input) => call("grep", input) as ReturnType<WorkspaceToolTarget["grep"]>,
    diff: (input) => call("diff", input) as ReturnType<WorkspaceToolTarget["diff"]>,
    batchEdit: (input) =>
      call("batchEdit", input) as ReturnType<WorkspaceToolTarget["batchEdit"]>,
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
  return (operation as (value: unknown) => Promise<unknown>).call(
    workspace,
    input,
  );
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
  const token = typeof record.FLARY_GIT_TOKEN === "string"
    ? record.FLARY_GIT_TOKEN
    : typeof record.GITHUB_TOKEN === "string"
      ? record.GITHUB_TOKEN
      : undefined;
  const provider = workspace.gitTools(token ? { token } : undefined);
  const tool = (provider.tools as Record<string, {
    execute?: (value: unknown) => Promise<unknown>;
  }>)[method];
  if (!tool?.execute) throw new Error("The Git operation is not executable");
  return tool.execute(input ?? {});
}

async function callWorkspaceControl(
  workspace: ShellWorkspace,
  method: string,
  inputValue: unknown,
  scope: WorkspaceRef,
  blobs: unknown,
): Promise<unknown> {
  if (!blobs) throw new Error("Workspace history needs WORKSPACE_BLOBS");
  const input = isRecord(inputValue) ? inputValue : {};
  const repository = typeof input.repository === "string"
    ? input.repository
    : scope.projectId;
  const recallScope = {
    kind: "session" as const,
    organizationId: scope.organizationId,
    appId: scope.appId,
    projectId: scope.projectId,
    sessionId:
      typeof input.sessionId === "string" ? input.sessionId : scope.workspaceId,
  };
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
    const kept = new Set(commit.files
      .filter((file) => !file.path.startsWith("sessions/"))
      .map((file) => file.path));
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
    const files = await Promise.all(listing.files.map(async (file) => {
      const text = file.mediaType.startsWith("text/") ||
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
    }));
    const latest = await store.latest(repository, recallScope, scope.branch);
    const result = await new FlaryHistoryProjector(store).checkpoint({
      id: input.id,
      repository,
      scope: recallScope,
      branch: scope.branch,
      ...(latest ? { parentId: latest.id } : {}),
      reason: "dirty_turn",
      files,
      metadata: {
        ...(typeof input.submissionId === "string"
          ? { submissionId: input.submissionId }
          : {}),
        ...(isRecord(input.modelPin) ? { modelPin: input.modelPin } : {}),
      },
    });
    return {
      commit: summarizeArtifactCommit(result.commit),
      reused: result.reused,
    };
  }
  throw new Error("The workspace control operation is not available");
}

export async function cloudflareWorkspaceObjectName(
  scope: WorkspaceRef,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      [
        scope.organizationId,
        scope.appId,
        scope.projectId,
        scope.workspaceId,
        scope.branch,
      ].join("\u0000"),
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

function directSql(
  value: CreateCloudflareWorkspaceTargetOptions["binding"],
): unknown | undefined {
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
    exec<T = Record<string, unknown>>(
      query: string,
      ...bindings: unknown[]
    ): { toArray(): T[] };
  };
  sql.exec(`
    CREATE TABLE IF NOT EXISTS flary_workspace_owner (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      scope_json TEXT NOT NULL
    )
  `);
  const row = sql.exec<{ scope_json: string }>(
    "SELECT scope_json FROM flary_workspace_owner WHERE singleton = 1",
  ).toArray()[0];
  const serialized = JSON.stringify(scope);
  if (!row) {
    sql.exec(
      "INSERT INTO flary_workspace_owner (singleton, scope_json) VALUES (1, ?)",
      serialized,
    );
    return;
  }
  if (row.scope_json !== serialized) {
    throw new Error("The workspace does not belong to this tenant scope");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
        const name = await workspaceObjectName(scope);
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
    if (!method || !WORKSPACE_METHODS.has(method)) {
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
    const output =
      method === "stat"
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
]);

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

async function workspaceObjectName(scope: WorkspaceRef): Promise<string> {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

import {
  StorageScopeSchema,
  ThreadRefSchema,
  WorkspaceRefSchema,
  type StorageScope,
  type ThreadRef,
  type WorkspaceRef,
} from "../contracts/tenancy.js";

const TENANT_PREFIX = "tenants";

function segment(value: string): string {
  return encodeURIComponent(value);
}

export function tenantStoragePrefix(scopeInput: StorageScope): string {
  const scope = StorageScopeSchema.parse(scopeInput);
  return [
    TENANT_PREFIX,
    segment(scope.organizationId),
    "applications",
    segment(scope.appId),
    "projects",
    segment(scope.projectId),
    "workspaces",
    segment(scope.workspaceId),
    ...(scope.branch === "main" ? [] : ["branches", segment(scope.branch)]),
  ].join("/");
}

export function tenantBlobKey(scopeInput: StorageScope, sha256: string): string {
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error("A blob key needs a lowercase SHA-256 digest");
  }
  return `${tenantStoragePrefix(scopeInput)}/blobs/${sha256}`;
}

export function tenantHistoryKey(scopeInput: StorageScope, historyId: string): string {
  return `${tenantStoragePrefix(scopeInput)}/history/${segment(historyId)}`;
}

export function tenantAssetKey(scopeInput: StorageScope, assetId: string): string {
  return `${tenantStoragePrefix(scopeInput)}/assets/${segment(assetId)}`;
}

export function workspaceName(refInput: WorkspaceRef): string {
  const ref = WorkspaceRefSchema.parse(refInput);
  const base = [ref.organizationId, ref.appId, ref.projectId, ref.workspaceId];
  return ref.branch === "main" ? base.join(":") : [...base, ref.branch].join(":");
}

export function threadName(refInput: ThreadRef): string {
  const ref = ThreadRefSchema.parse(refInput);
  return [ref.organizationId, ref.appId, ref.agentId, ref.threadId].join(":");
}

export function parseThreadName(value: string): ThreadRef {
  const parts = value.split(":");
  if (parts.length !== 4) {
    throw new Error("A Flary thread name must contain four opaque identifiers");
  }
  return ThreadRefSchema.parse({
    organizationId: parts[0],
    appId: parts[1],
    agentId: parts[2],
    threadId: parts[3],
  });
}

export function parseWorkspaceName(value: string): StorageScope {
  const parts = value.split(":");
  const [organizationId, appId, projectId, workspaceId, branch] = parts;
  if (parts.length !== 4 && parts.length !== 5) {
    throw new Error("A workspace name must contain four or five opaque identifiers");
  }
  return StorageScopeSchema.parse({
    organizationId,
    appId,
    projectId,
    workspaceId,
    ...(branch ? { branch } : {}),
  });
}

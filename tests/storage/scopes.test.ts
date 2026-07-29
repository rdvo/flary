import assert from "node:assert/strict";
import test from "node:test";

import {
  StorageScopeSchema,
  TenantContextSchema,
  ThreadRefSchema,
  WorkspaceMutationSchema,
  WorkspaceRefSchema,
} from "../../src/harness/contracts/index.js";
import {
  parseWorkspaceName,
  tenantBlobKey,
  tenantStoragePrefix,
  threadName,
  workspaceName,
} from "../../src/harness/storage/scopes.js";

const scope = StorageScopeSchema.parse({
  organizationId: "org_123",
  appId: "app_123",
  projectId: "project_123",
  workspaceId: "workspace_main",
});

test("tenant storage keys are opaque and tenant scoped", () => {
  assert.equal(
    tenantStoragePrefix(scope),
    "tenants/org_123/applications/app_123/projects/project_123/workspaces/workspace_main",
  );
  assert.equal(
    tenantBlobKey(scope, "a".repeat(64)),
    "tenants/org_123/applications/app_123/projects/project_123/workspaces/workspace_main/blobs/" +
      "a".repeat(64),
  );
  assert.throws(
    () => tenantBlobKey({ ...scope, organizationId: "org/other" }, "a".repeat(64)),
  );
});

test("workspace names round-trip without user-controlled path segments", () => {
  const ref = WorkspaceRefSchema.parse({ ...scope, branch: "main" });
  assert.equal(workspaceName(ref), "org_123:app_123:project_123:workspace_main");
  assert.deepEqual(parseWorkspaceName(workspaceName(ref)), scope);

  const thread = ThreadRefSchema.parse({
    organizationId: scope.organizationId,
    appId: scope.appId,
    agentId: "agent_123",
    threadId: "thread_123",
  });
  assert.equal(threadName(thread), "org_123:app_123:agent_123:thread_123");
});

test("tenant and workspace contracts reject unsafe identifiers", () => {
  assert.equal(
    TenantContextSchema.safeParse({
      organizationId: "org/other",
      appId: "app_123",
    }).success,
    false,
  );
  assert.equal(
    WorkspaceRefSchema.safeParse({ ...scope, branch: "feature\\secret" }).success,
    false,
  );
  assert.equal(
    WorkspaceMutationSchema.safeParse({
      operation: "write",
      request: {
        path: "src/index.ts",
        content: "export const ok = true;",
        mediaType: "text/typescript",
      },
    }).success,
    true,
  );
});

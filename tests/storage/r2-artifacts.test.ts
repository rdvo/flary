import assert from "node:assert/strict";
import test from "node:test";

import { R2ArtifactHistoryStore } from "../../src/harness/storage/r2-artifacts.js";
import { StorageScopeSchema } from "../../src/harness/contracts/tenancy.js";

class MemoryR2 {
  readonly objects = new Map<string, string>();

  async put(key: string, value: string): Promise<void> {
    this.objects.set(key, value);
  }

  async get(key: string) {
    const value = this.objects.get(key);
    return value === undefined ? null : { text: async () => value };
  }

  async list(options: { prefix?: string } = {}) {
    return {
      objects: [...this.objects.keys()]
        .filter((key) => !options.prefix || key.startsWith(options.prefix))
        .map((key) => ({ key })),
      truncated: false,
    };
  }
}

const storageScope = StorageScopeSchema.parse({
  organizationId: "org_1",
  appId: "app_1",
  projectId: "project_1",
  workspaceId: "workspace_main",
});

const commit = {
  id: "commit_1",
  repository: "session-history",
  scope: {
    kind: "project" as const,
    organizationId: "org_1",
    appId: "app_1",
    projectId: "project_1",
  },
  files: [
    {
      path: "decisions/auth.md",
      content: "Use passkeys for the authentication decision.",
      mediaType: "text/markdown",
    },
  ],
  createdAt: "2026-07-29T00:00:00.000Z",
};

test("R2 artifact history is immutable and searchable by tenant scope", async () => {
  const bucket = new MemoryR2();
  const history = new R2ArtifactHistoryStore({
    bucket,
    scope: storageScope,
    repository: "session-history",
  });
  assert.deepEqual(await history.commit(commit), await history.commit(commit));
  await assert.rejects(
    () =>
      history.commit({
        ...commit,
        files: [{ ...commit.files[0], content: "changed" }],
      }),
    /immutable/i,
  );
  assert.equal((await history.latest("session-history", commit.scope))?.id, "commit_1");
  assert.deepEqual(
    (await history.list("session-history", commit.scope)).map((item) => item.id),
    ["commit_1"],
  );
  const hits = await history.searchExact(
    "session-history",
    commit.scope,
    "passkeys",
  );
  assert.equal(hits[0]?.path, "decisions/auth.md");
  assert.equal(hits[0]?.lineStart, 1);
});

test("R2 artifact history rejects cross-tenant writes", async () => {
  const history = new R2ArtifactHistoryStore({
    bucket: new MemoryR2(),
    scope: storageScope,
  });
  await assert.rejects(
    () =>
      history.commit({
        ...commit,
        scope: {
          ...commit.scope,
          organizationId: "other_org",
        },
      }),
    /scope does not match/i,
  );
});

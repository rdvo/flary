import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryArtifactHistoryStore } from "../../src/harness/storage/artifacts.js";

test("artifact history commits are immutable and support exact scoped search", async () => {
  const store = new InMemoryArtifactHistoryStore();
  const commit = await store.commit({
    id: "commit-1",
    repository: "project-artifacts",
    scope: {
      kind: "project",
      appId: "app-1",
      projectId: "project-1",
    },
    files: [
      {
        path: "decisions/provider.md",
        content: "# Provider\n\nUse a provider-neutral session.",
        mediaType: "text/markdown",
      },
    ],
    createdAt: "2026-07-28T12:00:00.000Z",
  });
  assert.equal((await store.latest("project-artifacts", commit.scope))?.id, "commit-1");
  assert.equal(
    (await store.searchExact("project-artifacts", commit.scope, "provider-neutral"))[0]?.path,
    "decisions/provider.md",
  );
  await assert.rejects(
    store.commit({
      ...commit,
      files: [{ ...commit.files[0]!, content: "changed" }],
    }),
    /immutable/,
  );
});

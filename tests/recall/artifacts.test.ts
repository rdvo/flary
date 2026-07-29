import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryRecallIndex } from "../../src/harness/recall/index.js";
import { ArtifactRecallIndexer } from "../../src/harness/recall/artifacts.js";

test("artifact checkpoints become recall documents with source references", async () => {
  const index = new InMemoryRecallIndex();
  const indexer = new ArtifactRecallIndexer(index);
  const ids = await indexer.indexCommit({
    id: "commit-1",
    repository: "artifacts",
    scope: {
      kind: "project",
      appId: "app-1",
      projectId: "project-1",
    },
    files: [
      {
        path: "plans/next.md",
        content: "Build recall before adding more tools.",
        mediaType: "text/markdown",
      },
    ],
    createdAt: "2026-07-28T12:00:00.000Z",
  });
  assert.equal(ids.length, 1);
  const response = await index.search({
    query: "recall",
    scope: {
      kind: "project",
      appId: "app-1",
      projectId: "project-1",
    },
    kinds: ["plan"],
  });
  assert.equal(response.results[0]?.reference.commit, "commit-1");
  assert.equal(response.results[0]?.reference.path, "plans/next.md");
});

import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryArtifactHistoryStore } from "../../src/harness/storage/artifacts.js";
import { FlaryHistoryProjector } from "../../src/harness/history/index.js";

const scope = {
  kind: "project" as const,
  organizationId: "org_1",
  appId: "app_1",
  projectId: "project_1",
};

test("artifact history supports checkpoints, branches, diffs, forks, and merges", async () => {
  const store = new InMemoryArtifactHistoryStore();
  const projector = new FlaryHistoryProjector(store);
  await projector.checkpoint({
    id: "commit_1",
    repository: "project_1",
    scope,
    reason: "dirty_turn",
    files: [{ path: "src/main.ts", content: "export const value = 1;" }],
    events: [{ type: "message.created", value: "hello" }],
    createdAt: "2026-07-29T00:00:00.000Z",
  });
  await store.fork("project_1", scope, "main", "agent_1");
  const second = await projector.checkpoint({
    id: "commit_2",
    repository: "project_1",
    scope,
    branch: "agent_1",
    parentId: "commit_1",
    reason: "explicit_commit",
    files: [{ path: "src/main.ts", content: "export const value = 2;" }],
    createdAt: "2026-07-29T00:01:00.000Z",
  });
  const diff = await store.diff("project_1", scope, "commit_1", second.commit.id, "agent_1");
  assert.equal(diff.files.find((file) => file.path === "src/main.ts")?.status, "modified");
  assert.deepEqual(
    (await store.list("project_1", scope, "agent_1")).map((item) => item.id),
    ["commit_2"],
  );
  const merged = await store.merge("project_1", scope, "agent_1", "main");
  assert.equal(merged.branch, "main");
  assert.equal((await store.latest("project_1", scope, "main"))?.id, merged.id);
});

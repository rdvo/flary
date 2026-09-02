import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryRecallIndex } from "../../src/harness/recall/index.js";

const NOW = "2026-07-28T12:00:00.000Z";

function document(
  id: string,
  content: string,
  projectId: string,
  kind: "decision" | "message" = "decision",
) {
  return {
    id,
    content,
    kind,
    scope: {
      kind: "project" as const,
      organizationId: "org-1",
      appId: "app-1",
      projectId,
    },
    reference: {
      id,
      kind,
      organizationId: "org-1",
      appId: "app-1",
      projectId,
      repository: "artifacts",
      commit: "commit-1",
      path: "decisions/" + id + ".md",
      lineStart: 1,
      lineEnd: 4,
      createdAt: NOW,
    },
    createdAt: NOW,
  };
}

test("recall search returns exact and related records only in the requested scope", async () => {
  const index = new InMemoryRecallIndex([
    document("decision-a", "We chose Durable Objects for resumable agent sessions.", "project-a"),
    document("decision-b", "We chose Durable Objects for a different tenant.", "project-b"),
  ]);

  const response = await index.search({
    query: "resumable sessions",
    scope: {
      kind: "project",
      appId: "app-1",
      projectId: "project-a",
    },
    mode: "hybrid",
  });

  assert.equal(response.results.length, 1);
  assert.equal(response.results[0]?.id, "decision-a");
  assert.equal(response.results[0]?.matchType, "hybrid");
  assert.match(response.results[0]?.reference.path ?? "", /decision-a/);
});

test("recall open requires the same scope and returns the full source document", async () => {
  const index = new InMemoryRecallIndex([
    document("decision-a", "The full decision body.", "project-a"),
  ]);

  const opened = await index.open({
    id: "decision-a",
    scope: {
      kind: "project",
      appId: "app-1",
      projectId: "project-a",
    },
  });
  assert.equal(opened?.content, "The full decision body.");

  const denied = await index.open({
    id: "decision-a",
    scope: {
      kind: "project",
      appId: "app-1",
      projectId: "project-b",
    },
  });
  assert.equal(denied, undefined);
});

test("exact recall does not fall back to token overlap", async () => {
  const index = new InMemoryRecallIndex([
    document("exact", "Durable sessions are resumable.", "project-a"),
  ]);

  const response = await index.search({
    query: "resumable sessions",
    scope: { kind: "project", appId: "app-1", projectId: "project-a" },
    mode: "exact",
  });

  assert.equal(response.results.length, 0);
});

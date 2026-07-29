import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryPromptRevisionStore } from "../../src/harness/prompts/revisions.js";

const base = {
  promptId: "support-answer",
  sourceHash: "a".repeat(64),
  sourceKey: "prompts/support-answer/a.prompt.md",
  createdBy: "user-1",
};

test("prompt revisions are append-only, ordered, and idempotent by source hash", async () => {
  const store = new InMemoryPromptRevisionStore();
  const first = await store.create(base);
  const duplicate = await store.create(base);
  const second = await store.create({
    ...base,
    sourceHash: "b".repeat(64),
    sourceKey: "prompts/support-answer/b.prompt.md",
  });

  assert.equal(first.revision, 1);
  assert.equal(duplicate.id, first.id);
  assert.equal(second.revision, 2);
  assert.deepEqual(
    (await store.list("support-answer")).map((revision) => revision.revision),
    [2, 1]
  );
  assert.equal((await store.current("support-answer"))?.id, second.id);
  assert.equal(await store.get("missing"), undefined);
});

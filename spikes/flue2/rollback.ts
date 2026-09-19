import assert from "node:assert/strict";

import * as flueInternal from "@flue/runtime/internal";

type FixtureEntry = {
  readonly id: string;
  readonly parentId: string | null;
  readonly role: "system" | "user" | "assistant" | "signal";
  readonly body: string;
};

type FixtureConversation = {
  readonly entries: Map<string, FixtureEntry>;
  activeLeafId: string | null;
};

function activePath(conversation: FixtureConversation): FixtureEntry[] {
  const path: FixtureEntry[] = [];
  const visited = new Set<string>();
  let current = conversation.activeLeafId
    ? conversation.entries.get(conversation.activeLeafId)
    : undefined;
  while (current) {
    if (visited.has(current.id)) throw new Error(`cycle at ${current.id}`);
    visited.add(current.id);
    path.push(current);
    current = current.parentId ? conversation.entries.get(current.parentId) : undefined;
  }
  return path.reverse();
}

const conversation: FixtureConversation = {
  entries: new Map([
    ["root", { id: "root", parentId: null, role: "system", body: "system" }],
    ["u1", { id: "u1", parentId: "root", role: "user", body: "first" }],
    ["a1", { id: "a1", parentId: "u1", role: "assistant", body: "answer" }],
    ["u2", { id: "u2", parentId: "a1", role: "user", body: "second" }],
    ["a2", { id: "a2", parentId: "u2", role: "assistant", body: "later answer" }],
  ]),
  activeLeafId: "a2",
};

const canonicalBefore = [...conversation.entries.values()];
const contextBefore = activePath(conversation).map((entry) => entry.body);
assert.deepEqual(contextBefore, ["system", "first", "answer", "second", "later answer"]);

const rollbackMarker: FixtureEntry = {
  id: "rollback",
  parentId: conversation.activeLeafId,
  role: "signal",
  body: "flary_rollback target=a1",
};
conversation.entries.set(rollbackMarker.id, rollbackMarker);
conversation.activeLeafId = rollbackMarker.id;

const canonicalAfter = [...conversation.entries.values()];
const contextAfter = activePath(conversation).map((entry) => entry.body);
assert.equal(canonicalAfter.length, canonicalBefore.length + 1);
assert.deepEqual(contextAfter, [
  "system",
  "first",
  "answer",
  "second",
  "later answer",
  "flary_rollback target=a1",
]);
assert.equal(conversation.entries.get("a2")?.body, "later answer");

const internalKeys = Object.keys(flueInternal);
assert.equal(internalKeys.includes("getActiveConversationPath"), false);
assert.equal(internalKeys.includes("buildConversationContext"), false);

console.log(
  JSON.stringify({
    contextFiltering: "activeLeaf traversal only",
    canonicalStorage: "append-only; abandoned entries remain",
    subsequentDispatch: "extends current activeLeaf; no target override",
    publicOverrideApi: false,
    flueInternalKeyCount: internalKeys.length,
  }),
);

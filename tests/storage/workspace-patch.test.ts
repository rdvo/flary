import assert from "node:assert/strict";
import test from "node:test";

import { applyWorkspaceUnifiedPatch } from "../../src/harness/storage/workspace-patch.ts";

test("workspace unified patches apply multiple exact hunks", () => {
  const result = applyWorkspaceUnifiedPatch(
    "one\ntwo\nthree\nfour\n",
    [
      "--- a/example.txt",
      "+++ b/example.txt",
      "@@ -1,2 +1,2 @@",
      " one",
      "-two",
      "+second",
      "@@ -4,1 +4,2 @@",
      " four",
      "+five",
    ].join("\n"),
    "example.txt",
  );

  assert.equal(result.content, "one\nsecond\nthree\nfour\nfive\n");
  assert.equal(result.hunkCount, 2);
});

test("workspace unified patches reject stale context", () => {
  assert.throws(
    () => applyWorkspaceUnifiedPatch(
      "current\n",
      "@@ -1 +1 @@\n-old\n+new",
      "example.txt",
    ),
    /did not match/,
  );
});

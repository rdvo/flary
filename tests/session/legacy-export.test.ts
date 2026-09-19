import assert from "node:assert/strict";
import test from "node:test";

import {
  LegacyExportActiveError,
  LegacyExportAttachmentError,
  LegacyExportConflictError,
  discoverLegacyAttachmentReferences,
  legacyExportDigest,
} from "../../src/harness/session/legacy-export.ts";

const thread = {
  tenantId: "tenant_1",
  applicationId: "app_1",
  threadId: "thread_1",
  agentId: "agent_1",
};
const canonical = {
  format: "flue-canonical" as const,
  version: 1 as const,
  batches: [
    [
      { id: "root", type: "conversation_created" },
      {
        id: "user_1",
        type: "user_message",
        content: [
          {
            type: "attachment",
            attachment: {
              id: "image_1",
              mimeType: "image/png",
              size: 3,
              digest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              filename: "one.png",
            },
          },
        ],
      },
    ],
  ],
};

const attachment = {
  id: "image_1",
  mimeType: "image/png",
  size: 3,
  digest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  filename: "one.png",
  conversationId: "conversation_1",
  chunkCount: 1,
  chunkDigests: ["bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],
};

test("legacy export digest is deterministic and excludes timestamps", async () => {
  const first = await legacyExportDigest({
    thread,
    sourceRevision: "npm:@flue/runtime-legacy@1.0.0-beta.9",
    canonical,
    attachments: [attachment],
  });
  const retry = await legacyExportDigest({
    thread,
    sourceRevision: "npm:@flue/runtime-legacy@1.0.0-beta.9",
    canonical,
    attachments: [attachment],
  });
  const changed = await legacyExportDigest({
    thread,
    sourceRevision: "npm:@flue/runtime-legacy@1.0.0-beta.9",
    canonical: { ...canonical, batches: [...canonical.batches, [{ id: "assistant_1" }]] },
    attachments: [attachment],
  });
  assert.equal(first, retry);
  assert.notEqual(first, changed);
  assert.equal(
    await legacyExportDigest({
      thread,
      sourceRevision: "npm:@flue/runtime-legacy@1.0.0-beta.9",
      canonical,
      attachments: [attachment],
    }),
    first,
  );
});

test("legacy export attachment traversal is conservative and ordered", () => {
  assert.deepEqual(discoverLegacyAttachmentReferences(canonical), [
    {
      id: "image_1",
      mimeType: "image/png",
      size: 3,
      digest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      filename: "one.png",
    },
  ]);
  assert.deepEqual(
    discoverLegacyAttachmentReferences({ toolArguments: { id: "not-an-attachment" } }),
    [],
  );
  assert.throws(
    () =>
      discoverLegacyAttachmentReferences({
        one: canonical,
        two: {
          type: "attachment",
          attachment: { ...attachment, size: 4 },
        },
      }),
    LegacyExportAttachmentError,
  );
});

test("legacy export conflicts and active refusal have typed errors", () => {
  const conflict = new LegacyExportConflictError("a".repeat(64), "b".repeat(64));
  assert.ok(conflict instanceof LegacyExportConflictError);
  assert.equal(conflict.existingDigest, "a".repeat(64));
  assert.equal(conflict.requestedDigest, "b".repeat(64));
  const active = new LegacyExportActiveError();
  assert.ok(active instanceof LegacyExportActiveError);
  assert.equal(active.code, "legacy_export_active");
});

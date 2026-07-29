import assert from "node:assert/strict";
import test from "node:test";
import {
  exportJsonl,
  importJsonl,
} from "../../src/harness/storage/jsonl.js";
import { ThreadRecordSchema } from "../../src/harness/storage/records.js";

test("round-trips canonical records through JSONL", () => {
  const record = ThreadRecordSchema.parse({
    schemaVersion: 1,
    recordType: "thread",
    id: "thread_1",
    createdAt: "2026-07-28T18:00:00.000Z",
    status: "active",
    metadata: { app: "rend" },
  });

  assert.deepEqual(importJsonl(exportJsonl([record])), [record]);
});

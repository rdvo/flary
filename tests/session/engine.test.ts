import assert from "node:assert/strict";
import test from "node:test";

import {
  assertInteractiveSessionEngine,
  FLUE_2_0_2_FLARY_CAPABILITIES,
  loadPinnedFlue2Runtime,
  migrateSessionEngine,
  requiresFlue2StableRelease,
  type SessionEngine,
} from "../../src/harness/session/engine.ts";

const completeCapabilities = {
  durableAdmission: true,
  durableObservation: true,
  manualCompaction: true,
  activePathRollback: true,
  exactCanonicalExport: true,
  exactCanonicalRestore: true,
  perSubmissionModelPin: true,
  approvalContinuation: true,
} as const;

test("Flue 2.0.2 stays fail closed until its Flary parity adapter is complete", async () => {
  const loaded = await loadPinnedFlue2Runtime();
  assert.equal(loaded.version, "2.0.2");
  assert.deepEqual(loaded.capabilities, FLUE_2_0_2_FLARY_CAPABILITIES);
  assert.throws(
    () => assertInteractiveSessionEngine({
      pin: { id: "flue-2", version: "2.0.2", revision: "npm:2.0.2" },
      capabilities: loaded.capabilities,
    }),
    /manualCompaction.*activePathRollback.*exactCanonicalExport.*perSubmissionModelPin.*approvalContinuation/,
  );
});

test("engine migration checks parity before reading the source archive", async () => {
  let exported = false;
  const source = fakeEngine("flue-legacy", completeCapabilities, {
    async export() {
      exported = true;
      throw new Error("must not export");
    },
  });
  const target = fakeEngine("flue-2", FLUE_2_0_2_FLARY_CAPABILITIES);

  await assert.rejects(
    migrateSessionEngine({
      source,
      target,
      agentId: "coder",
      threadId: "thread_1",
      ledger: { async append() {} },
    }),
    /missing required capabilities/,
  );
  assert.equal(exported, false);
});

test("only stable 0.8 and later releases require the Flue 2 parity gate", () => {
  assert.equal(requiresFlue2StableRelease("0.7.1"), false);
  assert.equal(requiresFlue2StableRelease("0.8.0-rc.1"), false);
  assert.equal(requiresFlue2StableRelease("0.8.0"), true);
  assert.equal(requiresFlue2StableRelease("0.10.0"), true);
  assert.equal(requiresFlue2StableRelease("1.0.0"), true);
  assert.throws(() => requiresFlue2StableRelease("latest"), /Invalid/);
});

function fakeEngine(
  id: "flue-legacy" | "flue-2",
  capabilities: SessionEngine["capabilities"],
  overrides: Partial<SessionEngine> = {},
): SessionEngine {
  return {
    pin: { id, version: "test", revision: "test" },
    capabilities,
    async submit() { return { submissionId: "sub_1", cursor: "0" }; },
    async observe() {},
    async cancel() {},
    async compact() {},
    async rollback() {},
    async export() {
      return {
        format: "flary-session-engine",
        version: 1,
        source: { id, version: "test", revision: "test" },
        threadId: "thread_1",
        sha256: "",
        payload: {},
      };
    },
    async restore() {},
    async active() { return false; },
    ...overrides,
  };
}

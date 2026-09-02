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
import {
  createFlue2SessionEngine,
  InMemoryFlue2SessionEngineStateStore,
  SqliteFlue2SessionEngineStateStore,
  type Flue2SessionEngineControl,
  type Flue2SessionEngineTransport,
} from "../../src/harness/session/flue2-engine.ts";
import { DatabaseSync } from "node:sqlite";

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

test("Flue 2.0.2 exposes the complete Flary session adapter", async () => {
  const loaded = await loadPinnedFlue2Runtime();
  assert.equal(loaded.version, "2.0.2");
  assert.deepEqual(loaded.capabilities, FLUE_2_0_2_FLARY_CAPABILITIES);
  assert.doesNotThrow(() =>
    assertInteractiveSessionEngine({
      pin: { id: "flue-2", version: "2.0.2", revision: "npm:2.0.2" },
      capabilities: loaded.capabilities,
    }),
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
  const target = fakeEngine("flue-2", {
    ...FLUE_2_0_2_FLARY_CAPABILITIES,
    exactCanonicalRestore: false,
  });

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

test("Flue 2 pins the model before admission and reuses it after eviction", async () => {
  const sql = sqlStore();
  let modelResolution = 0;
  const submittedModels: string[] = [];
  let failAfterRemoteAdmission = true;
  const transport = transportStub({
    async submit(input) {
      submittedModels.push(input.model);
      if (failAfterRemoteAdmission) {
        failAfterRemoteAdmission = false;
        throw new Error("Worker evicted after remote admission");
      }
      return { submissionId: "sub_pinned", cursor: "4" };
    },
  });
  const makeEngine = () =>
    createFlue2SessionEngine({
      state: new SqliteFlue2SessionEngineStateStore(sql),
      transport,
      control: controlStub(),
      resolveModel: () => `openai/model-generation-${++modelResolution}`,
    });

  const input = {
    agentId: "coder",
    threadId: "thread_pin",
    message: "Continue",
    idempotencyKey: "turn_1",
  };
  await assert.rejects(makeEngine().submit(input), /evicted/);
  const admitted = await makeEngine().submit(input);
  assert.equal(admitted.submissionId, "sub_pinned");
  assert.deepEqual(submittedModels, ["openai/model-generation-1", "openai/model-generation-1"]);

  const replayed = await makeEngine().submit(input);
  assert.equal(replayed.duplicate, true);
  assert.equal(submittedModels.length, 2);
  assert.equal(modelResolution, 1);

  await assert.rejects(
    makeEngine().submit({ ...input, model: "anthropic/different-model" }),
    /different submission/,
  );
});

test("Flue 2 resumes durable approvals before observation after eviction", async () => {
  const state = new InMemoryFlue2SessionEngineStateStore();
  const calls: string[] = [];
  const control = controlStub({
    async resumeApprovals(input) {
      calls.push(`resume:${input.submissionId}`);
    },
  });
  const transport = transportStub({
    async observe(admission, onEvent) {
      calls.push(`observe:${admission.submissionId}`);
      await onEvent({ type: "submission.completed" });
      return { outcome: "completed" };
    },
  });
  const engine = createFlue2SessionEngine({
    state,
    transport,
    control,
    resolveModel: () => "openai/gpt-test",
  });
  const admission = await engine.submit({
    agentId: "coder",
    threadId: "thread_approval",
    message: "Write the file",
    idempotencyKey: "turn_approval",
  });

  const restarted = createFlue2SessionEngine({
    state: new InMemoryFlue2SessionEngineStateStore(state.snapshot()),
    transport,
    control,
    resolveModel: () => "must-not-replace-pin",
  });
  await restarted.observe(admission, async () => {});
  assert.deepEqual(calls, ["resume:sub_1", "observe:sub_1"]);
});

test("Flue 2 manual compaction and rollback use the durable control plane", async () => {
  const records = new Map<string, { id: string; parentId: string | null }>([
    ["turn_1", { id: "turn_1", parentId: null }],
    ["turn_2", { id: "turn_2", parentId: "turn_1" }],
  ]);
  let leaf = "turn_2";
  let compacted = false;
  const control = controlStub({
    async compact() {
      compacted = true;
      return { compacted: true };
    },
    async rollback(input) {
      const marker = `rollback:${input.turnId}`;
      const target = records.get(input.turnId);
      if (!target) throw new Error("turn not found");
      records.set(marker, {
        id: marker,
        parentId: input.excludeTarget ? target.parentId : target.id,
      });
      leaf = marker;
      return { marker };
    },
  });
  const makeEngine = () =>
    createFlue2SessionEngine({
      state: new InMemoryFlue2SessionEngineStateStore(),
      transport: transportStub(),
      control,
      resolveModel: () => "openai/gpt-test",
    });
  await makeEngine().compact("coder", "thread_branch", "manual");
  await makeEngine().rollback({
    agentId: "coder",
    threadId: "thread_branch",
    turnId: "turn_1",
  });
  const activePath: string[] = [];
  let current = records.get(leaf);
  while (current) {
    activePath.unshift(current.id);
    current = current.parentId ? records.get(current.parentId) : undefined;
  }
  assert.equal(compacted, true);
  assert.deepEqual(activePath, ["turn_1", "rollback:turn_1"]);
  assert.equal(activePath.includes("turn_2"), false);
});

test("Flue 2 canonical export and restore are exact and hash checked", async () => {
  const canonical = {
    incarnation: "inc_1",
    batches: [
      [{ type: "conversation_created", id: "r1" }],
      [{ type: "user_message", id: "r2", content: "hello" }],
    ],
  };
  let restored: unknown;
  const control = controlStub({
    async exportCanonical() {
      return structuredClone(canonical);
    },
    async restoreCanonical(input) {
      restored = structuredClone(input.payload);
    },
  });
  const engine = createFlue2SessionEngine({
    state: new InMemoryFlue2SessionEngineStateStore(),
    transport: transportStub(),
    control,
    resolveModel: () => "openai/gpt-test",
  });
  const archive = await engine.export({ agentId: "coder", threadId: "source" });
  const restarted = createFlue2SessionEngine({
    state: new InMemoryFlue2SessionEngineStateStore(),
    transport: transportStub(),
    control,
    resolveModel: () => "openai/gpt-test",
  });
  await restarted.restore({ agentId: "coder", threadId: "target", archive });
  assert.deepEqual(restored, canonical);

  await assert.rejects(
    restarted.restore({
      agentId: "coder",
      threadId: "target",
      archive: { ...archive, payload: { changed: true } },
    }),
    /hash does not match/,
  );
});

test("all 0.8 and later releases require the Flue 2 parity gate", () => {
  assert.equal(requiresFlue2StableRelease("0.7.1"), false);
  assert.equal(requiresFlue2StableRelease("0.8.0-rc.1"), true);
  assert.equal(requiresFlue2StableRelease("0.8.0"), true);
  assert.equal(requiresFlue2StableRelease("1.0.0-rc.2"), true);
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
    async submit() {
      return { submissionId: "sub_1", cursor: "0" };
    },
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
    async active() {
      return false;
    },
    ...overrides,
  };
}

function transportStub(
  overrides: Partial<Flue2SessionEngineTransport> = {},
): Flue2SessionEngineTransport {
  return {
    async submit() {
      return { submissionId: "sub_1", cursor: "0" };
    },
    async observe() {
      return { outcome: "completed" };
    },
    async cancel() {},
    ...overrides,
  };
}

function controlStub(
  overrides: Partial<Flue2SessionEngineControl> = {},
): Flue2SessionEngineControl {
  return {
    async compact() {},
    async rollback() {},
    async exportCanonical() {
      return { batches: [] };
    },
    async restoreCanonical() {},
    async active() {
      return false;
    },
    async resumeApprovals() {},
    ...overrides,
  };
}

function sqlStore() {
  const database = new DatabaseSync(":memory:");
  return {
    exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): { toArray(): T[] } {
      const trimmed = query.trim().toLowerCase();
      if (bindings.length === 0 && !/^(select|with|pragma|explain)\b/.test(trimmed)) {
        database.exec(query);
        return { toArray: () => [] };
      }
      const statement = database.prepare(query);
      if (/^(select|with|pragma|explain)\b/.test(trimmed) || /\breturning\b/.test(trimmed)) {
        return { toArray: () => statement.all(...bindings) as T[] };
      }
      statement.run(...bindings);
      return { toArray: () => [] };
    },
  };
}

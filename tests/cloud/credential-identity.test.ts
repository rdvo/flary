import assert from "node:assert/strict";
import test from "node:test";

import {
  CredentialRecoveryUnavailableError,
  requireRecoveredFlueModel,
  resolveCloudProviderCredential,
  stableCredentialHash,
} from "../../apps/cloud/worker/provider-credentials.js";
import type { Env } from "../../apps/cloud/worker/env.js";
import { recoverUnsettledSubmissions } from "../../apps/cloud/worker/submission-recovery.js";

test("provider registration identity cannot collide across tenants", async () => {
  const common = [
    "app-1",
    "agent-1",
    "same-thread-id",
    "anthropic",
    "connection-1",
    "7",
    "connection-7",
  ];
  const [first, second] = await Promise.all([
    stableCredentialHash(["organization-1", ...common]),
    stableCredentialHash(["organization-2", ...common]),
  ]);

  assert.match(first, /^[0-9a-f]{64}$/);
  assert.match(second, /^[0-9a-f]{64}$/);
  assert.notEqual(first, second);
});

test("provider registration identity is stable for recovery", async () => {
  const identity = [
    "organization-1",
    "app-1",
    "agent-1",
    "thread-1",
    "openai-codex",
    "connection-1",
    "3",
    "connection-3",
  ];
  const [first, recovered] = await Promise.all([
    stableCredentialHash(identity),
    stableCredentialHash(identity),
  ]);

  assert.equal(first, recovered);
});

test("deleted BYOK recovery cannot fall back to a managed credential", async () => {
  const env = {
    OPENAI_API_KEY: "managed-key-that-must-not-be-used",
  } as Env;
  const binding = {
    thread: { threadId: "same-thread", agentId: "agent-1" },
    workspace: { organizationId: "organization-1", appId: "app-1" },
    connectionIds: ["deleted-byok-connection"],
  };
  const selection = { provider: "openai", model: "gpt-test" };
  const managed = await resolveCloudProviderCredential(env, {
    tenantId: "organization-1",
    applicationId: "app-1",
    connectionIds: binding.connectionIds,
    selection,
    userId: "user-1",
  });
  assert.equal(managed?.source, "managed");

  await assert.rejects(
    requireRecoveredFlueModel(env, binding, selection, "user-1", {
      provider: "openai",
      source: "tenant_byok",
      billingMode: "byok",
      connectionId: "deleted-byok-connection",
      version: 2,
      generation: "connection-2",
      connectionRef: "f84c6a283f51ec6ba07ebf0da01c76730d4d472d5ef433b183a539c96eea7485",
    }),
    (error: unknown) =>
      error instanceof CredentialRecoveryUnavailableError &&
      error.code === "credential_recovery_unavailable",
  );
});

test("a completed BYOK turn cannot block a new managed turn after restart", async () => {
  const prepared: string[] = [];
  const failed: string[] = [];
  const recovered = await recoverUnsettledSubmissions(
    [
      { id: "old-byok", status: "completed", source: "tenant_byok" },
      { id: "new-managed", status: "admitted", source: "managed" },
    ],
    async (submission) => {
      prepared.push(submission.id);
      if (submission.source === "tenant_byok") {
        throw new CredentialRecoveryUnavailableError("deleted-byok-reference", "openai");
      }
      return "managed-provider/model";
    },
    async (submission) => {
      failed.push(submission.id);
    },
  );

  assert.deepEqual(prepared, ["new-managed"]);
  assert.deepEqual(failed, []);
  assert.equal(recovered.get("new-managed"), "managed-provider/model");
});

test("one unavailable unsettled credential does not stop unrelated recovery", async () => {
  const failed: string[] = [];
  const recovered = await recoverUnsettledSubmissions(
    [
      { id: "missing-byok", status: "admitted", source: "tenant_byok" },
      { id: "new-managed", status: "processing", source: "managed" },
    ],
    async (submission) => {
      if (submission.source === "tenant_byok") {
        throw new CredentialRecoveryUnavailableError("deleted-byok-reference", "openai");
      }
      return "managed-provider/model";
    },
    async (submission, error) => {
      assert.equal(error.code, "credential_recovery_unavailable");
      failed.push(submission.id);
    },
  );

  assert.deepEqual(failed, ["missing-byok"]);
  assert.equal(recovered.get("new-managed"), "managed-provider/model");
});

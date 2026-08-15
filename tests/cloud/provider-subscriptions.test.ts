import assert from "node:assert/strict";
import test from "node:test";

import { preserveCodexCredentialFields } from "../../apps/cloud/worker/provider-subscriptions.ts";

test("Codex refresh keeps optional identity fields when they are omitted", () => {
  const refreshed = preserveCodexCredentialFields(
    {
      type: "oauth",
      access: "old-access",
      refresh: "old-refresh",
      expires: 1,
      idToken: "old-id-token",
      accountId: "account-123",
    },
    {
      type: "oauth",
      access: "new-access",
      refresh: "new-refresh",
      expires: 2,
    },
  );

  assert.deepEqual(refreshed, {
    type: "oauth",
    access: "new-access",
    refresh: "new-refresh",
    expires: 2,
    idToken: "old-id-token",
    accountId: "account-123",
  });
});

test("Codex refresh accepts rotated identity fields", () => {
  const refreshed = preserveCodexCredentialFields(
    {
      type: "oauth",
      access: "old-access",
      refresh: "old-refresh",
      expires: 1,
      idToken: "old-id-token",
      accountId: "old-account",
    },
    {
      type: "oauth",
      access: "new-access",
      refresh: "new-refresh",
      expires: 2,
      idToken: "new-id-token",
      accountId: "new-account",
    },
  );

  assert.equal(refreshed.idToken, "new-id-token");
  assert.equal(refreshed.accountId, "new-account");
});

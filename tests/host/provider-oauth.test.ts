import assert from "node:assert/strict";
import test from "node:test";

import {
  createFlaryHostRouter,
  type FlaryProviderOAuthHostService,
  type FlaryThreadHostService,
} from "../../src/harness/host/index.js";

const oauthSession = {
  id: "oauth-session-1",
  appId: "relayr",
  organizationId: "tenant-1",
  userId: "user-1",
  connectionId: "connection-1",
  provider: "openai-codex" as const,
  method: "device_code" as const,
  status: "pending" as const,
  verificationUri: "https://auth.openai.com/codex/device",
  userCode: "ABCD-EFGH",
  intervalSeconds: 5,
  expiresAt: "2026-07-29T12:15:00.000Z",
  createdAt: "2026-07-29T12:00:00.000Z",
  updatedAt: "2026-07-29T12:00:00.000Z",
};

test("the OSS host router mounts provider OAuth without Flary Cloud auth", async () => {
  let startedForUser = "";
  let disconnected = "";
  const providerOAuth: FlaryProviderOAuthHostService = {
    async start(scope) {
      startedForUser = scope.authorization.actor.id;
      return oauthSession;
    },
    async inspect() {
      return oauthSession;
    },
    async complete() {
      return { ...oauthSession, status: "ready" };
    },
    async cancel() {
      return { ...oauthSession, status: "cancelled" };
    },
    async importEncrypted() {
      return {
        connectionId: "connection-1",
        provider: "openai-codex",
        billingMode: "subscription",
        status: "active",
        scopes: [],
        version: 1,
      };
    },
    async disconnect(_scope, connectionId) {
      disconnected = connectionId;
    },
  };
  const router = createFlaryHostRouter<object>({
    authorize: () => ({
      organizationId: "tenant-1",
      actor: { id: "user-1", kind: "user", version: "1" },
    }),
    service: {} as FlaryThreadHostService,
    providerOAuth,
  });

  const response = await router.request("/apps/relayr/provider-oauth/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "openai-codex" }),
  });
  const body = (await response.json()) as { oauth: { userId: string } };

  assert.equal(response.status, 201);
  assert.equal(body.oauth.userId, "user-1");
  assert.equal(startedForUser, "user-1");

  const handoff = await router.request("/apps/relayr/provider-oauth/handoff", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      connectionId: "connection-1",
      provider: "openai-codex",
      ownerUserId: "user-1",
      grant: "user",
      envelope: {
        algorithm: "A256GCM",
        keyId: "relayr-vault-key",
        ciphertext: "encrypted-value",
        iv: "encrypted-iv",
      },
      scopes: [],
      version: 1,
    }),
  });
  const handoffBody = await handoff.text();
  assert.equal(handoff.status, 201);
  assert.doesNotMatch(handoffBody, /access.?token|refresh.?token/i);

  const disconnect = await router.request(
    "/apps/relayr/provider-oauth/connections/connection-1/disconnect",
    { method: "POST" },
  );
  assert.equal(disconnect.status, 200);
  assert.equal(disconnected, "connection-1");
});

test("the OAuth handoff rejects another user's credential", async () => {
  const router = createFlaryHostRouter<object>({
    authorize: () => ({
      organizationId: "tenant-1",
      actor: { id: "user-1", kind: "user", version: "1" },
    }),
    service: {} as FlaryThreadHostService,
    providerOAuth: {
      async start() {
        return oauthSession;
      },
      async inspect() {
        return oauthSession;
      },
      async complete() {
        return oauthSession;
      },
      async cancel() {
        return oauthSession;
      },
      async importEncrypted() {
        throw new Error("must not be called");
      },
      async disconnect() {},
    },
  });

  const response = await router.request("/apps/relayr/provider-oauth/handoff", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      connectionId: "connection-1",
      provider: "anthropic",
      ownerUserId: "user-2",
      grant: "user",
      envelope: {
        algorithm: "A256GCM",
        keyId: "relayr-vault-key",
        ciphertext: "encrypted-value",
        iv: "encrypted-iv",
      },
      scopes: [],
      version: 1,
    }),
  });
  assert.equal(response.status, 403);
});

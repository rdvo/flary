import assert from "node:assert/strict";
import test from "node:test";

import {
  ensureFreshProviderCredential,
  resolveProviderCredential,
  type ProviderCredentialLifecycleStore,
} from "../../src/harness/providers/resolver.js";
import {
  ProviderCredentialLifecycleSchema,
  ThreadMessageRequestSchema,
  type ProviderCredentialLifecycle,
} from "../../src/harness/contracts/index.js";

test("thread submissions default to short provider cache retention", () => {
  const parsed = ThreadMessageRequestSchema.parse({ message: "Hello" });
  assert.equal(parsed.cacheRetention, "short");
  assert.equal(
    ThreadMessageRequestSchema.parse({
      message: "Do not cache this turn",
      cacheRetention: "none",
    }).cacheRetention,
    "none",
  );
  assert.throws(() =>
    ThreadMessageRequestSchema.parse({
      message: "Invalid",
      cacheRetention: "forever",
    }),
  );
});

test("subscription credentials take precedence over BYOK and managed keys", async () => {
  const credential = await resolveProviderCredential(
    {
      async resolveSubscription() {
        return {
          source: "subscription",
          billingMode: "subscription",
          provider: "anthropic",
          secretRef: "vault/subscription",
          version: 1,
          generation: "subscription-1",
        };
      },
      async resolveTenantByok() {
        return {
          source: "tenant_byok",
          billingMode: "byok",
          provider: "anthropic",
          secretRef: "vault/byok",
          version: 1,
          generation: "byok-1",
        };
      },
      async resolveManaged() {
        return {
          source: "managed",
          billingMode: "managed",
          provider: "anthropic",
          secretRef: "vault/managed",
          version: 1,
          generation: "managed-1",
        };
      },
    },
    {
      tenantId: "tenant_123",
      connectionIds: ["connection_123"],
      selection: { provider: "anthropic", model: "claude-sonnet" },
    },
  );

  assert.equal(credential.source, "subscription");
  assert.equal(credential.billingMode, "subscription");
});

test("expired subscription credentials refresh once under the store lock", async () => {
  let current: ProviderCredentialLifecycle = ProviderCredentialLifecycleSchema.parse({
    connectionId: "connection_123",
    provider: "anthropic",
    billingMode: "subscription",
    status: "active",
    accessSecretRef: "access_v1",
    refreshSecretRef: "refresh_v1",
    scopes: [],
    expiresAt: "2026-07-29T12:00:00.000Z",
    version: 1,
  });
  let refreshCalls = 0;
  let lock = Promise.resolve();
  const store: ProviderCredentialLifecycleStore = {
    async read() {
      return current;
    },
    async modify(_connectionId, update) {
      const previous = lock;
      let release = () => {};
      lock = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        const next = await update(current);
        if (next) current = ProviderCredentialLifecycleSchema.parse(next);
        return current;
      } finally {
        release();
      }
    },
    async revoke() {
      current = { ...current, status: "revoked" };
    },
  };
  const adapter = {
    async refresh(latest: ProviderCredentialLifecycle) {
      refreshCalls += 1;
      return ProviderCredentialLifecycleSchema.parse({
        ...latest,
        accessSecretRef: "access_v2",
        refreshSecretRef: "refresh_v2",
        expiresAt: "2026-07-29T14:00:00.000Z",
        refreshedAt: "2026-07-29T12:30:00.000Z",
        version: latest.version + 1,
      });
    },
  };

  const [first, second] = await Promise.all([
    ensureFreshProviderCredential(store, adapter, {
      connectionId: "connection_123",
      now: new Date("2026-07-29T12:30:00.000Z"),
    }),
    ensureFreshProviderCredential(store, adapter, {
      connectionId: "connection_123",
      now: new Date("2026-07-29T12:30:00.000Z"),
    }),
  ]);

  assert.equal(refreshCalls, 1);
  assert.equal(first.accessSecretRef, "access_v2");
  assert.equal(second.accessSecretRef, "access_v2");
});

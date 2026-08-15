import assert from "node:assert/strict";
import test from "node:test";

import {
  CloudflareProviderOAuthPersistence,
  registerTrustedProviderAlias,
  type ProviderOAuthD1,
} from "../../src/harness/cloudflare/provider-oauth.js";

test("trusted Codex resolution refreshes once, preserves identity, and uses a D1 lock", async () => {
  const database = new OAuthDatabase();
  const persistence = new CloudflareProviderOAuthPersistence({
    database,
    encryptionKey: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
  });
  const scope = { tenantId: "tenant_a", userId: "user_a" };
  const expired = {
    access: "old-access",
    refresh: "old-refresh",
    expires: Date.now() - 1,
    idToken: "kept-id-token",
    accountId: "kept-account",
    safeMetadata: "kept-metadata",
  };
  database.connection.encrypted_credential = await (persistence as any).encrypt(
    expired,
    "flary:credential:tenant_a:user_a:subscription_a",
  );

  const originalFetch = globalThis.fetch;
  let refreshes = 0;
  globalThis.fetch = async () => {
    refreshes += 1;
    const payload = btoa(JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: "kept-account" },
    })).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
    return Response.json({
      access_token: `header.${payload}.signature`,
      refresh_token: "new-refresh",
      expires_in: 3_600,
    });
  };
  try {
    const [first, second] = await Promise.all([
      persistence.resolveOpenAICodexAccess(scope, "subscription_a"),
      persistence.resolveOpenAICodexAccess(scope, "subscription_a"),
    ]);
    assert.equal(refreshes, 1);
    assert.equal(first.accessToken.startsWith("header."), true);
    assert.equal(second.accessToken, first.accessToken);
    assert.equal(first.accountId, "kept-account");
    assert.equal(first.credentialGeneration, second.credentialGeneration);

    const stored = await (persistence as any).decrypt(
      database.connection.encrypted_credential,
      "flary:credential:tenant_a:user_a:subscription_a",
    );
    assert.equal(stored.idToken, "kept-id-token");
    assert.equal(stored.accountId, "kept-account");
    assert.equal(stored.safeMetadata, "kept-metadata");
    assert.equal(stored.refresh, "new-refresh");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("trusted aliases accept isolated OpenAI and Codex registrations", () => {
  registerTrustedProviderAlias({
    provider: "openai",
    providerAlias: "flary-runtime-aaaaaaaaaaaaaaaa",
    apiKey: "test-openai-key",
  });
  registerTrustedProviderAlias({
    provider: "openai-codex",
    providerAlias: "flary-runtime-bbbbbbbbbbbbbbbb",
    accessToken: "test-codex-token",
  });
  assert.throws(() => registerTrustedProviderAlias({
    provider: "openai",
    providerAlias: "shared",
    apiKey: "test-openai-key",
  }), /alias is invalid/);
});

class OAuthDatabase implements ProviderOAuthD1 {
  readonly connection = {
    id: "subscription_a",
    label: "openai-codex",
    status: "ready",
    encrypted_credential: "",
    credential_generation: "generation_a",
    credential_expires_at: Date.now() - 1,
  };
  private readonly locks = new Map<string, { lockId: string; expiresAt: number }>();

  prepare(query: string) {
    let values: unknown[] = [];
    return {
      bind: (...input: unknown[]) => {
        values = input;
        return this.prepareBound(query, () => values);
      },
      run: async () => ({ success: true, meta: { changes: 0 } }),
      first: async <T>() => null as T | null,
    };
  }

  private prepareBound(query: string, values: () => unknown[]) {
    return {
      bind: (...input: unknown[]) => this.prepareBound(query, () => input),
      first: async <T>() => {
        if (query.includes("FROM flary_connection")) return { ...this.connection } as T;
        return null;
      },
      run: async () => {
        const input = values();
        if (query.startsWith("CREATE TABLE")) return changed(0);
        if (query.includes("DELETE FROM flary_provider_credential_refresh_lock") && query.includes("expires_at")) {
          const current = this.locks.get(input[0] as string);
          if (current && current.expiresAt <= (input[1] as number)) this.locks.delete(input[0] as string);
          return changed(0);
        }
        if (query.includes("INSERT OR IGNORE INTO flary_provider_credential_refresh_lock")) {
          const connectionId = input[0] as string;
          if (this.locks.has(connectionId)) return changed(0);
          this.locks.set(connectionId, { lockId: input[1] as string, expiresAt: input[2] as number });
          return changed(1);
        }
        if (query.includes("DELETE FROM flary_provider_credential_refresh_lock")) {
          const current = this.locks.get(input[0] as string);
          if (current?.lockId === input[1]) this.locks.delete(input[0] as string);
          return changed(1);
        }
        if (query.includes("UPDATE flary_connection SET encrypted_credential")) {
          if (input[7] !== this.connection.credential_generation) return changed(0);
          this.connection.encrypted_credential = input[0] as string;
          this.connection.credential_generation = input[1] as string;
          this.connection.credential_expires_at = input[2] as number;
          return changed(1);
        }
        return changed(0);
      },
    };
  }
}

function changed(changes: number) {
  return Promise.resolve({ success: true, meta: { changes } });
}

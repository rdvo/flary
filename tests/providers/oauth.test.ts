import assert from "node:assert/strict";
import test from "node:test";

import {
  ProviderOAuthSessionSchema,
} from "../../src/harness/contracts/connections.js";
import {
  completeProviderOAuth,
  pollProviderOAuth,
  startProviderOAuth,
} from "../../src/harness/providers/oauth.js";
import {
  resolveNativeCachePolicy,
} from "../../src/harness/providers/cache.js";

test("starts and polls an OpenAI device login without exposing private state", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/api/accounts/deviceauth/usercode")) {
      return Response.json({
        device_auth_id: "device-auth-1",
        user_code: "ABCD-EFGH",
        interval: 3,
      });
    }
    if (url.endsWith("/api/accounts/deviceauth/token")) {
      return Response.json(
        { error: { code: "deviceauth_authorization_pending" } },
        { status: 403 },
      );
    }
    throw new Error(`Unexpected OAuth request: ${url}`);
  };

  try {
    const started = await startProviderOAuth({
      provider: "openai-codex",
    });
    assert.equal(started.method, "device_code");
    assert.equal(started.userCode, "ABCD-EFGH");
    assert.equal(started.privateState.deviceAuthId, "device-auth-1");

    const polled = await pollProviderOAuth({
      privateState: started.privateState,
    });
    assert.equal(polled.status, "pending");
    if (polled.status === "pending") {
      assert.equal(polled.intervalSeconds, 3);
    }

    assert.equal(
      JSON.stringify({
        provider: started.provider,
        method: started.method,
        userCode: started.userCode,
      }).includes("device-auth-1"),
      false,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("supports local browser callbacks and rejects a mismatched OAuth state", async () => {
  const openai = await startProviderOAuth({
    provider: "openai-codex",
    method: "browser_callback",
  });
  assert.equal(openai.method, "browser_callback");
  assert.match(openai.authorizationUrl ?? "", /^https:\/\/auth\.openai\.com\//);
  assert.match(openai.privateState.redirectUri ?? "", /^http:\/\/localhost:/);

  const anthropic = await startProviderOAuth({
    provider: "anthropic",
  });
  await assert.rejects(
    completeProviderOAuth({
      privateState: anthropic.privateState,
      authorizationResult:
        "http://localhost:54545/callback?code=code-1&state=wrong-state",
    }),
    /state mismatch/i,
  );
});

test("keeps the Codex ID token and account identity after login", async () => {
  const originalFetch = globalThis.fetch;
  const access = testJwt({
    "https://api.openai.com/auth": { chatgpt_account_id: "account-123" },
  });
  globalThis.fetch = async (input) => {
    assert.equal(String(input), "https://auth.openai.com/oauth/token");
    return Response.json({
      access_token: access,
      refresh_token: "refresh-secret",
      id_token: "id-token-secret",
      expires_in: 3_600,
    });
  };
  try {
    const started = await startProviderOAuth({
      provider: "openai-codex",
      method: "browser_callback",
    });
    const credential = await completeProviderOAuth({
      privateState: started.privateState,
      authorizationResult: `code-123#${started.privateState.state}`,
    });
    assert.equal(credential.access, access);
    assert.equal(credential.refresh, "refresh-secret");
    assert.equal(credential.idToken, "id-token-secret");
    assert.equal(credential.accountId, "account-123");
    assert.equal(typeof credential.expires, "number");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("public OAuth sessions reject token fields", () => {
  const session = {
    id: "oauth-session-1",
    appId: "app-1",
    organizationId: "org-1",
    userId: "user-1",
    connectionId: "connection-1",
    provider: "anthropic",
    method: "authorization_code",
    status: "pending",
    expiresAt: "2026-07-29T12:15:00.000Z",
    createdAt: "2026-07-29T12:00:00.000Z",
    updatedAt: "2026-07-29T12:00:00.000Z",
  };
  assert.equal(ProviderOAuthSessionSchema.safeParse(session).success, true);
  assert.equal(
    ProviderOAuthSessionSchema.safeParse({
      ...session,
      accessToken: "must-not-leak",
    }).success,
    false,
  );
});

test("reports requested and effective native cache policies", () => {
  assert.deepEqual(
    resolveNativeCachePolicy({
      provider: "anthropic",
      requested: "long",
    }),
    { requested: "long", effective: "1h" },
  );
  assert.deepEqual(
    resolveNativeCachePolicy({
      provider: "openai-codex",
      requested: "long",
    }),
    { requested: "long", effective: "provider-controlled" },
  );
  assert.deepEqual(
    resolveNativeCachePolicy({
      provider: "openai-codex",
      requested: "none",
    }),
    { requested: "none", effective: "none" },
  );
});

function testJwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value))
    .toString("base64url");
  return `${encode({ alg: "none" })}.${encode(payload)}.signature`;
}

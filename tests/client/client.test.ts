import assert from "node:assert/strict";
import test from "node:test";
import { FlaryClient } from "../../src/harness/client/client.js";

test("writes a branch workspace file through the Cloud API mount", async () => {
  let requestUrl = "";
  const client = new FlaryClient({
    baseUrl: "https://cloud.flary.test",
    appId: "app one",
    apiPrefix: "/api",
    fetch: async (input) => {
      requestUrl = String(input);
      return Response.json({
        file: {
          path: "src/index.ts",
          size: 20,
          sha256: "a".repeat(64),
          mediaType: "text/typescript",
          storage: "inline",
          createdAt: "2026-07-28T12:00:00.000Z",
          updatedAt: "2026-07-28T12:00:00.000Z",
        },
      });
    },
  });

  const response = await client.writeWorkspaceFile(
    "project one",
    "branch main",
    {
    path: "src/index.ts",
    content: "export const ok = 1;",
    mediaType: "text/typescript",
    },
  );

  assert.equal(
    requestUrl,
    "https://cloud.flary.test/api/apps/app%20one/projects/project%20one/workspaces/branch%20main/files/write",
  );
  assert.equal(response.file.path, "src/index.ts");
});

test("manages redacted connections through the same Cloud API client", async () => {
  const urls: string[] = [];
  const bodies: unknown[] = [];
  const client = new FlaryClient({
    baseUrl: "https://cloud.flary.test",
    appId: "app-1",
    apiPrefix: "/api",
    fetch: async (input, init) => {
      urls.push(String(input));
      if (init?.body) bodies.push(JSON.parse(String(init.body)));
      const url = String(input);
      if (url.endsWith("/connections")) {
        return Response.json({
          connection: {
            id: "connection-1",
            appId: "app-1",
            organizationId: "org-1",
            name: "GitHub",
            slug: "github",
            provider: "github",
            type: "api",
            protocol: "http",
            baseUrl: "https://api.github.com",
            authType: "bearer",
            status: "configured",
            createdBy: "user-1",
            createdAt: "2026-07-28T12:00:00.000Z",
            updatedAt: "2026-07-28T12:00:00.000Z",
          },
        });
      }
      return Response.json({
        ok: true,
        secret: {
          id: "secret-1",
          connectionId: "connection-1",
          name: "github-token",
          scope: "organization",
          version: 1,
          keyId: "flary-token-encryption-key",
          createdAt: "2026-07-28T12:00:00.000Z",
          updatedAt: "2026-07-28T12:00:00.000Z",
        },
      });
    },
  });

  const connection = await client.createConnection({
    name: "GitHub",
    slug: "github",
    provider: "github",
    type: "api",
    baseUrl: "https://api.github.com",
    authType: "bearer",
  });
  const secret = await client.putConnectionSecret("connection-1", {
    name: "github-token",
    value: "secret-value",
    scope: "organization",
  });
  await client.deleteConnectionSecret("connection-1", "github-token");
  await client.deleteConnection("connection-1");

  assert.equal(connection.slug, "github");
  assert.equal(secret.name, "github-token");
  assert.equal(bodies.some((body) => JSON.stringify(body).includes("secret-value")), true);
  assert.equal(urls[0], "https://cloud.flary.test/api/apps/app-1/connections");
  assert.equal(
    urls[1],
    "https://cloud.flary.test/api/apps/app-1/connections/connection-1/secrets",
  );
});

test("drives provider OAuth through the reusable SDK", async () => {
  const requests: Array<{ url: string; method: string; body?: unknown }> = [];
  const oauth = {
    id: "oauth-session-1",
    appId: "app-1",
    organizationId: "org-1",
    userId: "user-1",
    connectionId: "connection-1",
    provider: "openai-codex",
    method: "device_code",
    status: "pending",
    verificationUri: "https://auth.openai.com/codex/device",
    userCode: "ABCD-EFGH",
    intervalSeconds: 5,
    expiresAt: "2026-07-29T12:15:00.000Z",
    createdAt: "2026-07-29T12:00:00.000Z",
    updatedAt: "2026-07-29T12:00:00.000Z",
  };
  const client = new FlaryClient({
    baseUrl: "https://cloud.flary.test",
    appId: "app-1",
    apiPrefix: "/api",
    fetch: async (input, init) => {
      requests.push({
        url: String(input),
        method: init?.method ?? "GET",
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      });
      return Response.json({ oauth });
    },
  });

  await client.startProviderOAuth({ provider: "openai-codex" });
  await client.getProviderOAuth("oauth-session-1", { poll: true });
  await client.cancelProviderOAuth("oauth-session-1");

  assert.deepEqual(requests[0], {
    url: "https://cloud.flary.test/api/apps/app-1/provider-oauth/start",
    method: "POST",
    body: { provider: "openai-codex" },
  });
  assert.equal(
    requests[1]?.url,
    "https://cloud.flary.test/api/apps/app-1/provider-oauth/oauth-session-1?poll=true",
  );
  assert.equal(requests[2]?.method, "POST");
});

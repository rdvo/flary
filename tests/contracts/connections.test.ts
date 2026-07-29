import assert from "node:assert/strict";
import test from "node:test";

import {
  CollectApiKeyRequestSchema,
  ConnectionCreateInputSchema,
  ConnectionSecretInputSchema,
} from "../../src/harness/contracts/index.js";

test("validates safe API and MCP connection metadata", () => {
  const api = ConnectionCreateInputSchema.parse({
    name: "GitHub",
    slug: "github",
    provider: "github",
    type: "api",
    baseUrl: "https://api.github.com",
    authType: "bearer",
  });
  assert.equal(api.protocol, "http");
  assert.equal(api.authType, "bearer");

  const mcp = ConnectionCreateInputSchema.parse({
    name: "Local tools",
    slug: "local-tools",
    provider: "local",
    type: "mcp",
    protocol: "stdio",
    authType: "none",
  });
  assert.equal(mcp.protocol, "stdio");

  assert.throws(() =>
    ConnectionCreateInputSchema.parse({
      name: "Missing endpoint",
      slug: "missing-endpoint",
      provider: "example",
      type: "api",
    }),
  );
  assert.throws(() =>
    ConnectionCreateInputSchema.parse({
      name: "Invalid stdio API",
      slug: "invalid-stdio-api",
      provider: "example",
      type: "api",
      protocol: "stdio",
      baseUrl: "https://example.com",
    }),
  );
});

test("collect_api_key requests never accept a secret value", () => {
  const request = CollectApiKeyRequestSchema.parse({
    connectionId: "connection-github",
    secretName: "github-token",
    label: "GitHub personal access token",
    provider: "github",
  });
  assert.equal(request.scope, "organization");
  assert.equal("value" in request, false);

  assert.throws(() =>
    CollectApiKeyRequestSchema.parse({
      connectionId: "connection-github",
      secretName: "github-token",
      label: "GitHub personal access token",
      value: "this-must-not-be-in-a-collect-request",
    }),
  );
});

test("secret values are accepted only by the explicit write contract", () => {
  const input = ConnectionSecretInputSchema.parse({
    name: "github-token",
    value: "secret-value",
    scope: "organization",
  });
  assert.equal(input.value, "secret-value");
});

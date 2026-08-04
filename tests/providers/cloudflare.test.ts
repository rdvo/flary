import assert from "node:assert/strict";
import test from "node:test";

import {
  CloudflareAIGatewayAdapter,
  CloudflareWorkersAIAdapter,
  type ModelRequest,
} from "../../src/harness/providers/index.js";

const request: ModelRequest = {
  model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  messages: [{ role: "user", content: "Say hello." }],
};

test("Cloudflare AI Gateway adapter sends the account gateway headers", async () => {
  let url = "";
  let headers: Headers | undefined;
  const adapter = new CloudflareAIGatewayAdapter({
    accountId: "0123456789abcdef0123456789abcdef",
    gatewayId: "flary-test",
    apiToken: "oauth-access-token",
    metadata: { app: "flary-test" },
    fetch: async (input, init) => {
      url = String(input);
      headers = new Headers(init?.headers);
      return new Response(
        JSON.stringify({
          id: "chatcmpl_1",
          model: request.model,
          choices: [
            {
              message: { role: "assistant", content: "Hello." },
              finish_reason: "stop",
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
  });

  const response = await adapter.complete(request);

  assert.equal(
    url,
    "https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/v1/chat/completions",
  );
  assert.equal(headers?.get("authorization"), "Bearer oauth-access-token");
  assert.equal(headers?.get("cf-aig-gateway-id"), "flary-test");
  assert.deepEqual(JSON.parse(headers?.get("cf-aig-metadata") ?? "{}"), {
    app: "flary-test",
  });
  assert.equal(response.provider, "cloudflare-ai-gateway");
  assert.equal(response.content, "Hello.");
});

test("Cloudflare Workers AI adapter uses the binding without a provider key", async () => {
  let model = "";
  let input: Record<string, unknown> | undefined;
  const adapter = new CloudflareWorkersAIAdapter({
    async run(selectedModel, selectedInput) {
      model = selectedModel;
      input = selectedInput;
      return {
        response: "Hello from Workers AI.",
        usage: { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 },
      };
    },
  });

  const response = await adapter.complete(request);
  assert.equal(model, request.model);
  assert.deepEqual(input?.messages, [{ role: "user", content: "Say hello." }]);
  assert.equal(response.content, "Hello from Workers AI.");
  assert.equal(response.usage?.totalTokens, 9);
  assert.equal(response.provider, "cloudflare");
});

test("Cloudflare AI Gateway adapter validates account IDs", () => {
  assert.throws(
    () =>
      new CloudflareAIGatewayAdapter({
        accountId: "not-an-account",
        gatewayId: "flary-test",
        apiToken: "token",
      }),
    /accountId must be a 32-character hex ID/,
  );
});

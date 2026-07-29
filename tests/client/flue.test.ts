import assert from "node:assert/strict";
import test from "node:test";

import { createFlaryThreadClient } from "../../src/harness/client/flue.js";

test("routes every turn through authenticated Flary thread admission", async () => {
  let requestUrl = "";
  let requestBody: Record<string, unknown> | undefined;
  const client = createFlaryThreadClient({
    baseUrl: "https://cloud.flary.test",
    token: "token_123",
    fetch: async (input, init) => {
      requestUrl = String(input);
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        streamUrl: "/streams/thread",
        offset: "0",
        submissionId: "submission_123",
      }, { status: 202 });
    },
  });

  const result = await client.send(
    {
      organizationId: "org_123",
      appId: "app_123",
      agentId: "support",
      threadId: "thread_123",
    },
    {
      message: "Hello",
      model: { provider: "anthropic", model: "claude-sonnet" },
      thinkingLevel: "high",
      cacheRetention: "long",
      idempotencyKey: "request_123",
    },
  );

  assert.equal(
    requestUrl,
    "https://cloud.flary.test/api/apps/app_123/threads/thread_123/messages",
  );
  assert.equal(result.submissionId, "submission_123");
  assert.deepEqual(requestBody, {
    message: "Hello",
    model: { provider: "anthropic", model: "claude-sonnet" },
    thinkingLevel: "high",
    cacheRetention: "long",
    idempotencyKey: "request_123",
  });
});

test("the prompt alias also uses Flary admission", async () => {
  let requestUrl = "";
  const client = createFlaryThreadClient({
    baseUrl: "https://cloud.flary.test",
    fetch: async (input) => {
      requestUrl = String(input);
      return Response.json({
        streamUrl: "/streams/thread",
        offset: "0",
        submissionId: "submission_456",
      }, { status: 202 });
    },
  });

  const result = await client.prompt(
    {
      organizationId: "org_123",
      appId: "app_123",
      agentId: "support",
      threadId: "thread_123",
    },
    { message: "Use the safe route" },
  );

  assert.equal(result.submissionId, "submission_456");
  assert.match(requestUrl, /\/api\/apps\/app_123\/threads\/thread_123\/messages$/);
});

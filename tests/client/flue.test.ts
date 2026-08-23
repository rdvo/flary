import assert from "node:assert/strict";
import test from "node:test";

import { createFlaryThreadClient } from "../../src/harness/client/flue.js";

test("binds the native fetch receiver for browser clients", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async function (this: typeof globalThis) {
    assert.equal(this, globalThis);
    return Response.json({ threads: [] });
  };

  try {
    const client = createFlaryThreadClient({
      baseUrl: "https://cloud.flary.test",
    });
    assert.deepEqual(await client.list("app_123"), []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

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

test("reads conversation history through the authenticated Flary thread API", async () => {
  let requestUrl = "";
  const snapshot = {
    v: 1 as const,
    conversationId: "conversation_123",
    offset: "4",
    messages: [],
    settlements: [],
  };
  const client = createFlaryThreadClient({
    baseUrl: "https://cloud.flary.test",
    token: "application_token",
    fetch: async (input) => {
      requestUrl = String(input);
      return Response.json(snapshot);
    },
  });

  const result = await client.history({
    organizationId: "org_123",
    appId: "app_123",
    agentId: "support",
    threadId: "thread_123",
  });

  assert.equal(
    requestUrl,
    "https://cloud.flary.test/api/apps/app_123/threads/thread_123/flue/agents/support/org_123%3Aapp_123%3Asupport%3Athread_123?view=history",
  );
  assert.deepEqual(result, snapshot);
});

test("routes aborts and attachments through the authenticated thread proxy", async () => {
  const requests: string[] = [];
  const client = createFlaryThreadClient({
    baseUrl: "https://cloud.flary.test",
    token: "application_token",
    fetch: async (input) => {
      requests.push(String(input));
      return Response.json({ aborted: true }, { status: 202 });
    },
  });
  const ref = {
    organizationId: "org_123",
    appId: "app_123",
    agentId: "support",
    threadId: "thread_123",
  };

  await client.abort(ref);
  assert.match(requests[0]!, /\/api\/apps\/app_123\/threads\/thread_123\/flue\/agents\/support\/.+\/abort$/);
  assert.match(
    client.attachmentUrl(ref, "file_123"),
    /\/api\/apps\/app_123\/threads\/thread_123\/flue\/agents\/support\/.+\/attachments\/file_123$/,
  );
});

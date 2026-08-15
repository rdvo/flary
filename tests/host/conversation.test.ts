import assert from "node:assert/strict";
import test from "node:test";

import {
  createFlaryHostRouter,
  type FlaryThreadHostService,
} from "../../src/harness/host/index.js";

test("the host reads a conversation only after tenant authorization", async () => {
  const calls: string[] = [];
  const service = {
    async conversation(target) {
      calls.push(`${target.authorization.organizationId}:${target.threadId}`);
      return {
        v: 1,
        conversationId: "conversation_1",
        offset: "2",
        messages: [],
        settlements: [],
      };
    },
  } as Pick<FlaryThreadHostService, "conversation"> as FlaryThreadHostService;
  const router = createFlaryHostRouter<object>({
    authorize: () => ({
      organizationId: "tenant_1",
      actor: { id: "user_1", kind: "user", version: "1" },
    }),
    service,
  });

  const response = await router.request(
    "/apps/docs/threads/thread_1/conversation",
  );

  assert.equal(response.status, 200);
  assert.deepEqual(calls, ["tenant_1:thread_1"]);
  assert.deepEqual(await response.json(), {
    conversation: {
      v: 1,
      conversationId: "conversation_1",
      offset: "2",
      messages: [],
      settlements: [],
    },
  });
});

test("the host streams safe conversation updates after tenant authorization", async () => {
  const calls: unknown[] = [];
  const service = {
    async conversationUpdates(target, input) {
      calls.push({ organizationId: target.authorization.organizationId, threadId: target.threadId, input });
      return new Response("event: data\ndata:[]\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    },
  } as Pick<FlaryThreadHostService, "conversationUpdates"> as FlaryThreadHostService;
  const router = createFlaryHostRouter<object>({
    authorize: () => ({
      organizationId: "tenant_1",
      actor: { id: "user_1", kind: "user", version: "1" },
    }),
    service,
  });

  const response = await router.request(
    "/apps/docs/threads/thread_1/conversation?view=updates&offset=1_2&live=sse",
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  assert.equal(await response.text(), "event: data\ndata:[]\n\n");
  const call = calls[0] as {
    organizationId: string;
    threadId: string;
    input: { offset: string; live: string; signal?: AbortSignal };
  };
  assert.equal(call.organizationId, "tenant_1");
  assert.equal(call.threadId, "thread_1");
  assert.equal(call.input.offset, "1_2");
  assert.equal(call.input.live, "sse");
  assert.ok(call.input.signal instanceof AbortSignal);
});

test("the host rejects an invalid live conversation cursor", async () => {
  const service = {
    async conversationUpdates() {
      throw new Error("must not run");
    },
  } as Pick<FlaryThreadHostService, "conversationUpdates"> as FlaryThreadHostService;
  const router = createFlaryHostRouter<object>({
    authorize: () => ({
      organizationId: "tenant_1",
      actor: { id: "user_1", kind: "user", version: "1" },
    }),
    service,
  });

  const response = await router.request(
    "/apps/docs/threads/thread_1/conversation?view=updates&offset=wrong&live=sse",
  );
  assert.equal(response.status, 400);
  assert.equal((await response.json() as any).error.type, "invalid_offset");
});

test("the Flue-compatible proxy authorizes streams, aborts, and attachments", async () => {
  const calls: string[] = [];
  const service = {
    async conversationUpdates(target, input) {
      calls.push(`stream:${target.authorization.organizationId}:${input.offset}`);
      return new Response("stream");
    },
    async interrupt(target) {
      calls.push(`abort:${target.authorization.organizationId}`);
    },
    async attachment(target, attachmentId) {
      calls.push(`attachment:${target.authorization.organizationId}:${attachmentId}`);
      return new Response("bytes", { headers: { "content-type": "image/png" } });
    },
  } as Pick<FlaryThreadHostService, "conversationUpdates" | "interrupt" | "attachment"> as FlaryThreadHostService;
  let authorizations = 0;
  const router = createFlaryHostRouter<object>({
    authorize: () => {
      authorizations += 1;
      return {
        organizationId: "tenant_1",
        actor: { id: "user_1", kind: "user", version: "1" },
      };
    },
    service,
  });
  const base = "/apps/docs/threads/thread_1/flue/agents/untrusted/untrusted";

  assert.equal((await router.request(`${base}?view=updates&offset=1_2&live=long-poll`)).status, 200);
  assert.equal((await router.request(`${base}/abort`, { method: "POST" })).status, 202);
  const attachment = await router.request(`${base}/attachments/file_1`);
  assert.equal(attachment.status, 200);
  assert.equal(await attachment.text(), "bytes");
  assert.equal(authorizations, 3);
  assert.deepEqual(calls, [
    "stream:tenant_1:1_2",
    "abort:tenant_1",
    "attachment:tenant_1:file_1",
  ]);
});

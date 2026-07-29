import assert from "node:assert/strict";
import test from "node:test";

import type { ConversationStreamChunk } from "@flue/sdk";

import {
  InMemoryFlaryRunRepository,
  createFlueRunService,
  type FlueAgentGateway,
} from "../../src/harness/flue/service.js";
import type { TrustedRunContext } from "../../src/harness/host/runs.js";

const trusted: TrustedRunContext = {
  tenantId: "tenant_1",
  applicationId: "relayr",
  projectId: "project_1",
  agentId: "research",
  identity: { id: "user_1", kind: "user" },
  roles: ["owner"],
  scopes: ["agents.run"],
};

function gateway(): FlueAgentGateway {
  return {
    async send() {
      return {
        streamUrl: "https://example.com/stream",
        offset: "offset_1",
        submissionId: "submission_1",
      };
    },
    async wait(_admission, onEvent) {
      const chunks: ConversationStreamChunk[] = [
        {
          type: "message-delta",
          conversationId: "conversation_1",
          messageId: "message_1",
          kind: "text",
          delta: "Hello",
          position: { batch: 1, index: 0 },
        },
        {
          type: "message-completed",
          conversationId: "conversation_1",
          messageId: "message_1",
          usage: {
            input: 10,
            output: 5,
            cacheRead: 2,
            cacheWrite: 0,
            totalTokens: 17,
            cost: {
              input: 0.001,
              output: 0.002,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0.003,
            },
          },
          position: { batch: 1, index: 1 },
        },
      ];
      for (const chunk of chunks) await onEvent(chunk);
      return { answer: "Hello" };
    },
    async abort() {
      return { aborted: true };
    },
  };
}

test("Flue run service admits once and materializes replayable events", async () => {
  const repository = new InMemoryFlaryRunRepository();
  const service = createFlueRunService({
    repository,
    gateway: gateway(),
    createRunId: () => "run_1",
    pollMs: 1,
  });
  const request = {
    requestId: "request_1",
    channelId: "channel_1",
    input: { prompt: "Hello" },
    execution: "agent" as const,
    idempotencyKey: "request-key-1",
  };

  const first = await service.create(trusted, request);
  const duplicate = await service.create(trusted, request);
  assert.equal(first.runId, "run_1");
  assert.equal(duplicate.runId, "run_1");

  const deadline = Date.now() + 1_000;
  let result = await service.get(trusted, first.runId);
  while (result.status !== "completed" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    result = await service.get(trusted, first.runId);
  }
  assert.equal(result.status, "completed");
  assert.deepEqual(result.output, { answer: "Hello" });
  assert.equal(result.usage?.totalTokens, 17);

  const controller = new AbortController();
  const events = [];
  for await (const event of service.observe(trusted, first.runId, {
    afterSequence: 0,
    signal: controller.signal,
  })) {
    events.push(event);
  }
  assert.ok(events.some((event) => event.type === "message.delta"));
  assert.equal(events.at(-1)?.type, "run.completed");
});

test("Flue run service hides runs across tenant boundaries", async () => {
  const service = createFlueRunService({
    repository: new InMemoryFlaryRunRepository(),
    gateway: gateway(),
    createRunId: () => "run_private",
  });
  await service.create(trusted, {
    requestId: "request_private",
    channelId: "channel_private",
    input: "private",
  });

  await assert.rejects(
    () =>
      service.get(
        { ...trusted, tenantId: "tenant_2" },
        "run_private",
      ),
    /not found/i,
  );
});

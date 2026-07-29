import assert from "node:assert/strict";
import test from "node:test";

import {
  OpenAIResponsesRecoveryAdapter,
  InterruptedProviderAdapter,
} from "../../src/harness/providers/durable-adapters.js";
import {
  InMemoryProviderCheckpointStore,
  continuationRequest,
  type ProviderRecoveryContext,
} from "../../src/harness/providers/recovery.js";

test("OpenAI Responses resumes by response ID and sequence", async () => {
  const urls: string[] = [];
  const methods: string[] = [];
  const adapter = new OpenAIResponsesRecoveryAdapter({
    apiKey: "test-key",
    fetch: async (input, init) => {
      urls.push(String(input));
      methods.push(init?.method ?? "GET");
      if (urls.length === 1) {
        return sse([
          {
            type: "response.created",
            sequence_number: 0,
            response: { id: "resp-1", model: "gpt-5" },
          },
          {
            type: "response.output_text.delta",
            sequence_number: 1,
            response_id: "resp-1",
            delta: "Hel",
          },
        ]);
      }
      return sse([
        {
          type: "response.output_text.delta",
          sequence_number: 2,
          response_id: "resp-1",
          delta: "lo",
        },
        {
          type: "response.completed",
          sequence_number: 3,
          response: {
            id: "resp-1",
            model: "gpt-5",
            output: [
              {
                type: "message",
                content: [{ type: "output_text", text: "Hello" }],
              },
            ],
            usage: {
              input_tokens: 10,
              output_tokens: 2,
              total_tokens: 12,
              input_tokens_details: { cached_tokens: 4 },
            },
          },
        },
      ]);
    },
  });
  const checkpoints = new InMemoryProviderCheckpointStore();
  const context: ProviderRecoveryContext = {
    runId: "run-1",
    operationId: "model-1",
    idempotencyKey: "model-request-1",
    checkpoints,
  };
  const request = {
    model: "gpt-5",
    messages: [{ role: "user" as const, content: "hello" }],
  };

  await assert.rejects(async () => {
    for await (const _event of adapter.start(request, context)) {
      // Consume the interrupted stream.
    }
  });
  const interrupted = await checkpoints.get("run-1", "model-1");
  assert.equal(interrupted?.status, "interrupted");
  assert.equal(interrupted?.resumeToken, "resp-1");
  assert.equal(interrupted?.streamSequence, 1);

  const recovered = [];
  for await (const event of adapter.recover(
    request,
    interrupted!,
    context,
  )) {
    recovered.push(event);
  }

  assert.equal(methods[0], "POST");
  assert.equal(methods[1], "GET");
  assert.match(urls[1] ?? "", /responses\/resp-1/);
  assert.match(urls[1] ?? "", /starting_after=1/);
  assert.equal(recovered.at(-1)?.type, "finish");
  const complete = await checkpoints.get("run-1", "model-1");
  assert.equal(complete?.status, "completed");
  assert.equal(complete?.partialText, "Hello");
  assert.equal(complete?.usage?.cachedInputTokens, 4);
});

test("continuation keeps persisted assistant output before tool results", () => {
  const request = {
    model: "claude-test",
    messages: [
      { role: "user" as const, content: "check" },
      {
        role: "tool" as const,
        content: "done",
        toolCallId: "tool-1",
      },
    ],
  };
  const continued = continuationRequest(request, {
    runId: "run-1",
    operationId: "model-1",
    adapterId: "anthropic",
    provider: "anthropic",
    status: "waiting_for_tool",
    partialText: "I will check.",
    partialReasoning: "",
    toolCalls: [
      { id: "tool-1", name: "check", arguments: { id: 1 } },
    ],
    attempt: 1,
    idempotencyKey: "request-1",
    updatedAt: "2026-07-28T12:00:00.000Z",
  });

  assert.deepEqual(
    continued.messages.map((message) => message.role),
    ["user", "assistant", "tool"],
  );
});

test("unknown providers require an explicit retry", async () => {
  const checkpoints = new InMemoryProviderCheckpointStore();
  const adapter = new InterruptedProviderAdapter();
  const context: ProviderRecoveryContext = {
    runId: "run-1",
    operationId: "model-1",
    idempotencyKey: "request-1",
    checkpoints,
  };
  const events = [];
  for await (const event of adapter.start(
    { model: "custom", messages: [{ role: "user", content: "hello" }] },
    context,
  )) {
    events.push(event);
  }

  assert.equal(events[0]?.type, "error");
  assert.equal(
    events[0]?.type === "error" ? events[0].error.code : undefined,
    "explicit_retry_required",
  );
  assert.equal(
    (await checkpoints.get("run-1", "model-1"))?.status,
    "interrupted",
  );
});

function sse(events: unknown[]): Response {
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

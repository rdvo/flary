import assert from "node:assert/strict";
import test from "node:test";

import {
  GeminiRecoveryAdapter,
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

test("OpenAI Responses requests a streamable reasoning summary", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const adapter = new OpenAIResponsesRecoveryAdapter({
    apiKey: "test-key",
    fetch: async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return sse([
        {
          type: "response.created",
          sequence_number: 0,
          response: { id: "resp-summary", model: "gpt-5" },
        },
        {
          type: "response.completed",
          sequence_number: 1,
          response: {
            id: "resp-summary",
            model: "gpt-5",
            output: [{ type: "message", content: [{ type: "output_text", text: "Done" }] }],
          },
        },
      ]);
    },
  });
  const context: ProviderRecoveryContext = {
    runId: "run-summary",
    operationId: "model-summary",
    idempotencyKey: "model-request-summary",
    checkpoints: new InMemoryProviderCheckpointStore(),
  };

  for await (const _event of adapter.start({
    model: "gpt-5",
    messages: [{ role: "user", content: "hello" }],
    reasoningEffort: "high",
  }, context)) {
    // Consume the complete response.
  }

  assert.deepEqual(requestBody?.reasoning, {
    effort: "high",
    summary: "auto",
  });
});

test("Gemini durable requests preserve the selected thinking level", async () => {
  let requestBody: Record<string, any> | undefined;
  const adapter = new GeminiRecoveryAdapter({
    apiKey: "test-key",
    fetch: async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, any>;
      return sse([
        {
          responseId: "gemini-thinking",
          candidates: [{ content: { parts: [{ text: "Done" }] }, finishReason: "STOP" }],
        },
      ]);
    },
  });
  const context: ProviderRecoveryContext = {
    runId: "run-gemini-thinking",
    operationId: "model-gemini-thinking",
    idempotencyKey: "request-gemini-thinking",
    checkpoints: new InMemoryProviderCheckpointStore(),
  };

  for await (const _event of adapter.start({
    model: "gemini-3.7-flash",
    messages: [{ role: "user", content: "hello" }],
    reasoningEffort: "low",
  }, context)) {
    // Consume the complete response.
  }

  assert.deepEqual(requestBody?.generationConfig?.thinkingConfig, {
    thinkingLevel: "LOW",
  });
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

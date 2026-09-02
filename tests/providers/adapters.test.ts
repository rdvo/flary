import assert from "node:assert/strict";
import test from "node:test";

import {
  AnthropicMessagesAdapter,
  GeminiAdapter,
  ModelRequestSchema,
  OpenAICompatibleAdapter,
  ProviderAdapterRegistry,
  type ModelRequest,
} from "../../src/harness/providers/index.js";

const request: ModelRequest = {
  model: "gpt-5.6-sol",
  messages: [
    { role: "system", content: "You are concise." },
    { role: "user", content: "Say hello." },
  ],
  maxOutputTokens: 321,
  parameters: { max_tokens: 12, temperature: 0.2 },
};

test("normalized model requests validate once for every adapter", () => {
  const parsed = ModelRequestSchema.parse(request);
  assert.equal(parsed.model, "gpt-5.6-sol");
  assert.equal(parsed.maxOutputTokens, 321);
  assert.throws(() => ModelRequestSchema.parse({ model: "missing-messages" }));
});

test("OpenAI-compatible complete uses max_completion_tokens", async () => {
  let body: Record<string, unknown> | undefined;
  let headers: Headers | undefined;
  const adapter = new OpenAICompatibleAdapter({
    id: "gateway",
    baseUrl: "https://gateway.example/v1",
    apiKey: "test-key",
    fetch: async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      headers = new Headers(init?.headers);
      return jsonResponse({
        id: "chatcmpl_1",
        model: "gpt-5.6-sol",
        choices: [
          {
            message: { role: "assistant", content: "Hello." },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
      });
    },
  });

  const response = await adapter.complete(request);

  assert.equal(body?.max_completion_tokens, 321);
  assert.equal("max_tokens" in (body ?? {}), false);
  assert.equal(body?.stream, false);
  assert.equal(headers?.get("authorization"), "Bearer test-key");
  assert.equal(response.content, "Hello.");
  assert.equal(response.finishReason, "stop");
  assert.deepEqual(response.usage, {
    inputTokens: 4,
    outputTokens: 2,
    totalTokens: 6,
  });
});

test("OpenAI-compatible streaming returns normalized deltas and final response", async () => {
  const adapter = new OpenAICompatibleAdapter({
    id: "openai-stream",
    baseUrl: "https://gateway.example/v1",
    fetch: async () =>
      sseResponse([
        'data: {"id":"resp_1","model":"gpt-5.6-sol","choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
        'data: {"id":"resp_1","choices":[{"delta":{"content":"Hel"},"finish_reason":null}]}\n',
        '\ndata: {"id":"resp_1","choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}\n\n',
        "data: [DONE]\n\n",
      ]),
  });

  const events = await collect(adapter.stream(request));

  assert.deepEqual(
    events.map((event) => event.type),
    ["start", "text_delta", "text_delta", "finish"],
  );
  assert.equal(events[1]?.type === "text_delta" ? events[1].delta : "", "Hel");
  const finish = events.at(-1);
  assert.equal(finish?.type, "finish");
  if (finish?.type === "finish") {
    assert.equal(finish.response.content, "Hello");
    assert.equal(finish.response.finishReason, "stop");
  }
});

test("Anthropic Messages adapter maps system prompts and tool output", async () => {
  let body: Record<string, unknown> | undefined;
  let headers: Headers | undefined;
  const adapter = new AnthropicMessagesAdapter({
    id: "claude-main",
    baseUrl: "https://anthropic.example/v1",
    apiKey: "anthropic-key",
    fetch: async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      headers = new Headers(init?.headers);
      return jsonResponse({
        id: "msg_1",
        model: "claude-opus-5",
        content: [
          { type: "text", text: "Done." },
          { type: "tool_use", id: "call_1", name: "lookup", input: { q: "x" } },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 7, output_tokens: 5 },
      });
    },
  });

  const response = await adapter.complete({
    ...request,
    model: "claude-opus-5",
    messages: [
      { role: "system", content: "Follow the policy." },
      { role: "user", content: "Use the tool." },
    ],
  });

  assert.equal(body?.max_tokens, 321);
  assert.equal(body?.stream, false);
  assert.equal(body?.system, "Follow the policy.");
  assert.equal(headers?.get("x-api-key"), "anthropic-key");
  assert.equal(headers?.get("anthropic-version"), "2023-06-01");
  assert.equal(response.content, "Done.");
  assert.equal(response.toolCalls[0]?.name, "lookup");
  assert.equal(response.finishReason, "tool_call");
});

test("Anthropic Messages streaming normalizes message events", async () => {
  const adapter = new AnthropicMessagesAdapter({
    id: "claude-stream",
    baseUrl: "https://anthropic.example/v1",
    fetch: async () =>
      sseResponse([
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_2","model":"claude-opus-5","usage":{"input_tokens":3}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]),
  });

  const events = await collect(
    adapter.stream({
      ...request,
      model: "claude-opus-5",
    }),
  );

  assert.deepEqual(
    events.map((event) => event.type),
    ["start", "usage", "text_delta", "usage", "finish"],
  );
  const finish = events.at(-1);
  assert.equal(finish?.type, "finish");
  if (finish?.type === "finish") {
    assert.equal(finish.response.content, "Hi");
    assert.equal(finish.response.usage?.totalTokens, 5);
  }
});

test("Gemini streams provider deltas and sends the selected thinking level", async () => {
  let body: Record<string, any> | undefined;
  let requestedUrl = "";
  const adapter = new GeminiAdapter({
    apiKey: "gemini-key",
    fetch: async (input, init) => {
      requestedUrl = String(input);
      body = JSON.parse(String(init?.body)) as Record<string, any>;
      return sseResponse([
        'data: {"responseId":"gemini-1","candidates":[{"content":{"parts":[{"text":"Fast "}]}}]}\n\n',
        'data: {"responseId":"gemini-1","candidates":[{"content":{"parts":[{"text":"reply"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":2,"totalTokenCount":5}}\n\n',
      ]);
    },
  });

  const events = await collect(
    adapter.stream({
      ...request,
      model: "gemini-3.7-flash",
      reasoningEffort: "low",
    }),
  );

  assert.match(requestedUrl, /:streamGenerateContent\?alt=sse/);
  assert.deepEqual(body?.generationConfig?.thinkingConfig, { thinkingLevel: "LOW" });
  assert.deepEqual(
    events
      .filter((event) => event.type === "text_delta")
      .map((event) => (event.type === "text_delta" ? event.delta : "")),
    ["Fast ", "reply"],
  );
  const finish = events.at(-1);
  assert.equal(finish?.type, "finish");
  if (finish?.type === "finish") assert.equal(finish.response.content, "Fast reply");
});

test("registry resolves adapters by provider ID", () => {
  const adapter = new OpenAICompatibleAdapter({
    id: "gateway",
    baseUrl: "https://gateway.example/v1",
  });
  const registry = new ProviderAdapterRegistry({ adapters: [adapter] });

  assert.equal(registry.resolve({ provider: "gateway" }), adapter);
  assert.equal(registry.has("gateway"), true);
  assert.deepEqual(registry.list(), [adapter]);
  assert.throws(() => registry.resolve("missing"), /No provider adapter/);
});

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const event of events) values.push(event);
  return values;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sseResponse(chunks: readonly string[]): Response {
  const encoder = new TextEncoder();
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk === undefined) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunk));
    },
  });
  return new Response(body, {
    headers: { "content-type": "text/event-stream" },
  });
}

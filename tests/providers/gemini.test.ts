import assert from "node:assert/strict";
import test from "node:test";

import { GeminiAdapter } from "../../src/harness/providers/gemini.ts";

test("Gemini uses the key header and normalizes text and usage", async () => {
  let request: Request | undefined;
  const adapter = new GeminiAdapter({
    apiKey: "secret-google-key",
    fetch: async (input, init) => {
      request = new Request(input, init);
      return Response.json({
        responseId: "gemini-1",
        candidates: [{ finishReason: "STOP", content: { parts: [{ text: "Hello" }] } }],
        usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, totalTokenCount: 6 },
      });
    },
  });

  const result = await adapter.complete({
    model: "gemini-2.5-flash",
    messages: [
      { role: "system", content: "Be clear." },
      { role: "user", content: "Hello" },
    ],
  });

  assert.equal(request?.headers.get("x-goog-api-key"), "secret-google-key");
  assert.doesNotMatch(request?.url ?? "", /secret-google-key/);
  assert.equal(result.content, "Hello");
  assert.deepEqual(result.usage, { inputTokens: 4, outputTokens: 2, totalTokens: 6 });
});

test("Gemini maps function calls to the provider-neutral contract", async () => {
  const adapter = new GeminiAdapter({
    fetch: async () =>
      Response.json({
        candidates: [
          { content: { parts: [{ functionCall: { name: "search", args: { query: "Flary" } } }] } },
        ],
      }),
  });
  const result = await adapter.complete({
    model: "gemini-test",
    messages: [{ role: "user", content: "Search" }],
  });
  assert.equal(result.finishReason, "tool_call");
  assert.deepEqual(result.toolCalls[0]?.arguments, { query: "Flary" });
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  createModels,
  type AssistantMessage,
  type MutableModels,
} from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { stream as streamOpenAICodex } from "../../node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js";

const OPENAI_MODEL = process.env.FLARY_OPENAI_CACHE_TEST_MODEL;
const ANTHROPIC_MODEL = process.env.FLARY_ANTHROPIC_CACHE_TEST_MODEL;
const STABLE_PREFIX = Array.from(
  { length: 2_000 },
  (_, index) => `stable-cache-token-${index}`,
).join(" ");

test("OpenAI Codex omits prompt cache affinity when caching is disabled", async () => {
  const originalFetch = globalThis.fetch;
  let payload: Record<string, unknown> | undefined;
  globalThis.fetch = async () =>
    Response.json({ error: { message: "stop after payload capture" } }, {
      status: 400,
    });
  try {
    const model = openaiCodexProvider().getModels().find(
      (candidate) => candidate.id === "gpt-5.4-mini",
    );
    assert.ok(model);
    const stream = streamOpenAICodex(
      model,
      {
        systemPrompt: "Stable instructions",
        messages: [
          {
            role: "user",
            content: "Test cache policy.",
            timestamp: Date.now(),
          },
        ],
      },
      {
        apiKey: testCodexAccessToken(),
        sessionId: "stable-flary-affinity",
        cacheRetention: "none",
        transport: "sse",
        maxRetries: 0,
        onPayload(value) {
          payload = value as Record<string, unknown>;
        },
      },
    );
    for await (const _event of stream) {
      // The mocked HTTP failure ends the stream after payload capture.
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.ok(payload);
  assert.equal(payload.prompt_cache_key, undefined);
});

test(
  "OpenAI reports a native cache read after a runtime restart",
  { skip: !OPENAI_MODEL || !process.env.OPENAI_API_KEY },
  async () => {
    const sessionId = `flary-cache-test-openai-${crypto.randomUUID()}`;
    await complete(createOpenAIModels(), "openai", OPENAI_MODEL!, sessionId);
    const second = await complete(
      createOpenAIModels(),
      "openai",
      OPENAI_MODEL!,
      sessionId,
    );
    assert.ok(second.usage.cacheRead > 0);
  },
);

test(
  "Anthropic reports a native cache read after a runtime restart",
  { skip: !ANTHROPIC_MODEL || !process.env.ANTHROPIC_API_KEY },
  async () => {
    const sessionId = `flary-cache-test-anthropic-${crypto.randomUUID()}`;
    await complete(
      createAnthropicModels(),
      "anthropic",
      ANTHROPIC_MODEL!,
      sessionId,
    );
    const second = await complete(
      createAnthropicModels(),
      "anthropic",
      ANTHROPIC_MODEL!,
      sessionId,
    );
    assert.ok(second.usage.cacheRead > 0);
  },
);

function createOpenAIModels(): MutableModels {
  const models = createModelCollection();
  models.setProvider(openaiProvider());
  return models;
}

function createAnthropicModels(): MutableModels {
  const models = createModelCollection();
  models.setProvider(anthropicProvider());
  return models;
}

function createModelCollection(): MutableModels {
  return createModels({
    authContext: {
      async env(name) {
        return process.env[name];
      },
      async fileExists() {
        return false;
      },
    },
  });
}

async function complete(
  models: MutableModels,
  provider: string,
  modelId: string,
  sessionId: string,
): Promise<AssistantMessage> {
  const model = models.getModel(provider, modelId);
  assert.ok(model, `Model '${provider}/${modelId}' is not in Pi's pinned catalog`);
  return models.completeSimple(
    model,
    {
      systemPrompt: STABLE_PREFIX,
      messages: [
        {
          role: "user",
          content: "Return the single word ready.",
          timestamp: Date.now(),
        },
      ],
    },
    {
      sessionId,
      cacheRetention: "short",
      maxTokens: 16,
    },
  );
}

function testCodexAccessToken(): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return [
    encode({ alg: "none", typ: "JWT" }),
    encode({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "account-test",
      },
    }),
    "signature",
  ].join(".");
}

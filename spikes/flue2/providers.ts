import assert from "node:assert/strict";

import {
  hasProvider,
  resetModelsForTests,
  resolveModel,
  setProvider,
} from "@flue/runtime/internal";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { Provider } from "@earendil-works/pi-ai";

import {
  completeAnthropicManualOAuth,
  completeOpenAICodexManualOAuth,
  pollOpenAICodexDeviceAuthorization,
  startAnthropicManualOAuth,
  startOpenAICodexDeviceAuthorization,
  startOpenAICodexManualOAuth,
} from "@earendil-works/pi-ai/worker-oauth";

export {
  completeAnthropicManualOAuth,
  completeOpenAICodexManualOAuth,
  pollOpenAICodexDeviceAuthorization,
  startAnthropicManualOAuth,
  startOpenAICodexDeviceAuthorization,
  startOpenAICodexManualOAuth,
};

const ALIAS_PATTERN = /^flary-runtime-[a-z0-9][a-z0-9_-]{15,159}$/;

interface ProviderAliasInput {
  readonly provider: Provider;
  readonly providerAlias: string;
  readonly fetch?: typeof fetch;
}

interface ProviderAlias {
  readonly providerAlias: string;
  model(id: string): string;
}

function registerProviderAlias(input: ProviderAliasInput): ProviderAlias {
  if (!ALIAS_PATTERN.test(input.providerAlias)) {
    throw new Error("The runtime provider alias is invalid");
  }

  const source = input.provider;
  const models = source.getModels().map((model) => ({
    ...model,
    provider: input.providerAlias,
  }));
  const forceSse = source.id === "openai-codex" && input.fetch !== undefined;
  const streamOptions = <T extends object>(options: T | undefined): T => ({
    ...(options ?? ({} as T)),
    ...(input.fetch ? { fetch: input.fetch } : {}),
    ...(forceSse ? { transport: "sse" } : {}),
  });

  const wrapped: Provider = {
    ...source,
    id: input.providerAlias,
    name: input.providerAlias,
    getModels: () => models,
    stream(model, context, options) {
      return source.stream({ ...model, provider: source.id }, context, streamOptions(options));
    },
    streamSimple(model, context, options) {
      return source.streamSimple(
        { ...model, provider: source.id },
        context,
        streamOptions(options),
      );
    },
  };

  setProvider(wrapped);
  return {
    providerAlias: input.providerAlias,
    model: (id) => `${input.providerAlias}/${id}`,
  };
}

resetModelsForTests();

const planned = [
  ["anthropic", "claude-sonnet-fixture"],
  ["openai-codex", "gpt-codex-fixture"],
  ["openai", "gpt-fixture"],
  ["google", "gemini-fixture"],
] as const;

const aliases = planned.map(([provider, modelId]) => {
  const source = fauxProvider({
    provider,
    models: [{ id: modelId, name: modelId }],
  }).provider;
  const alias = `flary-runtime-${provider}-fixture-0001`;
  const registered = registerProviderAlias({
    provider: source,
    providerAlias: alias,
    fetch: provider === "openai-codex" ? fetch : undefined,
  });
  const resolved = resolveModel(registered.model(modelId));
  assert.equal(resolved.provider, alias);
  assert.equal(hasProvider(alias), true);
  return { provider, alias, model: resolved.id };
});

const replacement = fauxProvider({
  provider: "google",
  models: [{ id: "replacement-fixture", name: "replacement-fixture" }],
}).provider;
registerProviderAlias({
  provider: replacement,
  providerAlias: aliases[3]!.alias,
});
assert.equal(resolveModel(`${aliases[3]!.alias}/replacement-fixture`).id, "replacement-fixture");

const codexOptions = {
  fetch,
  transport: "websocket" as const,
};
const codexForwarded = {
  ...codexOptions,
  ...(codexOptions.fetch ? { fetch: codexOptions.fetch } : {}),
  transport: "sse" as const,
};
assert.equal(codexForwarded.transport, "sse");
assert.equal(
  [
    startAnthropicManualOAuth,
    completeAnthropicManualOAuth,
    startOpenAICodexDeviceAuthorization,
    pollOpenAICodexDeviceAuthorization,
    startOpenAICodexManualOAuth,
    completeOpenAICodexManualOAuth,
  ].every((helper) => typeof helper === "function"),
  true,
);

console.log(JSON.stringify({ aliases, oauthHelpers: 6, codexTransport: codexForwarded.transport }));

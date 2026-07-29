import {
  PromptCacheRetentionSchema,
  ProviderKindSchema,
  type PromptCacheRetention,
  type ProviderKind,
} from "../contracts/provider.js";
import {
  EffectiveCacheRetentionSchema,
  type EffectiveCacheRetention,
} from "../contracts/telemetry.js";

export interface NativeCachePolicy {
  readonly requested: PromptCacheRetention;
  readonly effective: EffectiveCacheRetention;
}

/**
 * Report the provider policy that Flary requested and the policy the adapter
 * can apply. A provider can still shorten subscription retention.
 */
export function resolveNativeCachePolicy(input: {
  provider: ProviderKind;
  requested: PromptCacheRetention;
  supportsLongOpenAICache?: boolean;
}): NativeCachePolicy {
  const provider = ProviderKindSchema.parse(input.provider);
  const requested = PromptCacheRetentionSchema.parse(input.requested);
  if (requested === "none") {
    return { requested, effective: "none" };
  }
  let effective: EffectiveCacheRetention;
  if (provider === "anthropic") {
    effective = requested === "long" ? "1h" : "5m";
  } else if (provider === "openai-codex") {
    effective = "provider-controlled";
  } else if (provider === "openai" && requested === "long") {
    effective = input.supportsLongOpenAICache ? "24h" : "provider-default";
  } else {
    effective = "provider-default";
  }
  return {
    requested,
    effective: EffectiveCacheRetentionSchema.parse(effective),
  };
}

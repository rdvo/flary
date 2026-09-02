import type { OAuthCredentials } from "@earendil-works/pi-ai/oauth";
import {
  completeAnthropicManualOAuth,
  completeOpenAICodexManualOAuth,
  pollOpenAICodexDeviceAuthorization,
  startAnthropicManualOAuth,
  startOpenAICodexDeviceAuthorization,
  startOpenAICodexManualOAuth,
} from "@earendil-works/pi-ai/worker-oauth";

import {
  ProviderOAuthLoginMethodSchema,
  SubscriptionProviderSchema,
  type ProviderOAuthLoginMethod,
  type SubscriptionProvider,
} from "../contracts/connections.js";

export interface ProviderOAuthPrivateState {
  readonly provider: SubscriptionProvider;
  readonly method: ProviderOAuthLoginMethod;
  readonly state?: string;
  readonly verifier?: string;
  readonly redirectUri?: string;
  readonly deviceAuthId?: string;
  readonly userCode?: string;
  readonly intervalSeconds?: number;
}

export interface ProviderOAuthStartResult {
  readonly provider: SubscriptionProvider;
  readonly method: ProviderOAuthLoginMethod;
  readonly authorizationUrl?: string;
  readonly verificationUri?: string;
  readonly userCode?: string;
  readonly intervalSeconds?: number;
  readonly expiresInSeconds: number;
  readonly privateState: ProviderOAuthPrivateState;
}

export type ProviderOAuthPollResult =
  | {
      readonly status: "pending";
      readonly intervalSeconds: number;
      readonly privateState: ProviderOAuthPrivateState;
    }
  | {
      readonly status: "ready";
      readonly credential: OAuthCredentials;
    };

export class ProviderOAuthError extends Error {
  constructor(
    readonly code:
      | "oauth_provider_unsupported"
      | "oauth_method_unsupported"
      | "oauth_state_invalid"
      | "oauth_provider_failed",
    message: string,
  ) {
    super(message);
    this.name = "ProviderOAuthError";
  }
}

/**
 * Start a provider login without a local server.
 *
 * OpenAI uses device authorization. Anthropic returns an authorization URL
 * whose final redirect or code is submitted through `completeProviderOAuth`.
 */
export async function startProviderOAuth(input: {
  provider: SubscriptionProvider;
  method?: ProviderOAuthLoginMethod;
  signal?: AbortSignal;
}): Promise<ProviderOAuthStartResult> {
  const provider = SubscriptionProviderSchema.parse(input.provider);
  const method = ProviderOAuthLoginMethodSchema.parse(
    input.method ?? (provider === "openai-codex" ? "device_code" : "authorization_code"),
  );

  if (provider === "openai-codex") {
    if (method === "browser_callback") {
      const flow = await startOpenAICodexManualOAuth();
      return {
        provider,
        method,
        authorizationUrl: flow.authorizationUrl,
        expiresInSeconds: flow.expiresInSeconds,
        privateState: {
          provider,
          method,
          state: flow.state,
          verifier: flow.verifier,
          redirectUri: flow.redirectUri,
        },
      };
    }
    if (method !== "device_code") {
      throw new ProviderOAuthError(
        "oauth_method_unsupported",
        "OpenAI Codex supports device authorization or a browser callback",
      );
    }
    const device = await startOpenAICodexDeviceAuthorization(input.signal);
    return {
      provider,
      method,
      verificationUri: device.verificationUri,
      userCode: device.userCode,
      intervalSeconds: device.intervalSeconds,
      expiresInSeconds: device.expiresInSeconds,
      privateState: {
        provider,
        method,
        deviceAuthId: device.deviceAuthId,
        userCode: device.userCode,
        intervalSeconds: device.intervalSeconds,
        redirectUri: device.redirectUri,
      },
    };
  }

  if (method !== "authorization_code" && method !== "browser_callback") {
    throw new ProviderOAuthError(
      "oauth_method_unsupported",
      "Hosted Anthropic login uses authorization-code completion",
    );
  }
  const flow = await startAnthropicManualOAuth();
  return {
    provider,
    method,
    authorizationUrl: flow.authorizationUrl,
    expiresInSeconds: flow.expiresInSeconds,
    privateState: {
      provider,
      method,
      state: flow.state,
      verifier: flow.verifier,
      redirectUri: flow.redirectUri,
    },
  };
}

/** Poll one OpenAI device flow once. The host controls durable scheduling. */
export async function pollProviderOAuth(input: {
  privateState: ProviderOAuthPrivateState;
  signal?: AbortSignal;
}): Promise<ProviderOAuthPollResult> {
  const state = input.privateState;
  if (
    state.provider !== "openai-codex" ||
    state.method !== "device_code" ||
    !state.deviceAuthId ||
    !state.userCode ||
    !state.intervalSeconds
  ) {
    throw new ProviderOAuthError("oauth_state_invalid", "The provider login cannot be polled");
  }
  const result = await pollOpenAICodexDeviceAuthorization(
    {
      deviceAuthId: state.deviceAuthId,
      userCode: state.userCode,
      intervalSeconds: state.intervalSeconds,
      verificationUri: "https://auth.openai.com/codex/device",
      redirectUri: state.redirectUri ?? "https://auth.openai.com/deviceauth/callback",
      expiresInSeconds: 15 * 60,
    },
    input.signal,
  );
  if (result.status === "complete") {
    return { status: "ready", credential: result.credential };
  }
  const intervalSeconds = result.intervalSeconds;
  return {
    status: "pending",
    intervalSeconds,
    privateState: { ...state, intervalSeconds },
  };
}

/** Complete one Anthropic authorization-code flow. */
export async function completeProviderOAuth(input: {
  privateState: ProviderOAuthPrivateState;
  authorizationResult: string;
}): Promise<OAuthCredentials> {
  const state = input.privateState;
  if (!state.state || !state.verifier) {
    throw new ProviderOAuthError(
      "oauth_state_invalid",
      "The provider login cannot accept an authorization code",
    );
  }
  if (
    state.provider === "anthropic" &&
    (state.method === "authorization_code" || state.method === "browser_callback")
  ) {
    return completeAnthropicManualOAuth(
      input.authorizationResult,
      state.state,
      state.verifier,
      state.redirectUri,
    );
  }
  if (state.provider === "openai-codex" && state.method === "browser_callback") {
    return completeOpenAICodexManualOAuth(
      input.authorizationResult,
      state.state,
      state.verifier,
      state.redirectUri,
    );
  }
  throw new ProviderOAuthError(
    "oauth_state_invalid",
    "The provider login cannot accept an authorization code",
  );
}

export function providerOAuthSubject(credential: OAuthCredentials): string | undefined {
  const accountId = credential.accountId;
  return typeof accountId === "string" && accountId.length > 0 ? accountId : undefined;
}

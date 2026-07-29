import type { JsonObject } from "../contracts/common.js";
import { OpenAICompatibleAdapter } from "./openai-compatible.js";

const CLOUDFLARE_ACCOUNT_ID_PATTERN = /^[a-f0-9]{32}$/i;

export interface CloudflareAIGatewayAdapterOptions {
  /** A stable ID used when the adapter reports provider responses. */
  readonly id?: string;
  /** The Cloudflare account that owns the AI Gateway. */
  readonly accountId: string;
  /** The AI Gateway ID in that account. */
  readonly gatewayId: string;
  /** A Cloudflare OAuth access token or API token. */
  readonly apiToken: string;
  /** Optional request metadata sent to AI Gateway. */
  readonly metadata?: JsonObject;
  /** Override the account REST base URL for tests or a proxy. */
  readonly baseUrl?: string;
  /** Override the OpenAI-compatible endpoint path. */
  readonly path?: string;
  /** Override fetch for tests or a custom runtime. */
  readonly fetch?: typeof fetch;
}

/**
 * An OpenAI-compatible provider for an authenticated Cloudflare AI Gateway.
 *
 * The token stays in the runtime that creates this adapter. Do not construct
 * this adapter in browser code with a user credential.
 */
export class CloudflareAIGatewayAdapter extends OpenAICompatibleAdapter {
  constructor(options: CloudflareAIGatewayAdapterOptions) {
    if (!CLOUDFLARE_ACCOUNT_ID_PATTERN.test(options.accountId)) {
      throw new Error("Cloudflare accountId must be a 32-character hex ID");
    }
    if (!options.gatewayId.trim()) {
      throw new Error("Cloudflare gatewayId is required");
    }
    if (!options.apiToken.trim()) {
      throw new Error("Cloudflare apiToken is required");
    }

    const headers: Record<string, string> = {
      "cf-aig-gateway-id": options.gatewayId,
    };
    if (options.metadata) {
      headers["cf-aig-metadata"] = JSON.stringify(options.metadata);
    }

    super({
      id: options.id ?? "cloudflare-ai-gateway",
      provider: "cloudflare",
      baseUrl:
        options.baseUrl ??
        `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(options.accountId)}/ai/v1`,
      apiKey: options.apiToken,
      path: options.path,
      headers,
      fetch: options.fetch,
    });
  }
}


import { JsonObjectSchema, type JsonObject } from "../contracts/common.js";
import { OpenAICompatibleAdapter } from "./openai-compatible.js";
import {
  ModelRequestSchema,
  ModelResponseSchema,
  ProviderStreamEventSchema,
  type ModelRequest,
  type ModelResponse,
  type ModelStreamEvent,
  type ProviderMessage,
  type ProviderToolCall,
} from "./contracts.js";
import type { ModelAdapter, ProviderRequestOptions } from "./types.js";

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

export interface WorkersAIBinding {
  run(
    model: string,
    input: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<unknown>;
}

/** Use a Cloudflare Workers AI binding without putting a provider key in Flary. */
export class CloudflareWorkersAIAdapter implements ModelAdapter {
  readonly id = "cloudflare";
  readonly provider = "cloudflare" as const;
  readonly supportsStreaming = false;

  constructor(private readonly binding: WorkersAIBinding) {}

  async complete(
    input: ModelRequest,
    options: ProviderRequestOptions = {},
  ): Promise<ModelResponse> {
    const request = ModelRequestSchema.parse(input);
    const responseId = `cf_${crypto.randomUUID()}`;
    const result = await this.binding.run(
      request.model,
      {
        messages: request.messages.map(toWorkersAIMessage),
        ...(request.maxOutputTokens ? { max_tokens: request.maxOutputTokens } : {}),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.tools
          ? {
              tools: request.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema,
              })),
            }
          : {}),
      },
      { signal: options.signal },
    );
    const root = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
    const content =
      typeof root.response === "string"
        ? root.response
        : typeof root.result === "string"
          ? root.result
          : typeof result === "string"
            ? result
            : "";
    const usage =
      root.usage && typeof root.usage === "object"
        ? (root.usage as Record<string, unknown>)
        : undefined;
    const toolCalls = readWorkersAIToolCalls(root.tool_calls, responseId);
    return ModelResponseSchema.parse({
      id: typeof root.id === "string" ? root.id : responseId,
      model: request.model,
      content,
      toolCalls,
      finishReason: toolCalls.length > 0 ? "tool_call" : "stop",
      provider: "cloudflare",
      ...(usage
        ? {
            usage: {
              inputTokens: numeric(usage.prompt_tokens ?? usage.input_tokens),
              outputTokens: numeric(usage.completion_tokens ?? usage.output_tokens),
              totalTokens: numeric(usage.total_tokens),
            },
          }
        : {}),
    });
  }

  async *stream(
    input: ModelRequest,
    options: ProviderRequestOptions = {},
  ): AsyncIterable<ModelStreamEvent> {
    const response = await this.complete(input, options);
    yield ProviderStreamEventSchema.parse({
      type: "start",
      responseId: response.id,
      model: response.model,
    });
    if (response.content)
      yield ProviderStreamEventSchema.parse({
        type: "text_delta",
        responseId: response.id,
        delta: response.content,
      });
    if (response.usage)
      yield ProviderStreamEventSchema.parse({
        type: "usage",
        responseId: response.id,
        usage: response.usage,
      });
    yield ProviderStreamEventSchema.parse({ type: "finish", responseId: response.id, response });
  }
}

function toWorkersAIMessage(message: ProviderMessage): Record<string, unknown> {
  const content =
    typeof message.content === "string"
      ? message.content
      : message.content
          .map((part) => (part.type === "text" ? part.text : `[image: ${part.url}]`))
          .join("\n");
  return {
    role: message.role,
    content,
    ...(message.name ? { name: message.name } : {}),
    ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
    ...(message.toolCalls
      ? {
          tool_calls: message.toolCalls.map((call) => ({
            id: call.id,
            type: "function",
            function: {
              name: call.name,
              arguments: call.rawArguments ?? JSON.stringify(call.arguments),
            },
          })),
        }
      : {}),
  };
}

function readWorkersAIToolCalls(value: unknown, responseId: string): ProviderToolCall[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate, index) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      return [];
    }
    const record = candidate as Record<string, unknown>;
    const fn =
      record.function && typeof record.function === "object" && !Array.isArray(record.function)
        ? (record.function as Record<string, unknown>)
        : record;
    const name = typeof fn.name === "string" ? fn.name : undefined;
    if (!name) return [];
    const raw = fn.arguments;
    let args: JsonObject = {};
    let rawArguments: string | undefined;
    if (typeof raw === "string") {
      rawArguments = raw;
      try {
        const parsed = JSON.parse(raw) as unknown;
        const parsedArguments = JsonObjectSchema.safeParse(parsed);
        if (parsedArguments.success) args = parsedArguments.data;
      } catch {
        args = {};
      }
    } else if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const parsedArguments = JsonObjectSchema.safeParse(raw);
      if (parsedArguments.success) args = parsedArguments.data;
      rawArguments = JSON.stringify(raw);
    }
    return [
      {
        id: typeof record.id === "string" ? record.id : `${responseId}_tool_${index}`,
        name,
        arguments: args,
        ...(rawArguments ? { rawArguments } : {}),
      },
    ];
  });
}

function numeric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

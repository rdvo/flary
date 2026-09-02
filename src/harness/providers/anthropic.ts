import {
  ModelRequestSchema,
  ModelResponseSchema,
  ProviderStreamEventSchema,
  type ModelRequest,
  type ModelResponse,
  type ModelStreamEvent,
  type ProviderMessage,
  type ProviderToolCall,
  type ProviderError,
  type ProviderUsage,
} from "./contracts.js";
import type { ModelAdapter, ProviderRequestOptions } from "./types.js";
import {
  asNonNegativeInteger,
  asRecord,
  asString,
  contentToText,
  createProviderError,
  joinUrl,
  parseJsonObject,
  parseServerSentEvents,
  providerErrorFromResponse,
  randomId,
  requestSignal,
} from "./utils.js";
import { JsonObjectSchema } from "../contracts/common.js";

export interface AnthropicMessagesAdapterOptions {
  readonly id?: string;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly version?: string;
  readonly beta?: readonly string[];
  readonly headers?: HeadersInit;
  readonly defaultMaxOutputTokens?: number;
  readonly fetch?: typeof fetch;
}

export class AnthropicMessagesAdapter implements ModelAdapter {
  readonly id: string;
  readonly provider = "anthropic" as const;
  readonly supportsStreaming = true;

  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly version: string;
  private readonly beta?: readonly string[];
  private readonly headers?: HeadersInit;
  private readonly defaultMaxOutputTokens: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AnthropicMessagesAdapterOptions = {}) {
    this.id = options.id ?? "anthropic-messages";
    this.baseUrl = options.baseUrl ?? "https://api.anthropic.com/v1";
    this.apiKey = options.apiKey;
    this.version = options.version ?? "2023-06-01";
    this.beta = options.beta;
    this.headers = options.headers;
    this.defaultMaxOutputTokens = options.defaultMaxOutputTokens ?? 4096;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async complete(
    input: ModelRequest,
    options: ProviderRequestOptions = {},
  ): Promise<ModelResponse> {
    const request = ModelRequestSchema.parse(input);
    const signalState = requestSignal(options);
    try {
      const fetchResponse = await this.fetchImpl(joinUrl(this.baseUrl, "/messages"), {
        method: "POST",
        headers: this.headersFor(options.headers, "application/json"),
        body: JSON.stringify(this.toRequestBody(request, false)),
        signal: signalState.signal,
      });
      if (!fetchResponse.ok) {
        throw await providerErrorFromResponse(this.id, fetchResponse);
      }
      return this.fromResponse((await fetchResponse.json()) as unknown, request.model);
    } catch (error) {
      throw this.normalizeError(error);
    } finally {
      signalState.cleanup();
    }
  }

  async *stream(
    input: ModelRequest,
    options: ProviderRequestOptions = {},
  ): AsyncGenerator<ModelStreamEvent> {
    const request = ModelRequestSchema.parse(input);
    const signalState = requestSignal(options);
    let responseId: string | undefined;
    let model = request.model;
    let content = "";
    let reasoning = "";
    let finishReason: ModelResponse["finishReason"] = "unknown";
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
    let started = false;

    try {
      const fetchResponse = await this.fetchImpl(joinUrl(this.baseUrl, "/messages"), {
        method: "POST",
        headers: this.headersFor(options.headers, "text/event-stream"),
        body: JSON.stringify(this.toRequestBody(request, true)),
        signal: signalState.signal,
      });
      if (!fetchResponse.ok) {
        throw await providerErrorFromResponse(this.id, fetchResponse);
      }
      if (!fetchResponse.body) {
        throw createProviderError(this.id, {
          code: "missing_stream_body",
          message: "The provider returned no streaming body.",
        });
      }

      for await (const event of parseServerSentEvents(fetchResponse.body)) {
        if (!event.data) continue;
        let payload: unknown;
        try {
          payload = JSON.parse(event.data) as unknown;
        } catch {
          throw createProviderError(this.id, {
            code: "invalid_stream_event",
            message: "The provider returned invalid JSON in its stream.",
          });
        }
        const root = asRecord(payload);
        if (event.event === "error" || asRecord(root.error).message) {
          throw createProviderError(this.id, root.error ?? root);
        }

        const message = asRecord(root.message);
        responseId = asString(message.id ?? root.id, responseId ?? randomId("response"));
        model = asString(message.model ?? root.model, model);
        if (!started) {
          started = true;
          yield ProviderStreamEventSchema.parse({
            type: "start",
            responseId,
            model,
          });
        }

        if (event.event === "message_start") {
          const usage = this.fromUsage(message.usage);
          inputTokens = usage?.inputTokens;
          if (usage) {
            yield ProviderStreamEventSchema.parse({
              type: "usage",
              responseId,
              usage,
            });
          }
        }

        if (event.event === "content_block_start") {
          const block = asRecord(root.content_block);
          if (asString(block.type) === "tool_use") {
            const index = Number.isInteger(root.index) ? Number(root.index) : toolCalls.size;
            toolCalls.set(index, {
              id: asString(block.id, `tool_${index}`),
              name: asString(block.name, "unknown"),
              arguments: "",
            });
            yield ProviderStreamEventSchema.parse({
              type: "tool_call_delta",
              responseId,
              index,
              toolCallId: toolCalls.get(index)?.id,
              name: toolCalls.get(index)?.name,
            });
          }
        }

        if (event.event === "content_block_delta") {
          const index = Number.isInteger(root.index) ? Number(root.index) : 0;
          const delta = asRecord(root.delta);
          const deltaType = asString(delta.type);
          if (deltaType === "text_delta") {
            const text = asString(delta.text);
            content += text;
            if (text) {
              yield ProviderStreamEventSchema.parse({
                type: "text_delta",
                responseId,
                delta: text,
              });
            }
          }
          if (deltaType === "thinking_delta" || deltaType === "signature_delta") {
            const text = asString(delta.thinking ?? delta.signature);
            reasoning += text;
            if (text) {
              yield ProviderStreamEventSchema.parse({
                type: "reasoning_delta",
                responseId,
                delta: text,
              });
            }
          }
          if (deltaType === "input_json_delta") {
            const argumentsDelta = asString(delta.partial_json);
            const current = toolCalls.get(index) ?? {
              id: `tool_${index}`,
              name: "unknown",
              arguments: "",
            };
            current.arguments += argumentsDelta;
            toolCalls.set(index, current);
            yield ProviderStreamEventSchema.parse({
              type: "tool_call_delta",
              responseId,
              index,
              toolCallId: current.id,
              name: current.name !== "unknown" ? current.name : undefined,
              argumentsDelta: argumentsDelta || undefined,
            });
          }
        }

        if (event.event === "message_delta") {
          const usage = this.fromUsage(root.usage);
          outputTokens = usage?.outputTokens ?? outputTokens;
          if (usage) {
            const mergedUsage: ProviderUsage = {
              inputTokens,
              outputTokens,
              totalTokens:
                inputTokens !== undefined && outputTokens !== undefined
                  ? inputTokens + outputTokens
                  : usage.totalTokens,
            };
            yield ProviderStreamEventSchema.parse({
              type: "usage",
              responseId,
              usage: mergedUsage,
            });
          }
          const delta = asRecord(root.delta);
          finishReason = mapFinishReason(asString(delta.stop_reason));
        }
      }

      responseId ??= randomId("response");
      if (!started) {
        started = true;
        yield ProviderStreamEventSchema.parse({
          type: "start",
          responseId,
          model,
        });
      }
      const usage =
        inputTokens !== undefined || outputTokens !== undefined
          ? {
              inputTokens,
              outputTokens,
              totalTokens:
                inputTokens !== undefined && outputTokens !== undefined
                  ? inputTokens + outputTokens
                  : undefined,
            }
          : undefined;
      const completedResponse = ModelResponseSchema.parse({
        id: responseId,
        model,
        content,
        reasoning: reasoning || undefined,
        toolCalls: [...toolCalls.entries()]
          .sort(([left], [right]) => left - right)
          .map(([, call]) => parseToolCall(call.id, call.name, call.arguments)),
        finishReason,
        usage,
        provider: this.id,
      });
      yield ProviderStreamEventSchema.parse({
        type: "finish",
        responseId,
        response: completedResponse,
      });
    } catch (error) {
      const normalized = this.normalizeError(error);
      const providerError =
        normalized instanceof Error && normalized.name === "ProviderAdapterError"
          ? (normalized as typeof normalized & { error: ProviderError }).error
          : createProviderError(this.id, {
              code: "provider_request_failed",
              message: normalized instanceof Error ? normalized.message : String(normalized),
            }).error;
      yield ProviderStreamEventSchema.parse({
        type: "error",
        responseId,
        error: providerError,
      });
    } finally {
      signalState.cleanup();
    }
  }

  private headersFor(extra: HeadersInit | undefined, accept: string): Headers {
    const headers = new Headers(this.headers);
    headers.set("content-type", "application/json");
    headers.set("accept", accept);
    headers.set("anthropic-version", this.version);
    if (this.apiKey) headers.set("x-api-key", this.apiKey);
    if (this.beta?.length) headers.set("anthropic-beta", this.beta.join(","));
    new Headers(extra).forEach((value, key) => headers.set(key, value));
    return headers;
  }

  private toRequestBody(request: ModelRequest, stream: boolean): Record<string, unknown> {
    const parameters = { ...request.parameters };
    delete parameters.max_tokens;
    delete parameters.stream;
    const system = request.messages
      .filter((message) => message.role === "system" || message.role === "developer")
      .map((message) => contentToText(message.content))
      .filter(Boolean)
      .join("\n\n");
    const body: Record<string, unknown> = {
      ...parameters,
      model: request.model,
      messages: request.messages
        .filter((message) => message.role !== "system" && message.role !== "developer")
        .map(toAnthropicMessage),
      max_tokens: request.maxOutputTokens ?? this.defaultMaxOutputTokens,
      stream,
    };
    if (system) body.system = system;
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.topP !== undefined) body.top_p = request.topP;
    if (request.stop !== undefined) {
      body.stop_sequences = Array.isArray(request.stop) ? request.stop : [request.stop];
    }
    if (request.tools) {
      body.tools = request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      }));
    }
    if (request.toolChoice) body.tool_choice = toAnthropicToolChoice(request.toolChoice);
    return body;
  }

  private fromResponse(payload: unknown, requestedModel: string): ModelResponse {
    const root = asRecord(payload);
    const blocks = Array.isArray(root.content) ? root.content : [];
    const text = blocks
      .map((block) => {
        const record = asRecord(block);
        return asString(record.type) === "text" ? asString(record.text) : "";
      })
      .join("");
    const reasoning = blocks
      .map((block) => {
        const record = asRecord(block);
        return asString(record.type) === "thinking" ? asString(record.thinking) : "";
      })
      .join("");
    const toolCalls = blocks
      .map((block, index) => {
        const record = asRecord(block);
        if (asString(record.type) !== "tool_use") return undefined;
        return parseToolCall(
          asString(record.id, `tool_${index}`),
          asString(record.name, "unknown"),
          JSON.stringify(asRecord(record.input)),
        );
      })
      .filter((call): call is ProviderToolCall => call !== undefined);
    return ModelResponseSchema.parse({
      id: asString(root.id, randomId("response")),
      model: asString(root.model, requestedModel),
      content: text,
      reasoning: reasoning || undefined,
      toolCalls,
      finishReason: mapFinishReason(asString(root.stop_reason)),
      usage: this.fromUsage(root.usage),
      provider: this.id,
    });
  }

  private fromUsage(value: unknown): ProviderUsage | undefined {
    const usage = asRecord(value);
    const inputTokens = asNonNegativeInteger(usage.input_tokens);
    const outputTokens = asNonNegativeInteger(usage.output_tokens);
    if (inputTokens === undefined && outputTokens === undefined) return undefined;
    return {
      inputTokens,
      outputTokens,
      totalTokens:
        inputTokens !== undefined && outputTokens !== undefined
          ? inputTokens + outputTokens
          : undefined,
    };
  }

  private normalizeError(error: unknown): unknown {
    if (error instanceof Error && error.name === "ProviderAdapterError") return error;
    if (error instanceof TypeError) {
      return createProviderError(this.id, {
        code: "network_error",
        message: error.message,
      });
    }
    return error;
  }
}

export { AnthropicMessagesAdapter as AnthropicMessagesProviderAdapter };

function toAnthropicMessage(message: ProviderMessage): Record<string, unknown> {
  if (message.role === "tool") {
    return {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: message.toolCallId ?? "tool",
          content: contentToText(message.content),
        },
      ],
    };
  }

  const blocks: Record<string, unknown>[] = [];
  if (typeof message.content === "string") {
    blocks.push({ type: "text", text: message.content });
  } else {
    for (const part of message.content) {
      if (part.type === "text") blocks.push({ type: "text", text: part.text });
      if (part.type === "image") {
        blocks.push({ type: "text", text: `[image: ${part.url}]` });
      }
    }
  }
  for (const call of message.toolCalls ?? []) {
    blocks.push({
      type: "tool_use",
      id: call.id,
      name: call.name,
      input: call.arguments,
    });
  }
  return {
    role: message.role === "assistant" ? "assistant" : "user",
    content: blocks.length === 1 && blocks[0]?.type === "text" ? blocks[0].text : blocks,
  };
}

function toAnthropicToolChoice(choice: NonNullable<ModelRequest["toolChoice"]>): unknown {
  if (choice === "auto") return { type: "auto" };
  if (choice === "required") return { type: "any" };
  if (choice === "none") return undefined;
  return { type: "tool", name: choice.name };
}

function parseToolCall(id: string, name: string, rawArguments: string): ProviderToolCall {
  const argumentsValue = JsonObjectSchema.safeParse(parseJsonObject(rawArguments));
  return {
    id,
    name,
    arguments: argumentsValue.success ? argumentsValue.data : {},
    rawArguments: rawArguments || undefined,
  };
}

function mapFinishReason(value: string): ModelResponse["finishReason"] {
  if (value === "end_turn" || value === "stop_sequence" || value === "stop") return "stop";
  if (value === "max_tokens" || value === "length") return "length";
  if (value === "tool_use" || value === "tool_calls") return "tool_call";
  if (value === "error") return "error";
  return "unknown";
}

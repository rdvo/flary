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
import type { ProviderKind } from "../contracts/provider.js";
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

export interface OpenAICompatibleAdapterOptions {
  readonly id?: string;
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly provider?: ProviderKind;
  readonly path?: string;
  readonly headers?: HeadersInit;
  readonly fetch?: typeof fetch;
}

export class OpenAICompatibleAdapter implements ModelAdapter {
  readonly id: string;
  readonly provider: ProviderKind;
  readonly supportsStreaming = true;

  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly path: string;
  private readonly headers?: HeadersInit;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAICompatibleAdapterOptions) {
    this.id = options.id ?? "openai-compatible";
    this.provider = options.provider ?? "openai";
    this.baseUrl = options.baseUrl;
    this.apiKey = options.apiKey;
    this.path = options.path ?? "/chat/completions";
    this.headers = options.headers;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async complete(
    input: ModelRequest,
    options: ProviderRequestOptions = {}
  ): Promise<ModelResponse> {
    const request = ModelRequestSchema.parse(input);
    const signalState = requestSignal(options);
    try {
      const fetchResponse = await this.fetchImpl(
        joinUrl(this.baseUrl, this.path),
        {
          method: "POST",
          headers: this.headersFor(options.headers, "application/json"),
          body: JSON.stringify(this.toRequestBody(request, false)),
          signal: signalState.signal,
        }
      );
      if (!fetchResponse.ok) {
        throw await providerErrorFromResponse(this.id, fetchResponse);
      }
      return this.fromResponse(
        (await fetchResponse.json()) as unknown,
        request.model
      );
    } catch (error) {
      throw this.normalizeError(error);
    } finally {
      signalState.cleanup();
    }
  }

  async *stream(
    input: ModelRequest,
    options: ProviderRequestOptions = {}
  ): AsyncGenerator<ModelStreamEvent> {
    const request = ModelRequestSchema.parse(input);
    const signalState = requestSignal(options);
    let responseId: string | undefined;
    let model = request.model;
    let content = "";
    let reasoning = "";
    let finishReason: ModelResponse["finishReason"] = "unknown";
    let usage: ProviderUsage | undefined;
    const toolCalls = new Map<
      number,
      { id: string; name: string; arguments: string }
    >();
    let sequenceStarted = false;

    try {
      const fetchResponse = await this.fetchImpl(
        joinUrl(this.baseUrl, this.path),
        {
          method: "POST",
          headers: this.headersFor(options.headers, "text/event-stream"),
          body: JSON.stringify(this.toRequestBody(request, true)),
          signal: signalState.signal,
        }
      );
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
        if (!event.data || event.data === "[DONE]") continue;
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
        if (asRecord(root.error).message) {
          throw createProviderError(this.id, root.error);
        }

        responseId = asString(root.id, responseId ?? randomId("response"));
        model = asString(root.model, model);
        if (!sequenceStarted) {
          sequenceStarted = true;
          yield ProviderStreamEventSchema.parse({
            type: "start",
            responseId,
            model,
          });
        }

        const choices = Array.isArray(root.choices) ? root.choices : [];
        const choice = asRecord(choices[0]);
        const delta = asRecord(choice.delta);
        const textDelta = asString(delta.content);
        if (textDelta) {
          content += textDelta;
          yield ProviderStreamEventSchema.parse({
            type: "text_delta",
            responseId,
            delta: textDelta,
          });
        }

        const reasoningDelta = asString(
          delta.reasoning_content ?? delta.reasoning
        );
        if (reasoningDelta) {
          reasoning += reasoningDelta;
          yield ProviderStreamEventSchema.parse({
            type: "reasoning_delta",
            responseId,
            delta: reasoningDelta,
          });
        }

        const toolDeltas = Array.isArray(delta.tool_calls)
          ? delta.tool_calls
          : [];
        for (const rawToolDelta of toolDeltas) {
          const toolDelta = asRecord(rawToolDelta);
          const index = Number.isInteger(toolDelta.index)
            ? Number(toolDelta.index)
            : toolCalls.size;
          const functionDelta = asRecord(toolDelta.function);
          const current = toolCalls.get(index) ?? {
            id: asString(toolDelta.id, `tool_${index}`),
            name: "unknown",
            arguments: "",
          };
          current.id = asString(toolDelta.id, current.id);
          current.name = asString(functionDelta.name, current.name);
          const argumentsDelta = asString(functionDelta.arguments);
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

        const usageValue = this.fromUsage(root.usage);
        if (usageValue) {
          usage = usageValue;
          yield ProviderStreamEventSchema.parse({
            type: "usage",
            responseId,
            usage: usageValue,
          });
        }

        const rawFinishReason = asString(choice.finish_reason);
        if (rawFinishReason) finishReason = mapFinishReason(rawFinishReason);
      }

      responseId ??= randomId("response");
      if (!sequenceStarted) {
        sequenceStarted = true;
        yield ProviderStreamEventSchema.parse({
          type: "start",
          responseId,
          model,
        });
      }
      const completedResponse = this.buildResponse({
        id: responseId,
        model,
        content,
        reasoning,
        toolCalls,
        finishReason,
        usage,
        requestedModel: request.model,
      });
      yield ProviderStreamEventSchema.parse({
        type: "finish",
        responseId,
        response: completedResponse,
      });
    } catch (error) {
      const normalized = this.normalizeError(error);
      const providerError =
        normalized instanceof Error &&
        normalized.name === "ProviderAdapterError"
          ? (normalized as typeof normalized & { error: ProviderError }).error
          : createProviderError(this.id, {
              code: "provider_request_failed",
              message:
                normalized instanceof Error
                  ? normalized.message
                  : String(normalized),
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
    if (this.apiKey) headers.set("authorization", `Bearer ${this.apiKey}`);
    new Headers(extra).forEach((value, key) => headers.set(key, value));
    return headers;
  }

  private toRequestBody(
    request: ModelRequest,
    stream: boolean
  ): Record<string, unknown> {
    const parameters = { ...request.parameters };
    delete parameters.max_tokens;
    delete parameters.max_completion_tokens;
    delete parameters.stream;

    const body: Record<string, unknown> = {
      ...parameters,
      model: request.model,
      messages: request.messages.map(toOpenAIMessage),
      stream,
    };
    if (request.maxOutputTokens !== undefined) {
      body.max_completion_tokens = request.maxOutputTokens;
    }
    if (request.temperature !== undefined)
      body.temperature = request.temperature;
    if (request.topP !== undefined) body.top_p = request.topP;
    if (request.stop !== undefined) body.stop = request.stop;
    if (request.reasoningEffort && request.reasoningEffort !== "none") {
      body.reasoning_effort = request.reasoningEffort;
    }
    if (request.tools) {
      body.tools = request.tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      }));
    }
    if (request.toolChoice)
      body.tool_choice = toOpenAIToolChoice(request.toolChoice);
    if (request.responseFormat) {
      body.response_format =
        request.responseFormat === "text"
          ? { type: "text" }
          : { type: "json_object" };
    }
    return body;
  }

  private fromResponse(
    payload: unknown,
    requestedModel: string
  ): ModelResponse {
    const root = asRecord(payload);
    const choice = asRecord(
      Array.isArray(root.choices) ? root.choices[0] : undefined
    );
    const message = asRecord(choice.message);
    return this.buildResponse({
      id: asString(root.id, randomId("response")),
      model: asString(root.model, requestedModel),
      content: contentToText(message.content),
      toolCalls: this.readToolCalls(message.tool_calls),
      finishReason: mapFinishReason(asString(choice.finish_reason)),
      usage: this.fromUsage(root.usage),
      requestedModel,
    });
  }

  private buildResponse(input: {
    id: string;
    model: string;
    content: string;
    reasoning?: string;
    toolCalls:
      | Map<number, { id: string; name: string; arguments: string }>
      | ProviderToolCall[];
    finishReason: ModelResponse["finishReason"];
    usage?: ProviderUsage;
    requestedModel: string;
  }): ModelResponse {
    const toolCalls = Array.isArray(input.toolCalls)
      ? input.toolCalls
      : [...input.toolCalls.entries()]
          .sort(([left], [right]) => left - right)
          .map(([, call]) => parseToolCall(call.id, call.name, call.arguments));
    return ModelResponseSchema.parse({
      id: input.id,
      model: input.model || input.requestedModel,
      content: input.content,
      reasoning: input.reasoning || undefined,
      toolCalls,
      finishReason: input.finishReason,
      usage: input.usage,
      provider: this.id,
    });
  }

  private readToolCalls(value: unknown): ProviderToolCall[] {
    if (!Array.isArray(value)) return [];
    return value.map((raw, index) => {
      const record = asRecord(raw);
      const functionValue = asRecord(record.function);
      return parseToolCall(
        asString(record.id, `tool_${index}`),
        asString(functionValue.name, "unknown"),
        asString(functionValue.arguments)
      );
    });
  }

  private fromUsage(value: unknown): ProviderUsage | undefined {
    const usage = asRecord(value);
    const inputTokens = asNonNegativeInteger(
      usage.prompt_tokens ?? usage.input_tokens
    );
    const outputTokens = asNonNegativeInteger(
      usage.completion_tokens ?? usage.output_tokens
    );
    const totalTokens = asNonNegativeInteger(usage.total_tokens);
    if (
      inputTokens === undefined &&
      outputTokens === undefined &&
      totalTokens === undefined
    ) {
      return undefined;
    }
    return { inputTokens, outputTokens, totalTokens };
  }

  private normalizeError(error: unknown): unknown {
    if (error instanceof Error && error.name === "ProviderAdapterError")
      return error;
    if (error instanceof TypeError) {
      return createProviderError(this.id, {
        code: "network_error",
        message: error.message,
      });
    }
    return error;
  }
}

export { OpenAICompatibleAdapter as OpenAICompatibleProviderAdapter };

function toOpenAIMessage(message: ProviderMessage): Record<string, unknown> {
  const result: Record<string, unknown> = {
    role: message.role,
    content: messageContentForOpenAI(message.content),
  };
  if (message.name) result.name = message.name;
  if (message.toolCallId) result.tool_call_id = message.toolCallId;
  if (message.toolCalls) {
    result.tool_calls = message.toolCalls.map((call) => ({
      id: call.id,
      type: "function",
      function: {
        name: call.name,
        arguments: JSON.stringify(call.arguments),
      },
    }));
  }
  return result;
}

function messageContentForOpenAI(
  content: ProviderMessage["content"]
): string | Record<string, unknown>[] {
  if (typeof content === "string") return content;
  return content.map((part) =>
    part.type === "text"
      ? { type: "text", text: part.text }
      : {
          type: "image_url",
          image_url: { url: part.url, detail: part.detail },
        }
  );
}

function toOpenAIToolChoice(
  choice: NonNullable<ModelRequest["toolChoice"]>
): unknown {
  if (typeof choice === "string") return choice;
  return { type: "function", function: { name: choice.name } };
}

function parseToolCall(
  id: string,
  name: string,
  rawArguments: string
): ProviderToolCall {
  const argumentsValue = JsonObjectSchema.safeParse(
    parseJsonObject(rawArguments)
  );
  return {
    id,
    name,
    arguments: argumentsValue.success ? argumentsValue.data : {},
    rawArguments: rawArguments || undefined,
  };
}

function mapFinishReason(value: string): ModelResponse["finishReason"] {
  if (value === "stop" || value === "end_turn") return "stop";
  if (value === "length" || value === "max_tokens") return "length";
  if (value === "tool_calls" || value === "function_call") return "tool_call";
  if (value === "content_filter") return "content_filter";
  if (value === "error") return "error";
  return "unknown";
}

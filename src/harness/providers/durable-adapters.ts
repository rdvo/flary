import {
  JsonObjectSchema,
  type JsonObject,
} from "../contracts/common.js";
import {
  ModelRequestSchema,
  ModelResponseSchema,
  ProviderErrorSchema,
  ProviderStreamEventSchema,
  type ModelRequest,
  type ModelResponse,
  type ModelStreamEvent,
  type ProviderToolCall,
  type ProviderUsage,
} from "./contracts.js";
import {
  AnthropicMessagesAdapter,
  type AnthropicMessagesAdapterOptions,
} from "./anthropic.js";
import {
  ProviderAdapterError,
  asNonNegativeInteger,
  asRecord,
  asString,
  joinUrl,
  parseServerSentEvents,
  providerErrorFromResponse,
  randomId,
} from "./utils.js";
import {
  ProviderRecoveryCheckpointSchema,
  checkpointProviderStream,
  classifyHttpFailure,
  continuationRequest,
  initialProviderCheckpoint,
  type DurableProviderAdapter,
  type ProviderFailureClass,
  type ProviderRecoveryCheckpoint,
  type ProviderRecoveryContext,
} from "./recovery.js";

export interface OpenAIResponsesRecoveryAdapterOptions {
  id?: string;
  baseUrl?: string;
  apiKey?: string;
  headers?: HeadersInit;
  fetch?: typeof fetch;
}

export class OpenAIResponsesRecoveryAdapter
  implements DurableProviderAdapter
{
  readonly id: string;
  readonly provider = "openai" as const;
  readonly #baseUrl: string;
  readonly #apiKey?: string;
  readonly #headers?: HeadersInit;
  readonly #fetch: typeof fetch;
  readonly #controllers = new Map<string, AbortController>();

  constructor(options: OpenAIResponsesRecoveryAdapterOptions = {}) {
    this.id = options.id ?? "openai-responses-durable";
    this.#baseUrl = options.baseUrl ?? "https://api.openai.com/v1";
    this.#apiKey = options.apiKey;
    this.#headers = options.headers;
    this.#fetch = options.fetch ?? fetch;
  }

  start(
    requestValue: ModelRequest,
    context: ProviderRecoveryContext,
  ): AsyncIterable<ModelStreamEvent> {
    const checkpoint = initialProviderCheckpoint(this, context);
    return checkpointProviderStream(
      this,
      this.streamResponse(
        ModelRequestSchema.parse(requestValue),
        context,
        checkpoint,
      ),
      context,
      checkpoint,
    );
  }

  recover(
    requestValue: ModelRequest,
    checkpointValue: ProviderRecoveryCheckpoint,
    context: ProviderRecoveryContext,
  ): AsyncIterable<ModelStreamEvent> {
    const checkpoint =
      ProviderRecoveryCheckpointSchema.parse(checkpointValue);
    return checkpointProviderStream(
      this,
      this.streamResponse(
        ModelRequestSchema.parse(requestValue),
        context,
        checkpoint,
      ),
      context,
      ProviderRecoveryCheckpointSchema.parse({
        ...checkpoint,
        attempt: checkpoint.attempt + 1,
        updatedAt: new Date().toISOString(),
      }),
    );
  }

  async cancel(
    checkpointValue: ProviderRecoveryCheckpoint,
    context: ProviderRecoveryContext,
  ): Promise<void> {
    const checkpoint =
      ProviderRecoveryCheckpointSchema.parse(checkpointValue);
    this.#controllers
      .get(operationKey(context))
      ?.abort(new DOMException("Cancelled", "AbortError"));
    if (checkpoint.resumeToken) {
      const response = await this.#fetch(
        joinUrl(
          this.#baseUrl,
          `/responses/${encodeURIComponent(checkpoint.resumeToken)}/cancel`,
        ),
        {
          method: "POST",
          headers: this.headers(context.headers),
        },
      );
      if (!response.ok && response.status !== 409) {
        throw await providerErrorFromResponse(this.id, response);
      }
    }
    await context.checkpoints.put(
      ProviderRecoveryCheckpointSchema.parse({
        ...checkpoint,
        status: "cancelled",
        failureClass: "cancelled",
        updatedAt: new Date().toISOString(),
      }),
    );
  }

  classifyError(error: unknown): ProviderFailureClass {
    return classifyHttpFailure(error);
  }

  private async *streamResponse(
    request: ModelRequest,
    context: ProviderRecoveryContext,
    checkpoint: ProviderRecoveryCheckpoint,
  ): AsyncIterable<ModelStreamEvent> {
    const controller = linkedController(context.signal);
    this.#controllers.set(operationKey(context), controller);
    try {
      const response = checkpoint.resumeToken
        ? await this.resume(checkpoint, context, controller.signal)
        : await this.#fetch(joinUrl(this.#baseUrl, "/responses"), {
            method: "POST",
            headers: this.headers(context.headers, context.idempotencyKey),
            body: JSON.stringify(openAIResponsesBody(request)),
            signal: controller.signal,
          });
      if (!response.ok) throw await providerErrorFromResponse(this.id, response);
      if (
        response.headers.get("content-type")?.includes("application/json")
      ) {
        const completed = openAIResponse(
          await response.json(),
          request.model,
          this.id,
        );
        yield ProviderStreamEventSchema.parse({
          type: "start",
          responseId: completed.id,
          model: completed.model,
        });
        yield ProviderStreamEventSchema.parse({
          type: "finish",
          responseId: completed.id,
          response: completed,
        });
        return;
      }
      if (!response.body) {
        throw new Error("OpenAI returned no response stream.");
      }
      let responseId = checkpoint.resumeToken;
      let model = request.model;
      let content = checkpoint.partialText;
      let reasoning = checkpoint.partialReasoning;
      const toolCalls = [...checkpoint.toolCalls];
      let usage = checkpoint.usage;
      let terminal = false;
      for await (const frame of parseServerSentEvents(response.body)) {
        if (!frame.data || frame.data === "[DONE]") continue;
        const root = asRecord(JSON.parse(frame.data));
        const type = asString(root.type ?? frame.event);
        const responseValue = asRecord(root.response);
        responseId = asString(
          responseValue.id ?? root.response_id ?? root.id,
          responseId ?? randomId("response"),
        );
        model = asString(responseValue.model ?? root.model, model);
        const sequence = asNonNegativeInteger(root.sequence_number);
        if (sequence !== undefined) {
          const stored =
            (await context.checkpoints.get(
              context.runId,
              context.operationId,
            )) ?? checkpoint;
          await context.checkpoints.put(
            ProviderRecoveryCheckpointSchema.parse({
              ...stored,
              resumeToken: responseId,
              continuationToken: responseId,
              streamSequence: sequence,
              updatedAt: new Date().toISOString(),
            }),
          );
        }
        if (type === "response.created" || type === "response.in_progress") {
          yield ProviderStreamEventSchema.parse({
            type: "start",
            responseId,
            model,
          });
        } else if (type === "response.output_text.delta") {
          const delta = asString(root.delta);
          content += delta;
          if (delta) {
            yield ProviderStreamEventSchema.parse({
              type: "text_delta",
              responseId,
              delta,
            });
          }
        } else if (
          type === "response.reasoning_summary_text.delta" ||
          type === "response.reasoning_text.delta"
        ) {
          const delta = asString(root.delta);
          reasoning += delta;
          if (delta) {
            yield ProviderStreamEventSchema.parse({
              type: "reasoning_delta",
              responseId,
              delta,
            });
          }
        } else if (type === "response.function_call_arguments.delta") {
          const index = asNonNegativeInteger(root.output_index) ?? 0;
          const delta = asString(root.delta);
          const current = toolCalls[index] ?? {
            id: asString(root.item_id, `tool_${index}`),
            name: asString(root.name, "unknown"),
            arguments: {},
            rawArguments: "",
          };
          current.rawArguments = (current.rawArguments ?? "") + delta;
          current.arguments = parseObject(current.rawArguments);
          toolCalls[index] = current;
          yield ProviderStreamEventSchema.parse({
            type: "tool_call_delta",
            responseId,
            index,
            toolCallId: current.id,
            name: current.name,
            argumentsDelta: delta || undefined,
          });
        } else if (type === "response.completed") {
          terminal = true;
          const completed = openAIResponse(responseValue, model, this.id);
          yield ProviderStreamEventSchema.parse({
            type: "finish",
            responseId: completed.id,
            response: completed,
          });
          return;
        } else if (
          type === "response.failed" ||
          type === "response.incomplete" ||
          type === "error"
        ) {
          terminal = true;
          const error = normalizedProviderError(
            responseValue.error ?? root.error ?? root,
            this.id,
          );
          yield ProviderStreamEventSchema.parse({
            type: "error",
            responseId,
            error,
          });
          return;
        }
        usage = openAIUsage(responseValue.usage ?? root.usage) ?? usage;
        if (usage) {
          yield ProviderStreamEventSchema.parse({
            type: "usage",
            responseId,
            usage,
          });
        }
      }
      if (!terminal) {
        throw new ProviderAdapterError({
          code: "provider_stream_interrupted",
          message:
            "The OpenAI response stream ended before a terminal response event.",
          retryable: true,
          provider: this.id,
        });
      }
    } finally {
      this.#controllers.delete(operationKey(context));
    }
  }

  private resume(
    checkpoint: ProviderRecoveryCheckpoint,
    context: ProviderRecoveryContext,
    signal: AbortSignal,
  ): Promise<Response> {
    const url = new URL(
      joinUrl(
        this.#baseUrl,
        `/responses/${encodeURIComponent(checkpoint.resumeToken!)}`,
      ),
    );
    url.searchParams.set("stream", "true");
    if (checkpoint.streamSequence !== undefined) {
      url.searchParams.set(
        "starting_after",
        String(checkpoint.streamSequence),
      );
    }
    return this.#fetch(url, {
      headers: this.headers(context.headers),
      signal,
    });
  }

  private headers(extra?: HeadersInit, idempotencyKey?: string): Headers {
    const headers = new Headers(this.#headers);
    headers.set("content-type", "application/json");
    headers.set("accept", "text/event-stream, application/json");
    if (this.#apiKey) headers.set("authorization", `Bearer ${this.#apiKey}`);
    if (idempotencyKey) headers.set("idempotency-key", idempotencyKey);
    new Headers(extra).forEach((value, key) => headers.set(key, value));
    return headers;
  }
}

export class AnthropicRecoveryAdapter implements DurableProviderAdapter {
  readonly id: string;
  readonly provider = "anthropic" as const;
  readonly #adapter: AnthropicMessagesAdapter;
  readonly #controllers = new Map<string, AbortController>();

  constructor(options: AnthropicMessagesAdapterOptions = {}) {
    this.id = options.id ?? "anthropic-messages-durable";
    this.#adapter = new AnthropicMessagesAdapter({ ...options, id: this.id });
  }

  start(
    request: ModelRequest,
    context: ProviderRecoveryContext,
  ): AsyncIterable<ModelStreamEvent> {
    return this.run(request, context, initialProviderCheckpoint(this, context));
  }

  recover(
    request: ModelRequest,
    checkpointValue: ProviderRecoveryCheckpoint,
    context: ProviderRecoveryContext,
  ): AsyncIterable<ModelStreamEvent> {
    const checkpoint =
      ProviderRecoveryCheckpointSchema.parse(checkpointValue);
    return this.run(
      continuationRequest(request, checkpoint),
      context,
      ProviderRecoveryCheckpointSchema.parse({
        ...checkpoint,
        attempt: checkpoint.attempt + 1,
        continuationToken:
          checkpoint.resumeToken ?? `continuation_${checkpoint.attempt + 1}`,
        updatedAt: new Date().toISOString(),
      }),
    );
  }

  async cancel(
    checkpoint: ProviderRecoveryCheckpoint,
    context: ProviderRecoveryContext,
  ): Promise<void> {
    this.#controllers
      .get(operationKey(context))
      ?.abort(new DOMException("Cancelled", "AbortError"));
    await context.checkpoints.put(
      ProviderRecoveryCheckpointSchema.parse({
        ...checkpoint,
        status: "cancelled",
        failureClass: "cancelled",
        updatedAt: new Date().toISOString(),
      }),
    );
  }

  classifyError(error: unknown): ProviderFailureClass {
    return classifyHttpFailure(error);
  }

  private run(
    request: ModelRequest,
    context: ProviderRecoveryContext,
    checkpoint: ProviderRecoveryCheckpoint,
  ): AsyncIterable<ModelStreamEvent> {
    const controller = linkedController(context.signal);
    this.#controllers.set(operationKey(context), controller);
    const stream = this.#adapter.stream(request, {
      signal: controller.signal,
      headers: {
        ...headersRecord(context.headers),
        "idempotency-key": context.idempotencyKey,
      },
    });
    return checkpointProviderStream(
      this,
      finalizeStream(stream, () =>
        this.#controllers.delete(operationKey(context)),
      ),
      context,
      checkpoint,
    );
  }
}

export interface GeminiRecoveryAdapterOptions {
  id?: string;
  baseUrl?: string;
  apiKey?: string;
  headers?: HeadersInit;
  fetch?: typeof fetch;
}

export class GeminiRecoveryAdapter implements DurableProviderAdapter {
  readonly id: string;
  readonly provider = "google" as const;
  readonly #baseUrl: string;
  readonly #apiKey?: string;
  readonly #headers?: HeadersInit;
  readonly #fetch: typeof fetch;
  readonly #controllers = new Map<string, AbortController>();

  constructor(options: GeminiRecoveryAdapterOptions = {}) {
    this.id = options.id ?? "gemini-generate-content-durable";
    this.#baseUrl =
      options.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta";
    this.#apiKey = options.apiKey;
    this.#headers = options.headers;
    this.#fetch = options.fetch ?? fetch;
  }

  start(
    request: ModelRequest,
    context: ProviderRecoveryContext,
  ): AsyncIterable<ModelStreamEvent> {
    return this.run(request, context, initialProviderCheckpoint(this, context));
  }

  recover(
    request: ModelRequest,
    checkpointValue: ProviderRecoveryCheckpoint,
    context: ProviderRecoveryContext,
  ): AsyncIterable<ModelStreamEvent> {
    const checkpoint =
      ProviderRecoveryCheckpointSchema.parse(checkpointValue);
    return this.run(
      continuationRequest(request, checkpoint),
      context,
      ProviderRecoveryCheckpointSchema.parse({
        ...checkpoint,
        attempt: checkpoint.attempt + 1,
        continuationToken:
          checkpoint.resumeToken ?? `continuation_${checkpoint.attempt + 1}`,
        updatedAt: new Date().toISOString(),
      }),
    );
  }

  async cancel(
    checkpoint: ProviderRecoveryCheckpoint,
    context: ProviderRecoveryContext,
  ): Promise<void> {
    this.#controllers
      .get(operationKey(context))
      ?.abort(new DOMException("Cancelled", "AbortError"));
    await context.checkpoints.put(
      ProviderRecoveryCheckpointSchema.parse({
        ...checkpoint,
        status: "cancelled",
        failureClass: "cancelled",
        updatedAt: new Date().toISOString(),
      }),
    );
  }

  classifyError(error: unknown): ProviderFailureClass {
    return classifyHttpFailure(error);
  }

  private run(
    requestValue: ModelRequest,
    context: ProviderRecoveryContext,
    checkpoint: ProviderRecoveryCheckpoint,
  ): AsyncIterable<ModelStreamEvent> {
    const request = ModelRequestSchema.parse(requestValue);
    return checkpointProviderStream(
      this,
      this.streamGemini(request, context, checkpoint),
      context,
      checkpoint,
    );
  }

  private async *streamGemini(
    request: ModelRequest,
    context: ProviderRecoveryContext,
    checkpoint: ProviderRecoveryCheckpoint,
  ): AsyncIterable<ModelStreamEvent> {
    const controller = linkedController(context.signal);
    this.#controllers.set(operationKey(context), controller);
    const url = new URL(
      joinUrl(
        this.#baseUrl,
        `/models/${encodeURIComponent(request.model)}:streamGenerateContent`,
      ),
    );
    url.searchParams.set("alt", "sse");
    if (this.#apiKey) url.searchParams.set("key", this.#apiKey);
    let responseId = checkpoint.resumeToken ?? randomId("gemini");
    let content = checkpoint.partialText;
    const toolCalls = [...checkpoint.toolCalls];
    let usage = checkpoint.usage;
    try {
      const response = await this.#fetch(url, {
        method: "POST",
        headers: this.headers(context),
        body: JSON.stringify(geminiBody(request)),
        signal: controller.signal,
      });
      if (!response.ok) throw await providerErrorFromResponse(this.id, response);
      if (!response.body) throw new Error("Gemini returned no response stream.");
      let started = false;
      for await (const frame of parseServerSentEvents(response.body)) {
        if (!frame.data) continue;
        const root = asRecord(JSON.parse(frame.data));
        responseId = asString(root.responseId, responseId);
        if (!started) {
          started = true;
          yield ProviderStreamEventSchema.parse({
            type: "start",
            responseId,
            model: request.model,
          });
        }
        const candidates = Array.isArray(root.candidates)
          ? root.candidates
          : [];
        for (const candidateValue of candidates) {
          const candidate = asRecord(candidateValue);
          const candidateContent = asRecord(candidate.content);
          const parts = Array.isArray(candidateContent.parts)
            ? candidateContent.parts
            : [];
          for (const partValue of parts) {
            const part = asRecord(partValue);
            const text = asString(part.text);
            if (text) {
              content += text;
              yield ProviderStreamEventSchema.parse({
                type: "text_delta",
                responseId,
                delta: text,
              });
            }
            const functionCall = asRecord(part.functionCall);
            if (Object.keys(functionCall).length > 0) {
              const index = toolCalls.length;
              const call: ProviderToolCall = {
                id: asString(functionCall.id, `tool_${index}`),
                name: asString(functionCall.name, "unknown"),
                arguments: parseObject(functionCall.args),
                rawArguments: JSON.stringify(functionCall.args ?? {}),
              };
              toolCalls.push(call);
              yield ProviderStreamEventSchema.parse({
                type: "tool_call_delta",
                responseId,
                index,
                toolCallId: call.id,
                name: call.name,
                argumentsDelta: call.rawArguments,
              });
            }
          }
        }
        usage = geminiUsage(root.usageMetadata) ?? usage;
        if (usage) {
          yield ProviderStreamEventSchema.parse({
            type: "usage",
            responseId,
            usage,
          });
        }
      }
      const completed = ModelResponseSchema.parse({
        id: responseId,
        model: request.model,
        content,
        toolCalls,
        finishReason: toolCalls.length > 0 ? "tool_call" : "stop",
        usage,
        provider: this.id,
      });
      yield ProviderStreamEventSchema.parse({
        type: "finish",
        responseId,
        response: completed,
      });
    } finally {
      this.#controllers.delete(operationKey(context));
    }
  }

  private headers(context: ProviderRecoveryContext): Headers {
    const headers = new Headers(this.#headers);
    headers.set("content-type", "application/json");
    headers.set("accept", "text/event-stream");
    headers.set("x-flary-idempotency-key", context.idempotencyKey);
    new Headers(context.headers).forEach((value, key) =>
      headers.set(key, value),
    );
    return headers;
  }
}

export class InterruptedProviderAdapter implements DurableProviderAdapter {
  readonly provider = "custom" as const;

  constructor(readonly id = "unknown-provider") {}

  start(
    _request: ModelRequest,
    context: ProviderRecoveryContext,
  ): AsyncIterable<ModelStreamEvent> {
    return this.interrupted(context, initialProviderCheckpoint(this, context));
  }

  recover(
    _request: ModelRequest,
    checkpoint: ProviderRecoveryCheckpoint,
    context: ProviderRecoveryContext,
  ): AsyncIterable<ModelStreamEvent> {
    return this.interrupted(context, checkpoint);
  }

  async cancel(
    checkpoint: ProviderRecoveryCheckpoint,
    context: ProviderRecoveryContext,
  ): Promise<void> {
    await context.checkpoints.put(
      ProviderRecoveryCheckpointSchema.parse({
        ...checkpoint,
        status: "cancelled",
        failureClass: "cancelled",
        updatedAt: new Date().toISOString(),
      }),
    );
  }

  classifyError(): ProviderFailureClass {
    return "interrupted";
  }

  private async *interrupted(
    context: ProviderRecoveryContext,
    checkpoint: ProviderRecoveryCheckpoint,
  ): AsyncIterable<ModelStreamEvent> {
    const error = ProviderErrorSchema.parse({
      code: "explicit_retry_required",
      message:
        "This provider cannot recover the operation safely. An explicit retry is required.",
      retryable: false,
      provider: this.id,
    });
    await context.checkpoints.put(
      ProviderRecoveryCheckpointSchema.parse({
        ...checkpoint,
        status: "interrupted",
        failureClass: "interrupted",
        error,
        updatedAt: new Date().toISOString(),
      }),
    );
    yield ProviderStreamEventSchema.parse({ type: "error", error });
  }
}

function openAIResponsesBody(request: ModelRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    ...(request.parameters ?? {}),
    model: request.model,
    input: request.messages.map((message) => ({
      role: message.role === "tool" ? "user" : message.role,
      content:
        typeof message.content === "string"
          ? message.content
          : message.content.map((part) =>
              part.type === "text"
                ? { type: "input_text", text: part.text }
                : { type: "input_image", image_url: part.url, detail: part.detail },
            ),
    })),
    background: true,
    stream: true,
    store: true,
  };
  if (request.maxOutputTokens !== undefined) {
    body.max_output_tokens = request.maxOutputTokens;
  }
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.topP !== undefined) body.top_p = request.topP;
  if (request.tools) {
    body.tools = request.tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    }));
  }
  if (request.toolChoice) body.tool_choice = request.toolChoice;
  if (request.reasoningEffort) {
    body.reasoning = {
      effort: request.reasoningEffort,
      summary: "auto",
    };
  }
  if (request.verbosity) body.text = { verbosity: request.verbosity };
  return body;
}

function openAIResponse(
  value: unknown,
  requestedModel: string,
  provider: string,
): ModelResponse {
  const root = asRecord(value);
  const output = Array.isArray(root.output) ? root.output : [];
  let content = "";
  let reasoning = "";
  const toolCalls: ProviderToolCall[] = [];
  for (const itemValue of output) {
    const item = asRecord(itemValue);
    if (asString(item.type) === "function_call") {
      toolCalls.push({
        id: asString(item.call_id ?? item.id, randomId("tool")),
        name: asString(item.name, "unknown"),
        arguments: parseObject(item.arguments),
        rawArguments: asString(item.arguments),
      });
      continue;
    }
    const parts = Array.isArray(item.content) ? item.content : [];
    for (const partValue of parts) {
      const part = asRecord(partValue);
      const type = asString(part.type);
      if (type === "output_text") content += asString(part.text);
      if (type.includes("reasoning")) {
        reasoning += asString(part.text ?? part.summary);
      }
    }
  }
  return ModelResponseSchema.parse({
    id: asString(root.id, randomId("response")),
    model: asString(root.model, requestedModel),
    content,
    reasoning: reasoning || undefined,
    toolCalls,
    finishReason: toolCalls.length > 0 ? "tool_call" : "stop",
    usage: openAIUsage(root.usage),
    provider,
  });
}

function openAIUsage(value: unknown): ProviderUsage | undefined {
  const usage = asRecord(value);
  if (Object.keys(usage).length === 0) return undefined;
  const details = asRecord(usage.input_tokens_details);
  return {
    inputTokens: asNonNegativeInteger(usage.input_tokens),
    outputTokens: asNonNegativeInteger(usage.output_tokens),
    totalTokens: asNonNegativeInteger(usage.total_tokens),
    cachedInputTokens: asNonNegativeInteger(details.cached_tokens),
  };
}

function geminiBody(request: ModelRequest): Record<string, unknown> {
  const system = request.messages
    .filter((message) =>
      ["system", "developer"].includes(message.role),
    )
    .map((message) => messageText(message.content))
    .filter(Boolean)
    .join("\n\n");
  const body: Record<string, unknown> = {
    contents: request.messages
      .filter(
        (message) => !["system", "developer"].includes(message.role),
      )
      .map((message) => ({
        role: message.role === "assistant" ? "model" : "user",
        parts: [{ text: messageText(message.content) }],
      })),
    generationConfig: {
      maxOutputTokens: request.maxOutputTokens,
      temperature: request.temperature,
      topP: request.topP,
      stopSequences: request.stop
        ? Array.isArray(request.stop)
          ? request.stop
          : [request.stop]
        : undefined,
      responseMimeType:
        request.responseFormat === "text" ||
        request.responseFormat === undefined
          ? undefined
          : "application/json",
    },
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (request.tools) {
    body.tools = [
      {
        functionDeclarations: request.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        })),
      },
    ];
  }
  return body;
}

function geminiUsage(value: unknown): ProviderUsage | undefined {
  const usage = asRecord(value);
  if (Object.keys(usage).length === 0) return undefined;
  return {
    inputTokens: asNonNegativeInteger(usage.promptTokenCount),
    outputTokens: asNonNegativeInteger(usage.candidatesTokenCount),
    totalTokens: asNonNegativeInteger(usage.totalTokenCount),
    cachedInputTokens: asNonNegativeInteger(usage.cachedContentTokenCount),
  };
}

function messageText(content: ModelRequest["messages"][number]["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => (part.type === "text" ? part.text : `[image: ${part.url}]`))
    .join("\n");
}

function normalizedProviderError(
  value: unknown,
  provider: string,
) {
  const root = asRecord(value);
  return ProviderErrorSchema.parse({
    code: asString(root.code ?? root.type, "provider_error"),
    message: asString(root.message, "The provider returned an error."),
    retryable: Boolean(root.retryable),
    provider,
  });
}

function parseObject(value: unknown): JsonObject {
  if (typeof value === "string") {
    try {
      return JsonObjectSchema.parse(JSON.parse(value));
    } catch {
      return {};
    }
  }
  const parsed = JsonObjectSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}

function linkedController(signal?: AbortSignal): AbortController {
  const controller = new AbortController();
  if (signal?.aborted) {
    controller.abort(signal.reason);
  } else {
    signal?.addEventListener(
      "abort",
      () => controller.abort(signal.reason),
      { once: true },
    );
  }
  return controller;
}

function operationKey(context: ProviderRecoveryContext): string {
  return `${context.runId}:${context.operationId}`;
}

function headersRecord(value?: HeadersInit): Record<string, string> {
  return Object.fromEntries(new Headers(value).entries());
}

async function* finalizeStream<T>(
  stream: AsyncIterable<T>,
  finalize: () => void,
): AsyncIterable<T> {
  try {
    yield* stream;
  } finally {
    finalize();
  }
}

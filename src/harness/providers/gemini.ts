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

export interface GeminiAdapterOptions {
  readonly id?: string;
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
}

/** Google Gemini GenerateContent adapter with no browser-visible credential. */
export class GeminiAdapter implements ModelAdapter {
  readonly id: string;
  readonly provider = "google" as const;
  readonly supportsStreaming = false;
  readonly #apiKey?: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;

  constructor(options: GeminiAdapterOptions = {}) {
    this.id = options.id ?? "google-gemini";
    this.#apiKey = options.apiKey;
    this.#baseUrl = options.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta";
    this.#fetch = options.fetch ?? fetch;
  }

  async complete(requestValue: ModelRequest, options: ProviderRequestOptions = {}): Promise<ModelResponse> {
    const request = ModelRequestSchema.parse(requestValue);
    const response = await this.#fetch(
      `${this.#baseUrl.replace(/\/$/, "")}/models/${encodeURIComponent(request.model)}:generateContent`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.#apiKey ? { "x-goog-api-key": this.#apiKey } : {}),
          ...headersRecord(options.headers),
        },
        body: JSON.stringify(geminiRequest(request)),
        signal: options.signal ?? (options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined),
      },
    );
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Gemini request failed with HTTP ${response.status}${detail ? `: ${detail.slice(0, 300)}` : "."}`);
    }
    return geminiResponse(await response.json(), request.model, this.id);
  }

  async *stream(request: ModelRequest, options: ProviderRequestOptions = {}): AsyncIterable<ModelStreamEvent> {
    const response = await this.complete(request, options);
    yield ProviderStreamEventSchema.parse({ type: "start", responseId: response.id, model: response.model });
    if (response.content) {
      yield ProviderStreamEventSchema.parse({ type: "text_delta", responseId: response.id, delta: response.content });
    }
    for (const [index, call] of response.toolCalls.entries()) {
      yield ProviderStreamEventSchema.parse({
        type: "tool_call_delta",
        responseId: response.id,
        index,
        toolCallId: call.id,
        name: call.name,
        argumentsDelta: call.rawArguments ?? JSON.stringify(call.arguments),
      });
    }
    if (response.usage) yield ProviderStreamEventSchema.parse({ type: "usage", responseId: response.id, usage: response.usage });
    yield ProviderStreamEventSchema.parse({ type: "finish", responseId: response.id, response });
  }
}

function geminiRequest(request: ModelRequest): Record<string, unknown> {
  const system = request.messages
    .filter((message) => message.role === "system" || message.role === "developer")
    .map(messageText)
    .filter(Boolean)
    .join("\n\n");
  const contents = request.messages
    .filter((message) => message.role !== "system" && message.role !== "developer")
    .map((message) => ({
      role: message.role === "assistant" ? "model" : "user",
      parts: messageParts(message, request.messages),
    }));
  return {
    contents,
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    ...(request.tools?.length ? {
      tools: [{ functionDeclarations: request.tools.map((tool) => ({
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        parameters: tool.inputSchema,
      })) }],
    } : {}),
    generationConfig: {
      ...(request.maxOutputTokens ? { maxOutputTokens: request.maxOutputTokens } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.topP !== undefined ? { topP: request.topP } : {}),
      ...(request.stop ? { stopSequences: Array.isArray(request.stop) ? request.stop : [request.stop] } : {}),
      ...(request.responseFormat && request.responseFormat !== "text"
        ? { responseMimeType: "application/json", ...(request.responseFormat.schema ? { responseSchema: request.responseFormat.schema } : {}) }
        : {}),
    },
  };
}

function messageText(message: ProviderMessage): string {
  return typeof message.content === "string"
    ? message.content
    : message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

function messageParts(message: ProviderMessage, history: readonly ProviderMessage[]): Array<Record<string, unknown>> {
  if (message.role === "tool") {
    const call = history.flatMap((entry) => entry.toolCalls ?? []).find((entry) => entry.id === message.toolCallId);
    return [{ functionResponse: { name: message.name ?? call?.name ?? "tool", response: { result: messageText(message) } } }];
  }
  const parts: Array<Record<string, unknown>> = typeof message.content === "string"
    ? [{ text: message.content }]
    : message.content.map((part) => part.type === "text"
      ? { text: part.text }
      : { fileData: { mimeType: part.mimeType ?? "application/octet-stream", fileUri: part.url } });
  for (const call of message.toolCalls ?? []) {
    parts.push({ functionCall: { name: call.name, args: call.arguments } });
  }
  return parts;
}

function geminiResponse(value: unknown, model: string, provider: string): ModelResponse {
  const root = record(value);
  const candidate = Array.isArray(root.candidates) ? record(root.candidates[0]) : {};
  const content = record(candidate.content);
  const parts = Array.isArray(content.parts) ? content.parts.map(record) : [];
  const text = parts.map((part) => typeof part.text === "string" ? part.text : "").join("");
  const toolCalls: ProviderToolCall[] = parts.flatMap((part, index) => {
    const call = record(part.functionCall);
    if (typeof call.name !== "string") return [];
    const args = record(call.args);
    return [{ id: `gemini_tool_${index}`, name: call.name, arguments: args, rawArguments: JSON.stringify(args) }];
  });
  const usage = record(root.usageMetadata);
  return ModelResponseSchema.parse({
    id: typeof root.responseId === "string" ? root.responseId : crypto.randomUUID(),
    model,
    content: text,
    toolCalls,
    finishReason: toolCalls.length ? "tool_call" : finishReason(candidate.finishReason),
    provider,
    usage: {
      inputTokens: numberValue(usage.promptTokenCount),
      outputTokens: numberValue(usage.candidatesTokenCount),
      totalTokens: numberValue(usage.totalTokenCount),
    },
  });
}

function finishReason(value: unknown): "stop" | "length" | "content_filter" | "unknown" {
  if (value === "STOP") return "stop";
  if (value === "MAX_TOKENS") return "length";
  if (value === "SAFETY" || value === "BLOCKLIST" || value === "PROHIBITED_CONTENT") return "content_filter";
  return "unknown";
}

function headersRecord(value: HeadersInit | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  new Headers(value).forEach((entry, key) => { result[key] = entry; });
  return result;
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

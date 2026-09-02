import { ProviderErrorSchema, type ProviderError } from "./contracts.js";
import { JsonObjectSchema } from "../contracts/common.js";
import type { ProviderRequestOptions } from "./types.js";

export class ProviderAdapterError extends Error {
  readonly error: ProviderError;

  constructor(error: ProviderError) {
    super(error.message);
    this.name = "ProviderAdapterError";
    this.error = ProviderErrorSchema.parse(error);
  }
}

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function asNonNegativeInteger(value: unknown): number | undefined {
  const number = asNumber(value);
  return number !== undefined && Number.isInteger(number) && number >= 0 ? number : undefined;
}

export function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return asRecord(value);
  try {
    return asRecord(JSON.parse(value) as unknown);
  } catch {
    return {};
  }
}

export function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const suffix = path.replace(/^\/+/, "");
  return base.endsWith(suffix) ? base : `${base}/${suffix}`;
}

export function randomId(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return `${prefix}_${uuid ?? Math.random().toString(36).slice(2)}`;
}

export function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const record = asRecord(part);
      return asString(record.text);
    })
    .filter(Boolean)
    .join("");
}

export function createProviderError(
  provider: string,
  error: unknown,
  status?: number,
): ProviderAdapterError {
  const record = asRecord(error);
  const nested = asRecord(record.error);
  const code = asString(
    nested.code ?? record.code ?? record.type,
    status && status >= 500 ? "provider_server_error" : "provider_error",
  );
  const message = asString(nested.message ?? record.message, "The provider returned an error.");
  const details = JsonObjectSchema.safeParse(nested.details ?? record.details);

  return new ProviderAdapterError({
    code,
    message,
    status,
    retryable:
      status === 408 || status === 409 || status === 429 || status === undefined || status >= 500,
    provider,
    details: details.success ? details.data : undefined,
  });
}

export async function providerErrorFromResponse(
  provider: string,
  response: Response,
): Promise<ProviderAdapterError> {
  let payload: unknown;
  try {
    payload = JSON.parse(await response.text()) as unknown;
  } catch {
    payload = { message: response.statusText || "The provider returned an error." };
  }
  return createProviderError(provider, payload, response.status);
}

export function requestSignal(options: ProviderRequestOptions): {
  signal?: AbortSignal;
  cleanup: () => void;
} {
  if (!options.timeoutMs || options.timeoutMs <= 0) {
    return { signal: options.signal, cleanup: () => undefined };
  }

  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) {
    abortFromCaller();
  } else {
    options.signal?.addEventListener("abort", abortFromCaller, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abortFromCaller);
    },
  };
}

export interface ServerSentEvent {
  readonly event?: string;
  readonly data: string;
  readonly id?: string;
}

export async function* parseServerSentEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<ServerSentEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event: string | undefined;
  let id: string | undefined;
  let data: string[] = [];

  const flush = (): ServerSentEvent | undefined => {
    if (data.length === 0 && event === undefined && id === undefined) {
      return undefined;
    }
    const result: ServerSentEvent = {
      event,
      id,
      data: data.join("\n"),
    };
    event = undefined;
    id = undefined;
    data = [];
    return result;
  };

  const consumeLine = (line: string): ServerSentEvent | undefined => {
    if (line === "") return flush();
    if (line.startsWith(":")) return undefined;

    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? "" : line.slice(separator + 1).replace(/^ /, "");
    if (field === "event") event = value;
    if (field === "id") id = value;
    if (field === "data") data.push(value);
    return undefined;
  };

  try {
    while (true) {
      const result = await reader.read();
      buffer += decoder.decode(result.value ?? new Uint8Array(), {
        stream: !result.done,
      });

      let lineEnd = findLineEnd(buffer);
      while (lineEnd !== undefined) {
        const line = buffer.slice(0, lineEnd.index);
        buffer = buffer.slice(lineEnd.nextIndex);
        const parsed = consumeLine(line);
        if (parsed) yield parsed;
        lineEnd = findLineEnd(buffer);
      }

      if (result.done) break;
    }

    if (buffer.length > 0) {
      const parsed = consumeLine(buffer);
      if (parsed) yield parsed;
    }
    const parsed = flush();
    if (parsed) yield parsed;
  } finally {
    reader.releaseLock();
  }
}

function findLineEnd(value: string): { index: number; nextIndex: number } | undefined {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "\n") {
      return {
        index: index > 0 && value[index - 1] === "\r" ? index - 1 : index,
        nextIndex: index + 1,
      };
    }
    if (value[index] === "\r") {
      return {
        index,
        nextIndex: value[index + 1] === "\n" ? index + 2 : index + 1,
      };
    }
  }
  return undefined;
}

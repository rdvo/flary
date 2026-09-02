import {
  CancelRunRequestSchema,
  CreateRunRequestSchema,
  RunEventSchema,
  RunHandleSchema,
  RunInputSchema,
  RunResultSchema,
  type CancelRunRequest,
  type CreateRunRequest,
  type RunEvent,
  type RunHandle,
  type RunInput,
  type RunResult,
} from "../contracts/index.js";

export interface CreateFlaryRunClientOptions {
  /** Exact agent API base, for example `/v1/agents/research`. */
  readonly baseUrl: string;
  readonly token?: string;
  readonly headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
  readonly fetch?: typeof fetch;
}

export interface ObserveFlaryRunOptions {
  readonly afterSequence?: number;
  readonly signal?: AbortSignal;
}

export class FlaryRunClient {
  readonly #baseUrl: string;
  readonly #token?: string;
  readonly #headers?: CreateFlaryRunClientOptions["headers"];
  readonly #fetch: typeof fetch;

  constructor(options: CreateFlaryRunClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#token = options.token;
    this.#headers = options.headers;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async create(input: CreateRunRequest): Promise<RunHandle> {
    return RunHandleSchema.parse(
      await this.json("/runs", {
        method: "POST",
        body: JSON.stringify(CreateRunRequestSchema.parse(input)),
      }),
    );
  }

  async get(runId: string): Promise<RunResult> {
    return RunResultSchema.parse(await this.json(`/runs/${encodeURIComponent(runId)}`));
  }

  async input(runId: string, input: RunInput): Promise<RunResult> {
    return RunResultSchema.parse(
      await this.json(`/runs/${encodeURIComponent(runId)}/input`, {
        method: "POST",
        body: JSON.stringify(RunInputSchema.parse(input)),
      }),
    );
  }

  async cancel(runId: string, input: CancelRunRequest): Promise<RunResult> {
    return RunResultSchema.parse(
      await this.json(`/runs/${encodeURIComponent(runId)}/cancel`, {
        method: "POST",
        body: JSON.stringify(CancelRunRequestSchema.parse(input)),
      }),
    );
  }

  async *observe(runId: string, options: ObserveFlaryRunOptions = {}): AsyncGenerator<RunEvent> {
    const query = new URLSearchParams();
    if (options.afterSequence !== undefined) {
      query.set("afterSequence", String(options.afterSequence));
    }
    const suffix = query.size > 0 ? `?${query}` : "";
    const response = await this.request(`/runs/${encodeURIComponent(runId)}/events${suffix}`, {
      headers: { accept: "text/event-stream" },
      signal: options.signal,
    });
    if (!response.body) {
      throw new Error("The Flary run stream returned no body");
    }

    for await (const event of parseSse(response.body)) {
      if (event.event === "heartbeat" || !event.data) continue;
      yield RunEventSchema.parse(JSON.parse(event.data) as unknown);
    }
  }

  private async json(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await this.request(path, init);
    return response.json();
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (init.body !== undefined && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    if (this.#token) headers.set("authorization", `Bearer ${this.#token}`);
    const configured = typeof this.#headers === "function" ? await this.#headers() : this.#headers;
    for (const [name, value] of new Headers(configured).entries()) {
      if (!headers.has(name)) headers.set(name, value);
    }
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      ...init,
      headers,
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => undefined);
      const message =
        payload &&
        typeof payload === "object" &&
        "error" in payload &&
        payload.error &&
        typeof payload.error === "object" &&
        "message" in payload.error
          ? String(payload.error.message)
          : `Flary run request failed (${response.status})`;
      throw new Error(message);
    }
    return response;
  }
}

export function createFlaryRunClient(options: CreateFlaryRunClientOptions): FlaryRunClient {
  return new FlaryRunClient(options);
}

interface SseRecord {
  readonly event?: string;
  readonly data: string;
}

async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseRecord> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event: string | undefined;
  let data: string[] = [];

  const consume = (block: string): SseRecord | undefined => {
    event = undefined;
    data = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice(6).trimStart();
      if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    return data.length > 0 ? { event, data: data.join("\n") } : undefined;
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const record = consume(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      if (record) yield record;
      boundary = buffer.indexOf("\n\n");
    }
    if (done) break;
  }
  const record = consume(buffer);
  if (record) yield record;
}

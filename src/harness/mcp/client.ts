import { z } from "zod";

import { IdentifierSchema, NonEmptyStringSchema } from "../contracts/common.js";

const McpToolNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_.:/-]+$/);

export const McpEndpointSchema = z
  .object({
    connectionId: IdentifierSchema,
    name: NonEmptyStringSchema.max(120),
    url: z.string().url().max(2_000),
    transport: z.enum(["streamable-http", "sse"]),
  })
  .strict();
export type McpEndpoint = z.infer<typeof McpEndpointSchema>;

export const McpToolDescriptorSchema = z
  .object({
    connectionId: IdentifierSchema,
    server: NonEmptyStringSchema.max(120),
    name: McpToolNameSchema,
    description: z.string().max(8_000).optional(),
    inputSchema: z.record(z.string(), z.unknown()),
    annotations: z
      .object({
        readOnlyHint: z.boolean().optional(),
        destructiveHint: z.boolean().optional(),
      })
      .strict()
      .optional(),
    discoveredAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type McpToolDescriptor = z.infer<typeof McpToolDescriptorSchema>;

export interface McpCredential {
  readonly kind: "api_key" | "bearer";
  readonly value: string;
  readonly header?: string;
}

export const McpCredentialSchema = z
  .object({
    kind: z.enum(["api_key", "bearer"]),
    value: z.string().min(1).max(16_384),
    header: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/)
      .optional(),
  })
  .strict()
  .superRefine((credential, context) => {
    const header = credential.header?.toLowerCase();
    if (
      header &&
      ["cookie", "host", "content-length", "connection"].includes(header)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["header"],
        message: "The credential header is not allowed",
      });
    }
  });

export interface McpCredentialProvider {
  get(connectionId: string): Promise<McpCredential | undefined>;
}

export interface McpClientOptions {
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxRedirects?: number;
  readonly maxResponseBytes?: number;
  /** Only self-hosted deployments may opt in to HTTP for local development. */
  readonly allowInsecureHttp?: boolean;
}

export interface McpCallResult {
  readonly content: unknown;
  readonly isError: boolean;
}

export class McpSecurityError extends Error {
  readonly code = "mcp_security_error" as const;

  constructor(message: string) {
    super(message);
    this.name = "McpSecurityError";
  }
}

interface JsonRpcResponse {
  readonly result?: unknown;
  readonly error?: { code?: number; message?: string; data?: unknown };
}

/**
 * A small provider-neutral MCP client. Public descriptors are always
 * redacted. Protected servers can receive a credential from trusted host code
 * during discovery and invocation.
 */
export class McpConnectionClient {
  readonly #endpoint: McpEndpoint;
  readonly #fetch: typeof fetch;
  readonly #options: Required<
    Pick<McpClientOptions, "timeoutMs" | "maxRedirects" | "maxResponseBytes">
  > &
    Pick<McpClientOptions, "allowInsecureHttp">;
  #sessionId: string | undefined;
  #requestId = 0;

  constructor(endpointInput: McpEndpoint, options: McpClientOptions = {}) {
    this.#endpoint = McpEndpointSchema.parse(endpointInput);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#options = {
      timeoutMs: options.timeoutMs ?? 30_000,
      maxRedirects: options.maxRedirects ?? 3,
      maxResponseBytes: options.maxResponseBytes ?? 512 * 1024,
      allowInsecureHttp: options.allowInsecureHttp,
    };
    assertSafeMcpUrl(this.#endpoint.url, this.#options);
  }

  get endpoint(): McpEndpoint {
    return this.#endpoint;
  }

  async listTools(
    credentials?: McpCredentialProvider
  ): Promise<McpToolDescriptor[]> {
    const credential = await resolveCredential(
      credentials,
      this.#endpoint.connectionId
    );
    const headers = credential ? credentialHeaders(credential) : undefined;
    await this.initialize(headers);
    const response = await this.request("tools/list", {}, headers);
    const result = asRecord(response.result);
    const tools = Array.isArray(result.tools) ? result.tools : [];
    if (tools.length > 256) {
      throw new McpSecurityError("MCP tool catalog exceeds the 256-tool limit");
    }
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 5 * 60_000).toISOString();
    return tools.map((tool) => {
      const value = asRecord(tool);
      const inputSchema = asRecord(value.inputSchema ?? { type: "object" });
      const serialized = JSON.stringify(inputSchema);
      if (serialized.length > 64 * 1024) {
        throw new McpSecurityError("MCP tool schema exceeds the 64 KiB limit");
      }
      return McpToolDescriptorSchema.parse({
        connectionId: this.#endpoint.connectionId,
        server: this.#endpoint.name,
        name: value.name,
        ...(typeof value.description === "string"
          ? { description: value.description.slice(0, 8_000) }
          : {}),
        inputSchema,
        ...(safeAnnotations(value.annotations)
          ? { annotations: safeAnnotations(value.annotations) }
          : {}),
        discoveredAt: now.toISOString(),
        expiresAt,
      });
    });
  }

  async call(
    toolName: string,
    argumentsInput: Record<string, unknown>,
    credentials?: McpCredentialProvider
  ): Promise<McpCallResult> {
    const name = McpToolNameSchema.parse(toolName);
    const args = z.record(z.string(), z.unknown()).parse(argumentsInput);
    const serialized = JSON.stringify(args);
    if (serialized.length > 512 * 1024) {
      throw new McpSecurityError("MCP tool arguments exceed the 512 KiB limit");
    }
    const credential = await resolveCredential(
      credentials,
      this.#endpoint.connectionId
    );
    const headers = credential ? credentialHeaders(credential) : undefined;
    await this.initialize(headers);
    const response = await this.request(
      "tools/call",
      { name, arguments: args },
      headers
    );
    return {
      content: response.result,
      isError: asRecord(response.result).isError === true,
    };
  }

  private async initialize(extraHeaders?: Headers): Promise<void> {
    if (this.#sessionId) return;
    const response = await this.request(
      "initialize",
      {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "flary", version: "0.3.0" },
      },
      extraHeaders
    );
    const result = asRecord(response.result);
    if (!result.protocolVersion) {
      throw new Error(
        "MCP initialize response did not contain protocolVersion"
      );
    }
    await this.request("notifications/initialized", {}, extraHeaders, true);
  }

  private async request(
    method: string,
    params: Record<string, unknown>,
    extraHeaders?: Headers,
    notification = false
  ): Promise<JsonRpcResponse> {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      ...(notification ? {} : { id: ++this.#requestId }),
      method,
      params,
    });
    const headers = new Headers(extraHeaders);
    headers.set("content-type", "application/json");
    headers.set("accept", "application/json, text/event-stream");
    if (this.#sessionId) headers.set("mcp-session-id", this.#sessionId);
    const response = await fetchWithSafeRedirects(
      this.#fetch,
      this.#endpoint.url,
      {
        method: "POST",
        headers,
        body,
        signal: undefined,
      },
      this.#options
    );
    const sessionId = response.headers.get("mcp-session-id");
    if (sessionId) this.#sessionId = sessionId;
    if (notification && (response.status === 202 || response.status === 204)) {
      return {};
    }
    const text = await readBoundedText(
      response,
      this.#options.maxResponseBytes
    );
    if (!text.trim()) return {};
    const parsed = parseMcpResponse(text, response.headers.get("content-type"));
    if (parsed.error) {
      throw new Error(parsed.error.message ?? `MCP request failed: ${method}`);
    }
    return parsed;
  }
}

function safeAnnotations(
  value: unknown
): { readOnlyHint?: boolean; destructiveHint?: boolean } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  const annotations = {
    ...(typeof record.readOnlyHint === "boolean"
      ? { readOnlyHint: record.readOnlyHint }
      : {}),
    ...(typeof record.destructiveHint === "boolean"
      ? { destructiveHint: record.destructiveHint }
      : {}),
  };
  return Object.keys(annotations).length > 0 ? annotations : undefined;
}

export class McpToolCache {
  readonly #clients = new Map<string, McpConnectionClient>();
  readonly #tools = new Map<string, McpToolDescriptor[]>();

  constructor(private readonly options: McpClientOptions = {}) {}

  async discover(
    endpoint: McpEndpoint,
    options: {
      namespace?: string;
      credentials?: McpCredentialProvider;
    } = {}
  ): Promise<readonly McpToolDescriptor[]> {
    const parsed = McpEndpointSchema.parse(endpoint);
    const key = cacheKey(parsed, options.namespace);
    const cached = this.#tools.get(key);
    if (cached?.[0] && Date.parse(cached[0].expiresAt) > Date.now())
      return cached;
    const client =
      this.#clients.get(key) ?? new McpConnectionClient(parsed, this.options);
    this.#clients.set(key, client);
    const tools = await client.listTools(options.credentials);
    this.#tools.set(key, tools);
    return tools;
  }

  client(endpoint: McpEndpoint, namespace?: string): McpConnectionClient {
    const parsed = McpEndpointSchema.parse(endpoint);
    const key = cacheKey(parsed, namespace);
    const client =
      this.#clients.get(key) ?? new McpConnectionClient(parsed, this.options);
    this.#clients.set(key, client);
    return client;
  }

  clear(connectionId?: string): void {
    if (!connectionId) {
      this.#tools.clear();
      this.#clients.clear();
      return;
    }
    for (const key of this.#tools.keys()) {
      if (key.includes(`:${connectionId}:`)) this.#tools.delete(key);
    }
    for (const key of this.#clients.keys()) {
      if (key.includes(`:${connectionId}:`)) this.#clients.delete(key);
    }
  }
}

export function assertSafeMcpUrl(
  value: string | URL,
  options: Pick<McpClientOptions, "allowInsecureHttp"> = {}
): URL {
  const url = new URL(value.toString());
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (url.username || url.password)
    throw new McpSecurityError("MCP URLs cannot contain user information");
  if (
    url.protocol !== "https:" &&
    !(options.allowInsecureHttp && url.protocol === "http:")
  ) {
    throw new McpSecurityError("Remote MCP endpoints must use HTTPS");
  }
  if (isPrivateHostname(hostname)) {
    throw new McpSecurityError(
      "Remote MCP endpoints cannot target private or local networks"
    );
  }
  return url;
}

function isPrivateHostname(hostname: string): boolean {
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "0.0.0.0" ||
    hostname === "::1"
  )
    return true;
  if (
    hostname.startsWith("127.") ||
    hostname.startsWith("10.") ||
    hostname.startsWith("192.168.")
  )
    return true;
  const match = hostname.match(/^172\.(\d{1,3})\./);
  if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return true;
  if (/^(169\.254\.|100\.64\.)/.test(hostname)) return true;
  if (hostname.includes(":")) return true;
  return false;
}

function credentialHeaders(credential: McpCredential): Headers {
  const parsed = McpCredentialSchema.parse(credential);
  const headers = new Headers();
  if (parsed.kind === "bearer") {
    headers.set("authorization", `Bearer ${parsed.value}`);
  } else {
    headers.set(parsed.header ?? "x-api-key", parsed.value);
  }
  return headers;
}

async function resolveCredential(
  provider: McpCredentialProvider | undefined,
  connectionId: string
): Promise<McpCredential | undefined> {
  if (!provider) return undefined;
  try {
    const credential = await provider.get(connectionId);
    return credential ? McpCredentialSchema.parse(credential) : undefined;
  } catch {
    throw new McpSecurityError("MCP credential resolution failed");
  }
}

function cacheKey(endpoint: McpEndpoint, namespace = "default"): string {
  return `${namespace}:${endpoint.connectionId}:${endpoint.url}:${endpoint.transport}`;
}

async function fetchWithSafeRedirects(
  fetcher: typeof fetch,
  initialUrl: string,
  init: RequestInit,
  options: Required<Pick<McpClientOptions, "timeoutMs" | "maxRedirects">> &
    Pick<McpClientOptions, "allowInsecureHttp">
): Promise<Response> {
  let url = assertSafeMcpUrl(initialUrl, options);
  for (let redirect = 0; redirect <= options.maxRedirects; redirect += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const response = await fetcher(url, {
        ...init,
        redirect: "manual",
        signal: controller.signal,
      });
      if (response.status < 300 || response.status >= 400) {
        if (!response.ok)
          throw new Error(`MCP endpoint returned HTTP ${response.status}`);
        return response;
      }
      const location = response.headers.get("location");
      if (!location)
        throw new McpSecurityError("MCP redirect did not contain a location");
      const next = assertSafeMcpUrl(new URL(location, url), options);
      if (next.origin !== url.origin) {
        throw new McpSecurityError(
          "MCP redirects must stay on the same HTTPS origin"
        );
      }
      url = next;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new McpSecurityError("MCP endpoint exceeded the redirect limit");
}

async function readBoundedText(
  response: Response,
  maxBytes: number
): Promise<string> {
  const length = response.headers.get("content-length");
  if (length && Number(length) > maxBytes)
    throw new McpSecurityError("MCP response exceeds the size limit");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes)
    throw new McpSecurityError("MCP response exceeds the size limit");
  return new TextDecoder().decode(bytes);
}

function parseMcpResponse(
  text: string,
  contentType: string | null
): JsonRpcResponse {
  if (contentType?.includes("text/event-stream")) {
    const data = text
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter(Boolean)
      .at(-1);
    if (!data) return {};
    return asJsonRpcResponse(JSON.parse(data));
  }
  return asJsonRpcResponse(JSON.parse(text));
}

function asJsonRpcResponse(value: unknown): JsonRpcResponse {
  const record = asRecord(value);
  return {
    ...(record.result !== undefined ? { result: record.result } : {}),
    ...(record.error !== undefined
      ? { error: asRecord(record.error) as JsonRpcResponse["error"] }
      : {}),
  };
}

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
}

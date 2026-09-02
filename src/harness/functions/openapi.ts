import YAML from "yaml";
import { Validator } from "@cfworker/json-schema";

import type { FlaryOpenApiRuntime, FlaryOpenApiSource } from "./types.js";

export interface FlaryOpenApiRuntimeOptions {
  readonly fetch?: typeof fetch;
  readonly baseUrl?: string;
  readonly headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
  readonly timeoutMs?: number;
  readonly maxSpecBytes?: number;
  readonly maxResponseBytes?: number;
  readonly maxRedirects?: number;
}

export class FlaryOpenApiSecurityError extends Error {
  readonly code = "openapi_security_error" as const;
}

export class FlaryOpenApiValidationError extends Error {
  readonly code = "openapi_validation_error" as const;
}

interface CachedOpenApiSpec {
  readonly etag?: string;
  readonly spec: Record<string, unknown>;
}

const remoteSpecCache = new Map<string, CachedOpenApiSpec>();

/** Conservative default policy for an OpenAPI operation. */
export function inferOpenApiOperationPolicy(method: string): {
  readonly operation: "read" | "write";
  readonly requiresApproval: boolean;
} {
  const normalized = method.toUpperCase();
  if (normalized === "GET" || normalized === "HEAD" || normalized === "OPTIONS") {
    return { operation: "read", requiresApproval: false };
  }
  return { operation: "write", requiresApproval: true };
}

/** Load and parse an OpenAPI 3 JSON or YAML document with size and URL limits. */
export async function loadOpenApiSpec(
  spec: string | Record<string, unknown>,
  options: Pick<FlaryOpenApiRuntimeOptions, "fetch" | "maxSpecBytes" | "maxRedirects"> = {},
): Promise<Record<string, unknown>> {
  const maxBytes = options.maxSpecBytes ?? 2 * 1024 * 1024;
  let parsed: unknown = spec;
  if (typeof spec !== "string") {
    try {
      if (new TextEncoder().encode(JSON.stringify(spec)).byteLength > maxBytes) {
        throw new FlaryOpenApiSecurityError("The OpenAPI specification is too large");
      }
    } catch (error) {
      if (error instanceof FlaryOpenApiSecurityError) throw error;
      throw new FlaryOpenApiSecurityError("The OpenAPI specification is not serializable");
    }
  }
  if (typeof spec === "string") {
    let text: string;
    if (/^https:\/\//i.test(spec)) {
      const url = new URL(spec);
      assertSafeUrl(url);
      const cached = remoteSpecCache.get(url.toString());
      const response = await fetchBounded(options.fetch ?? globalThis.fetch, url, {
        maxBytes,
        maxRedirects: options.maxRedirects ?? 3,
        headers: cached?.etag ? { "if-none-match": cached.etag } : undefined,
      });
      if (response.status === 304 && cached) return cached.spec;
      if (!response.ok) {
        throw new FlaryOpenApiSecurityError(
          `OpenAPI specification request failed (${response.status})`,
        );
      }
      text = await readBounded(response, maxBytes);
      const parsedRemote = parseSpecText(text);
      const remote = assertOpenApiDocument(parsedRemote);
      remoteSpecCache.set(url.toString(), {
        spec: remote,
        ...(response.headers.get("etag") ? { etag: response.headers.get("etag")! } : {}),
      });
      return remote;
    } else {
      // Local specs are useful in Vite and local development. Production
      // Workers should bundle an object or use an HTTPS URL.
      try {
        const fs = await import("node:fs/promises");
        text = await fs.readFile(spec, "utf8");
        if (new TextEncoder().encode(text).byteLength > maxBytes) {
          throw new FlaryOpenApiSecurityError("The OpenAPI specification is too large");
        }
      } catch (error) {
        if (error instanceof FlaryOpenApiSecurityError) throw error;
        throw new FlaryOpenApiSecurityError(`OpenAPI specification could not be loaded: ${spec}`);
      }
    }
    parsed = parseSpecText(text);
  }
  return assertOpenApiDocument(parsed);
}

/** Create an authenticated OpenAPI host runtime for the Codemode connector. */
export async function createOpenApiRuntime(
  source: FlaryOpenApiSource,
  options: FlaryOpenApiRuntimeOptions = {},
): Promise<FlaryOpenApiRuntime> {
  const spec = await loadOpenApiSpec(source.spec, options);
  const revision = await openApiRevision(spec);
  const baseUrl = options.baseUrl ?? source.baseUrl ?? inferServerUrl(spec);
  if (!baseUrl) {
    throw new FlaryOpenApiSecurityError(
      `OpenAPI source '${source.namespace}' has no base URL. Set baseUrl or define servers[0].url.`,
    );
  }
  const base = new URL(baseUrl);
  assertSafeUrl(base);
  const request: FlaryOpenApiRuntime["request"] = async (input) => {
    const operation = findOperation(spec, input.path, input.method ?? "GET");
    validateRequest(operation, spec, input);
    const resolvedPath = resolveRequestPath(operation, input.path, input.params);
    const url = new URL(resolvedPath, base);
    if (input.params) {
      for (const [key, value] of Object.entries(input.params)) {
        if (value === undefined || value === null) continue;
        if (operation && pathParameterNames(spec, operation).has(key)) continue;
        if (Array.isArray(value)) {
          for (const item of value) url.searchParams.append(key, String(item));
        } else {
          url.searchParams.set(key, String(value));
        }
      }
    }
    assertSafeUrl(url);
    const headers = new Headers(
      typeof options.headers === "function" ? await options.headers() : options.headers,
    );
    for (const [name, value] of Object.entries(input.headers ?? {})) {
      if (isUnsafeRequestHeader(name)) {
        throw new FlaryOpenApiSecurityError(`The OpenAPI header '${name}' is not allowed`);
      }
      headers.set(name, value);
    }
    headers.set("accept", "application/json");
    let body: string | undefined;
    if (input.body !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(input.body);
    }
    const response = await fetchBounded(options.fetch ?? globalThis.fetch, url, {
      method: input.method ?? "GET",
      headers,
      body,
      signal: timeoutSignal(options.timeoutMs ?? 30_000),
      maxBytes: options.maxResponseBytes ?? 2 * 1024 * 1024,
      maxRedirects: options.maxRedirects ?? 3,
    });
    const text = await readBounded(response, options.maxResponseBytes ?? 2 * 1024 * 1024);
    if (!text.trim()) {
      validateResponse(operation, spec, response.status, undefined);
      if (!response.ok) throw new Error(`OpenAPI request failed (${response.status})`);
      return undefined;
    }
    const contentType = response.headers.get("content-type") ?? "";
    const responseSchema = responseSchemaFor(spec, operation, response.status);
    if (contentType.includes("json") || responseSchema) {
      let value: unknown;
      try {
        value = JSON.parse(text) as unknown;
      } catch {
        if (responseSchema) {
          throw new FlaryOpenApiValidationError(
            `OpenAPI ${operation?.method.toUpperCase() ?? "REQUEST"} response was not valid JSON`,
          );
        }
        value = text;
      }
      validateResponse(operation, spec, response.status, value);
      if (!response.ok) throw new Error(`OpenAPI request failed (${response.status})`);
      return value;
    }
    try {
      const value = JSON.parse(text) as unknown;
      validateResponse(operation, spec, response.status, value);
      if (!response.ok) throw new Error(`OpenAPI request failed (${response.status})`);
      return value;
    } catch {
      if (!response.ok) throw new Error(`OpenAPI request failed (${response.status})`);
      return text;
    }
  };
  return { spec, revision, request };
}

export async function openApiRevision(spec: Record<string, unknown>): Promise<string> {
  const bytes = new TextEncoder().encode(stableJson(spec));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function inferServerUrl(spec: Record<string, unknown>): string | undefined {
  const servers = Array.isArray(spec.servers) ? spec.servers : [];
  const first = servers[0];
  return isRecord(first) && typeof first.url === "string" ? first.url : undefined;
}

function assertSafeUrl(url: URL): void {
  if (url.protocol !== "https:") {
    throw new FlaryOpenApiSecurityError("OpenAPI URLs must use HTTPS");
  }
  if (url.username || url.password) {
    throw new FlaryOpenApiSecurityError("OpenAPI URLs cannot contain user information");
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname === "::1" ||
    hostname === "0.0.0.0" ||
    hostname === "metadata.google.internal" ||
    /^127\.|^10\.|^192\.168\./.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
    /^(100\.64\.|169\.254\.)/.test(hostname) ||
    hostname.startsWith("169.254.") ||
    /^(fc|fd)[0-9a-f]{2}:/i.test(hostname) ||
    /^fe[89ab][0-9a-f]:/i.test(hostname) ||
    /^::ffff:(?:0:)?(?:127\.|10\.|192\.168\.|169\.254\.)/i.test(hostname)
  ) {
    throw new FlaryOpenApiSecurityError("OpenAPI URLs cannot target private networks");
  }
}

async function fetchBounded(
  fetchImpl: typeof fetch,
  url: URL,
  init: RequestInit & { maxBytes: number; maxRedirects: number },
): Promise<Response> {
  let current = new URL(url);
  for (let redirect = 0; redirect <= init.maxRedirects; redirect += 1) {
    const { maxBytes: _maxBytes, maxRedirects: _maxRedirects, ...requestInit } = init;
    const response = await fetchImpl(current, {
      ...requestInit,
      redirect: "manual",
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location || redirect === init.maxRedirects) {
      throw new FlaryOpenApiSecurityError("OpenAPI redirect limit exceeded");
    }
    const next = new URL(location, current);
    assertSafeUrl(next);
    if (next.origin !== current.origin) {
      throw new FlaryOpenApiSecurityError("OpenAPI redirects must stay on the same HTTPS origin");
    }
    current = next;
  }
  throw new FlaryOpenApiSecurityError("OpenAPI redirect limit exceeded");
}

function parseSpecText(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return YAML.parse(text) as unknown;
  }
}

function assertOpenApiDocument(value: unknown): Record<string, unknown> {
  if (
    !isRecord(value) ||
    typeof value.openapi !== "string" ||
    !/^3\.(0|1)(?:\.\d+)?$/.test(value.openapi)
  ) {
    throw new FlaryOpenApiSecurityError("Only OpenAPI 3.0 and 3.1 documents are supported");
  }
  if (
    !isRecord(value.info) ||
    typeof value.info.title !== "string" ||
    typeof value.info.version !== "string" ||
    (value.paths !== undefined && !isRecord(value.paths))
  ) {
    throw new FlaryOpenApiSecurityError(
      "The OpenAPI document must include info.title, info.version, and an object paths value",
    );
  }
  assertSafeReferences(value);
  return value;
}

interface OpenApiOperation {
  readonly path: string;
  readonly method: string;
  readonly value: Record<string, unknown>;
  readonly pathParams: Readonly<Record<string, string>>;
}

function findOperation(
  spec: Record<string, unknown>,
  requestPath: string,
  method: string,
): OpenApiOperation | undefined {
  const paths = isRecord(spec.paths) ? spec.paths : {};
  const normalizedMethod = method.toLowerCase();
  for (const [path, pathItem] of Object.entries(paths)) {
    if (!isRecord(pathItem)) continue;
    const operation = pathItem[normalizedMethod];
    if (!isRecord(operation)) continue;
    if (path === requestPath || templateMatches(path, requestPath)) {
      return {
        path,
        method: normalizedMethod,
        value: operation,
        pathParams: pathParametersFor(path, requestPath),
      };
    }
  }
  return undefined;
}

function templateMatches(template: string, actual: string): boolean {
  const pattern = template
    .split("/")
    .map((part) => (part.startsWith("{") && part.endsWith("}") ? "[^/]+" : escapeRegExp(part)))
    .join("/");
  return new RegExp(`^${pattern}$`).test(actual);
}

function validateRequest(
  operation: OpenApiOperation | undefined,
  spec: Record<string, unknown>,
  input: {
    readonly path: string;
    readonly params?: Record<string, unknown>;
    readonly body?: unknown;
  },
): void {
  if (!operation && isRecord(spec.paths) && Object.keys(spec.paths).length > 0) {
    throw new FlaryOpenApiValidationError(
      `OpenAPI operation is not declared for ${String(input.path)}`,
    );
  }
  if (!operation) return;
  const schema = requestSchema(spec, operation);
  if (!schema) return;
  const value = {
    ...operation.pathParams,
    ...input.params,
    ...(input.body === undefined ? {} : { body: input.body }),
  };
  const result = new Validator(
    schema,
    spec.openapi?.toString().startsWith("3.1") ? "2020-12" : "7",
    false,
  ).validate(value);
  if (!result.valid) {
    throw new FlaryOpenApiValidationError(
      `OpenAPI ${operation.method.toUpperCase()} ${
        operation.path
      } request failed schema validation`,
    );
  }
}

function validateResponse(
  operation: OpenApiOperation | undefined,
  spec: Record<string, unknown>,
  status: number,
  value: unknown,
): void {
  if (!operation) return;
  const responses = isRecord(operation.value.responses) ? operation.value.responses : {};
  const response = responseForStatus(responses, status);
  if (!response) return;
  const resolvedResponse = resolveDocumentObject(spec, response);
  const content = isRecord(resolvedResponse.content) ? resolvedResponse.content : {};
  const jsonContent = selectJsonMedia(content);
  const schema =
    isRecord(jsonContent) &&
    (isRecord(jsonContent.schema) || typeof jsonContent.schema === "boolean")
      ? resolveSchema(spec, jsonContent.schema)
      : undefined;
  if (!schema) return;
  const result = new Validator(
    schema,
    spec.openapi?.toString().startsWith("3.1") ? "2020-12" : "7",
    false,
  ).validate(value);
  if (!result.valid) {
    throw new FlaryOpenApiValidationError(
      `OpenAPI ${operation.method.toUpperCase()} ${
        operation.path
      } response failed schema validation`,
    );
  }
}

function responseSchemaFor(
  spec: Record<string, unknown>,
  operation: OpenApiOperation | undefined,
  status: number,
): Record<string, unknown> | boolean | undefined {
  if (!operation) return undefined;
  const responses = isRecord(operation.value.responses) ? operation.value.responses : {};
  const response = responseForStatus(responses, status);
  if (!response) return undefined;
  const resolvedResponse = resolveDocumentObject(spec, response);
  const content = isRecord(resolvedResponse.content) ? resolvedResponse.content : {};
  const media = selectJsonMedia(content);
  if (!isRecord(media) || (!isRecord(media.schema) && typeof media.schema !== "boolean")) {
    return undefined;
  }
  return resolveSchema(spec, media.schema);
}

function requestSchema(
  spec: Record<string, unknown>,
  operation: OpenApiOperation,
): Record<string, unknown> | undefined {
  const pathItem = isRecord(spec.paths) ? spec.paths[operation.path] : undefined;
  const pathParameters =
    isRecord(pathItem) && Array.isArray(pathItem.parameters) ? pathItem.parameters : [];
  const parameters = [
    ...pathParameters,
    ...(Array.isArray(operation.value.parameters) ? operation.value.parameters : []),
  ].filter(isRecord);
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const parameter of parameters) {
    const resolvedParameter = resolveDocumentObject(spec, parameter);
    if (typeof resolvedParameter.name !== "string") continue;
    const parameterSchema =
      isRecord(resolvedParameter.schema) || typeof resolvedParameter.schema === "boolean"
        ? resolveSchema(spec, resolvedParameter.schema)
        : { type: "string" };
    properties[resolvedParameter.name] = parameterSchema;
    if (resolvedParameter.required === true) required.push(resolvedParameter.name);
  }
  const bodySchema = requestBodySchema(spec, operation.value);
  if (bodySchema) properties.body = bodySchema;
  const requestBody = resolveDocumentObject(
    spec,
    isRecord(operation.value.requestBody) ? operation.value.requestBody : {},
  );
  if (requestBody.required === true && bodySchema) required.push("body");
  if (Object.keys(properties).length === 0) return undefined;
  return {
    type: "object",
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: true,
  };
}

function requestBodySchema(
  spec: Record<string, unknown>,
  operation: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const body = isRecord(operation.requestBody)
    ? resolveDocumentObject(spec, operation.requestBody)
    : undefined;
  const content = body && isRecord(body.content) ? body.content : undefined;
  const json = content ? selectJsonMedia(content) : undefined;
  if (!isRecord(json) || (!isRecord(json.schema) && typeof json.schema !== "boolean"))
    return undefined;
  const resolved = resolveSchema(spec, json.schema);
  return isRecord(resolved) ? resolved : undefined;
}

function selectJsonMedia(content: Record<string, unknown>): unknown {
  return Object.entries(content).find(([type]) => {
    const normalized = type.toLowerCase();
    return (
      normalized === "application/json" || normalized.endsWith("+json") || normalized === "*/*"
    );
  })?.[1];
}

function responseForStatus(
  responses: Record<string, unknown>,
  status: number,
): Record<string, unknown> | undefined {
  const exact = responses[String(status)];
  if (isRecord(exact)) return exact;
  const range =
    responses[`${Math.floor(status / 100)}XX`] ?? responses[`${Math.floor(status / 100)}xx`];
  if (isRecord(range)) return range;
  return isRecord(responses.default) ? responses.default : undefined;
}

function pathParameterNames(
  spec: Record<string, unknown>,
  operation: OpenApiOperation,
): ReadonlySet<string> {
  const pathItem = isRecord(spec.paths) ? spec.paths[operation.path] : undefined;
  const values = [
    ...(isRecord(pathItem) && Array.isArray(pathItem.parameters) ? pathItem.parameters : []),
    ...(Array.isArray(operation.value.parameters) ? operation.value.parameters : []),
  ];
  return new Set(
    values
      .filter(isRecord)
      .map((value) => resolveDocumentObject(spec, value))
      .filter((value) => value.in === "path" && typeof value.name === "string")
      .map((value) => value.name as string),
  );
}

function resolveSchema(
  spec: Record<string, unknown>,
  schema: Record<string, unknown> | boolean,
  seen = new Set<string>(),
): Record<string, unknown> | boolean {
  if (typeof schema === "boolean") return schema;
  if (typeof schema.$ref !== "string") {
    return Object.fromEntries(
      Object.entries(schema).map(([key, value]) => {
        if (key === "properties" && isRecord(value)) {
          return [
            key,
            Object.fromEntries(
              Object.entries(value).map(([name, child]) => [
                name,
                isRecord(child) || typeof child === "boolean"
                  ? resolveSchema(spec, child, seen)
                  : child,
              ]),
            ),
          ];
        }
        if (key === "items" && (isRecord(value) || typeof value === "boolean")) {
          return [key, resolveSchema(spec, value, seen)];
        }
        if (key === "additionalProperties" && (isRecord(value) || typeof value === "boolean")) {
          return [key, resolveSchema(spec, value, seen)];
        }
        if (["allOf", "oneOf", "anyOf", "prefixItems"].includes(key) && Array.isArray(value)) {
          return [
            key,
            value.map((child) =>
              isRecord(child) || typeof child === "boolean"
                ? resolveSchema(spec, child, seen)
                : child,
            ),
          ];
        }
        return [key, value];
      }),
    );
  }
  const ref = schema.$ref;
  if (!ref.startsWith("#/") || seen.has(ref)) return {};
  const target = ref
    .slice(2)
    .split("/")
    .reduce<unknown>(
      (current, part) =>
        isRecord(current) ? current[part.replace(/~1/g, "/").replace(/~0/g, "~")] : undefined,
      spec,
    );
  if (!isRecord(target)) return {};
  const nextSeen = new Set(seen).add(ref);
  const resolved = resolveSchema(spec, target, nextSeen);
  return isRecord(resolved)
    ? {
        ...resolved,
        ...Object.fromEntries(Object.entries(schema).filter(([key]) => key !== "$ref")),
      }
    : resolved;
}

function resolveDocumentObject(
  spec: Record<string, unknown>,
  value: Record<string, unknown>,
  seen = new Set<string>(),
): Record<string, unknown> {
  if (typeof value.$ref !== "string") return value;
  const ref = value.$ref;
  if (!ref.startsWith("#/") || seen.has(ref)) return {};
  const target = ref
    .slice(2)
    .split("/")
    .reduce<unknown>(
      (current, part) =>
        isRecord(current) ? current[part.replace(/~1/g, "/").replace(/~0/g, "~")] : undefined,
      spec,
    );
  if (!isRecord(target)) return {};
  return {
    ...resolveDocumentObject(spec, target, new Set(seen).add(ref)),
    ...Object.fromEntries(Object.entries(value).filter(([key]) => key !== "$ref")),
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isUnsafeRequestHeader(name: string): boolean {
  return [
    "authorization",
    "cookie",
    "host",
    "content-length",
    "connection",
    "transfer-encoding",
  ].includes(name.toLowerCase());
}

async function readBounded(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      size += value.byteLength;
      if (size > maxBytes) throw new FlaryOpenApiSecurityError("OpenAPI response is too large");
      chunks.push(value);
    }
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(result);
}

function pathParametersFor(template: string, actual: string): Readonly<Record<string, string>> {
  const templateParts = template.split("/");
  const actualParts = actual.split("/");
  const values: Record<string, string> = {};
  for (let index = 0; index < templateParts.length; index += 1) {
    const match = /^\{([^{}]+)\}$/.exec(templateParts[index] ?? "");
    if (match && actualParts[index] !== undefined) {
      values[match[1]!] = decodeURIComponent(actualParts[index]!);
    }
  }
  return values;
}

function resolveRequestPath(
  operation: OpenApiOperation | undefined,
  inputPath: string,
  params: Record<string, unknown> | undefined,
): string {
  if (!operation) return inputPath;
  let resolved = inputPath;
  for (const [name, value] of Object.entries(params ?? {})) {
    if (value === undefined || value === null) continue;
    resolved = resolved.replace(`{${name}}`, encodeURIComponent(String(value)));
  }
  if (resolved === operation.path) {
    for (const name of Object.keys(operation.pathParams)) {
      const value = params?.[name];
      if (value !== undefined && value !== null) {
        resolved = resolved.replace(`{${name}}`, encodeURIComponent(String(value)));
      }
    }
  }
  return resolved;
}

function timeoutSignal(timeoutMs: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort("OpenAPI request timed out"), timeoutMs);
  return controller.signal;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertSafeReferences(value: unknown, depth = 0): void {
  if (depth > 64) {
    throw new FlaryOpenApiSecurityError("The OpenAPI document is too deeply nested");
  }
  if (Array.isArray(value)) {
    for (const item of value) assertSafeReferences(item, depth + 1);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (key === "$ref" && typeof item === "string" && !item.startsWith("#/")) {
      throw new FlaryOpenApiSecurityError("External OpenAPI references are not allowed");
    }
    assertSafeReferences(item, depth + 1);
  }
}

function stableJson(value: unknown): string {
  return (
    JSON.stringify(value, (_key, item: unknown) =>
      isRecord(item)
        ? Object.fromEntries(
            Object.entries(item).sort(([left], [right]) => left.localeCompare(right)),
          )
        : item,
    ) ?? "undefined"
  );
}

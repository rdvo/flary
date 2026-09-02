import { Validator, type Schema as JsonSchema } from "@cfworker/json-schema";
import type { ToolDefinition } from "@flue/runtime";
import { z } from "zod";

import {
  IdentifierSchema,
  JsonObjectSchema,
  StorageIdentifierSchema,
  TenantContextSchema,
  ToolLifecycleEventSchema,
  type AgentMode,
  type TenantContext,
  type TenantContextInput,
  type ToolLifecycleEvent,
  type ToolOperation,
} from "../contracts/index.js";
import type { ToolExecutionJournal } from "../execution/tool-journal.js";
import type { ExecutionLimitsInput } from "../execution/types.js";
import { createFlueLazyTools } from "../flue/tools.js";
import {
  InMemoryToolCatalog,
  type ToolCatalog,
  type ToolCatalogRegistration,
} from "../tools/catalog.js";
import { LazyToolRuntime, type LazyToolRuntimeOptions } from "../tools/runtime.js";
import type { FlaryToolset } from "../tools/sdk.js";
import {
  McpCredentialSchema,
  McpEndpointSchema,
  McpSecurityError,
  McpToolCache,
  McpToolDescriptorSchema,
  type McpClientOptions,
  type McpCredential,
  type McpCredentialProvider,
  type McpEndpoint,
  type McpToolDescriptor,
} from "./client.js";

export const ScopedMcpEndpointSchema = McpEndpointSchema.extend({
  organizationId: StorageIdentifierSchema,
  appId: StorageIdentifierSchema,
  credentialVersion: StorageIdentifierSchema.optional(),
}).strict();
export type ScopedMcpEndpoint = z.infer<typeof ScopedMcpEndpointSchema>;
export type ScopedMcpEndpointInput = z.input<typeof ScopedMcpEndpointSchema>;

export const McpToolGrantSchema = z
  .object({
    operation: z.enum(["read", "write"]),
    capabilities: z.array(IdentifierSchema).max(64).default([]),
    requiresApproval: z.boolean().optional(),
  })
  .strict();
export type McpToolGrant = z.infer<typeof McpToolGrantSchema>;
export type McpToolGrantInput = z.input<typeof McpToolGrantSchema>;

export interface McpCredentialRequest {
  readonly scope: TenantContext;
  readonly endpoint: ScopedMcpEndpoint;
}

export interface McpToolPermissionRequest extends McpCredentialRequest {
  readonly tool: McpToolDescriptor;
}

export type ScopedMcpCredentialResolver =
  | ((
      request: McpCredentialRequest,
    ) => McpCredential | undefined | Promise<McpCredential | undefined>)
  | {
      get(
        request: McpCredentialRequest,
      ): McpCredential | undefined | Promise<McpCredential | undefined>;
    };

export type McpToolPermissionResolver =
  | ((
      request: McpToolPermissionRequest,
    ) => McpToolGrantInput | false | undefined | Promise<McpToolGrantInput | false | undefined>)
  | {
      resolve(
        request: McpToolPermissionRequest,
      ): McpToolGrantInput | false | undefined | Promise<McpToolGrantInput | false | undefined>;
    };

export interface McpDescriptorCache {
  get(request: {
    scope: TenantContext;
    endpoint: ScopedMcpEndpoint;
  }): Promise<readonly McpToolDescriptor[] | undefined>;
  put(request: {
    scope: TenantContext;
    endpoint: ScopedMcpEndpoint;
    tools: readonly McpToolDescriptor[];
  }): Promise<void>;
}

export interface CreateMcpToolsetOptions {
  readonly scope: TenantContextInput;
  readonly endpoints: readonly ScopedMcpEndpointInput[];
  readonly credentials: ScopedMcpCredentialResolver;
  readonly permissions: McpToolPermissionResolver;
  readonly descriptorCache?: McpDescriptorCache;
  readonly clientOptions?: McpClientOptions;
  readonly cache?: McpToolCache;
  readonly onDiscoveryError?: (failure: {
    scope: TenantContext;
    endpoint: ScopedMcpEndpoint;
    error: {
      code: "mcp_discovery_failed";
      message: "MCP tool discovery failed";
    };
  }) => void | Promise<void>;
}

export interface CreateMcpToolsOptions extends CreateMcpToolsetOptions {
  readonly mode: AgentMode;
  readonly runId: string;
  readonly journal: ToolExecutionJournal;
  readonly limits?: ExecutionLimitsInput;
  readonly maxConcurrency?: number;
  readonly readParallelism?: number;
  readonly maxConcurrencyPerConnection?: number;
  readonly approve?: LazyToolRuntimeOptions["approve"];
  readonly onEvent?: (event: ToolLifecycleEvent) => void | Promise<void>;
}

export class McpTenantIsolationError extends Error {
  readonly code = "mcp_tenant_isolation_error" as const;

  constructor(message = "The MCP connection is outside the trusted tenant scope") {
    super(message);
    this.name = "McpTenantIsolationError";
  }
}

export class McpToolInputError extends Error {
  readonly code = "mcp_tool_input_invalid" as const;
  readonly safeToRetry = true;

  constructor() {
    super("The MCP tool arguments do not match its input schema");
    this.name = "McpToolInputError";
  }
}

export class McpToolExecutionError extends Error {
  readonly code = "mcp_tool_execution_failed" as const;

  constructor() {
    super("The MCP tool reported an execution error");
    this.name = "McpToolExecutionError";
  }
}

export class McpToolTransportError extends Error {
  readonly code = "mcp_tool_transport_failed" as const;

  constructor() {
    super("The MCP tool call failed");
    this.name = "McpToolTransportError";
  }
}

interface RegisteredMcpTool {
  readonly id: string;
  readonly registration: ToolCatalogRegistration;
}

const sharedMcpCache = new McpToolCache();

/**
 * Discover approved MCP descriptors and register them in a private Flary
 * catalog. Credentials stay inside trusted resolver closures.
 */
export async function createMcpToolset(options: CreateMcpToolsetOptions): Promise<FlaryToolset> {
  const scope = TenantContextSchema.parse(options.scope);
  const endpoints = options.endpoints.map((endpoint) => ScopedMcpEndpointSchema.parse(endpoint));
  assertUniqueConnections(endpoints);

  const cache =
    options.cache ??
    (options.clientOptions ? new McpToolCache(options.clientOptions) : sharedMcpCache);
  const tools: RegisteredMcpTool[] = [];

  for (const endpoint of endpoints) {
    assertEndpointScope(scope, endpoint);
    const namespace = mcpNamespace(scope, endpoint);
    const credentialProvider = scopedCredentialProvider(scope, endpoint, options.credentials);
    let descriptors: readonly McpToolDescriptor[];
    try {
      descriptors = await loadDescriptors({
        scope,
        endpoint,
        cache,
        namespace,
        credentials: credentialProvider,
        persistentCache: options.descriptorCache,
      });
    } catch {
      await options.onDiscoveryError?.({
        scope,
        endpoint,
        error: {
          code: "mcp_discovery_failed",
          message: "MCP tool discovery failed",
        },
      });
      continue;
    }

    for (const descriptor of descriptors) {
      const grant = await resolveGrant(options.permissions, {
        scope,
        endpoint,
        tool: descriptor,
      });
      if (!grant) continue;
      const toolId = await mcpToolId(scope, endpoint, descriptor);
      const connectionRef = await mcpConnectionReference(scope, endpoint);
      tools.push({
        id: toolId,
        registration: createRegistration({
          id: toolId,
          endpoint,
          descriptor,
          grant,
          namespace,
          connectionRef,
          cache,
          credentials: credentialProvider,
        }),
      });
    }
  }

  const ids = new Set<string>();
  for (const tool of tools) {
    if (ids.has(tool.id)) {
      throw new McpSecurityError("MCP tool IDs must be unique");
    }
    ids.add(tool.id);
  }

  return Object.freeze({
    tools: Object.freeze(
      tools.map((tool) =>
        Object.freeze({
          id: tool.id,
          register(catalog: ToolCatalog): void {
            catalog.register(tool.registration);
          },
        }),
      ),
    ),
    register(catalog: ToolCatalog): void {
      for (const tool of tools) catalog.register(tool.registration);
    },
  });
}

/**
 * Convert trusted MCP connections into Flue's small lazy tool surface.
 *
 * The durable journal is required. It prevents a state-changing MCP call from
 * running twice when its prior outcome is not known after recovery.
 */
export async function createMcpTools(options: CreateMcpToolsOptions): Promise<ToolDefinition[]> {
  const catalog = new InMemoryToolCatalog();
  const toolset = await createMcpToolset(options);
  toolset.register(catalog);
  if (toolset.tools.length === 0) return [];

  const concurrencyCaps = Object.fromEntries(
    options.endpoints.map((endpointInput) => {
      const endpoint = ScopedMcpEndpointSchema.parse(endpointInput);
      return [connectionConcurrencyKey(endpoint), options.maxConcurrencyPerConnection ?? 4];
    }),
  );
  const runtime = new LazyToolRuntime({
    catalog,
    mode: options.mode,
    runId: IdentifierSchema.parse(options.runId),
    toolJournal: options.journal,
    limits: options.limits,
    maxConcurrency: options.maxConcurrency ?? 8,
    readParallelism: options.readParallelism ?? 8,
    concurrencyCaps,
    approve: options.approve,
    onToolEvent: options.onEvent
      ? async (event) => {
          await options.onEvent?.(ToolLifecycleEventSchema.parse(event));
        }
      : undefined,
  });
  return createFlueLazyTools(runtime);
}

function createRegistration(input: {
  id: string;
  endpoint: ScopedMcpEndpoint;
  descriptor: McpToolDescriptor;
  grant: McpToolGrant;
  namespace: string;
  connectionRef: string;
  cache: McpToolCache;
  credentials: McpCredentialProvider;
}): ToolCatalogRegistration {
  const { id, endpoint, descriptor, grant, namespace, connectionRef, cache, credentials } = input;
  const validator = new Validator(descriptor.inputSchema as JsonSchema);
  const capabilities =
    grant.capabilities.length > 0
      ? grant.capabilities
      : [grant.operation === "read" ? "connection.mcp.read" : "connection.mcp.call"];
  const operation: ToolOperation = grant.operation;
  const resourceKey = `mcp:${endpoint.connectionId}`;

  return {
    definition: {
      id,
      name: descriptor.name,
      ...(descriptor.description ? { description: descriptor.description } : {}),
      kind: "mcp",
      inputSchema: JsonObjectSchema.parse(descriptor.inputSchema),
      operation,
      capabilities,
      tags: ["mcp", "connection", safeTag(endpoint.name)],
      requiresApproval: grant.requiresApproval ?? operation === "write",
      concurrencyKey: connectionConcurrencyKey(endpoint),
      metadata: {
        connectionRef,
        server: endpoint.name,
        ...(endpoint.credentialVersion ? { sourceRevision: endpoint.credentialVersion } : {}),
      },
    },
    resourceKey,
    async execute(raw): Promise<unknown> {
      const argumentsInput = JsonObjectSchema.parse(raw ?? {});
      const validation = validator.validate(argumentsInput);
      if (!validation.valid) throw new McpToolInputError();
      let result;
      try {
        result = await cache
          .client(mcpEndpoint(endpoint), namespace)
          .call(descriptor.name, argumentsInput, credentials);
      } catch {
        throw new McpToolTransportError();
      }
      if (result.isError) throw new McpToolExecutionError();
      return result.content;
    },
  };
}

async function loadDescriptors(input: {
  scope: TenantContext;
  endpoint: ScopedMcpEndpoint;
  cache: McpToolCache;
  namespace: string;
  credentials: McpCredentialProvider;
  persistentCache?: McpDescriptorCache;
}): Promise<readonly McpToolDescriptor[]> {
  const cached = await input.persistentCache?.get({
    scope: input.scope,
    endpoint: input.endpoint,
  });
  const valid = validateCachedDescriptors(input.endpoint, cached);
  if (valid.length > 0) return valid;

  const tools = await input.cache.discover(mcpEndpoint(input.endpoint), {
    namespace: input.namespace,
    credentials: input.credentials,
  });
  const parsed = validateDiscoveredDescriptors(input.endpoint, tools);
  await input.persistentCache?.put({
    scope: input.scope,
    endpoint: input.endpoint,
    tools: parsed,
  });
  return parsed;
}

function validateCachedDescriptors(
  endpoint: ScopedMcpEndpoint,
  values: readonly McpToolDescriptor[] | undefined,
): McpToolDescriptor[] {
  if (!values || values.length === 0) return [];
  const parsed = validateDiscoveredDescriptors(endpoint, values);
  return parsed.every((tool) => Date.parse(tool.expiresAt) > Date.now()) ? parsed : [];
}

function validateDiscoveredDescriptors(
  endpoint: ScopedMcpEndpoint,
  values: readonly McpToolDescriptor[],
): McpToolDescriptor[] {
  if (values.length > 256) {
    throw new McpSecurityError("MCP tool catalog exceeds the 256-tool limit");
  }
  return values.map((value) => {
    const tool = McpToolDescriptorSchema.parse(value);
    if (tool.connectionId !== endpoint.connectionId || tool.server !== endpoint.name) {
      throw new McpTenantIsolationError("An MCP descriptor does not match its trusted connection");
    }
    return tool;
  });
}

function scopedCredentialProvider(
  scope: TenantContext,
  endpoint: ScopedMcpEndpoint,
  resolver: ScopedMcpCredentialResolver,
): McpCredentialProvider {
  return {
    async get(connectionId): Promise<McpCredential | undefined> {
      if (connectionId !== endpoint.connectionId) {
        throw new McpTenantIsolationError();
      }
      assertEndpointScope(scope, endpoint);
      try {
        const value =
          typeof resolver === "function"
            ? await resolver({ scope, endpoint })
            : await resolver.get({ scope, endpoint });
        return value ? McpCredentialSchema.parse(value) : undefined;
      } catch (error) {
        if (error instanceof McpTenantIsolationError) throw error;
        throw new McpSecurityError("MCP credential resolution failed");
      }
    },
  };
}

async function resolveGrant(
  resolver: McpToolPermissionResolver,
  request: McpToolPermissionRequest,
): Promise<McpToolGrant | undefined> {
  const value =
    typeof resolver === "function" ? await resolver(request) : await resolver.resolve(request);
  return value === false || value === undefined ? undefined : McpToolGrantSchema.parse(value);
}

function assertEndpointScope(scope: TenantContext, endpoint: ScopedMcpEndpoint): void {
  if (endpoint.organizationId !== scope.organizationId || endpoint.appId !== scope.appId) {
    throw new McpTenantIsolationError();
  }
}

function assertUniqueConnections(endpoints: readonly ScopedMcpEndpoint[]): void {
  const ids = new Set<string>();
  for (const endpoint of endpoints) {
    if (ids.has(endpoint.connectionId)) {
      throw new McpSecurityError(`Duplicate MCP connection: ${endpoint.connectionId}`);
    }
    ids.add(endpoint.connectionId);
  }
}

async function mcpToolId(
  scope: TenantContext,
  endpoint: McpEndpoint,
  descriptor: McpToolDescriptor,
): Promise<string> {
  const value = [
    scope.organizationId,
    scope.appId,
    endpoint.connectionId,
    "credentialVersion" in endpoint ? (endpoint.credentialVersion ?? "current") : "current",
    descriptor.name,
  ].join("\u0000");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  const hash = [...new Uint8Array(digest)]
    .slice(0, 8)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const name = safeId(descriptor.name).slice(0, 96);
  return IdentifierSchema.parse(`mcp.${name}.${hash}`);
}

async function mcpConnectionReference(
  scope: TenantContext,
  endpoint: ScopedMcpEndpoint,
): Promise<string> {
  const value = [
    scope.organizationId,
    scope.appId,
    endpoint.connectionId,
    endpoint.credentialVersion ?? "current",
  ].join("\u0000");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .slice(0, 12)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function connectionConcurrencyKey(endpoint: McpEndpoint): string {
  return IdentifierSchema.parse(`mcp_${safeId(endpoint.connectionId)}`);
}

function mcpEndpoint(endpoint: ScopedMcpEndpoint): McpEndpoint {
  return McpEndpointSchema.parse({
    connectionId: endpoint.connectionId,
    name: endpoint.name,
    url: endpoint.url,
    transport: endpoint.transport,
  });
}

function mcpNamespace(scope: TenantContext, endpoint: ScopedMcpEndpoint): string {
  return [
    scope.organizationId,
    scope.appId,
    scope.userId ?? "service",
    endpoint.credentialVersion ?? "current",
  ].join(":");
}

function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:/-]+/g, "_");
}

function safeTag(value: string): string {
  const tag = safeId(value.toLowerCase()).slice(0, 80);
  return tag || "server";
}

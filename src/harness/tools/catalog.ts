import {
  ToolCatalogDefinitionSchema,
  ToolCatalogLoadRequestSchema,
  ToolCatalogLoadResponseSchema,
  ToolCatalogMatchFieldSchema,
  ToolCatalogSearchRequestSchema,
  ToolCatalogSearchResponseSchema,
  ToolCatalogSearchResultSchema,
  ToolCapabilityDescriptorSchema,
  type ToolCatalogDefinition,
  type ToolCatalogDefinitionInput,
  type ToolCatalogLoadRequestInput,
  type ToolCatalogLoadResponse,
  type ToolCatalogSearchRequestInput,
  type ToolCatalogSearchResponse,
  type ToolCatalogSearchResult,
  type ToolCapabilityDescriptor,
} from "../contracts/tools";

export type ToolSecretValue = string | Uint8Array;

/**
 * Resolves a named secret for one invocation. The resolver is kept private to
 * the capability handle and is never part of a catalog response.
 */
export interface ToolSecretProvider {
  get(secretRef: string): Promise<ToolSecretValue | undefined>;
}

export interface ToolCapabilityContext {
  readonly tool: ToolCatalogDefinition;
  readonly capability: ToolCapabilityDescriptor;
  readonly secretRefs: readonly string[];
  /**
   * Runs a callback while a declared secret is available. The secret is not
   * returned from the handle, stored in the descriptor, or written to logs.
   */
  useSecret<T>(
    secretRef: string,
    callback: (value: ToolSecretValue) => T | PromiseLike<T>,
  ): Promise<T>;
}

export type ToolExecutor<TInput = unknown, TOutput = unknown> = (
  input: TInput,
  context: ToolCapabilityContext,
) => TOutput | PromiseLike<TOutput>;

export interface ToolCatalogRegistration<TInput = unknown, TOutput = unknown> {
  definition: ToolCatalogDefinitionInput;
  execute: ToolExecutor<TInput, TOutput>;
  capabilityId?: string;
}

export interface CapabilityHandle<TInput = unknown, TOutput = unknown> {
  readonly descriptor: ToolCapabilityDescriptor;
  invoke(input: TInput): Promise<TOutput>;
  /** Returns the redacted descriptor, never the executor or secret provider. */
  toJSON(): ToolCapabilityDescriptor;
}

export interface ToolCatalog {
  register<TInput = unknown, TOutput = unknown>(
    registration: ToolCatalogRegistration<TInput, TOutput>,
  ): ToolCapabilityDescriptor;
  unregister(toolId: string): boolean;
  search(
    request?: ToolCatalogSearchRequestInput,
  ): Promise<ToolCatalogSearchResponse>;
  load(
    request: ToolCatalogLoadRequestInput,
  ): Promise<ToolCatalogLoadResponse | undefined>;
  loadHandle<TInput = unknown, TOutput = unknown>(
    request: ToolCatalogLoadRequestInput,
  ): Promise<CapabilityHandle<TInput, TOutput> | undefined>;
}

export interface InMemoryToolCatalogOptions {
  secretProvider?: ToolSecretProvider;
}

export class ToolCatalogError extends Error {
  readonly code:
    | "tool_already_registered"
    | "tool_not_found"
    | "capability_not_found"
    | "secret_not_declared"
    | "secret_unavailable";

  constructor(
    code: ToolCatalogError["code"],
    message: string,
  ) {
    super(message);
    this.name = "ToolCatalogError";
    this.code = code;
  }
}

interface StoredTool {
  readonly definition: ToolCatalogDefinition;
  readonly capability: ToolCapabilityDescriptor;
  readonly execute: ToolExecutor;
}

function normalize(value: string): string {
  return value.toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

function tokenize(value: string): string[] {
  return normalize(value)
    .split(/[^a-z0-9_.:/-]+/i)
    .filter(Boolean);
}

function scoreField(field: string, query: string): number {
  const normalizedField = normalize(field);
  const normalizedQuery = normalize(query);
  if (!normalizedField || !normalizedQuery) return 0;
  if (normalizedField === normalizedQuery) return 1;
  if (normalizedField.includes(normalizedQuery)) return 0.9;

  const queryTokens = new Set(tokenize(normalizedQuery));
  const fieldTokens = new Set(tokenize(normalizedField));
  if (queryTokens.size === 0) return 0;
  let matches = 0;
  for (const token of queryTokens) {
    if (fieldTokens.has(token)) matches += 1;
  }
  return matches / queryTokens.size;
}

function scoreTool(
  definition: ToolCatalogDefinition,
  query: string | undefined,
): { score: number; matchedOn: string[] } {
  if (!query) return { score: 1, matchedOn: ["name"] };

  const fields: Array<[string, string, number]> = [
    ["id", definition.id, 1],
    ["name", definition.name, 1],
    ["description", definition.description ?? "", 0.8],
    ["kind", definition.kind, 0.6],
    ...definition.tags.map((tag) => ["tag", tag, 0.9] as [string, string, number]),
    ...definition.capabilities.map(
      (capability) => ["capability", capability, 0.9] as [string, string, number],
    ),
  ];

  let bestScore = 0;
  const matchedOn = new Set<string>();
  for (const [field, value, weight] of fields) {
    const fieldScore = scoreField(value, query);
    if (fieldScore > 0) {
      bestScore = Math.max(bestScore, fieldScore * weight);
      matchedOn.add(field);
    }
  }

  return {
    score: Math.min(1, bestScore),
    matchedOn: [...matchedOn].filter((field) =>
      ToolCatalogMatchFieldSchema.safeParse(field).success,
    ),
  };
}

function matchesFilters(
  definition: ToolCatalogDefinition,
  request: ReturnType<typeof ToolCatalogSearchRequestSchema.parse>,
): boolean {
  if (request.kinds.length > 0 && !request.kinds.includes(definition.kind)) {
    return false;
  }
  if (
    request.capabilities.some(
      (capability) => !definition.capabilities.includes(capability),
    )
  ) {
    return false;
  }
  if (request.tags.some((tag) => !definition.tags.includes(tag))) return false;
  return true;
}

function cloneBytes(value: ToolSecretValue): ToolSecretValue {
  return typeof value === "string" ? value : new Uint8Array(value);
}

function makeCapability(
  stored: StoredTool,
  secretProvider: ToolSecretProvider | undefined,
): CapabilityHandle {
  const descriptor = ToolCapabilityDescriptorSchema.parse(stored.capability);

  return {
    descriptor,
    async invoke(input: unknown): Promise<unknown> {
      const context: ToolCapabilityContext = {
        tool: stored.definition,
        capability: descriptor,
        secretRefs: descriptor.secretRefs,
        async useSecret<T>(
          secretRef: string,
          callback: (value: ToolSecretValue) => T | PromiseLike<T>,
        ): Promise<T> {
          if (!descriptor.secretRefs.includes(secretRef)) {
            throw new ToolCatalogError(
              "secret_not_declared",
              `Secret reference is not declared by tool ${descriptor.toolId}`,
            );
          }
          if (!secretProvider) {
            throw new ToolCatalogError(
              "secret_unavailable",
              `Secret reference ${secretRef} is not available`,
            );
          }
          const value = await secretProvider.get(secretRef);
          if (value === undefined) {
            throw new ToolCatalogError(
              "secret_unavailable",
              `Secret reference ${secretRef} is not available`,
            );
          }
          const callbackValue = cloneBytes(value);
          try {
            return await callback(callbackValue);
          } finally {
            if (callbackValue instanceof Uint8Array) callbackValue.fill(0);
          }
        },
      };
      return stored.execute(input, context);
    },
    toJSON(): ToolCapabilityDescriptor {
      return ToolCapabilityDescriptorSchema.parse(descriptor);
    },
  };
}

export class InMemoryToolCatalog implements ToolCatalog {
  readonly #tools = new Map<string, StoredTool>();
  readonly #capabilities = new Map<string, string>();
  readonly #secretProvider: ToolSecretProvider | undefined;

  constructor(options: InMemoryToolCatalogOptions = {}) {
    this.#secretProvider = options.secretProvider;
  }

  register<TInput = unknown, TOutput = unknown>(
    registration: ToolCatalogRegistration<TInput, TOutput>,
  ): ToolCapabilityDescriptor {
    const definition = ToolCatalogDefinitionSchema.parse(registration.definition);
    if (this.#tools.has(definition.id)) {
      throw new ToolCatalogError(
        "tool_already_registered",
        `Tool ${definition.id} is already registered`,
      );
    }

    const capabilityId = registration.capabilityId ?? `${definition.id}:invoke`;
    if (this.#capabilities.has(capabilityId)) {
      throw new ToolCatalogError(
        "tool_already_registered",
        `Capability ${capabilityId} is already registered`,
      );
    }

    const capability = ToolCapabilityDescriptorSchema.parse({
      id: capabilityId,
      toolId: definition.id,
      kind: definition.kind,
      capabilities: definition.capabilities,
      secretRefs: definition.secretRefs ?? [],
      requiresApproval: definition.requiresApproval ?? false,
    });
    const stored: StoredTool = {
      definition,
      capability,
      execute: registration.execute as ToolExecutor,
    };
    this.#tools.set(definition.id, stored);
    this.#capabilities.set(capability.id, definition.id);
    return ToolCapabilityDescriptorSchema.parse(capability);
  }

  unregister(toolId: string): boolean {
    const stored = this.#tools.get(toolId);
    if (!stored) return false;
    this.#tools.delete(toolId);
    this.#capabilities.delete(stored.capability.id);
    return true;
  }

  async search(
    requestInput: ToolCatalogSearchRequestInput = {},
  ): Promise<ToolCatalogSearchResponse> {
    const request = ToolCatalogSearchRequestSchema.parse(requestInput);
    const start = request.cursor ? Number(request.cursor) : 0;
    const ranked = [...this.#tools.values()]
      .filter((stored) => matchesFilters(stored.definition, request))
      .map((stored) => {
        const result = scoreTool(stored.definition, request.query);
        return { stored, ...result };
      })
      .filter(
        ({ score, matchedOn }) =>
          !request.query || (score > 0 && matchedOn.length > 0),
      )
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.stored.definition.name.localeCompare(right.stored.definition.name) ||
          left.stored.definition.id.localeCompare(right.stored.definition.id),
      );

    const page = ranked.slice(start, start + request.limit);
    const results: ToolCatalogSearchResult[] = page.map((item) =>
      ToolCatalogSearchResultSchema.parse({
        tool: item.stored.definition,
        score: item.score,
        matchedOn: item.matchedOn,
      }),
    );
    const nextCursor =
      start + request.limit < ranked.length
        ? String(start + request.limit)
        : undefined;
    return ToolCatalogSearchResponseSchema.parse({ results, nextCursor });
  }

  async load(
    requestInput: ToolCatalogLoadRequestInput,
  ): Promise<ToolCatalogLoadResponse | undefined> {
    const request = ToolCatalogLoadRequestSchema.parse(requestInput);
    const stored = this.#tools.get(request.id);
    if (!stored) return undefined;
    return ToolCatalogLoadResponseSchema.parse({
      tool: stored.definition,
      capability: stored.capability,
    });
  }

  async loadHandle<TInput = unknown, TOutput = unknown>(
    requestInput: ToolCatalogLoadRequestInput,
  ): Promise<CapabilityHandle<TInput, TOutput> | undefined> {
    const request = ToolCatalogLoadRequestSchema.parse(requestInput);
    const stored = this.#tools.get(request.id);
    return stored
      ? (makeCapability(stored, this.#secretProvider) as CapabilityHandle<
          TInput,
          TOutput
        >)
      : undefined;
  }
}

export function createInMemoryToolCatalog(
  options: InMemoryToolCatalogOptions = {},
): InMemoryToolCatalog {
  return new InMemoryToolCatalog(options);
}

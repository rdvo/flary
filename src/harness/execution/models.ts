import {
  modelDescriptorSchema,
  modelResolutionRequestSchema,
  type ModelDescriptor,
  type ModelDescriptorInput,
  type ModelResolutionRequest,
  type ResolvedModel,
} from "./types.js";

export class ModelResolutionError extends Error {
  readonly code = "MODEL_RESOLUTION_FAILED";

  constructor(message: string) {
    super(message);
    this.name = "ModelResolutionError";
  }
}

interface NormalizedModel {
  readonly descriptor: ModelDescriptor;
  readonly inputIndex: number;
}

function normalizeModel(
  input: ModelDescriptorInput,
  inputIndex: number
): NormalizedModel {
  const descriptor =
    typeof input === "string"
      ? modelDescriptorSchema.parse({
          id: input,
          aliases: [],
          capabilities: [],
          priority: 0,
        })
      : modelDescriptorSchema.parse({
          aliases: [],
          capabilities: [],
          priority: 0,
          ...input,
        });

  return { descriptor, inputIndex };
}

function compareModels(left: NormalizedModel, right: NormalizedModel): number {
  const priorityDifference =
    right.descriptor.priority - left.descriptor.priority;
  if (priorityDifference !== 0) {
    return priorityDifference;
  }

  const leftOrder = left.descriptor.order ?? Number.MAX_SAFE_INTEGER;
  const rightOrder = right.descriptor.order ?? Number.MAX_SAFE_INTEGER;
  if (leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }

  const idDifference = left.descriptor.id.localeCompare(right.descriptor.id);
  return idDifference === 0 ? left.inputIndex - right.inputIndex : idDifference;
}

function hasCapabilities(
  model: ModelDescriptor,
  requiredCapabilities: readonly string[]
): boolean {
  return requiredCapabilities.every((capability) =>
    model.capabilities.includes(capability)
  );
}

function isExcluded(model: ModelDescriptor, excluded: readonly string[]): boolean {
  return excluded.includes(model.id) || model.aliases.some((alias) => excluded.includes(alias));
}

function findByName(
  models: readonly NormalizedModel[],
  requested: string,
  requiredCapabilities: readonly string[],
  excluded: readonly string[]
): { model: NormalizedModel; matchedBy: "id" | "alias" } | undefined {
  const eligible = models
    .filter(({ descriptor }) => !isExcluded(descriptor, excluded))
    .filter(({ descriptor }) => hasCapabilities(descriptor, requiredCapabilities));
  const exact = eligible
    .filter(({ descriptor }) => descriptor.id === requested)
    .sort(compareModels)[0];

  if (exact) {
    return { model: exact, matchedBy: "id" };
  }

  const alias = eligible
    .filter(({ descriptor }) => descriptor.aliases.includes(requested))
    .sort(compareModels)[0];

  if (alias) {
    return { model: alias, matchedBy: "alias" };
  }

  return undefined;
}

function normalizeRequest(
  requestOrName:
    | string
    | readonly ModelDescriptorInput[]
    | (Omit<ModelResolutionRequest, "candidates"> & {
        candidates?: readonly ModelDescriptorInput[];
        models?: readonly ModelDescriptorInput[];
      })
    | undefined,
  candidates?: readonly ModelDescriptorInput[]
): ModelResolutionRequest {
  if (Array.isArray(requestOrName)) {
    return modelResolutionRequestSchema.parse({
      candidates: requestOrName,
    });
  }

  if (typeof requestOrName === "string" || requestOrName === undefined) {
    return modelResolutionRequestSchema.parse({
      requested: requestOrName,
      candidates: candidates ?? [],
    });
  }

  const request = requestOrName as Omit<ModelResolutionRequest, "candidates"> & {
    candidates?: readonly ModelDescriptorInput[];
    models?: readonly ModelDescriptorInput[];
  };
  return modelResolutionRequestSchema.parse({
    ...request,
    candidates: request.candidates ?? request.models ?? candidates ?? [],
  });
}

/**
 * Resolve a model with no network calls or random selection.
 *
 * An exact ID wins over an alias. Without a requested name, the resolver uses
 * priority, explicit order, and then the model ID as stable tie breakers.
 */
export function resolveModel(
  requestOrName:
    | string
    | readonly ModelDescriptorInput[]
    | (Omit<ModelResolutionRequest, "candidates"> & {
        candidates?: readonly ModelDescriptorInput[];
        models?: readonly ModelDescriptorInput[];
      })
    | undefined,
  candidates?: readonly ModelDescriptorInput[]
): ResolvedModel {
  const request = normalizeRequest(requestOrName, candidates);
  const models = request.candidates.map(normalizeModel);
  const names = models.map(({ descriptor }) => descriptor.id);
  if (new Set(names).size !== names.length) {
    throw new ModelResolutionError("Model IDs must be unique");
  }

  const requested = request.requested ?? request.model;
  const requiredCapabilities = request.capabilities;
  const excluded = request.exclude;

  if (requested) {
    const match = findByName(models, requested, requiredCapabilities, excluded);
    if (match) {
      return {
        ...match.model.descriptor,
        requested,
        matchedBy: match.matchedBy,
      };
    }

    if (request.fallback) {
      const fallback = findByName(
        models,
        request.fallback,
        requiredCapabilities,
        excluded
      );
      if (fallback) {
        return {
          ...fallback.model.descriptor,
          requested,
          matchedBy: "fallback",
        };
      }
    }

    throw new ModelResolutionError(
      `No eligible model matches '${requested}'`
    );
  }

  const best = models
    .filter(({ descriptor }) => !isExcluded(descriptor, excluded))
    .filter(({ descriptor }) => hasCapabilities(descriptor, requiredCapabilities))
    .sort(compareModels)[0];

  if (!best) {
    throw new ModelResolutionError("No eligible model is available");
  }

  return {
    ...best.descriptor,
    matchedBy: "priority",
  };
}

export class DeterministicModelResolver {
  readonly models: readonly ModelDescriptor[];

  constructor(models: readonly ModelDescriptorInput[]) {
    const parsed = models.map(normalizeModel).sort(compareModels);
    const ids = parsed.map(({ descriptor }) => descriptor.id);
    if (new Set(ids).size !== ids.length) {
      throw new ModelResolutionError("Model IDs must be unique");
    }
    this.models = parsed.map(({ descriptor }) => descriptor);
  }

  resolve(
    request?:
      | string
      | Omit<ModelResolutionRequest, "candidates">
      | (Omit<ModelResolutionRequest, "candidates"> & {
          models?: readonly ModelDescriptorInput[];
        })
  ): ResolvedModel {
    return resolveModel(request, this.models);
  }
}

export const ModelResolver = DeterministicModelResolver;

export function createModelResolver(
  models: readonly ModelDescriptorInput[]
): DeterministicModelResolver {
  return new DeterministicModelResolver(models);
}

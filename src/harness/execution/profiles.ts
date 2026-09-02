import {
  approvalPolicySchema,
  executionLimitsSchema,
  executionProfileInputSchema,
  type ExecutionLimits,
  type ExecutionProfile,
  type ExecutionProfileInput,
} from "./types.js";

function toProfile(input: ExecutionProfileInput | ExecutionProfile): ExecutionProfile {
  const parsed = executionProfileInputSchema.parse(input);
  const inlineLimits = executionLimitsSchema.parse({
    maxToolCalls: parsed.maxToolCalls,
    maxDurationMs: parsed.maxDurationMs,
    maxResultBytes: parsed.maxResultBytes,
    maxConcurrency: parsed.maxConcurrency,
    readParallelism: parsed.readParallelism,
    batchSize: parsed.batchSize,
  });
  const nestedLimits = executionLimitsSchema.parse(parsed.limits ?? {});
  const limits: ExecutionLimits = {};

  for (const name of [
    "maxToolCalls",
    "maxDurationMs",
    "maxResultBytes",
    "maxConcurrency",
    "readParallelism",
    "batchSize",
  ] as const) {
    const value = nestedLimits[name] ?? inlineLimits[name];
    if (value !== undefined) {
      limits[name] = value;
    }
  }

  return Object.freeze({
    name: parsed.name,
    model: parsed.model,
    limits: Object.freeze(limits),
    approval: Object.freeze(approvalPolicySchema.parse(parsed.approval ?? {})),
  });
}

export function defineExecutionProfile(
  input: ExecutionProfileInput | ExecutionProfile,
): ExecutionProfile {
  return toProfile(input);
}

export const createExecutionProfile = defineExecutionProfile;

export const DEFAULT_EXECUTION_PROFILES: Readonly<Record<string, ExecutionProfile>> = Object.freeze(
  {
    default: toProfile({
      name: "default",
      limits: {
        maxToolCalls: 64,
        maxConcurrency: 4,
        readParallelism: 4,
        batchSize: 8,
      },
    }),
    safe: toProfile({
      name: "safe",
      limits: {
        maxToolCalls: 32,
        maxConcurrency: 1,
        readParallelism: 1,
        batchSize: 1,
      },
      approval: { requireForWrites: true },
    }),
    balanced: toProfile({
      name: "balanced",
      limits: {
        maxToolCalls: 64,
        maxConcurrency: 4,
        readParallelism: 4,
        batchSize: 8,
      },
    }),
    fast: toProfile({
      name: "fast",
      limits: {
        maxToolCalls: 128,
        maxConcurrency: 8,
        readParallelism: 8,
        batchSize: 16,
      },
    }),
    strict: toProfile({
      name: "strict",
      limits: {
        maxToolCalls: 32,
        maxConcurrency: 2,
        readParallelism: 1,
        batchSize: 4,
      },
      approval: { requireForWrites: true },
    }),
  },
);

export const NAMED_EXECUTION_PROFILES = DEFAULT_EXECUTION_PROFILES;

export function resolveExecutionProfile(
  profile: string | ExecutionProfileInput | ExecutionProfile | undefined = "default",
  profiles: Readonly<
    Record<string, ExecutionProfileInput | ExecutionProfile>
  > = DEFAULT_EXECUTION_PROFILES,
): ExecutionProfile {
  if (typeof profile !== "string") {
    return toProfile(profile ?? { name: "default" });
  }

  const entry = profiles[profile];
  if (!entry) {
    throw new Error(`Unknown execution profile '${profile}'`);
  }

  const resolved = toProfile(entry);
  if (resolved.name !== profile && !profiles[resolved.name]) {
    return toProfile({ ...resolved, name: profile });
  }
  return resolved;
}

export const resolveProfile = resolveExecutionProfile;

export class ExecutionProfileRegistry {
  readonly #profiles = new Map<string, ExecutionProfile>();

  constructor(
    profiles: Readonly<
      Record<string, ExecutionProfileInput | ExecutionProfile>
    > = DEFAULT_EXECUTION_PROFILES,
  ) {
    for (const [name, profile] of Object.entries(profiles)) {
      const resolved = toProfile(profile);
      this.#profiles.set(name, resolved);
      if (!this.#profiles.has(resolved.name)) {
        this.#profiles.set(resolved.name, resolved);
      }
    }
  }

  define(profile: ExecutionProfileInput | ExecutionProfile): ExecutionProfile {
    const resolved = toProfile(profile);
    this.#profiles.set(resolved.name, resolved);
    return resolved;
  }

  get(name: string): ExecutionProfile | undefined {
    return this.#profiles.get(name);
  }

  resolve(profile: string | ExecutionProfileInput | ExecutionProfile): ExecutionProfile {
    if (typeof profile !== "string") {
      return this.define(profile);
    }
    const resolved = this.#profiles.get(profile);
    if (!resolved) {
      throw new Error(`Unknown execution profile '${profile}'`);
    }
    return resolved;
  }

  names(): readonly string[] {
    return [...this.#profiles.keys()].sort();
  }
}

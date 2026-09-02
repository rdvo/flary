import { z } from "zod";

import {
  ModelCapabilitySchema,
  ModelInputSchema,
  ModelSelectionSchema,
  normalizeModelInput,
  type ModelInput,
  type ModelSelection,
} from "../contracts/provider.js";
import type { ModelDescriptor } from "../execution/types.js";

export const RoutingStrategySchema = z.enum(["explicit", "quality", "balanced", "cost", "latency"]);
export type RoutingStrategy = z.infer<typeof RoutingStrategySchema>;

export const RoutingPolicySchema = z
  .object({
    strategy: RoutingStrategySchema.default("balanced"),
    allow: z.array(ModelInputSchema).min(1).max(128),
    optimizeFor: z.enum(["quality", "cost", "latency"]).optional(),
    maxCostUsd: z.number().finite().positive().optional(),
    maxLatencyMs: z.number().int().positive().optional(),
    capabilities: z.array(ModelCapabilitySchema).max(32).default([]),
    fallback: z.array(ModelInputSchema).max(16).default([]),
    /** State-changing operations must set this false for automatic fallback. */
    stateChanging: z.boolean().default(false),
  })
  .strict();
export type RoutingPolicy = z.input<typeof RoutingPolicySchema>;

export const ProviderRouteCandidateSchema = z
  .object({
    selection: ModelSelectionSchema,
    quality: z.number().finite().default(0),
    costUsd: z.number().finite().nonnegative().optional(),
    latencyMs: z.number().finite().nonnegative().optional(),
    healthy: z.boolean().default(true),
    capabilities: z.array(ModelCapabilitySchema).default([]),
    credentialReference: z.string().max(256).optional(),
  })
  .strict();
export type ProviderRouteCandidate = z.infer<typeof ProviderRouteCandidateSchema>;

export const RouteDecisionSchema = z
  .object({
    decisionId: z.string().min(1),
    operationId: z.string().min(1),
    selection: ModelSelectionSchema,
    candidates: z.array(
      z
        .object({
          selection: ModelSelectionSchema,
          score: z.number().finite(),
          eligible: z.boolean(),
          reason: z.string().max(1_000),
        })
        .strict(),
    ),
    strategy: RoutingStrategySchema,
    fallbackIndex: z.number().int().nonnegative().default(0),
    stateChanging: z.boolean(),
    decidedAt: z.string().datetime({ offset: true }),
    healthRevision: z.string().max(256).optional(),
  })
  .strict();
export type RouteDecision = z.infer<typeof RouteDecisionSchema>;

export interface RouteDecisionStore {
  get(operationId: string): Promise<RouteDecision | undefined>;
  put(decision: RouteDecision): Promise<void>;
}

export interface RoutingRequest {
  readonly operationId: string;
  readonly policy: RoutingPolicy;
  readonly candidates: readonly ProviderRouteCandidate[];
  readonly healthRevision?: string;
}

export class ModelRoutingError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ModelRoutingError";
    this.code = code;
  }
}

/**
 * Deterministic, credential-safe model routing. It never changes a decision
 * after it is persisted for the same operation ID.
 */
export class DeterministicModelRouter {
  readonly #store?: RouteDecisionStore;

  constructor(options: { readonly store?: RouteDecisionStore } = {}) {
    this.#store = options.store;
  }

  async decide(input: RoutingRequest): Promise<RouteDecision> {
    const existing = await this.#store?.get(input.operationId);
    if (existing) return RouteDecisionSchema.parse(existing);
    const policy: z.output<typeof RoutingPolicySchema> = RoutingPolicySchema.parse(input.policy);
    const candidates = input.candidates.map((candidate) =>
      ProviderRouteCandidateSchema.parse(candidate),
    );
    const allowed = uniqueModels(
      policy.allow.map((candidate) => normalizeModelInput(candidate as ModelInput)),
    );
    // Fallback models are an ordered retry chain. They must not participate in
    // the initial score: a high-scoring fallback is still a fallback.
    const fallback = uniqueModels(
      (policy.fallback ?? [])
        .map((candidate) => normalizeModelInput(candidate as ModelInput))
        .filter((candidate) => !allowed.some((item) => sameModel(item, candidate))),
    );
    const scored = [
      ...allowed.map((selection, index) =>
        scoreCandidate({
          selection,
          candidate: candidates.find((item) => sameModel(item.selection, selection)),
          policy,
          index,
          count: allowed.length,
        }),
      ),
      ...fallback.map((selection) => ({
        selection,
        score: -Number.MAX_SAFE_INTEGER,
        eligible: false,
        reason: "fallback_only",
      })),
    ];
    const eligible = scored.filter((candidate) => candidate.eligible);
    if (eligible.length === 0) {
      throw new ModelRoutingError("no_route", "No healthy model satisfies the routing policy");
    }
    eligible.sort((left, right) => {
      const difference = right.score - left.score;
      return difference !== 0
        ? difference
        : allowed.indexOf(left.selection) - allowed.indexOf(right.selection);
    });
    const selected = eligible[0]!;
    const decision = RouteDecisionSchema.parse({
      decisionId: `route_${hash(
        `${input.operationId}:${selected.selection.provider}/${selected.selection.model}`,
      )}`,
      operationId: input.operationId,
      selection: selected.selection,
      candidates: scored,
      strategy: policy.strategy,
      fallbackIndex: 0,
      stateChanging: policy.stateChanging,
      decidedAt: new Date().toISOString(),
      ...(input.healthRevision ? { healthRevision: input.healthRevision } : {}),
    });
    await this.#store?.put(decision);
    return decision;
  }

  /**
   * Run a provider operation with the persisted decision. Automatic fallback
   * is disabled after a state-changing operation or an unknown write result.
   */
  async execute<T>(
    input: RoutingRequest & {
      readonly run: (selection: ModelSelection) => Promise<T>;
      readonly isRetryable?: (error: unknown) => boolean;
      readonly outcomeUnknown?: boolean;
    },
  ): Promise<{ readonly value: T; readonly decision: RouteDecision }> {
    const decision = await this.decide(input);
    try {
      return { value: await input.run(decision.selection), decision };
    } catch (error) {
      if (
        input.policy.stateChanging ||
        input.outcomeUnknown ||
        input.isRetryable?.(error) !== true
      ) {
        throw error;
      }
      const fallbackCandidates = uniqueModels(
        (input.policy.fallback ?? []).map((candidate) =>
          normalizeModelInput(candidate as ModelInput),
        ),
      );
      let fallbackIndex = 0;
      for (const selection of fallbackCandidates) {
        fallbackIndex += 1;
        if (sameModel(selection, decision.selection)) continue;
        const candidate = input.candidates.find((item) => sameModel(item.selection, selection));
        if (!candidate?.healthy) continue;
        try {
          const value = await input.run(selection);
          // The provider that returned the value is the effective model for
          // telemetry and attribution. Do not return the original decision.
          const effectiveDecision = RouteDecisionSchema.parse({
            ...decision,
            selection,
            fallbackIndex,
            candidates: decision.candidates.map((item) =>
              sameModel(item.selection, selection)
                ? { ...item, eligible: true, reason: "fallback_selected" }
                : item,
            ),
          });
          // Persist the effective producer. Recovery and telemetry must not
          // report the failed primary after a fallback returned the value.
          await this.#store?.put(effectiveDecision);
          return {
            value,
            decision: effectiveDecision,
          };
        } catch {
          // Continue through the explicit chain. The original error is kept if
          // the chain cannot complete.
        }
      }
      throw error;
    }
  }
}

function scoreCandidate(input: {
  readonly selection: ModelSelection;
  readonly candidate: ProviderRouteCandidate | undefined;
  readonly policy: z.output<typeof RoutingPolicySchema>;
  readonly index: number;
  readonly count: number;
}): {
  readonly selection: ModelSelection;
  readonly score: number;
  readonly eligible: boolean;
  readonly reason: string;
} {
  const { selection, candidate, policy, index, count } = input;
  const reasons: string[] = [];
  let eligible = Boolean(candidate);
  if (!candidate) reasons.push("not_configured");
  if (candidate && !candidate.healthy) {
    eligible = false;
    reasons.push("unhealthy");
  }
  if (
    candidate &&
    policy.capabilities.some((capability) => !candidate.capabilities.includes(capability))
  ) {
    eligible = false;
    reasons.push("missing_capability");
  }
  if (
    candidate?.costUsd !== undefined &&
    policy.maxCostUsd !== undefined &&
    candidate.costUsd > policy.maxCostUsd
  ) {
    eligible = false;
    reasons.push("cost_limit");
  }
  if (
    candidate?.latencyMs !== undefined &&
    policy.maxLatencyMs !== undefined &&
    candidate.latencyMs > policy.maxLatencyMs
  ) {
    eligible = false;
    reasons.push("latency_limit");
  }
  return {
    selection,
    eligible,
    score:
      eligible && candidate ? score(policy, candidate, index, count) : -Number.MAX_SAFE_INTEGER,
    reason: reasons.length > 0 ? reasons.join(",") : "eligible",
  };
}

function uniqueModels(models: readonly ModelSelection[]): ModelSelection[] {
  return models.filter(
    (candidate, index) => models.findIndex((item) => sameModel(item, candidate)) === index,
  );
}

export class MemoryRouteDecisionStore implements RouteDecisionStore {
  readonly #values = new Map<string, RouteDecision>();

  async get(operationId: string): Promise<RouteDecision | undefined> {
    const value = this.#values.get(operationId);
    return value ? RouteDecisionSchema.parse(value) : undefined;
  }

  async put(decision: RouteDecision): Promise<void> {
    this.#values.set(decision.operationId, RouteDecisionSchema.parse(decision));
  }
}

/** Adapt the existing model descriptor catalog to route candidates. */
export function routeCandidatesFromDescriptors(
  descriptors: readonly (ModelDescriptor & {
    readonly costUsd?: number;
    readonly latencyMs?: number;
    readonly healthy?: boolean;
  })[],
  provider = "custom",
): ProviderRouteCandidate[] {
  return descriptors.map((descriptor) =>
    ProviderRouteCandidateSchema.parse({
      selection: normalizeModelInput(
        descriptor.id.includes("/") ? descriptor.id : `${provider}/${descriptor.id}`,
      ),
      quality: descriptor.priority,
      ...(descriptor.costUsd !== undefined ? { costUsd: descriptor.costUsd } : {}),
      ...(descriptor.latencyMs !== undefined ? { latencyMs: descriptor.latencyMs } : {}),
      healthy: descriptor.healthy ?? true,
      capabilities: descriptor.capabilities.flatMap((value) => {
        const parsed = ModelCapabilitySchema.safeParse(value);
        return parsed.success ? [parsed.data] : [];
      }),
    }),
  );
}

function score(
  policy: z.output<typeof RoutingPolicySchema>,
  candidate: ProviderRouteCandidate,
  index: number,
  count: number,
): number {
  const strategy = policy.optimizeFor ?? policy.strategy;
  if (strategy === "explicit") return -index;
  if (strategy === "quality") return candidate.quality * 1_000 - index;
  if (strategy === "cost")
    return candidate.costUsd === undefined ? 0 - index : -candidate.costUsd * 1_000 - index;
  if (strategy === "latency")
    return candidate.latencyMs === undefined ? 0 - index : -candidate.latencyMs - index;
  const quality = candidate.quality;
  const cost = candidate.costUsd === undefined ? 0 : -candidate.costUsd;
  const latency = candidate.latencyMs === undefined ? 0 : -candidate.latencyMs / 1_000;
  return quality + cost + latency + (count - index) / Math.max(1, count * 1_000);
}

function sameModel(left: ModelSelection, right: ModelSelection): boolean {
  return (
    left.provider === right.provider &&
    left.model === right.model &&
    left.deployment === right.deployment &&
    left.variant === right.variant
  );
}

function hash(value: string): string {
  let result = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    result = Math.imul(result ^ value.charCodeAt(index), 0x01000193) >>> 0;
  }
  return result.toString(16).padStart(8, "0");
}

import {
  defineAgent,
  type AgentDefinition,
  type AgentInitializerContext,
  type AgentRuntimeConfig,
  type ThinkingLevel,
  type ToolDefinition,
} from "@flue/runtime";
import { z } from "zod";

import {
  AgentModeIdSchema,
  IdentifierSchema,
  JsonObjectSchema,
  ModelSelectionSchema,
  ReasoningEffortSchema,
  ExecutionLimitsSchema,
  AgentModeSchema,
  type AgentMode,
} from "../contracts/index.js";
import { resolveAgentMode } from "../contracts/modes.js";
import { TrustedRunContextSchema, type TrustedRunContext } from "../host/runs.js";
import type {
  ApprovalContinuation,
  ApprovalRecoveryCall,
} from "../execution/approval-continuation.js";
import { FLARY_LAZY_TOOL_INSTRUCTIONS } from "./tools.js";
import { FlaryToolCapabilitySchema, approvalContinuationForFlaryTools } from "./toolset.js";

export const ResolvedFlaryAgentSchema = z
  .object({
    agentId: IdentifierSchema,
    revisionId: IdentifierSchema.optional(),
    instructions: z.string().min(1).max(2_000_000),
    model: ModelSelectionSchema,
    thinkingLevel: ReasoningEffortSchema.default("medium"),
    mode: AgentModeIdSchema.default("build"),
    capabilities: z.array(FlaryToolCapabilitySchema).max(128).default([]),
    limits: ExecutionLimitsSchema.optional(),
    outputSchema: JsonObjectSchema.optional(),
    metadata: JsonObjectSchema.optional(),
  })
  .strict();
export type ResolvedFlaryAgent = z.infer<typeof ResolvedFlaryAgentSchema>;
export type ResolvedFlaryAgentInput = z.input<typeof ResolvedFlaryAgentSchema>;

export interface FlaryAgentResolutionInput<TEnv> {
  readonly env: TEnv;
  readonly id: string;
  readonly trusted: TrustedRunContext;
}

export interface FlaryAgentToolInput<TEnv> extends FlaryAgentResolutionInput<TEnv> {
  readonly agent: ResolvedFlaryAgent;
}

export interface DefineFlaryAgentOptions<TEnv> {
  /**
   * Read trusted context that the host stored before Flue starts.
   * This callback must not trust model-visible input.
   */
  readonly resolveContext: (
    input: Pick<FlaryAgentResolutionInput<TEnv>, "env" | "id">,
  ) => Promise<TrustedRunContext> | TrustedRunContext;
  readonly resolveAgent: (
    input: FlaryAgentResolutionInput<TEnv>,
  ) => Promise<ResolvedFlaryAgentInput> | ResolvedFlaryAgentInput;
  /**
   * Register credentials in trusted code and return the Flue model handle.
   * Raw credentials must not be returned in the agent definition.
   */
  readonly resolveModel: (input: FlaryAgentToolInput<TEnv>) => Promise<string> | string;
  readonly resolveTools?: (
    input: FlaryAgentToolInput<TEnv>,
  ) => Promise<ToolDefinition[]> | ToolDefinition[];
  readonly resolveMode?: (input: FlaryAgentToolInput<TEnv>) => Promise<AgentMode> | AgentMode;
  readonly configure?: (
    input: FlaryAgentToolInput<TEnv>,
  ) => Promise<Partial<AgentRuntimeConfig>> | Partial<AgentRuntimeConfig>;
  readonly durability?: {
    readonly maxAttempts?: number;
    readonly timeoutMs?: number;
  };
}

/**
 * Define a tenant-neutral Flue agent for a host application.
 *
 * Put the returned definition in the application's `src/agents` directory.
 * The Flue build then generates the Durable Object class and bindings.
 */
export function defineFlaryAgent<TEnv = Record<string, unknown>>(
  options: DefineFlaryAgentOptions<TEnv>,
): AgentDefinition<TEnv> {
  return defineAgent<TEnv>(
    async (initializer: AgentInitializerContext<TEnv>): Promise<AgentRuntimeConfig> => {
      const trusted = TrustedRunContextSchema.parse(
        await options.resolveContext({
          env: initializer.env,
          id: initializer.id,
        }),
      );
      const resolution = {
        env: initializer.env,
        id: initializer.id,
        trusted,
      };
      const agent = ResolvedFlaryAgentSchema.parse(await options.resolveAgent(resolution));
      if (agent.agentId !== trusted.agentId) {
        throw new Error("The resolved agent does not match trusted run context");
      }
      if (trusted.revisionId && agent.revisionId !== trusted.revisionId) {
        throw new Error("The resolved agent revision does not match trusted run context");
      }
      const resolved = { ...resolution, agent };
      const configured = (await options.configure?.(resolved)) ?? {};
      const tools = options.resolveTools ? await options.resolveTools(resolved) : [];
      const mode = AgentModeSchema.parse(
        options.resolveMode ? await options.resolveMode(resolved) : resolveAgentMode(agent.mode),
      );
      const approvalContinuation = combineApprovalContinuations(
        configured.approvalContinuation as ApprovalContinuation | undefined,
        approvalContinuationForFlaryTools(tools),
      );

      return {
        ...configured,
        model: await options.resolveModel(resolved),
        instructions: [
          agent.instructions,
          `Active mode: ${mode.name ?? mode.id}.`,
          mode.prompt,
          tools.some((tool) => tool.name === "tool_search") ? FLARY_LAZY_TOOL_INSTRUCTIONS : "",
        ].join("\n\n"),
        thinkingLevel: toFlueThinkingLevel(agent.thinkingLevel),
        tools,
        ...(approvalContinuation ? { approvalContinuation } : {}),
        durability: {
          maxAttempts: options.durability?.maxAttempts ?? 10,
          timeoutMs: options.durability?.timeoutMs ?? 3_600_000,
          ...configured.durability,
        },
      };
    },
  );
}

function combineApprovalContinuations(
  ...values: Array<ApprovalContinuation | undefined>
): ApprovalContinuation | undefined {
  const continuations = values.filter((value): value is ApprovalContinuation => Boolean(value));
  if (continuations.length === 0) return undefined;
  return {
    async inspect(input) {
      const states = await Promise.all(
        continuations.map((continuation) => continuation.inspect(input)),
      );
      if (states.includes("ready")) return "ready";
      if (states.includes("waiting")) return "waiting";
      return "none";
    },
    async resume(input: ApprovalRecoveryCall) {
      for (const continuation of continuations) {
        if ((await continuation.inspect(input)) === "ready") {
          return continuation.resume(input);
        }
      }
      throw new Error("No approval continuation is ready");
    },
  };
}

export function toFlueThinkingLevel(value: z.input<typeof ReasoningEffortSchema>): ThinkingLevel {
  const effort = ReasoningEffortSchema.parse(value);
  if (effort === "none") return "off";
  if (effort === "ultra" || effort === "max") return "xhigh";
  return effort;
}

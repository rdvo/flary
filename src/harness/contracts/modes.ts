import { z } from "zod";

import { ExecutionLimitsSchema, type ExecutionLimits } from "./execution.js";
import { IdentifierSchema, MetadataSchema, NonEmptyStringSchema } from "./common.js";

// Agent modes are permission profiles. They do not create a second runtime.
export const BuiltInAgentModeIdSchema = z.enum(["ask", "plan", "build", "review"]);
export type BuiltInAgentModeId = z.infer<typeof BuiltInAgentModeIdSchema>;

export const AgentModeIdSchema = IdentifierSchema;
export type AgentModeId = z.infer<typeof AgentModeIdSchema>;

export const ModeApprovalPolicySchema = z
  .object({
    requireForWrites: z.boolean().default(false),
    requiredCapabilities: z.array(IdentifierSchema).max(256).default([]),
    requiredTools: z.array(IdentifierSchema).max(256).default([]),
  })
  .strict();
export type ModeApprovalPolicy = z.infer<typeof ModeApprovalPolicySchema>;

export const AgentModeSchema = z
  .object({
    id: AgentModeIdSchema,
    name: NonEmptyStringSchema.optional(),
    prompt: NonEmptyStringSchema,
    allowedCapabilities: z.array(IdentifierSchema).max(256).default([]),
    deniedCapabilities: z.array(IdentifierSchema).max(256).default([]),
    writableScopes: z.array(NonEmptyStringSchema).max(128).default([]),
    approvalPolicy: ModeApprovalPolicySchema.default({
      requireForWrites: false,
      requiredCapabilities: [],
      requiredTools: [],
    }),
    limits: ExecutionLimitsSchema.optional(),
    outputSchema: z.unknown().optional(),
    metadata: MetadataSchema.optional(),
  })
  .strict();
export type AgentMode = z.infer<typeof AgentModeSchema>;
export type AgentModeInput = z.input<typeof AgentModeSchema>;

export const SetAgentModeRequestSchema = z
  .object({
    mode: AgentModeIdSchema,
    reason: z.string().trim().max(4096).optional(),
    requestedBy: IdentifierSchema.optional(),
    metadata: MetadataSchema.optional(),
  })
  .strict();
export type SetAgentModeRequest = z.infer<typeof SetAgentModeRequestSchema>;

export const AgentModeTransitionSchema = z
  .object({
    fromMode: AgentModeIdSchema,
    toMode: AgentModeIdSchema,
    reason: z.string().trim().max(4096).optional(),
    requestedBy: IdentifierSchema.optional(),
    changedAt: z.string().datetime({ offset: true }),
    metadata: MetadataSchema.optional(),
  })
  .strict();
export type AgentModeTransition = z.infer<typeof AgentModeTransitionSchema>;

const builtin = (mode: AgentModeInput): AgentMode => AgentModeSchema.parse(mode);

// Keep defaults conservative. Applications can define a custom profile, but
// a custom profile must still pass through AgentModeSchema and policy checks.
export const BUILT_IN_AGENT_MODES: Readonly<Record<BuiltInAgentModeId, AgentMode>> = Object.freeze({
  ask: builtin({
    id: "ask",
    name: "Ask",
    prompt: "Answer using approved read-only tools. Do not change external state.",
    allowedCapabilities: [
      "interaction.user_input",
      "file.read",
      "workspace.read",
      "recall.search",
      "recall.open",
      "tool.search",
      "connection.mcp.read",
    ],
  }),
  plan: builtin({
    id: "plan",
    name: "Plan",
    prompt:
      "Inspect the project and history, ask questions, and write a plan artifact. Do not perform external side effects.",
    allowedCapabilities: [
      "interaction.user_input",
      "file.read",
      "workspace.read",
      "recall.search",
      "recall.open",
      "tool.search",
      "artifact.plan.write",
      "connection.mcp.read",
    ],
    writableScopes: ["plans/*"],
  }),
  build: builtin({
    id: "build",
    name: "Build",
    prompt:
      "Make approved changes with the available tools. Keep the user informed and request approval for risky writes.",
    allowedCapabilities: ["*"],
    writableScopes: ["*"],
    approvalPolicy: {
      requireForWrites: true,
      requiredCapabilities: [],
      requiredTools: [],
    },
  }),
  review: builtin({
    id: "review",
    name: "Review",
    prompt:
      "Inspect files, checkpoints, history, and diffs. Report findings without changing the project.",
    allowedCapabilities: [
      "interaction.user_input",
      "file.read",
      "workspace.read",
      "recall.search",
      "workspace.git",
      "recall.open",
      "diff.read",
      "artifact.read",
      "tool.search",
      "connection.mcp.read",
    ],
  }),
});

export function resolveAgentMode(
  mode: AgentModeId | AgentMode,
  customModes: Readonly<Record<string, AgentMode>> = {},
): AgentMode {
  if (typeof mode !== "string") return AgentModeSchema.parse(mode);
  const custom = customModes[mode];
  if (custom) return AgentModeSchema.parse(custom);
  const builtinMode = BUILT_IN_AGENT_MODES[mode as BuiltInAgentModeId];
  if (!builtinMode) throw new Error("Unknown agent mode: " + mode);
  return AgentModeSchema.parse(builtinMode);
}

export function listBuiltInAgentModes(): AgentMode[] {
  return Object.values(BUILT_IN_AGENT_MODES).map((mode) => AgentModeSchema.parse(mode));
}

export type { ExecutionLimits };

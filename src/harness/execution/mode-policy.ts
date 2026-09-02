import { z } from "zod";

import { AgentModeSchema, type AgentMode } from "../contracts/modes.js";
import { IdentifierSchema, NonEmptyStringSchema } from "../contracts/common.js";

export const ModeAccessRequestSchema = z
  .object({
    capability: IdentifierSchema,
    operation: z.enum(["read", "write"]),
    resource: NonEmptyStringSchema.optional(),
    toolId: IdentifierSchema.optional(),
  })
  .strict();
export type ModeAccessRequest = z.infer<typeof ModeAccessRequestSchema>;

export type ModeAccessDecision =
  { allowed: true; requiresApproval: boolean } | { allowed: false; reason: string };

export class ModeAccessDeniedError extends Error {
  constructor(
    readonly modeId: string,
    readonly request: ModeAccessRequest,
    message: string,
  ) {
    super(message);
    this.name = "ModeAccessDeniedError";
  }
}

function matchesPattern(value: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith("*")) return value.startsWith(pattern.slice(0, -1));
  return value === pattern;
}

function matchesAny(value: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchesPattern(value, pattern));
}

export function modeAllowsCapability(modeInput: AgentMode, capability: string): boolean {
  const mode = AgentModeSchema.parse(modeInput);
  if (matchesAny(capability, mode.deniedCapabilities)) return false;
  return matchesAny(capability, mode.allowedCapabilities);
}

export function modeAllowsWrite(modeInput: AgentMode, requestInput: ModeAccessRequest): boolean {
  const mode = AgentModeSchema.parse(modeInput);
  const request = ModeAccessRequestSchema.parse(requestInput);
  if (request.operation !== "write") return true;
  if (!modeAllowsCapability(mode, request.capability)) return false;
  if (!request.resource) return false;
  return matchesAny(request.resource, mode.writableScopes);
}

export function modeRequiresApproval(
  modeInput: AgentMode,
  requestInput: ModeAccessRequest,
): boolean {
  const mode = AgentModeSchema.parse(modeInput);
  const request = ModeAccessRequestSchema.parse(requestInput);
  if (request.operation !== "write") return false;
  return (
    mode.approvalPolicy.requireForWrites ||
    mode.approvalPolicy.requiredCapabilities.some((capability) =>
      matchesPattern(request.capability, capability),
    ) ||
    (request.toolId !== undefined &&
      mode.approvalPolicy.requiredTools.some((toolId) => matchesPattern(request.toolId!, toolId)))
  );
}

export function checkModeAccess(
  modeInput: AgentMode,
  requestInput: ModeAccessRequest,
): ModeAccessDecision {
  const mode = AgentModeSchema.parse(modeInput);
  const request = ModeAccessRequestSchema.parse(requestInput);
  if (!modeAllowsCapability(mode, request.capability)) {
    return {
      allowed: false,
      reason: "Capability is not allowed in mode " + mode.id,
    };
  }
  if (request.operation === "write" && !modeAllowsWrite(mode, request)) {
    return {
      allowed: false,
      reason: "Write resource is outside the mode writable scopes",
    };
  }
  return {
    allowed: true,
    requiresApproval: modeRequiresApproval(mode, request),
  };
}

export function assertModeAccess(modeInput: AgentMode, requestInput: ModeAccessRequest): void {
  const mode = AgentModeSchema.parse(modeInput);
  const request = ModeAccessRequestSchema.parse(requestInput);
  const decision = checkModeAccess(mode, request);
  if (!decision.allowed) {
    throw new ModeAccessDeniedError(mode.id, request, decision.reason);
  }
}

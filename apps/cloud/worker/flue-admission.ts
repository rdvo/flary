import { ReasoningEffortSchema, type ReasoningEffort } from "flary/contracts";

/**
 * Flary keeps a wider provider-neutral reasoning vocabulary. Flue beta 9
 * accepts `off`, `minimal`, `low`, `medium`, `high`, and `xhigh` for its
 * provider loop. Store the user's original value in Flary; use this adapter
 * only at the Flue boundary.
 */
export function normalizeFlueThinkingLevel(
  value: ReasoningEffort | undefined,
): "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined {
  if (value === undefined) return undefined;
  const level = ReasoningEffortSchema.parse(value);
  if (level === "none") return "off";
  if (level === "max" || level === "ultra") return "xhigh";
  return level;
}

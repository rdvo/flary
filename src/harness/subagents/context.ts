import {
  SeedTurnsSchema,
  SubagentConversationTurnSchema,
  type SubagentConversationTurn,
} from "../contracts/subagents";

// Return complete turns. Never cut a tool call away from its result.
export function selectSeededTurns(
  turns: readonly SubagentConversationTurn[],
  requestedTurns: number
): SubagentConversationTurn[] {
  const count = SeedTurnsSchema.parse(requestedTurns);
  if (count === 0) return [];

  const parsed = turns.map((turn) =>
    SubagentConversationTurnSchema.parse(turn)
  );
  return parsed
    .slice(Math.max(0, parsed.length - count))
    .map((turn) => structuredClone(turn));
}

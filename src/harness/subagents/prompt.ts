import {
  SubagentConversationTurnSchema,
  SubagentThreadSchema,
  type SubagentConversationTurn,
  type SubagentThread,
} from "../contracts/subagents.js";

export function buildSubagentTaskPrompt(
  inputThread: SubagentThread,
  inputTurns: readonly SubagentConversationTurn[]
): string {
  const thread = SubagentThreadSchema.parse(inputThread);
  const seededIds = new Set(thread.seededTurnIds);
  const turns = inputTurns
    .map((turn) => SubagentConversationTurnSchema.parse(turn))
    .filter((turn) => seededIds.has(turn.id))
    .map((turn) => ({
      ...turn,
      messages: turn.messages.filter(
        (message) =>
          thread.contextSeed.includeSystem || message.role !== "system"
      ),
    }))
    .filter((turn) => turn.messages.length > 0)
    .sort((left, right) => left.ordinal - right.ordinal);
  const sections = ["# Task", thread.task];

  if (turns.length > 0) {
    sections.push(
      "# Selected parent context",
      ...turns.map(
        (turn) =>
          `## Turn ${turn.ordinal}\n${turn.messages
            .map((message) => `${message.role}: ${message.content}`)
            .join("\n")}`
      )
    );
  }

  if (thread.verbosity) {
    sections.push("# Response style", verbosityInstruction(thread.verbosity));
  }

  return `${sections.join("\n\n")}\n`;
}

function verbosityInstruction(
  verbosity: NonNullable<SubagentThread["verbosity"]>
): string {
  if (verbosity === "low") {
    return "Be concise. Return only the result and essential evidence.";
  }
  if (verbosity === "high") {
    return "Be detailed. Include useful evidence, context, and clear reasoning.";
  }
  return "Use a balanced level of detail.";
}

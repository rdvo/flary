import { z } from "zod";

import { JsonObjectSchema, type JsonObject } from "../contracts/common.js";
import {
  ModelSelectionSchema,
  ProviderKindSchema,
  ReasoningEffortSchema,
  TextVerbositySchema,
  type ModelSelection,
  type ProviderKind,
} from "../contracts/provider.js";

export const ProviderApiStyleSchema = z.enum([
  "responses",
  "chat-completions",
  "messages",
  "generate-content",
  "custom",
]);
export type ProviderApiStyle = z.infer<typeof ProviderApiStyleSchema>;

export const ProviderRequestTuningSchema = z
  .object({
    parameters: JsonObjectSchema,
    instructions: z.array(z.string().min(1)),
    warnings: z.array(z.string().min(1)),
  })
  .strict();
export type ProviderRequestTuning = z.infer<typeof ProviderRequestTuningSchema>;

export interface ResolveProviderRequestTuningInput {
  providerKind: ProviderKind;
  api: ProviderApiStyle;
  selection: ModelSelection;
}

const OPENAI_REASONING_LEVELS: ReadonlySet<string> = new Set(
  ReasoningEffortSchema.options.filter(
    (level) => level !== "max" && level !== "ultra"
  )
);

// Pi-style native verbosity is available through the OpenAI Responses API.
// Other adapters receive the same value as clear prompt guidance.
export function resolveProviderRequestTuning(
  input: ResolveProviderRequestTuningInput
): ProviderRequestTuning {
  const providerKind = ProviderKindSchema.parse(input.providerKind);
  const api = ProviderApiStyleSchema.parse(input.api);
  const selection = ModelSelectionSchema.parse(input.selection);
  const parameters: JsonObject = { ...selection.parameters };
  const instructions: string[] = [];
  const warnings: string[] = [];

  if (selection.verbosity) {
    const verbosity = TextVerbositySchema.parse(selection.verbosity);
    if (providerKind === "openai" && api === "responses") {
      const currentText = asJsonObject(parameters.text);
      parameters.text = { ...currentText, verbosity };
    } else {
      instructions.push(verbosityInstruction(verbosity));
    }
  }

  if (selection.reasoningEffort) {
    const effort = ReasoningEffortSchema.parse(selection.reasoningEffort);
    if (
      providerKind === "openai" &&
      api === "responses" &&
      OPENAI_REASONING_LEVELS.has(effort)
    ) {
      const currentReasoning = asJsonObject(parameters.reasoning);
      parameters.reasoning = { ...currentReasoning, effort };
    } else {
      warnings.push(
        `The ${providerKind} ${api} adapter must map reasoning effort '${effort}'.`
      );
    }
  }

  return ProviderRequestTuningSchema.parse({
    parameters,
    instructions,
    warnings,
  });
}

function asJsonObject(value: unknown): JsonObject {
  const parsed = JsonObjectSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}

function verbosityInstruction(
  verbosity: z.infer<typeof TextVerbositySchema>
): string {
  if (verbosity === "low") {
    return "Use concise answers. Include only details that are needed.";
  }
  if (verbosity === "high") {
    return "Use detailed answers. Include useful context and clear explanations.";
  }
  return "Use a balanced level of detail.";
}

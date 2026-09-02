import { ModelSelectionSchema, type ModelSelection } from "../contracts/provider.js";
import type { SubagentThread } from "../contracts/subagents.js";

// Direct thread controls are the easy API. They override values nested in the
// selected model. The application fallback is used only when the thread does
// not select a model.
export function resolveSubagentModelSelection(
  thread: Pick<SubagentThread, "model" | "reasoningEffort" | "verbosity">,
  fallback?: ModelSelection,
): ModelSelection | undefined {
  const selected = thread.model ?? fallback;
  if (!selected) return undefined;
  return ModelSelectionSchema.parse({
    ...selected,
    reasoningEffort: thread.reasoningEffort ?? selected.reasoningEffort,
    verbosity: thread.verbosity ?? selected.verbosity,
  });
}

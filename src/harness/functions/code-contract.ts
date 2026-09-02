/**
 * The model-visible contract for one lazy catalog call.
 *
 * Keep this schema explicit. An untyped array makes models guess the call
 * shape and can turn a valid batch into `{ id: undefined }` at runtime.
 */
export function catalogCallInputSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      id: {
        type: "string",
        minLength: 1,
        description: "The exact catalog item.id returned by tools.search or tools.describe.",
      },
      input: {
        type: "object",
        description: "Input that matches the selected tool input schema.",
      },
    },
    required: ["id", "input"],
    additionalProperties: false,
  };
}

/** The model-visible contract for a replay-safe read batch. */
export function catalogBatchInputSchema(maxCalls = 16): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      calls: {
        type: "array",
        minItems: 1,
        maxItems: maxCalls,
        items: catalogCallInputSchema(),
        description: "Independent read calls in stable replay order.",
      },
    },
    required: ["calls"],
    additionalProperties: false,
  };
}

/**
 * Accept the canonical call shape and common model-generated aliases.
 * The runtime still resolves the value to a registered catalog descriptor
 * before it executes anything.
 */
export function normalizeCatalogCall(value: unknown, input?: unknown): unknown {
  if (typeof value === "string") return { id: value, input: input ?? {} };
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;

  const record = value as Record<string, unknown>;
  const id = record.id ?? record.toolId ?? record.tool_id ?? record.name;
  const normalizedInput =
    "input" in record
      ? record.input
      : "arguments" in record
        ? record.arguments
        : "args" in record
          ? record.args
          : "parameters" in record
            ? record.parameters
            : {};

  return typeof id === "string" ? { id, input: normalizedInput } : value;
}

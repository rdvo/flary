import { z } from "zod";

import { ModelSelectionSchema, type ModelSelection } from "../contracts/provider.js";

/** Provider-neutral content kept in the canonical session archive. */
export const CanonicalHistoryItemSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("user"),
    id: z.string().min(1),
    text: z.string(),
    attachments: z.array(z.object({
      id: z.string().min(1),
      mimeType: z.string().min(1),
      storageKey: z.string().min(1),
    }).strict()).default([]),
    producer: z.object({ provider: z.string().min(1), model: z.string().min(1) }).strict().optional(),
  }).strict(),
  z.object({
    kind: z.literal("assistant"),
    id: z.string().min(1),
    text: z.string(),
    producer: z.object({ provider: z.string().min(1), model: z.string().min(1) }).strict().optional(),
  }).strict(),
  z.object({
    kind: z.literal("tool-call"),
    id: z.string().min(1),
    toolId: z.string().min(1),
    input: z.record(z.string(), z.unknown()),
  }).strict(),
  z.object({
    kind: z.literal("tool-result"),
    id: z.string().min(1),
    toolId: z.string().min(1),
    output: z.unknown(),
    error: z.string().optional(),
  }).strict(),
  z.object({
    kind: z.literal("compaction"),
    id: z.string().min(1),
    summary: z.string(),
    throughId: z.string().min(1).optional(),
  }).strict(),
  z.object({
    kind: z.literal("rollback"),
    id: z.string().min(1),
    throughId: z.string().min(1),
    reason: z.string().optional(),
  }).strict(),
]);
export type CanonicalHistoryItem = z.infer<typeof CanonicalHistoryItemSchema>;

export interface ProviderHistoryCapabilities {
  readonly supportsVision?: boolean;
  readonly supportsTools?: boolean;
  readonly supportsReasoning?: boolean;
  readonly toolName?: (stableToolId: string) => string;
}

/** Model-facing item. It has no native response IDs, cache keys, or secrets. */
export type PortableProviderMessage =
  | { readonly role: "user" | "assistant"; readonly content: string | readonly Record<string, unknown>[] }
  | { readonly role: "tool"; readonly name: string; readonly content: string };

/**
 * Convert the canonical history for a target provider. This function does not
 * mutate the archive. Unsupported attachments become safe references and
 * provider-private continuation data is never copied.
 */
export function toProviderHistory(
  input: readonly CanonicalHistoryItem[],
  modelInput: ModelSelection,
  capabilities: ProviderHistoryCapabilities = {},
): PortableProviderMessage[] {
  const model = ModelSelectionSchema.parse(modelInput);
  const output: PortableProviderMessage[] = [];
  for (const candidate of input) {
    const item = CanonicalHistoryItemSchema.parse(candidate);
    if (item.kind === "user") {
      if (item.attachments.length > 0 && capabilities.supportsVision) {
        output.push({
          role: "user",
          content: [
            { type: "text", text: item.text },
            ...item.attachments.map((attachment) => ({
              type: "attachment",
              id: attachment.id,
              mimeType: attachment.mimeType,
              ref: attachment.storageKey,
            })),
          ],
        });
      } else if (item.attachments.length > 0) {
        output.push({
          role: "user",
          content: `${item.text}\n\n[Attachments: ${item.attachments.map((attachment) => attachment.id).join(", ")}]`,
        });
      } else {
        output.push({ role: "user", content: item.text });
      }
      continue;
    }
    if (item.kind === "assistant") {
      output.push({ role: "assistant", content: item.text });
      continue;
    }
    if (item.kind === "tool-call") {
      if (capabilities.supportsTools === false) {
        output.push({ role: "assistant", content: `[Tool call: ${item.toolId}]` });
      }
      continue;
    }
    if (item.kind === "tool-result") {
      const name = capabilities.toolName?.(item.toolId) ?? item.toolId;
      output.push({
        role: "tool",
        name,
        content: item.error ?? safeJson(item.output),
      });
      continue;
    }
    if (item.kind === "compaction") {
      output.push({ role: "assistant", content: `[Previous context summary]\n${item.summary}` });
      continue;
    }
    if (item.kind === "rollback") {
      output.push({ role: "assistant", content: `[Context rolled back through ${item.throughId}]` });
    }
  }
  // Keep the parsed model in the contract even when a provider ignores a
  // capability. This catches invalid cross-provider selections early.
  void model;
  return output;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return "[unserializable tool result]";
  }
}

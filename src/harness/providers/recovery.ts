import { z } from "zod";

import {
  ErrorInfoSchema,
  IdentifierSchema,
  JsonObjectSchema,
  TimestampSchema,
} from "../contracts/common.js";
import { ProviderKindSchema } from "../contracts/provider.js";
import {
  ModelRequestSchema,
  ProviderErrorSchema,
  ProviderStreamEventSchema,
  ProviderToolCallSchema,
  ProviderUsageSchema,
  type ModelRequest,
  type ModelStreamEvent,
  type ProviderError,
  type ProviderToolCall,
  type ProviderUsage,
} from "./contracts.js";

export const ProviderOperationStatusSchema = z.enum([
  "pending",
  "streaming",
  "waiting_for_tool",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
export type ProviderOperationStatus = z.infer<
  typeof ProviderOperationStatusSchema
>;

export const ProviderFailureClassSchema = z.enum([
  "rate_limit",
  "transient",
  "authentication",
  "invalid_request",
  "content_safety",
  "cancelled",
  "interrupted",
  "unknown",
]);
export type ProviderFailureClass = z.infer<typeof ProviderFailureClassSchema>;

// Tokens are opaque. A public Flary run never exposes a provider response type.
export const ProviderRecoveryCheckpointSchema = z
  .object({
    runId: IdentifierSchema,
    operationId: IdentifierSchema,
    adapterId: IdentifierSchema,
    provider: ProviderKindSchema,
    status: ProviderOperationStatusSchema,
    resumeToken: z.string().min(1).optional(),
    continuationToken: z.string().min(1).optional(),
    streamSequence: z.number().int().nonnegative().optional(),
    partialText: z.string(),
    partialReasoning: z.string(),
    toolCalls: z.array(ProviderToolCallSchema).max(128),
    usage: ProviderUsageSchema.optional(),
    attempt: z.number().int().positive(),
    idempotencyKey: IdentifierSchema,
    failureClass: ProviderFailureClassSchema.optional(),
    error: ProviderErrorSchema.optional(),
    metadata: JsonObjectSchema.optional(),
    updatedAt: TimestampSchema,
  })
  .strict();
export type ProviderRecoveryCheckpoint = z.infer<
  typeof ProviderRecoveryCheckpointSchema
>;

export interface ProviderCheckpointStore {
  get(
    runId: string,
    operationId: string,
  ): Promise<ProviderRecoveryCheckpoint | undefined>;
  put(checkpoint: ProviderRecoveryCheckpoint): Promise<void>;
}

export class InMemoryProviderCheckpointStore
  implements ProviderCheckpointStore
{
  readonly #values = new Map<string, ProviderRecoveryCheckpoint>();

  async get(
    runId: string,
    operationId: string,
  ): Promise<ProviderRecoveryCheckpoint | undefined> {
    const value = this.#values.get(`${runId}:${operationId}`);
    return value ? ProviderRecoveryCheckpointSchema.parse(value) : undefined;
  }

  async put(checkpointValue: ProviderRecoveryCheckpoint): Promise<void> {
    const checkpoint =
      ProviderRecoveryCheckpointSchema.parse(checkpointValue);
    this.#values.set(
      `${checkpoint.runId}:${checkpoint.operationId}`,
      checkpoint,
    );
  }
}

export interface ProviderRecoveryContext {
  runId: string;
  operationId: string;
  idempotencyKey: string;
  checkpoints: ProviderCheckpointStore;
  signal?: AbortSignal;
  headers?: HeadersInit;
}

export interface DurableProviderAdapter {
  readonly id: string;
  readonly provider: z.infer<typeof ProviderKindSchema>;

  start(
    request: ModelRequest,
    context: ProviderRecoveryContext,
  ): AsyncIterable<ModelStreamEvent>;

  recover(
    request: ModelRequest,
    checkpoint: ProviderRecoveryCheckpoint,
    context: ProviderRecoveryContext,
  ): AsyncIterable<ModelStreamEvent>;

  cancel(
    checkpoint: ProviderRecoveryCheckpoint,
    context: ProviderRecoveryContext,
  ): Promise<void>;

  classifyError(error: unknown): ProviderFailureClass;
}

export function initialProviderCheckpoint(
  adapter: Pick<DurableProviderAdapter, "id" | "provider">,
  context: ProviderRecoveryContext,
  attempt = 1,
): ProviderRecoveryCheckpoint {
  return ProviderRecoveryCheckpointSchema.parse({
    runId: IdentifierSchema.parse(context.runId),
    operationId: IdentifierSchema.parse(context.operationId),
    adapterId: adapter.id,
    provider: adapter.provider,
    status: "pending",
    partialText: "",
    partialReasoning: "",
    toolCalls: [],
    attempt,
    idempotencyKey: IdentifierSchema.parse(context.idempotencyKey),
    updatedAt: new Date().toISOString(),
  });
}

export async function* checkpointProviderStream(
  adapter: Pick<DurableProviderAdapter, "id" | "provider" | "classifyError">,
  stream: AsyncIterable<ModelStreamEvent>,
  context: ProviderRecoveryContext,
  initial?: ProviderRecoveryCheckpoint,
): AsyncIterable<ModelStreamEvent> {
  let checkpoint =
    initial ?? initialProviderCheckpoint(adapter, context);
  await context.checkpoints.put(checkpoint);
  try {
    for await (const eventValue of stream) {
      const event = ProviderStreamEventSchema.parse(eventValue);
      const persisted = await context.checkpoints.get(
        checkpoint.runId,
        checkpoint.operationId,
      );
      if (persisted) {
        checkpoint = ProviderRecoveryCheckpointSchema.parse({
          ...checkpoint,
          streamSequence:
            persisted.streamSequence ?? checkpoint.streamSequence,
          continuationToken:
            persisted.continuationToken ?? checkpoint.continuationToken,
        });
      }
      checkpoint = checkpointForEvent(checkpoint, event, adapter);
      await context.checkpoints.put(checkpoint);
      yield event;
    }
  } catch (cause) {
    const error = providerError(cause, adapter.id);
    checkpoint = ProviderRecoveryCheckpointSchema.parse({
      ...checkpoint,
      status:
        adapter.classifyError(cause) === "cancelled"
          ? "cancelled"
          : "interrupted",
      failureClass: adapter.classifyError(cause),
      error,
      updatedAt: new Date().toISOString(),
    });
    await context.checkpoints.put(checkpoint);
    throw cause;
  }
}

export function continuationRequest(
  requestValue: ModelRequest,
  checkpoint: ProviderRecoveryCheckpoint,
): ModelRequest {
  const request = ModelRequestSchema.parse(requestValue);
  if (!checkpoint.partialText) return request;
  let insertAt = request.messages.length;
  while (
    insertAt > 0 &&
    request.messages[insertAt - 1]?.role === "tool"
  ) {
    insertAt -= 1;
  }
  const messages = [...request.messages];
  messages.splice(insertAt, 0, {
    role: "assistant",
    content: checkpoint.partialText,
    toolCalls:
      checkpoint.toolCalls.length > 0 ? checkpoint.toolCalls : undefined,
  });
  return ModelRequestSchema.parse({
    ...request,
    messages,
  });
}

export function classifyHttpFailure(
  error: unknown,
): ProviderFailureClass {
  if (error instanceof DOMException && error.name === "AbortError") {
    return "cancelled";
  }
  const status =
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof error.status === "number"
      ? error.status
      : typeof error === "object" &&
          error !== null &&
          "error" in error &&
          typeof error.error === "object" &&
          error.error !== null &&
          "status" in error.error &&
          typeof error.error.status === "number"
        ? error.error.status
        : undefined;
  if (status === 401 || status === 403) return "authentication";
  if (status === 429) return "rate_limit";
  if (status === 408 || status === 409 || (status !== undefined && status >= 500)) {
    return "transient";
  }
  if (status !== undefined && status >= 400) return "invalid_request";
  return "unknown";
}

function checkpointForEvent(
  checkpoint: ProviderRecoveryCheckpoint,
  event: ModelStreamEvent,
  adapter: Pick<DurableProviderAdapter, "id" | "provider" | "classifyError">,
): ProviderRecoveryCheckpoint {
  const base = {
    ...checkpoint,
    status: "streaming" as const,
    updatedAt: new Date().toISOString(),
  };
  if (event.type === "start") {
    return ProviderRecoveryCheckpointSchema.parse({
      ...base,
      resumeToken: event.responseId,
    });
  }
  if (event.type === "text_delta") {
    return ProviderRecoveryCheckpointSchema.parse({
      ...base,
      resumeToken: event.responseId,
      partialText: checkpoint.partialText + event.delta,
    });
  }
  if (event.type === "reasoning_delta") {
    return ProviderRecoveryCheckpointSchema.parse({
      ...base,
      resumeToken: event.responseId,
      partialReasoning: checkpoint.partialReasoning + event.delta,
    });
  }
  if (event.type === "tool_call_delta") {
    return ProviderRecoveryCheckpointSchema.parse({
      ...base,
      resumeToken: event.responseId,
      toolCalls: mergeToolCallDelta(checkpoint.toolCalls, event),
      status: "waiting_for_tool",
    });
  }
  if (event.type === "usage") {
    return ProviderRecoveryCheckpointSchema.parse({
      ...base,
      resumeToken: event.responseId,
      usage: event.usage,
    });
  }
  if (event.type === "finish") {
    return ProviderRecoveryCheckpointSchema.parse({
      ...base,
      status: "completed",
      resumeToken: event.responseId,
      partialText: event.response.content,
      partialReasoning: event.response.reasoning ?? checkpoint.partialReasoning,
      toolCalls: event.response.toolCalls,
      usage: event.response.usage ?? checkpoint.usage,
    });
  }
  const failureClass = adapter.classifyError(event.error);
  return ProviderRecoveryCheckpointSchema.parse({
    ...base,
    status: failureClass === "cancelled" ? "cancelled" : "failed",
    resumeToken: event.responseId ?? checkpoint.resumeToken,
    failureClass,
    error: event.error,
  });
}

function mergeToolCallDelta(
  calls: ProviderToolCall[],
  event: Extract<ModelStreamEvent, { type: "tool_call_delta" }>,
): ProviderToolCall[] {
  const next = [...calls];
  const current = next[event.index] ?? {
    id: event.toolCallId ?? `tool_${event.index}`,
    name: event.name ?? "unknown",
    arguments: {},
    rawArguments: "",
  };
  const rawArguments =
    (current.rawArguments ?? JSON.stringify(current.arguments)) +
    (event.argumentsDelta ?? "");
  let argumentsValue = current.arguments;
  try {
    argumentsValue = JsonObjectSchema.parse(JSON.parse(rawArguments));
  } catch {
    argumentsValue = {};
  }
  next[event.index] = ProviderToolCallSchema.parse({
    ...current,
    id: event.toolCallId ?? current.id,
    name: event.name ?? current.name,
    arguments: argumentsValue,
    rawArguments,
  });
  return next;
}

function providerError(error: unknown, provider: string): ProviderError {
  if (
    typeof error === "object" &&
    error !== null &&
    "error" in error &&
    ProviderErrorSchema.safeParse(error.error).success
  ) {
    return ProviderErrorSchema.parse(error.error);
  }
  return ProviderErrorSchema.parse({
    code: "provider_interrupted",
    message: error instanceof Error ? error.message : "Provider work stopped.",
    retryable: true,
    provider,
  });
}

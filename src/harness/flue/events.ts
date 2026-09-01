import type { FlueEvent } from "@flue/runtime";

import {
  JsonObjectSchema,
  NormalizedUsageSchema,
  RunEventSchema,
  TraceContextSchema,
  type RunEvent,
  type TraceContext,
} from "../contracts/index.js";
import {
  redactErrorMessage,
  redactSecrets,
  redactText,
} from "../execution/redaction.js";

export interface NormalizeFlueEventOptions {
  readonly runId: string;
  readonly agentId: string;
  readonly traceContext?: TraceContext;
  readonly parentRunId?: string;
}

/**
 * Convert one versioned Flue event into Flary's stable public event contract.
 *
 * Unsupported internal events return `undefined`. The source event remains in
 * Flue's canonical stream and can be normalized by a later Flary version.
 */
export function normalizeFlueEvent(
  event: FlueEvent,
  options: NormalizeFlueEventOptions
): RunEvent | undefined {
  const base = {
    id: `event_${options.runId}_${event.eventIndex}`,
    runId: options.runId,
    sequence: event.eventIndex,
    occurredAt: event.timestamp,
    ...(options.traceContext
      ? { traceContext: TraceContextSchema.parse(options.traceContext) }
      : {}),
    ...(options.parentRunId ? { parentRunId: options.parentRunId } : {}),
    ...(event.operationId ? { operationId: event.operationId } : {}),
    ...(event.turnId ? { nodeId: event.turnId } : {}),
  };

  switch (event.type) {
    case "run_start":
    case "run_resume":
      return RunEventSchema.parse({
        ...base,
        type: "run.started",
        startedAt: event.startedAt,
        payload: { requestId: options.runId },
      });
    case "agent_start":
      return RunEventSchema.parse({
        ...base,
        type: "agent.started",
        payload: { agentId: options.agentId },
      });
    case "agent_end":
      return RunEventSchema.parse({
        ...base,
        type: "agent.completed",
        payload: { agentId: options.agentId },
      });
    case "text_delta":
      if (!event.text) return undefined;
      return RunEventSchema.parse({
        ...base,
        type: "message.delta",
        payload: { delta: redactText(event.text) },
      });
    case "thinking_delta":
      if (!event.delta) return undefined;
      return RunEventSchema.parse({
        ...base,
        type: "reasoning.delta",
        payload: { delta: event.delta },
      });
    case "message_end": {
      const content = messageText(event.message);
      if (!content) return undefined;
      return RunEventSchema.parse({
        ...base,
        type: "message.created",
        payload: {
          role: messageRole(event.message),
          content,
        },
      });
    }
    case "tool_start":
      return RunEventSchema.parse({
        ...base,
        type: "tool.call",
        payload: {
          call: {
            id: event.toolCallId,
            toolId: event.toolName,
            arguments: jsonObject(event.args),
            runId: options.runId,
            requestedAt: event.timestamp,
            ...(event.operationId ? { idempotencyKey: event.operationId } : {}),
          },
        },
      });
    case "tool":
      return RunEventSchema.parse({
        ...base,
        type: "tool.result",
        payload: {
          result: {
            id: `result_${event.toolCallId}`,
            callId: event.toolCallId,
            toolId: event.toolName,
            status: event.isError ? "failed" : "succeeded",
            ...(event.isError
              ? {
                  error: {
                    code: "tool_failed",
                    message: errorMessage(
                      event.result,
                      "Tool execution failed"
                    ),
                  },
                }
              : { output: jsonObject(event.result) }),
            durationMs: Math.max(0, Math.floor(event.durationMs)),
            completedAt: event.timestamp,
          },
        },
      });
    case "turn": {
      const request = asRecord(event.request);
      const response = asRecord(event.response);
      const model = asRecord(request.model ?? response.model);
      const usage = normalizeUsage(response.usage);
      return RunEventSchema.parse({
        ...base,
        type: "model.completed",
        payload: {
          ...(stringValue(model.provider) || stringValue(response.provider)
            ? {
                provider:
                  stringValue(model.provider) ?? stringValue(response.provider),
              }
            : {}),
          ...(stringValue(model.id) || stringValue(response.model)
            ? {
                model: stringValue(model.id) ?? stringValue(response.model),
              }
            : {}),
          ...(usage ? { usage } : {}),
          durationMs: Math.max(0, Math.floor(event.durationMs)),
          retryCount: Math.max(
            0,
            Math.floor(numberValue(response.retryCount) ?? 0)
          ),
        },
      });
    }
    case "submission_settled":
      if (event.outcome === "completed") {
        return RunEventSchema.parse({
          ...base,
          type: "run.completed",
          payload: { output: jsonValue(event.result) },
        });
      }
      if (event.outcome === "aborted") {
        return RunEventSchema.parse({
          ...base,
          type: "run.cancelled",
          payload: event.error?.message ? { reason: event.error.message } : {},
        });
      }
      return RunEventSchema.parse({
        ...base,
        type: "run.failed",
        payload: {
          error: {
            code: event.error?.type ?? "submission_failed",
            message: event.error?.message ?? "The agent submission failed",
          },
        },
      });
    case "run_end":
      return event.isError
        ? RunEventSchema.parse({
            ...base,
            type: "run.failed",
            payload: {
              error: {
                code: "run_failed",
                message: errorMessage(event.error, "The run failed"),
              },
            },
          })
        : RunEventSchema.parse({
            ...base,
            type: "run.completed",
            payload: { output: jsonValue(event.result) },
          });
    default:
      return undefined;
  }
}

function normalizeUsage(value: unknown) {
  const usage = asRecord(value);
  const inputTokens = numberValue(usage.input ?? usage.inputTokens);
  const outputTokens = numberValue(usage.output ?? usage.outputTokens);
  const totalTokens = numberValue(usage.totalTokens);
  const cacheRead = numberValue(usage.cacheRead);
  const cacheWrite = numberValue(usage.cacheWrite);
  const cost = asRecord(usage.cost);
  const totalCost = numberValue(cost.total);
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    totalTokens === undefined &&
    cacheRead === undefined &&
    cacheWrite === undefined &&
    totalCost === undefined
  ) {
    return undefined;
  }
  return NormalizedUsageSchema.parse({
    inputTokens,
    outputTokens,
    totalTokens,
    cache:
      cacheRead === undefined && cacheWrite === undefined
        ? undefined
        : {
            readTokens: cacheRead,
            writeTokens: cacheWrite,
          },
    cost:
      totalCost === undefined
        ? { state: "unknown", reason: "Provider cost was not reported" }
        : {
            state: "known",
            microUnits: Math.max(0, Math.round(totalCost * 1_000_000)),
            unit: "USD",
          },
  });
}

function messageText(value: unknown): string {
  const message = asRecord(value);
  if (typeof message.content === "string") return redactText(message.content);
  if (!Array.isArray(message.content)) return "";
  return redactText(
    message.content
      .map((part) => stringValue(asRecord(part).text) ?? "")
      .join("")
  );
}

function messageRole(value: unknown): "user" | "assistant" | "system" | "tool" {
  const role = stringValue(asRecord(value).role);
  return role === "user" || role === "system" || role === "tool"
    ? role
    : "assistant";
}

function jsonObject(value: unknown): Record<string, unknown> {
  const object = asRecord(value);
  const parsed = JsonObjectSchema.safeParse(object);
  return parsed.success
    ? (redactSecrets(parsed.data) as Record<string, unknown>)
    : { value: redactSecrets(jsonValue(value)) };
}

function jsonValue(value: unknown): unknown {
  if (value === undefined) return null;
  try {
    return redactSecrets(JSON.parse(JSON.stringify(value)));
  } catch {
    return redactText(String(value));
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function errorMessage(value: unknown, fallback: string): string {
  if (value instanceof Error) return redactErrorMessage(value, fallback);
  const record = asRecord(value);
  return redactErrorMessage(stringValue(record.message), fallback);
}

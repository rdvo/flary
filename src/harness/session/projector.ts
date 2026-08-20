import { redactSecrets } from "../execution/redaction.js";
import {
  SESSION_LEDGER_FORMAT,
  SESSION_LEDGER_SCHEMA_VERSION,
  SessionJsonObjectSchema,
  type EncryptedSessionContentRef,
  type SessionRecord,
  type SessionRecordType,
} from "./contracts.js";
import type { SqliteSessionLedger } from "./sqlite.js";

export interface SessionProjectionScope {
  readonly tenantId: string;
  readonly applicationId: string;
  readonly sessionId: string;
  readonly threadId: string;
  readonly agentId?: string;
  readonly sourceRevision: string;
}

export interface ProjectSessionEventInput {
  readonly sourceCursor: string;
  readonly event: Readonly<Record<string, unknown>>;
  readonly encryptedContentRef?: EncryptedSessionContentRef;
  readonly attempt?: number;
}

/**
 * Build a redacted, rebuildable read model from canonical Flue events.
 *
 * This projector never replaces or mutates the Flue transcript. It only adds
 * ordered references and safe operational payloads to the session ledger.
 */
export class FlarySessionProjector {
  readonly #ledger: SqliteSessionLedger;
  readonly #scope: SessionProjectionScope;

  constructor(ledger: SqliteSessionLedger, scope: SessionProjectionScope) {
    this.#ledger = ledger;
    this.#scope = Object.freeze({ ...scope });
  }

  async project(input: ProjectSessionEventInput): Promise<SessionRecord> {
    const event = input.event;
    const eventType = typeof event.type === "string" ? event.type : "unknown";
    const recordedAt =
      typeof event.timestamp === "string"
        ? event.timestamp
        : typeof event.occurredAt === "string"
          ? event.occurredAt
          : new Date().toISOString();
    const turnId = stringValue(event.turnId) ??
      (eventType === "submission-settled"
        ? stringValue(event.submissionId)
        : undefined);
    const payload = SessionJsonObjectSchema.parse(
      redactProviderPrivate(
        eventType,
        jsonObject(redactSecrets(jsonObject(event)) as Record<string, unknown>),
      ),
    );
    return this.#ledger.append({
      schemaVersion: SESSION_LEDGER_SCHEMA_VERSION,
      format: SESSION_LEDGER_FORMAT,
      ...this.#scope,
      sourceCursor: input.sourceCursor,
      sourceRevision: this.#scope.sourceRevision,
      recordType: recordTypeForProjectedEvent(event),
      recordedAt,
      attempt: input.attempt ?? numeric(event.attempt) ?? 0,
      publicPayload: payload,
      ...(producerForEvent(event) ? { producer: producerForEvent(event) } : {}),
      ...(turnId ? { turnId } : {}),
      ...(stringValue(event.runId) ? { runId: stringValue(event.runId) } : {}),
      ...(stringValue(event.toolCallId ?? event.callId)
        ? { toolCallId: stringValue(event.toolCallId ?? event.callId) }
        : {}),
      ...(stringValue(event.parentId) ? { parentId: stringValue(event.parentId) } : {}),
      ...(input.encryptedContentRef
        ? { encryptedContentRef: input.encryptedContentRef }
        : {}),
    });
  }
}

function redactProviderPrivate(
  eventType: string,
  value: Record<string, unknown>,
): Record<string, unknown> {
  const privateKey = /^(?:responseId|previousResponse|nativeSession|cache|continuation|credential|apiKey|secret|encryptedReasoning)/i;
  const reasoningEvent =
    eventType === "message-delta" && value.kind === "reasoning";
  const walk = (candidate: unknown, key = ""): unknown => {
    if (privateKey.test(key)) return "[REDACTED]";
    if ((reasoningEvent && /^(text|delta|content)$/i.test(key)) ||
        (eventType === "message-delta" &&
        key.toLowerCase().includes("reasoning")) &&
        (typeof candidate === "string" || Array.isArray(candidate))) {
      return "[PROVIDER_PRIVATE_REASONING]";
    }
    if (Array.isArray(candidate)) return candidate.map((item) => walk(item));
    if (candidate && typeof candidate === "object") {
      const output: Record<string, unknown> = {};
      for (const [childKey, childValue] of Object.entries(candidate)) {
        output[childKey] = walk(childValue, childKey);
      }
      return output;
    }
    return candidate;
  };
  return walk(value) as Record<string, unknown>;
}

function producerForEvent(
  event: Readonly<Record<string, unknown>>,
): { provider: string; model: string; variant?: string } | undefined {
  const candidate = event.modelInfo ?? event.model;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return undefined;
  }
  const value = candidate as Record<string, unknown>;
  const provider = typeof value.provider === "string"
    ? value.provider
    : typeof value.providerId === "string"
      ? value.providerId
      : undefined;
  const model = typeof value.model === "string"
    ? value.model
    : typeof value.id === "string"
      ? value.id
      : undefined;
  if (!provider || !model) return undefined;
  return {
    provider,
    model,
    ...(typeof value.variant === "string" ? { variant: value.variant } : {}),
  };
}

function recordTypeForProjectedEvent(
  event: Readonly<Record<string, unknown>>,
): SessionRecordType {
  const type = typeof event.type === "string" ? event.type : "unknown";
  if (type === "conversation-reset") return "compaction.window";
  // Flue can start and complete more than one assistant message inside one
  // submission when the model calls tools. These are message boundaries, not
  // user-turn boundaries. Only submission-settled closes the logical turn.
  if (type === "message-started" || type === "message-completed") {
    return "message.assistant";
  }
  if (type === "message-delta") {
    return event.kind === "reasoning"
      ? "message.reasoning"
      : "message.assistant";
  }
  if (type === "message-appended") {
    const message = jsonObject(
      event.message && typeof event.message === "object"
        ? event.message as Record<string, unknown>
        : {},
    );
    return message.role === "user" ? "message.user" : "message.assistant";
  }
  if (type === "tool-input") return "tool.call";
  if (type === "tool-output" || type === "tool-output-error") {
    return "tool.result";
  }
  if (type === "submission-settled") {
    if (event.outcome === "completed") return "turn.completed";
    return event.outcome === "aborted" ? "turn.aborted" : "terminal";
  }
  return recordTypeForEvent(type);
}

export function recordTypeForEvent(type: string): SessionRecordType {
  if (type === "turn_request" || type === "turn.started") return "turn.started";
  if (type === "turn" || type === "turn.completed") return "turn.completed";
  if (type === "turn.aborted") return "turn.aborted";
  if (type === "message.user") return "message.user";
  if (
    type === "message.assistant" ||
    type === "message" ||
    type === "message_end"
  ) return "message.assistant";
  if (type.startsWith("thinking") || type.includes("reasoning")) {
    return "message.reasoning";
  }
  if (type === "tool.search") return "tool.search";
  if (type === "tool.describe") return "tool.describe";
  if (type === "tool_start" || type === "tool.call") return "tool.call";
  if (type === "tool" || type === "tool.result") return "tool.result";
  if (type === "tool.batch") return "tool.batch";
  if (type === "codemode.started") return "codemode.started";
  if (type === "codemode.paused") return "codemode.paused";
  if (type === "codemode.completed") return "codemode.completed";
  if (type === "codemode.failed") return "codemode.failed";
  if (type.includes("approval") && type.includes("request")) {
    return "approval.requested";
  }
  if (type.includes("approval")) return "approval.resolved";
  if (type.includes("user_input") && type.includes("request")) {
    return "input.requested";
  }
  if (type.includes("user_input")) return "input.resolved";
  if (type === "task" || type.includes("subagent")) return "subagent.status";
  if (type === "compaction_start") return "compaction.started";
  if (type === "compaction") return "compaction.completed";
  if (type.includes("usage")) return "usage";
  if (type.includes("rate_limit")) return "rate_limit";
  if (type.includes("rollback")) return "rollback";
  if (type.includes("terminal") || type === "run_completed" || type === "run_failed") {
    return "terminal";
  }
  if (type.startsWith("process.")) {
    if (type.endsWith("output")) return "process.output";
    if (type.endsWith("completed") || type.endsWith("failed")) {
      return "process.completed";
    }
    if (type.endsWith("started")) return "process.started";
    return "process.control";
  }
  return "runtime.event";
}

function jsonObject(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numeric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

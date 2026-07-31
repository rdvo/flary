import {
  SESSION_LEDGER_FORMAT,
  SESSION_LEDGER_SCHEMA_VERSION,
  SessionJsonObjectSchema,
  type EncryptedSessionContentRef,
  type SessionJsonObject,
  type SessionJsonValue,
  type SessionRecord,
  type SessionRecordDraft,
  type SessionRecordType,
} from "./contracts.js";
import { sealSessionRecord } from "./integrity.js";

interface CodexRolloutRecord {
  timestamp?: unknown;
  type?: unknown;
  payload?: unknown;
}

export interface CodexRolloutImportOptions {
  tenantId: string;
  applicationId: string;
  sessionId?: string;
  threadId?: string;
  sourceRevision?: string;
  fallbackTimestamp?: string;
  /**
   * Store the complete source record in trusted storage. The returned
   * reference is put in the ledger. Raw content is not put in public data.
   */
  storeEncryptedContent?: (
    source: SessionJsonObject,
    lineNumber: number,
  ) => Promise<EncryptedSessionContentRef | undefined>;
}

export class CodexRolloutImportError extends Error {
  readonly lineNumber: number;

  constructor(lineNumber: number, message: string) {
    super(`Invalid Codex rollout at line ${lineNumber}: ${message}`);
    this.name = "CodexRolloutImportError";
    this.lineNumber = lineNumber;
  }
}

const SENSITIVE_KEY =
  /authorization|cookie|credential|password|secret|api[_-]?key|encrypted[_-]?content|(?:^|[_-])(?:access|refresh|id|session|auth|bearer)?[_-]?token$/i;

/** Remove common secret values before source data enters a public ledger. */
export function redactCodexRolloutValue(
  value: SessionJsonValue,
  key = "",
): SessionJsonValue {
  if (key && SENSITIVE_KEY.test(key)) return "[REDACTED]";
  if (Array.isArray(value)) {
    return value.map((item) => redactCodexRolloutValue(item));
  }
  if (value !== null && typeof value === "object") {
    const output: Record<string, SessionJsonValue> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      output[childKey] = redactCodexRolloutValue(childValue, childKey);
    }
    return output;
  }
  return value;
}

function objectValue(value: unknown): SessionJsonObject {
  const parsed = SessionJsonObjectSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}

function textValue(value: SessionJsonValue | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function nestedText(
  value: SessionJsonObject,
  path: readonly string[],
): string | undefined {
  let current: SessionJsonValue = value;
  for (const key of path) {
    if (current === null || Array.isArray(current) || typeof current !== "object") {
      return undefined;
    }
    current = current[key] as SessionJsonValue;
  }
  return textValue(current);
}

function mapCodexType(
  topLevelType: string,
  payload: SessionJsonObject,
): SessionRecordType {
  const nestedType = textValue(payload.type);
  if (topLevelType === "session_meta") return "session.manifest";
  if (topLevelType === "world_state") return "session.world_state";
  if (topLevelType === "turn_context") return "turn.settings";
  if (topLevelType === "compacted") return "compaction.window";
  if (topLevelType === "inter_agent_communication_metadata") {
    return "subagent.message";
  }
  if (topLevelType === "response_item") {
    if (nestedType === "message") {
      return payload.role === "user" ? "message.user" : "message.assistant";
    }
    if (nestedType === "agent_message") return "message.assistant";
    if (nestedType === "reasoning") return "message.reasoning";
    if (nestedType === "function_call" || nestedType === "custom_tool_call") {
      return "tool.call";
    }
    if (
      nestedType === "function_call_output" ||
      nestedType === "custom_tool_call_output"
    ) {
      return "tool.result";
    }
    return "codex.opaque";
  }
  if (topLevelType === "event_msg") {
    const mapping: Record<string, SessionRecordType> = {
      task_started: "turn.started",
      task_complete: "turn.completed",
      task_aborted: "turn.aborted",
      user_message: "message.user",
      agent_message: "message.assistant",
      agent_reasoning: "message.reasoning",
      token_count: "usage",
      rate_limit: "rate_limit",
      context_compacted: "compaction.completed",
      mcp_tool_call_begin: "tool.call",
      mcp_tool_call_end: "tool.result",
      sub_agent_activity: "subagent.status",
      approval_request: "approval.requested",
      approval_response: "approval.resolved",
    };
    return nestedType ? mapping[nestedType] ?? "codex.opaque" : "codex.opaque";
  }
  return "codex.opaque";
}

function firstIdentifier(
  payload: SessionJsonObject,
  paths: readonly (readonly string[])[],
): string | undefined {
  for (const path of paths) {
    const value = nestedText(payload, path);
    if (value) return value;
  }
  return undefined;
}

/**
 * Convert a Codex rollout to a deterministic Flary integrity chain.
 *
 * Known records get a Flary type. Unknown records keep their source type and
 * redacted source structure in a `codex.opaque` record.
 */
export async function importCodexRollout(
  input: string,
  options: CodexRolloutImportOptions,
): Promise<SessionRecord[]> {
  const sources: Array<{
    lineNumber: number;
    record: CodexRolloutRecord;
    source: SessionJsonObject;
  }> = [];

  for (const [index, sourceLine] of input.split(/\r?\n/).entries()) {
    const line = sourceLine.trim();
    if (line.length === 0) continue;
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch (error) {
      throw new CodexRolloutImportError(
        index + 1,
        error instanceof Error ? error.message : "Invalid JSON",
      );
    }
    const source = objectValue(value);
    if (Object.keys(source).length === 0) {
      throw new CodexRolloutImportError(index + 1, "Expected a JSON object");
    }
    sources.push({
      lineNumber: index + 1,
      record: source as CodexRolloutRecord,
      source,
    });
  }

  const manifest = sources.find(({ record }) => record.type === "session_meta");
  const manifestPayload = objectValue(manifest?.record.payload);
  const sessionId =
    options.sessionId ??
    textValue(manifestPayload.session_id) ??
    textValue(manifestPayload.id) ??
    "codex-import";
  const threadId =
    options.threadId ??
    textValue(manifestPayload.id) ??
    textValue(manifestPayload.session_id) ??
    sessionId;
  const fallbackTimestamp =
    options.fallbackTimestamp ?? "1970-01-01T00:00:00.000Z";
  const sourceRevision = options.sourceRevision ?? "codex-rollout/v1";
  const output: SessionRecord[] = [];
  let previousHash: string | null = null;

  for (const { lineNumber, record, source } of sources) {
    const payload = objectValue(record.payload);
    const topLevelType =
      typeof record.type === "string" && record.type.length > 0
        ? record.type
        : "unknown";
    const redactedSource = redactCodexRolloutValue(source);
    const publicPayload = SessionJsonObjectSchema.parse({
      codexType: topLevelType,
      codexPayloadType: textValue(payload.type) ?? null,
      source: redactedSource,
    });
    const encryptedContentRef = options.storeEncryptedContent
      ? await options.storeEncryptedContent(source, lineNumber)
      : undefined;
    const recordedAt =
      typeof record.timestamp === "string"
        ? record.timestamp
        : textValue(payload.timestamp) ?? fallbackTimestamp;
    const recordType = mapCodexType(topLevelType, payload);
    const turnId = firstIdentifier(payload, [
      ["turn_id"],
      ["internal_chat_message_metadata_passthrough", "turn_id"],
    ]);
    const toolCallId = recordType.startsWith("tool.")
      ? firstIdentifier(payload, [
          ["call_id"],
          ["tool_call_id"],
          ["id"],
        ])
      : undefined;
    const agentId = firstIdentifier(payload, [
      ["agent_id"],
      ["agent_path"],
      ["source", "subagent", "thread_spawn", "agent_path"],
    ]);
    const parentId = firstIdentifier(payload, [
      ["parent_thread_id"],
      ["forked_from_id"],
      ["source", "subagent", "thread_spawn", "parent_thread_id"],
    ]);
    let sealed: SessionRecord;
    try {
      const draft: SessionRecordDraft = {
        schemaVersion: SESSION_LEDGER_SCHEMA_VERSION,
        format: SESSION_LEDGER_FORMAT,
        tenantId: options.tenantId,
        applicationId: options.applicationId,
        sessionId,
        threadId,
        sourceCursor: `codex:${lineNumber}`,
        recordType,
        recordedAt,
        attempt: 0,
        sourceRevision,
        publicPayload,
        ...(turnId ? { turnId } : {}),
        ...(toolCallId ? { toolCallId } : {}),
        ...(agentId ? { agentId } : {}),
        ...(parentId ? { parentId } : {}),
        ...(encryptedContentRef ? { encryptedContentRef } : {}),
      };
      sealed = await sealSessionRecord(
        draft,
        output.length + 1,
        previousHash,
      );
    } catch (error) {
      throw new CodexRolloutImportError(
        lineNumber,
        error instanceof Error ? error.message : "The record is invalid",
      );
    }
    output.push(sealed);
    previousHash = sealed.recordHash;
  }
  return output;
}

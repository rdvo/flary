export type FlaryUiJson =
  | null
  | boolean
  | number
  | string
  | FlaryUiJson[]
  | { [key: string]: FlaryUiJson };

export interface FlaryUiRecord {
  sequence: number;
  type: string;
  occurredAt?: string;
  payload: Record<string, unknown>;
}

export interface FlaryUiMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  sequence: number;
  optimistic?: boolean;
}

export interface FlaryUiActivity {
  id: string;
  label: string;
  kind: "reasoning" | "tool" | "approval" | "checkpoint" | "error";
  state: "running" | "completed" | "waiting" | "failed";
  sequence: number;
  durationMs?: number;
  request?: FlaryUiJson;
  response?: FlaryUiJson;
  detail?: string;
  approvalId?: string;
}

export interface FlaryUiTurn {
  id: string;
  startedAt?: string;
  completedAt?: string;
  status: "working" | "completed" | "waiting" | "failed";
  messages: FlaryUiMessage[];
  activity: FlaryUiActivity[];
  error?: string;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function json(value: unknown): FlaryUiJson | undefined {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value)) as FlaryUiJson;
  } catch {
    return undefined;
  }
}

function content(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(content).join("");
  const valueObject = object(value);
  return (
    text(valueObject.text) ||
    text(valueObject.delta) ||
    content(valueObject.parts ?? valueObject.content ?? valueObject.message)
  );
}

export function normalizeFlaryUiRecords(
  values: readonly unknown[]
): FlaryUiRecord[] {
  return values
    .flatMap((value) => {
      const record = object(value);
      const sequence = Number(record.sequence ?? record.sessionSequence);
      const type = text(record.recordType ?? record.type);
      if (!Number.isSafeInteger(sequence) || sequence <= 0 || !type) return [];
      return [
        {
          sequence,
          type,
          ...(text(record.occurredAt ?? record.recordedAt)
            ? { occurredAt: text(record.occurredAt ?? record.recordedAt) }
            : {}),
          payload: object(record.publicPayload ?? record.payload),
        },
      ];
    })
    .sort((left, right) => left.sequence - right.sequence);
}

export function mergeFlaryUiRecords(
  current: readonly FlaryUiRecord[],
  incoming: readonly FlaryUiRecord[]
): FlaryUiRecord[] {
  if (!incoming.length) return [...current];
  const records = new Map(current.map((record) => [record.sequence, record]));
  for (const record of incoming) records.set(record.sequence, record);
  return [...records.values()].sort(
    (left, right) => left.sequence - right.sequence
  );
}

function safeError(value: unknown): string {
  const message = text(value) || text(object(value).message);
  if (
    /<\/?(?:html|head|body|style|svg)\b/i.test(message) ||
    /ray id:/i.test(message)
  ) {
    return "The provider rejected the request. Check the selected connection.";
  }
  return message.replace(/\s+/g, " ").trim().slice(0, 1_000);
}

function toolIdentity(record: FlaryUiRecord) {
  const call = object(record.payload.call);
  const result = object(record.payload.result);
  const input = object(call.arguments ?? result.input ?? record.payload.input);
  const wrapper =
    text(
      call.toolId ??
        result.toolId ??
        record.payload.toolId ??
        record.payload.toolName
    ) || "tool";
  const nested = /^(?:flary__)?tool_(?:call|batch)$/.test(wrapper)
    ? text(input.id ?? input.toolId)
    : "";
  const name = (nested || wrapper).replace(/^flary__/, "");
  return {
    id:
      text(call.id ?? result.callId ?? record.payload.callId) ||
      `${name}:${record.sequence}`,
    name,
    input: nested ? object(input.input ?? input.arguments) : input,
    result,
  };
}

function friendlyTool(name: string, state: FlaryUiActivity["state"]): string {
  const normalized = name.replaceAll(/[._-]+/g, " ").trim();
  const past = state === "completed";
  const failed = state === "failed";
  if (/search/i.test(normalized))
    return failed
      ? "Tool search failed"
      : past
      ? "Searched tools"
      : "Searching tools";
  if (/describe/i.test(normalized))
    return failed
      ? "Tool schema failed"
      : past
      ? "Loaded tool schema"
      : "Loading tool schema";
  if (/read/i.test(normalized))
    return failed
      ? "Read failed"
      : past
      ? `Read with ${normalized}`
      : `Reading with ${normalized}`;
  if (/write|edit/i.test(normalized))
    return failed
      ? "Edit failed"
      : past
      ? `Edited with ${normalized}`
      : `Editing with ${normalized}`;
  return failed
    ? `${normalized} failed`
    : past
    ? `Used ${normalized}`
    : `Using ${normalized}`;
}

function recordFailure(record: FlaryUiRecord): string {
  const response = object(record.payload.response);
  const result = object(record.payload.result);
  return safeError(
    record.payload.error ??
      result.error ??
      response.error ??
      record.payload.message
  );
}

function turnId(record: FlaryUiRecord): string {
  return (
    text(record.payload.turnId ?? record.payload.runId) ||
    `turn:${record.sequence}`
  );
}

/** Convert the durable public ledger into a stable chat and work timeline. */
export function projectFlaryUiTurns(
  records: readonly FlaryUiRecord[]
): FlaryUiTurn[] {
  const turns: FlaryUiTurn[] = [];
  let current: FlaryUiTurn | undefined;
  let assistant: FlaryUiMessage | undefined;
  const activities = new Map<string, number>();

  const ensureTurn = (record: FlaryUiRecord) => {
    if (!current) {
      current = {
        id: turnId(record),
        ...(record.occurredAt ? { startedAt: record.occurredAt } : {}),
        status: "working",
        messages: [],
        activity: [],
      };
      turns.push(current);
      activities.clear();
      assistant = undefined;
    }
    return current;
  };

  for (const record of records) {
    if (record.type === "turn.started" || record.type === "message.user") {
      if (
        record.type === "turn.started" &&
        current?.status === "working" &&
        current.messages.length === 0
      )
        continue;
      if (
        !current ||
        current.status !== "working" ||
        (record.type === "message.user" &&
          current.messages.some((message) => message.role === "user"))
      ) {
        current = undefined;
      }
      const turn = ensureTurn(record);
      if (record.type === "message.user") {
        const messageText = content(
          record.payload.message ??
            record.payload.content ??
            record.payload.text
        );
        if (messageText)
          turn.messages.push({
            id: `user:${record.sequence}`,
            role: "user",
            text: messageText,
            sequence: record.sequence,
          });
      }
      continue;
    }

    const relevant =
      record.type.includes("reasoning") ||
      record.type === "tool.search" ||
      record.type === "tool.describe" ||
      record.type === "tool.batch" ||
      record.type.startsWith("codemode.") ||
      record.type === "tool.call" ||
      record.type === "tool.result" ||
      record.type === "approval.requested" ||
      record.type === "input.requested" ||
      record.type.includes("checkpoint") ||
      record.type === "message.assistant" ||
      record.type.includes("assistant") ||
      record.type === "turn.failed" ||
      record.type === "run.failed" ||
      record.type === "turn.aborted" ||
      record.type === "turn.completed";
    if (!relevant) continue;

    const turn = ensureTurn(record);
    if (record.type.includes("reasoning")) {
      const summary =
        text(record.payload.summary) ||
        content(record.payload.message ?? record.payload.text) ||
        "Thinking";
      const key = "reasoning";
      const index = activities.get(key);
      const next: FlaryUiActivity = {
        id: key,
        label: summary.slice(0, 240),
        kind: "reasoning",
        state: "running",
        sequence: record.sequence,
      };
      if (index === undefined) {
        activities.set(key, turn.activity.length);
        turn.activity.push(next);
      } else turn.activity[index] = next;
      continue;
    }

    if (
      record.type === "tool.search" ||
      record.type === "tool.describe" ||
      record.type === "tool.batch"
    ) {
      const durationMs = number(record.payload.durationMs);
      const failed =
        text(record.payload.state) === "failed" ||
        Boolean(record.payload.error);
      const label =
        record.type === "tool.search"
          ? `Searched tools${
              number(record.payload.resultCount) !== undefined
                ? ` · ${number(record.payload.resultCount)} found`
                : ""
            }`
          : record.type === "tool.describe"
          ? `Loaded ${text(record.payload.toolId) || "tool schema"}`
          : failed
          ? "Parallel tool batch failed"
          : `Ran ${number(record.payload.callCount) ?? 0} tools in parallel`;
      turn.activity.push({
        id: `${record.type}:${record.sequence}`,
        label,
        kind: "tool",
        state: failed ? "failed" : "completed",
        sequence: record.sequence,
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(json(
          record.payload.query ? { query: record.payload.query } : undefined
        ) !== undefined
          ? { request: json({ query: record.payload.query }) }
          : {}),
        ...(json(record.payload) !== undefined
          ? { response: json(record.payload) }
          : {}),
        ...(failed && recordFailure(record)
          ? { detail: recordFailure(record) }
          : {}),
      });
      continue;
    }

    if (record.type.startsWith("codemode.")) {
      const executionId = text(record.payload.executionId) || "current";
      const key = `codemode:${executionId}`;
      const index = activities.get(key);
      const state: FlaryUiActivity["state"] = record.type.endsWith("failed")
        ? "failed"
        : record.type.endsWith("paused")
        ? "waiting"
        : record.type.endsWith("completed")
        ? "completed"
        : "running";
      const next: FlaryUiActivity = {
        id: key,
        label:
          state === "failed"
            ? "Code Mode failed"
            : state === "waiting"
            ? "Code Mode needs approval"
            : state === "completed"
            ? "Completed Code Mode"
            : "Running Code Mode",
        kind: "tool",
        state,
        sequence: record.sequence,
        ...(number(record.payload.durationMs) !== undefined
          ? { durationMs: number(record.payload.durationMs) }
          : {}),
        ...(json(record.payload.usage) !== undefined
          ? { response: json(record.payload.usage) }
          : {}),
        ...(state === "failed" && recordFailure(record)
          ? { detail: recordFailure(record) }
          : {}),
      };
      if (index === undefined) {
        activities.set(key, turn.activity.length);
        turn.activity.push(next);
      } else turn.activity[index] = next;
      continue;
    }

    if (record.type === "tool.call") {
      const tool = toolIdentity(record);
      const key = `tool:${tool.id}`;
      activities.set(key, turn.activity.length);
      turn.activity.push({
        id: key,
        label: friendlyTool(tool.name, "running"),
        kind: "tool",
        state: "running",
        sequence: record.sequence,
        ...(Object.keys(tool.input).length
          ? { request: json(tool.input) }
          : {}),
      });
      continue;
    }

    if (record.type === "tool.result") {
      const tool = toolIdentity(record);
      const key = `tool:${tool.id}`;
      const index = activities.get(key);
      const failed =
        Boolean(tool.result.error) ||
        ["failed", "error"].includes(
          text(tool.result.status ?? record.payload.outcome).toLowerCase()
        );
      const next: FlaryUiActivity = {
        id: key,
        label: friendlyTool(tool.name, failed ? "failed" : "completed"),
        kind: "tool",
        state: failed ? "failed" : "completed",
        sequence: record.sequence,
        ...(Object.keys(tool.input).length
          ? { request: json(tool.input) }
          : {}),
        ...(json(
          tool.result.output ?? tool.result.value ?? tool.result.data
        ) !== undefined
          ? {
              response: json(
                tool.result.output ?? tool.result.value ?? tool.result.data
              ),
            }
          : {}),
        ...(failed && recordFailure(record)
          ? { detail: recordFailure(record) }
          : {}),
      };
      if (index === undefined) {
        activities.set(key, turn.activity.length);
        turn.activity.push(next);
      } else turn.activity[index] = next;
      continue;
    }

    if (
      record.type === "approval.requested" ||
      record.type === "input.requested"
    ) {
      const approvalId = text(
        record.payload.approvalId ??
          object(record.payload.request).id ??
          record.payload.requestId
      );
      turn.status = "waiting";
      turn.activity.push({
        id: `${record.type}:${record.sequence}`,
        label:
          record.type === "approval.requested"
            ? "Waiting for approval"
            : "Waiting for input",
        kind: "approval",
        state: "waiting",
        sequence: record.sequence,
        ...(approvalId ? { approvalId } : {}),
        ...(json(record.payload) !== undefined
          ? { request: json(record.payload) }
          : {}),
      });
      continue;
    }

    if (record.type.includes("checkpoint")) {
      turn.activity.push({
        id: `checkpoint:${record.sequence}`,
        label: "Saved a workspace checkpoint",
        kind: "checkpoint",
        state: "completed",
        sequence: record.sequence,
      });
      continue;
    }

    if (
      record.type === "message.assistant" ||
      record.type.includes("assistant")
    ) {
      const delta = text(record.payload.delta);
      const messageText =
        delta ||
        content(
          record.payload.message ??
            record.payload.content ??
            record.payload.text
        );
      if (!messageText) continue;
      if (delta) {
        if (!assistant) {
          assistant = {
            id: `assistant:${record.sequence}`,
            role: "assistant",
            text: "",
            sequence: record.sequence,
          };
          turn.messages.push(assistant);
        }
        assistant.text += delta;
      } else if (
        !turn.messages.some(
          (message) =>
            message.role === "assistant" && message.text === messageText
        )
      ) {
        assistant = {
          id: `assistant:${record.sequence}`,
          role: "assistant",
          text: messageText,
          sequence: record.sequence,
        };
        turn.messages.push(assistant);
      }
      continue;
    }

    const failure = recordFailure(record);
    if (
      record.type === "turn.failed" ||
      record.type === "run.failed" ||
      record.type === "turn.aborted"
    ) {
      turn.status = "failed";
      turn.error =
        failure ||
        (record.type === "turn.aborted"
          ? "The turn was stopped."
          : "The turn failed.");
    } else if (record.type === "turn.completed") {
      turn.status = "completed";
      turn.completedAt = record.occurredAt;
      for (const item of turn.activity)
        if (item.state === "running") item.state = "completed";
      current = undefined;
      assistant = undefined;
    }
  }
  return turns.filter(
    (turn) => turn.messages.length || turn.activity.length || turn.error
  );
}

export function flaryUiTurnIsActive(turns: readonly FlaryUiTurn[]): boolean {
  const status = turns.at(-1)?.status;
  return status === "working" || status === "waiting";
}

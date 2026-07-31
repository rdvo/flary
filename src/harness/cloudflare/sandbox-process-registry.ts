import { z } from "zod";

import {
  IdentifierSchema,
  JsonObjectSchema,
  MetadataSchema,
  TimestampSchema,
} from "../contracts/common.js";

export const SandboxEnvironmentHashSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/);
export type SandboxEnvironmentHash = z.infer<
  typeof SandboxEnvironmentHashSchema
>;

export const SandboxProcessStatusSchema = z.enum([
  "queued",
  "running",
  "sleeping",
  "completed",
  "failed",
  "cancelled",
]);
export type SandboxProcessStatus = z.infer<typeof SandboxProcessStatusSchema>;

export const SandboxProcessCreateSchema = z
  .object({
    id: IdentifierSchema,
    runId: IdentifierSchema,
    sandboxId: IdentifierSchema,
    command: z.string().trim().min(1).max(100_000),
    cwd: z.string().trim().min(1).max(1_024).default("/workspace"),
    environmentHash: SandboxEnvironmentHashSchema.optional(),
    metadata: MetadataSchema.optional(),
  })
  .strict();
export type SandboxProcessCreate = z.output<typeof SandboxProcessCreateSchema>;

export const SandboxProcessSchema = SandboxProcessCreateSchema.extend({
  status: SandboxProcessStatusSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  startedAt: TimestampSchema.optional(),
  sleepUntil: TimestampSchema.optional(),
  completedAt: TimestampSchema.optional(),
  exitCode: z.number().int().safe().optional(),
  errorCode: IdentifierSchema.optional(),
  outputBytes: z.number().int().nonnegative(),
  outputTruncated: z.boolean(),
}).strict();
export type SandboxProcess = z.output<typeof SandboxProcessSchema>;

export const SandboxProcessOutputStreamSchema = z.enum(["stdout", "stderr"]);
export type SandboxProcessOutputStream = z.infer<
  typeof SandboxProcessOutputStreamSchema
>;

export const SandboxProcessOutputChunkSchema = z
  .object({
    cursor: z.number().int().positive(),
    processId: IdentifierSchema,
    stream: SandboxProcessOutputStreamSchema,
    text: z.string().max(256 * 1024),
    byteLength: z.number().int().nonnegative(),
    truncated: z.boolean(),
    occurredAt: TimestampSchema,
  })
  .strict();
export type SandboxProcessOutputChunk = z.output<
  typeof SandboxProcessOutputChunkSchema
>;

const SandboxProcessControlBase = {
  id: IdentifierSchema,
  processId: IdentifierSchema,
  requestedAt: TimestampSchema,
  status: z.enum(["pending", "delivered", "failed"]),
  completedAt: TimestampSchema.optional(),
  errorCode: IdentifierSchema.optional(),
} as const;

export const SandboxProcessStdinRequestSchema = z
  .object({
    ...SandboxProcessControlBase,
    kind: z.literal("stdin"),
    data: z
      .string()
      .max(64 * 1024)
      .refine(
        (value) => new TextEncoder().encode(value).byteLength <= 64 * 1024,
        "stdin data must not exceed 64 KiB"
      ),
  })
  .strict();
export type SandboxProcessStdinRequest = z.output<
  typeof SandboxProcessStdinRequestSchema
>;

export const SandboxProcessSignalRequestSchema = z
  .object({
    ...SandboxProcessControlBase,
    kind: z.literal("signal"),
    signal: z.enum([
      "SIGHUP",
      "SIGINT",
      "SIGTERM",
      "SIGKILL",
      "SIGUSR1",
      "SIGUSR2",
      "SIGSTOP",
      "SIGCONT",
    ]),
  })
  .strict();
export type SandboxProcessSignalRequest = z.output<
  typeof SandboxProcessSignalRequestSchema
>;

export const SandboxProcessControlRequestSchema = z.discriminatedUnion("kind", [
  SandboxProcessStdinRequestSchema,
  SandboxProcessSignalRequestSchema,
]);
export type SandboxProcessControlRequest = z.output<
  typeof SandboxProcessControlRequestSchema
>;

export const SandboxProcessLifecycleEventSchema = z
  .object({
    cursor: z.number().int().positive(),
    processId: IdentifierSchema,
    action: z.enum([
      "created",
      "started",
      "slept",
      "woke",
      "completed",
      "failed",
      "cancelled",
    ]),
    fromStatus: SandboxProcessStatusSchema.optional(),
    toStatus: SandboxProcessStatusSchema,
    occurredAt: TimestampSchema,
    details: JsonObjectSchema.optional(),
  })
  .strict();
export type SandboxProcessLifecycleEvent = z.output<
  typeof SandboxProcessLifecycleEventSchema
>;

export interface SandboxProcessRegistryOptions {
  readonly maxOutputBytes?: number;
  readonly maxChunkBytes?: number;
  readonly now?: () => string;
}

export interface SandboxProcessListOptions {
  readonly runId?: string;
  readonly status?: SandboxProcessStatus | readonly SandboxProcessStatus[];
  readonly limit?: number;
}

export interface SandboxProcessOutputReadOptions {
  readonly afterCursor?: number;
  readonly limit?: number;
}

interface SqlRows<T> {
  toArray(): T[];
}

interface SqlStorage {
  exec<T = Record<string, unknown>>(
    query: string,
    ...bindings: unknown[]
  ): SqlRows<T>;
}

interface ProcessRow {
  record_json: string;
}

interface OutputRow {
  cursor: number;
  process_id: string;
  stream: SandboxProcessOutputStream;
  text: string;
  byte_length: number;
  truncated: number;
  occurred_at: string;
}

interface OutputStateRow {
  total_bytes: number;
  truncated: number;
}

interface ControlRow {
  request_json: string;
}

interface LifecycleRow {
  event_json: string;
}

const terminalStatuses = new Set<SandboxProcessStatus>([
  "completed",
  "failed",
  "cancelled",
]);

/**
 * Durable process state for Cloudflare Sandbox sessions.
 *
 * The registry keeps process metadata and control requests. The executor owns
 * the live process handle. Raw environment values are not accepted or stored.
 */
export class SqliteSandboxProcessRegistry {
  readonly #sql: SqlStorage;
  readonly #maxOutputBytes: number;
  readonly #maxChunkBytes: number;
  readonly #now: () => string;

  constructor(sql: unknown, options: SandboxProcessRegistryOptions = {}) {
    this.#sql = sql as SqlStorage;
    this.#maxOutputBytes = boundedPositiveLimit(
      options.maxOutputBytes,
      1024 * 1024,
      10 * 1024 * 1024,
      "maxOutputBytes"
    );
    this.#maxChunkBytes = boundedPositiveLimit(
      options.maxChunkBytes,
      64 * 1024,
      256 * 1024,
      "maxChunkBytes"
    );
    if (this.#maxChunkBytes > this.#maxOutputBytes) {
      throw new RangeError(
        "maxChunkBytes must not be larger than maxOutputBytes"
      );
    }
    if (this.#maxChunkBytes < 4) {
      throw new RangeError(
        "maxChunkBytes must be at least 4 to preserve UTF-8 characters"
      );
    }
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#sql.exec(`
      CREATE TABLE IF NOT EXISTS flary_sandbox_processes (
        process_id TEXT PRIMARY KEY NOT NULL,
        run_id TEXT NOT NULL,
        sandbox_id TEXT NOT NULL,
        status TEXT NOT NULL,
        record_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS flary_sandbox_processes_run
      ON flary_sandbox_processes (run_id, created_at, process_id);
      CREATE INDEX IF NOT EXISTS flary_sandbox_processes_status
      ON flary_sandbox_processes (status, created_at, process_id);
      CREATE TABLE IF NOT EXISTS flary_sandbox_process_output (
        cursor INTEGER PRIMARY KEY AUTOINCREMENT,
        process_id TEXT NOT NULL,
        stream TEXT NOT NULL,
        text TEXT NOT NULL,
        byte_length INTEGER NOT NULL,
        truncated INTEGER NOT NULL,
        occurred_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS flary_sandbox_process_output_replay
      ON flary_sandbox_process_output (process_id, cursor);
      CREATE TABLE IF NOT EXISTS flary_sandbox_process_control (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT NOT NULL UNIQUE,
        process_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        request_json TEXT NOT NULL,
        requested_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS flary_sandbox_process_control_pending
      ON flary_sandbox_process_control (process_id, status, sequence);
      CREATE TABLE IF NOT EXISTS flary_sandbox_process_lifecycle (
        cursor INTEGER PRIMARY KEY AUTOINCREMENT,
        process_id TEXT NOT NULL,
        from_status TEXT,
        to_status TEXT NOT NULL,
        action TEXT NOT NULL,
        event_json TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS flary_sandbox_process_lifecycle_replay
      ON flary_sandbox_process_lifecycle (process_id, cursor);
    `);
  }

  async create(input: SandboxProcessCreate): Promise<SandboxProcess> {
    const parsed = SandboxProcessCreateSchema.parse(input);
    if (await this.get(parsed.id)) {
      throw new Error(`Sandbox process '${parsed.id}' already exists`);
    }
    const now = TimestampSchema.parse(this.#now());
    const process = SandboxProcessSchema.parse({
      ...parsed,
      status: "queued",
      createdAt: now,
      updatedAt: now,
      outputBytes: 0,
      outputTruncated: false,
    });
    this.#insertProcess(process);
    this.#appendLifecycle({
      processId: process.id,
      action: "created",
      toStatus: "queued",
      occurredAt: now,
    });
    return clone(process);
  }

  async get(processId: string): Promise<SandboxProcess | undefined> {
    const id = IdentifierSchema.parse(processId);
    const row = this.#sql
      .exec<ProcessRow>(
        `SELECT record_json
         FROM flary_sandbox_processes
         WHERE process_id = ?`,
        id
      )
      .toArray()[0];
    if (!row) return undefined;
    const process = SandboxProcessSchema.parse(JSON.parse(row.record_json));
    const output = this.#sql
      .exec<OutputStateRow>(
        `SELECT COALESCE(SUM(byte_length), 0) AS total_bytes,
                COALESCE(MAX(truncated), 0) AS truncated
         FROM flary_sandbox_process_output
         WHERE process_id = ?`,
        id
      )
      .toArray()[0];
    return SandboxProcessSchema.parse({
      ...process,
      outputBytes: Number(output?.total_bytes ?? process.outputBytes),
      outputTruncated: Boolean(output?.truncated) || process.outputTruncated,
    });
  }

  async list(
    options: SandboxProcessListOptions = {}
  ): Promise<readonly SandboxProcess[]> {
    const limit = readLimit(options.limit, 100, 1_000);
    const conditions: string[] = [];
    const bindings: unknown[] = [];
    if (options.runId !== undefined) {
      conditions.push("run_id = ?");
      bindings.push(IdentifierSchema.parse(options.runId));
    }
    if (options.status !== undefined) {
      const statuses = Array.isArray(options.status)
        ? [...options.status]
        : [options.status];
      if (statuses.length === 0) return [];
      const parsed = statuses.map((status) =>
        SandboxProcessStatusSchema.parse(status)
      );
      conditions.push(`status IN (${parsed.map(() => "?").join(", ")})`);
      bindings.push(...parsed);
    }
    bindings.push(limit);
    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    return this.#sql
      .exec<ProcessRow>(
        `SELECT record_json
         FROM flary_sandbox_processes
         ${where}
         ORDER BY created_at ASC, process_id ASC
         LIMIT ?`,
        ...bindings
      )
      .toArray()
      .map((row) => SandboxProcessSchema.parse(JSON.parse(row.record_json)));
  }

  async start(processId: string): Promise<SandboxProcess> {
    return this.#transition(
      processId,
      ["queued"],
      "running",
      "started",
      (process, now) => ({ ...process, startedAt: now })
    );
  }

  async sleep(processId: string, sleepUntil?: string): Promise<SandboxProcess> {
    const until =
      sleepUntil === undefined ? undefined : TimestampSchema.parse(sleepUntil);
    return this.#transition(
      processId,
      ["running"],
      "sleeping",
      "slept",
      (process) => ({ ...process, sleepUntil: until }),
      until ? { sleepUntil: until } : undefined
    );
  }

  async wake(processId: string): Promise<SandboxProcess> {
    return this.#transition(
      processId,
      ["sleeping"],
      "running",
      "woke",
      (process) => {
        const { sleepUntil: _sleepUntil, ...rest } = process;
        return rest;
      }
    );
  }

  async complete(processId: string, exitCode = 0): Promise<SandboxProcess> {
    if (!Number.isSafeInteger(exitCode)) {
      throw new RangeError("Sandbox process exit code must be an integer");
    }
    return this.#transition(
      processId,
      ["running", "sleeping"],
      "completed",
      "completed",
      (process, now) => {
        const {
          sleepUntil: _sleepUntil,
          errorCode: _errorCode,
          ...rest
        } = process;
        return { ...rest, exitCode, completedAt: now };
      },
      { exitCode }
    );
  }

  async fail(
    processId: string,
    errorCode: string,
    exitCode?: number
  ): Promise<SandboxProcess> {
    const error = IdentifierSchema.parse(errorCode);
    if (exitCode !== undefined && !Number.isSafeInteger(exitCode)) {
      throw new RangeError("Sandbox process exit code must be an integer");
    }
    return this.#transition(
      processId,
      ["queued", "running", "sleeping"],
      "failed",
      "failed",
      (process, now) => {
        const { sleepUntil: _sleepUntil, ...rest } = process;
        return {
          ...rest,
          errorCode: error,
          exitCode,
          completedAt: now,
        };
      },
      { errorCode: error, ...(exitCode === undefined ? {} : { exitCode }) }
    );
  }

  async cancel(processId: string): Promise<SandboxProcess> {
    return this.#transition(
      processId,
      ["queued", "running", "sleeping"],
      "cancelled",
      "cancelled",
      (process, now) => {
        const { sleepUntil: _sleepUntil, ...rest } = process;
        return { ...rest, completedAt: now };
      }
    );
  }

  async appendOutput(input: {
    processId: string;
    stream: SandboxProcessOutputStream;
    text: string;
    occurredAt?: string;
  }): Promise<readonly SandboxProcessOutputChunk[]> {
    const process = await this.#requireProcess(input.processId);
    if (!["running", "sleeping"].includes(process.status)) {
      throw new Error(
        `Sandbox process '${process.id}' cannot accept output while ${process.status}`
      );
    }
    const stream = SandboxProcessOutputStreamSchema.parse(input.stream);
    const occurredAt = TimestampSchema.parse(input.occurredAt ?? this.#now());
    let remaining =
      this.#maxOutputBytes -
      Math.min(process.outputBytes, this.#maxOutputBytes);
    const encoded = new TextEncoder().encode(input.text);
    if (encoded.byteLength === 0 || process.outputTruncated) return [];
    const acceptedLength = Math.min(encoded.byteLength, remaining);
    const accepted = encoded.slice(0, acceptedLength);
    const chunks: SandboxProcessOutputChunk[] = [];
    let offset = 0;
    while (offset < accepted.byteLength) {
      const end = Math.min(offset + this.#maxChunkBytes, accepted.byteLength);
      const safeEnd = utf8Boundary(accepted, offset, end);
      if (safeEnd === offset) break;
      const bytes = accepted.slice(offset, safeEnd);
      const isLast = safeEnd === accepted.byteLength;
      const truncated = isLast && acceptedLength < encoded.byteLength;
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const row = this.#sql
        .exec<{ cursor: number }>(
          `INSERT INTO flary_sandbox_process_output
            (process_id, stream, text, byte_length, truncated, occurred_at)
           VALUES (?, ?, ?, ?, ?, ?)
           RETURNING cursor`,
          process.id,
          stream,
          text,
          bytes.byteLength,
          truncated ? 1 : 0,
          occurredAt
        )
        .toArray()[0];
      if (!row) {
        throw new Error(
          `Output for sandbox process '${process.id}' was not stored`
        );
      }
      chunks.push(
        SandboxProcessOutputChunkSchema.parse({
          cursor: Number(row.cursor),
          processId: process.id,
          stream,
          text,
          byteLength: bytes.byteLength,
          truncated,
          occurredAt,
        })
      );
      offset = safeEnd;
      remaining -= bytes.byteLength;
    }

    const outputTruncated =
      acceptedLength < encoded.byteLength || offset < accepted.byteLength;
    if (outputTruncated && !chunks.some((chunk) => chunk.truncated)) {
      const row = this.#sql
        .exec<{ cursor: number }>(
          `INSERT INTO flary_sandbox_process_output
            (process_id, stream, text, byte_length, truncated, occurred_at)
           VALUES (?, ?, '', 0, 1, ?)
           RETURNING cursor`,
          process.id,
          stream,
          occurredAt
        )
        .toArray()[0];
      if (!row) {
        throw new Error(
          `Output marker for sandbox process '${process.id}' was not stored`
        );
      }
      chunks.push(
        SandboxProcessOutputChunkSchema.parse({
          cursor: Number(row.cursor),
          processId: process.id,
          stream,
          text: "",
          byteLength: 0,
          truncated: true,
          occurredAt,
        })
      );
    }

    const consumed = chunks.reduce(
      (total, chunk) => total + chunk.byteLength,
      0
    );
    this.#updateProcess({
      ...process,
      outputBytes: process.outputBytes + consumed,
      outputTruncated: process.outputTruncated || outputTruncated,
      updatedAt: occurredAt,
    });
    return chunks.map(clone);
  }

  async readOutput(
    processId: string,
    options: SandboxProcessOutputReadOptions = {}
  ): Promise<readonly SandboxProcessOutputChunk[]> {
    const id = IdentifierSchema.parse(processId);
    await this.#requireProcess(id);
    const afterCursor = cursor(options.afterCursor);
    const limit = readLimit(options.limit, 100, 1_000);
    return this.#sql
      .exec<OutputRow>(
        `SELECT cursor, process_id, stream, text, byte_length,
                truncated, occurred_at
         FROM flary_sandbox_process_output
         WHERE process_id = ? AND cursor > ?
         ORDER BY cursor ASC
         LIMIT ?`,
        id,
        afterCursor,
        limit
      )
      .toArray()
      .map((row) =>
        SandboxProcessOutputChunkSchema.parse({
          cursor: Number(row.cursor),
          processId: row.process_id,
          stream: row.stream,
          text: row.text,
          byteLength: Number(row.byte_length),
          truncated: Boolean(row.truncated),
          occurredAt: row.occurred_at,
        })
      );
  }

  async requestStdin(input: {
    id: string;
    processId: string;
    data: string;
    requestedAt?: string;
  }): Promise<SandboxProcessControlRequest> {
    return this.#createControl({
      id: input.id,
      processId: input.processId,
      kind: "stdin",
      data: input.data,
      status: "pending",
      requestedAt: input.requestedAt ?? this.#now(),
    });
  }

  async requestSignal(input: {
    id: string;
    processId: string;
    signal: z.input<typeof SandboxProcessSignalRequestSchema>["signal"];
    requestedAt?: string;
  }): Promise<SandboxProcessControlRequest> {
    return this.#createControl({
      id: input.id,
      processId: input.processId,
      kind: "signal",
      signal: input.signal,
      status: "pending",
      requestedAt: input.requestedAt ?? this.#now(),
    });
  }

  async listControlRequests(
    processId: string,
    options: {
      status?: SandboxProcessControlRequest["status"];
      limit?: number;
    } = {}
  ): Promise<readonly SandboxProcessControlRequest[]> {
    const id = IdentifierSchema.parse(processId);
    const status =
      options.status === undefined
        ? undefined
        : z.enum(["pending", "delivered", "failed"]).parse(options.status);
    const limit = readLimit(options.limit, 100, 1_000);
    return this.#sql
      .exec<ControlRow>(
        `SELECT request_json
         FROM flary_sandbox_process_control
         WHERE process_id = ?
           ${status === undefined ? "" : "AND status = ?"}
         ORDER BY sequence ASC
         LIMIT ?`,
        id,
        ...(status === undefined ? [] : [status]),
        limit
      )
      .toArray()
      .map((row) =>
        SandboxProcessControlRequestSchema.parse(JSON.parse(row.request_json))
      );
  }

  async resolveControlRequest(input: {
    requestId: string;
    status: "delivered" | "failed";
    errorCode?: string;
    completedAt?: string;
  }): Promise<SandboxProcessControlRequest> {
    const requestId = IdentifierSchema.parse(input.requestId);
    const row = this.#sql
      .exec<ControlRow>(
        `SELECT request_json
         FROM flary_sandbox_process_control
         WHERE request_id = ?`,
        requestId
      )
      .toArray()[0];
    if (!row) {
      throw new Error(`Sandbox control request '${requestId}' was not found`);
    }
    const current = SandboxProcessControlRequestSchema.parse(
      JSON.parse(row.request_json)
    );
    if (current.status !== "pending") return current;
    const completedAt = TimestampSchema.parse(input.completedAt ?? this.#now());
    const resolved = SandboxProcessControlRequestSchema.parse({
      ...current,
      status: input.status,
      completedAt,
      errorCode:
        input.status === "failed"
          ? IdentifierSchema.parse(input.errorCode ?? "delivery_failed")
          : undefined,
    });
    this.#sql.exec(
      `UPDATE flary_sandbox_process_control
       SET status = ?, request_json = ?
       WHERE request_id = ? AND status = 'pending'`,
      resolved.status,
      JSON.stringify(resolved),
      requestId
    );
    return clone(resolved);
  }

  async readLifecycle(
    processId: string,
    options: SandboxProcessOutputReadOptions = {}
  ): Promise<readonly SandboxProcessLifecycleEvent[]> {
    const id = IdentifierSchema.parse(processId);
    const afterCursor = cursor(options.afterCursor);
    const limit = readLimit(options.limit, 100, 1_000);
    return this.#sql
      .exec<LifecycleRow>(
        `SELECT event_json
         FROM flary_sandbox_process_lifecycle
         WHERE process_id = ? AND cursor > ?
         ORDER BY cursor ASC
         LIMIT ?`,
        id,
        afterCursor,
        limit
      )
      .toArray()
      .map((row) =>
        SandboxProcessLifecycleEventSchema.parse(JSON.parse(row.event_json))
      );
  }

  async #createControl(
    input: z.input<typeof SandboxProcessControlRequestSchema>
  ): Promise<SandboxProcessControlRequest> {
    const request = SandboxProcessControlRequestSchema.parse(input);
    const existing = this.#sql
      .exec<ControlRow>(
        `SELECT request_json
         FROM flary_sandbox_process_control
         WHERE request_id = ?`,
        request.id
      )
      .toArray()[0];
    if (existing) {
      const stored = SandboxProcessControlRequestSchema.parse(
        JSON.parse(existing.request_json)
      );
      const sameRequest =
        stored.processId === request.processId &&
        stored.kind === request.kind &&
        (stored.kind === "stdin"
          ? request.kind === "stdin" && stored.data === request.data
          : request.kind === "signal" && stored.signal === request.signal);
      if (sameRequest) return stored;
      throw new Error(`Sandbox control request '${request.id}' already exists`);
    }
    const process = await this.#requireProcess(request.processId);
    if (!["running", "sleeping"].includes(process.status)) {
      throw new Error(
        `Sandbox process '${process.id}' cannot accept control requests while ${process.status}`
      );
    }
    this.#sql.exec(
      `INSERT INTO flary_sandbox_process_control
        (request_id, process_id, kind, status, request_json, requested_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      request.id,
      request.processId,
      request.kind,
      request.status,
      JSON.stringify(request),
      request.requestedAt
    );
    return clone(request);
  }

  async #transition(
    processId: string,
    allowed: readonly SandboxProcessStatus[],
    target: SandboxProcessStatus,
    action: SandboxProcessLifecycleEvent["action"],
    update: (
      process: SandboxProcess,
      now: string
    ) => Omit<SandboxProcess, "status" | "updatedAt">,
    details?: Record<string, string | number | boolean | null>
  ): Promise<SandboxProcess> {
    const process = await this.#requireProcess(processId);
    if (process.status === target) return process;
    if (
      terminalStatuses.has(process.status) ||
      !allowed.includes(process.status)
    ) {
      throw new Error(
        `Sandbox process '${process.id}' cannot move from ${process.status} to ${target}`
      );
    }
    const now = TimestampSchema.parse(this.#now());
    const next = SandboxProcessSchema.parse({
      ...update(process, now),
      status: target,
      updatedAt: now,
    });
    this.#updateProcess(next);
    this.#appendLifecycle({
      processId: next.id,
      action,
      fromStatus: process.status,
      toStatus: next.status,
      occurredAt: now,
      details,
    });
    return clone(next);
  }

  async #requireProcess(processId: string): Promise<SandboxProcess> {
    const process = await this.get(processId);
    if (!process) {
      throw new Error(`Sandbox process '${processId}' was not found`);
    }
    return process;
  }

  #insertProcess(process: SandboxProcess): void {
    this.#sql.exec(
      `INSERT INTO flary_sandbox_processes
        (process_id, run_id, sandbox_id, status, record_json,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      process.id,
      process.runId,
      process.sandboxId,
      process.status,
      JSON.stringify(process),
      process.createdAt,
      process.updatedAt
    );
  }

  #updateProcess(processInput: SandboxProcess): void {
    const process = SandboxProcessSchema.parse(processInput);
    this.#sql.exec(
      `UPDATE flary_sandbox_processes
       SET status = ?, record_json = ?, updated_at = ?
       WHERE process_id = ?`,
      process.status,
      JSON.stringify(process),
      process.updatedAt,
      process.id
    );
  }

  #appendLifecycle(input: Omit<SandboxProcessLifecycleEvent, "cursor">): void {
    const row = this.#sql
      .exec<{ cursor: number }>(
        `INSERT INTO flary_sandbox_process_lifecycle
          (process_id, from_status, to_status, action, event_json, occurred_at)
         VALUES (?, ?, ?, ?, '{}', ?)
         RETURNING cursor`,
        input.processId,
        input.fromStatus ?? null,
        input.toStatus,
        input.action,
        input.occurredAt
      )
      .toArray()[0];
    if (!row) {
      throw new Error(
        `Lifecycle event for sandbox process '${input.processId}' was not stored`
      );
    }
    const event = SandboxProcessLifecycleEventSchema.parse({
      ...input,
      cursor: Number(row.cursor),
    });
    this.#sql.exec(
      `UPDATE flary_sandbox_process_lifecycle
       SET event_json = ?
       WHERE cursor = ?`,
      JSON.stringify(event),
      event.cursor
    );
  }
}

/** Hash a process environment without returning or storing its values. */
export async function hashSandboxEnvironment(
  environment: Readonly<Record<string, string>>
): Promise<SandboxEnvironmentHash> {
  const canonical = Object.keys(environment)
    .sort()
    .map((key) => [key, environment[key]] as const);
  const bytes = new TextEncoder().encode(JSON.stringify(canonical));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return SandboxEnvironmentHashSchema.parse(
    `sha256:${[...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")}`
  );
}

function boundedPositiveLimit(
  value: number | undefined,
  fallback: number,
  maximum: number,
  name: string
): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0 || selected > maximum) {
    throw new RangeError(
      `${name} must be a positive integer no larger than ${maximum}`
    );
  }
  return selected;
}

function readLimit(
  value: number | undefined,
  fallback: number,
  maximum: number
): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0 || selected > maximum) {
    throw new RangeError(
      `Read limit must be an integer from 1 through ${maximum}`
    );
  }
  return selected;
}

function cursor(value: number | undefined): number {
  const selected = value ?? 0;
  if (!Number.isSafeInteger(selected) || selected < 0) {
    throw new RangeError("Cursor must be a non-negative integer");
  }
  return selected;
}

function utf8Boundary(
  bytes: Uint8Array,
  start: number,
  proposedEnd: number
): number {
  let end = proposedEnd;
  while (end > start) {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes.slice(start, end));
      return end;
    } catch {
      end -= 1;
    }
  }
  return start;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

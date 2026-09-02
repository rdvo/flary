import {
  FlaryRunRecordSchema,
  FlueAdmissionSchema,
  type FlaryRunRecord,
  type FlaryRunRepository,
  type FlueAdmission,
  type RunEventDraft,
} from "../flue/service.js";
import {
  RunEventSchema,
  RunResultSchema,
  UserInputAnswerRequestSchema,
  UserInputRecordSchema,
  UserInputRequestSchema,
  type UserInputAnswerRequest,
  type UserInputRecord,
  type UserInputRequest,
  type RunEvent,
  type RunResult,
} from "../contracts/index.js";
import type { IdentityReference } from "../contracts/identity.js";
import type { TrustedRunContext } from "../host/runs.js";

interface SqlRows<T> {
  toArray(): T[];
}

interface SqlStorage {
  exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): SqlRows<T>;
}

/** Durable user-input records owned by the Runtime Durable Object. */
export interface FlaryUserInputRepository {
  createUserInput(runId: string, request: UserInputRequest): Promise<UserInputRequest>;
  getUserInput(runId: string, requestId: string): Promise<UserInputRecord | undefined>;
  listUserInput(runId: string): Promise<UserInputRecord[]>;
  respondToUserInput(
    runId: string,
    requestId: string,
    input: UserInputAnswerRequest,
    answeredBy: IdentityReference,
  ): Promise<UserInputRecord>;
}

/**
 * Durable Object SQLite storage for function admission, ownership, results,
 * inputs, and replayable public events.
 */
export class SqliteFlaryRunRepository implements FlaryRunRepository, FlaryUserInputRepository {
  readonly #sql: SqlStorage;

  constructor(sql: unknown) {
    this.#sql = sql as SqlStorage;
    this.#sql.exec(`
      CREATE TABLE IF NOT EXISTS flary_function_runs (
        run_id TEXT PRIMARY KEY NOT NULL,
        tenant_id TEXT NOT NULL,
        application_id TEXT NOT NULL,
        project_id TEXT,
        agent_id TEXT NOT NULL,
        idempotency_key TEXT,
        record_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS flary_function_runs_idempotency
      ON flary_function_runs (
        tenant_id,
        application_id,
        COALESCE(project_id, ''),
        agent_id,
        idempotency_key
      ) WHERE idempotency_key IS NOT NULL;
      CREATE TABLE IF NOT EXISTS flary_function_run_inputs (
        run_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        admission_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (run_id, idempotency_key)
      );
      CREATE TABLE IF NOT EXISTS flary_function_run_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        dedupe_key TEXT NOT NULL,
        event_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (run_id, dedupe_key)
      );
      CREATE INDEX IF NOT EXISTS flary_function_run_events_replay
      ON flary_function_run_events (run_id, sequence);
      CREATE TABLE IF NOT EXISTS flary_function_user_input (
        request_id TEXT PRIMARY KEY NOT NULL,
        run_id TEXT NOT NULL,
        request_json TEXT NOT NULL,
        response_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS flary_function_user_input_run
      ON flary_function_user_input (run_id, created_at);
    `);
  }

  async createUserInput(runId: string, requestInput: UserInputRequest): Promise<UserInputRequest> {
    const canonicalRunId = await this.canonicalRunId(runId, true);
    const request = UserInputRequestSchema.parse(requestInput);
    const now = new Date().toISOString();
    this.#sql.exec(
      `INSERT OR IGNORE INTO flary_function_user_input (
         request_id, run_id, request_json, response_json, created_at, updated_at
      ) VALUES (?, ?, ?, NULL, ?, ?)`,
      request.id,
      canonicalRunId,
      JSON.stringify(request),
      now,
      now,
    );
    const row = this.first<{ request_json: string }>(
      `SELECT request_json FROM flary_function_user_input
       WHERE run_id = ? AND request_id = ? LIMIT 1`,
      canonicalRunId,
      request.id,
    );
    if (!row) throw new Error("The user-input request could not be stored");
    return UserInputRequestSchema.parse(JSON.parse(row.request_json));
  }

  async getUserInput(runId: string, requestId: string): Promise<UserInputRecord | undefined> {
    const canonicalRunId = await this.canonicalRunId(runId, true);
    const row = this.first<{ request_json: string; response_json: string | null }>(
      `SELECT request_json, response_json FROM flary_function_user_input
       WHERE run_id = ? AND request_id = ? LIMIT 1`,
      canonicalRunId,
      requestId,
    );
    return row ? this.userInputRecord(row) : undefined;
  }

  async listUserInput(runId: string): Promise<UserInputRecord[]> {
    const canonicalRunId = await this.canonicalRunId(runId, true);
    return this.#sql
      .exec<{ request_json: string; response_json: string | null }>(
        `SELECT request_json, response_json FROM flary_function_user_input
       WHERE run_id = ? ORDER BY created_at ASC, request_id ASC`,
        canonicalRunId,
      )
      .toArray()
      .map((row) => this.userInputRecord(row));
  }

  async respondToUserInput(
    runId: string,
    requestId: string,
    inputValue: UserInputAnswerRequest,
    answeredBy: IdentityReference,
  ): Promise<UserInputRecord> {
    const canonicalRunId = await this.canonicalRunId(runId, true);
    const current = await this.getUserInput(canonicalRunId, requestId);
    if (!current) throw new Error("The user-input request was not found");
    if (current.response) return current;
    const input = UserInputAnswerRequestSchema.parse(inputValue);
    const response = {
      requestId,
      answers: input.answers ?? {},
      ...(input.response === undefined ? {} : { response: input.response }),
      canceled: input.canceled ?? false,
      answeredBy,
      answeredAt: new Date().toISOString(),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    };
    this.#sql.exec(
      `UPDATE flary_function_user_input
       SET response_json = ?, updated_at = ?
       WHERE run_id = ? AND request_id = ? AND response_json IS NULL`,
      JSON.stringify(response),
      new Date().toISOString(),
      canonicalRunId,
      requestId,
    );
    return (await this.getUserInput(canonicalRunId, requestId))!;
  }

  async findByIdempotency(
    trusted: TrustedRunContext,
    idempotencyKey: string,
  ): Promise<FlaryRunRecord | undefined> {
    const row = this.first<{ record_json: string }>(
      `SELECT record_json FROM flary_function_runs
       WHERE tenant_id = ? AND application_id = ?
         AND COALESCE(project_id, '') = COALESCE(?, '')
         AND agent_id = ? AND idempotency_key = ?
       LIMIT 1`,
      trusted.tenantId,
      trusted.applicationId,
      trusted.projectId ?? null,
      trusted.agentId,
      idempotencyKey,
    );
    return row ? FlaryRunRecordSchema.parse(JSON.parse(row.record_json)) : undefined;
  }

  async create(recordInput: FlaryRunRecord): Promise<FlaryRunRecord> {
    const record = FlaryRunRecordSchema.parse(recordInput);
    this.#sql.exec(
      `INSERT INTO flary_function_runs (
         run_id, tenant_id, application_id, project_id, agent_id,
         idempotency_key, record_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.runId,
      record.trusted.tenantId,
      record.trusted.applicationId,
      record.trusted.projectId ?? null,
      record.trusted.agentId,
      record.request.idempotencyKey ?? null,
      JSON.stringify(record),
      record.createdAt,
      record.updatedAt,
    );
    return record;
  }

  async get(runId: string): Promise<FlaryRunRecord | undefined> {
    const row = this.first<{ record_json: string }>(
      `SELECT record_json FROM flary_function_runs
       WHERE run_id = ? LIMIT 1`,
      runId,
    );
    return row ? FlaryRunRecordSchema.parse(JSON.parse(row.record_json)) : undefined;
  }

  async findInputAdmission(
    runId: string,
    idempotencyKey: string,
  ): Promise<FlueAdmission | undefined> {
    await this.required(runId);
    const row = this.first<{ admission_json: string }>(
      `SELECT admission_json FROM flary_function_run_inputs
       WHERE run_id = ? AND idempotency_key = ? LIMIT 1`,
      runId,
      idempotencyKey,
    );
    return row ? FlueAdmissionSchema.parse(JSON.parse(row.admission_json)) : undefined;
  }

  async setAdmission(
    runId: string,
    idempotencyKey: string,
    admissionInput: FlueAdmission,
  ): Promise<boolean> {
    const admission = FlueAdmissionSchema.parse(admissionInput);
    const inserted = this.#sql
      .exec<{ run_id: string }>(
        `INSERT OR IGNORE INTO flary_function_run_inputs (
         run_id, idempotency_key, admission_json, created_at
       ) VALUES (?, ?, ?, ?)
       RETURNING run_id`,
        runId,
        idempotencyKey,
        JSON.stringify(admission),
        new Date().toISOString(),
      )
      .toArray();
    if (inserted.length === 0) return false;
    const record = await this.required(runId);
    await this.write({
      ...record,
      admission,
      updatedAt: new Date().toISOString(),
    });
    return true;
  }

  async setResult(runId: string, resultInput: RunResult): Promise<FlaryRunRecord> {
    const record = await this.required(runId);
    const next = FlaryRunRecordSchema.parse({
      ...record,
      result: RunResultSchema.parse(resultInput),
      updatedAt: new Date().toISOString(),
    });
    await this.write(next);
    return next;
  }

  async appendEvent(
    runId: string,
    dedupeKey: string,
    event: RunEventDraft,
  ): Promise<RunEvent | undefined> {
    await this.required(runId);
    this.#sql.exec(
      `INSERT OR IGNORE INTO flary_function_run_events (
         run_id, dedupe_key, event_json, created_at
       ) VALUES (?, ?, ?, ?)`,
      runId,
      dedupeKey,
      JSON.stringify(event),
      new Date().toISOString(),
    );
    const row = this.first<{ sequence: number; event_json: string }>(
      `SELECT sequence, event_json FROM flary_function_run_events
       WHERE run_id = ? AND dedupe_key = ? LIMIT 1`,
      runId,
      dedupeKey,
    );
    if (!row) return undefined;
    const normalized = RunEventSchema.parse({
      ...JSON.parse(row.event_json),
      id: `event_${runId}_${row.sequence}`,
      sequence: row.sequence,
    });
    const record = await this.required(runId);
    if ((record.result.lastSequence ?? 0) < row.sequence) {
      await this.write({
        ...record,
        result: { ...record.result, lastSequence: row.sequence },
        updatedAt: new Date().toISOString(),
      });
    }
    return normalized;
  }

  async events(runId: string, afterSequence: number): Promise<RunEvent[]> {
    await this.required(runId);
    return this.#sql
      .exec<{ sequence: number; event_json: string }>(
        `SELECT sequence, event_json FROM flary_function_run_events
       WHERE run_id = ? AND sequence > ?
       ORDER BY sequence ASC`,
        runId,
        afterSequence,
      )
      .toArray()
      .map((row) =>
        RunEventSchema.parse({
          ...JSON.parse(row.event_json),
          id: `event_${runId}_${row.sequence}`,
          sequence: row.sequence,
        }),
      );
  }

  private first<T>(query: string, ...bindings: unknown[]): T | undefined {
    return this.#sql.exec<T>(query, ...bindings).toArray()[0];
  }

  private async required(runId: string): Promise<FlaryRunRecord> {
    const record = await this.get(runId);
    if (!record) throw new Error("The run was not found");
    return record;
  }

  /**
   * Workflow Durable Objects use Flue's submission id as their agent id,
   * while the Flary Runtime stores the parent function run id. Resolve that
   * private alias before reading or writing user-input records.
   */
  private async canonicalRunId(runId: string, allowStandalone = false): Promise<string> {
    const direct = await this.get(runId);
    if (direct) return direct.runId;
    const rows = this.#sql
      .exec<{ run_id: string; record_json: string }>(
        `SELECT run_id, record_json FROM flary_function_runs`,
      )
      .toArray();
    for (const row of rows) {
      try {
        const record = FlaryRunRecordSchema.parse(JSON.parse(row.record_json));
        if (record.admission.submissionId === runId) return record.runId;
      } catch {
        // Ignore an unrelated malformed legacy row. Normal run reads still
        // fail closed through required() and the public schema validators.
      }
    }
    if (allowStandalone) return runId;
    throw new Error("The run was not found");
  }

  private async write(recordInput: FlaryRunRecord): Promise<void> {
    const record = FlaryRunRecordSchema.parse(recordInput);
    this.#sql.exec(
      `UPDATE flary_function_runs
       SET record_json = ?, updated_at = ?
       WHERE run_id = ?`,
      JSON.stringify(record),
      record.updatedAt,
      record.runId,
    );
  }

  private userInputRecord(row: {
    readonly request_json: string;
    readonly response_json: string | null;
  }): UserInputRecord {
    return UserInputRecordSchema.parse({
      request: JSON.parse(row.request_json),
      response: row.response_json ? JSON.parse(row.response_json) : null,
    });
  }
}

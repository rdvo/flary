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
  type RunEvent,
  type RunResult,
} from "../contracts/index.js";
import type { TrustedRunContext } from "../host/runs.js";

export const FLARY_RUNS_D1_MIGRATION = `
CREATE TABLE IF NOT EXISTS flary_runs (
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
CREATE UNIQUE INDEX IF NOT EXISTS flary_runs_idempotency_unique
ON flary_runs (
  tenant_id,
  application_id,
  COALESCE(project_id, ''),
  agent_id,
  idempotency_key
)
WHERE idempotency_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS flary_run_inputs (
  run_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  admission_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, idempotency_key),
  FOREIGN KEY (run_id) REFERENCES flary_runs(run_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS flary_run_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  event_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (run_id, dedupe_key),
  FOREIGN KEY (run_id) REFERENCES flary_runs(run_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS flary_run_events_replay_idx
ON flary_run_events (run_id, sequence);
`;

type D1Row = Record<string, unknown>;

export interface FlaryD1PreparedStatement {
  bind(...values: unknown[]): FlaryD1PreparedStatement;
  first<T = D1Row>(): Promise<T | null>;
  run(): Promise<{ meta: { changes: number } }>;
  all<T = D1Row>(): Promise<{ results: T[] }>;
}

export interface FlaryD1Database {
  prepare(query: string): FlaryD1PreparedStatement;
}

/**
 * D1-backed run projection for self-hosted Workers.
 *
 * Apply `FLARY_RUNS_D1_MIGRATION` through the host application's normal D1
 * migration process before serving requests.
 */
export class D1FlaryRunRepository implements FlaryRunRepository {
  readonly #db: FlaryD1Database;

  constructor(db: FlaryD1Database) {
    this.#db = db;
  }

  async findByIdempotency(
    trusted: TrustedRunContext,
    idempotencyKey: string,
  ): Promise<FlaryRunRecord | undefined> {
    const row = await this.#db
      .prepare(
        `SELECT record_json FROM flary_runs
         WHERE tenant_id = ? AND application_id = ?
           AND COALESCE(project_id, '') = COALESCE(?, '')
           AND agent_id = ? AND idempotency_key = ?
         LIMIT 1`,
      )
      .bind(
        trusted.tenantId,
        trusted.applicationId,
        trusted.projectId ?? null,
        trusted.agentId,
        idempotencyKey,
      )
      .first<{ record_json: string }>();
    return row
      ? FlaryRunRecordSchema.parse(JSON.parse(row.record_json))
      : undefined;
  }

  async create(recordInput: FlaryRunRecord): Promise<FlaryRunRecord> {
    const record = FlaryRunRecordSchema.parse(recordInput);
    await this.#db
      .prepare(
        `INSERT INTO flary_runs (
           run_id, tenant_id, application_id, project_id, agent_id,
           idempotency_key, record_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        record.runId,
        record.trusted.tenantId,
        record.trusted.applicationId,
        record.trusted.projectId ?? null,
        record.trusted.agentId,
        record.request.idempotencyKey ?? null,
        JSON.stringify(record),
        record.createdAt,
        record.updatedAt,
      )
      .run();
    return record;
  }

  async get(runId: string): Promise<FlaryRunRecord | undefined> {
    const row = await this.#db
      .prepare(`SELECT record_json FROM flary_runs WHERE run_id = ? LIMIT 1`)
      .bind(runId)
      .first<{ record_json: string }>();
    return row
      ? FlaryRunRecordSchema.parse(JSON.parse(row.record_json))
      : undefined;
  }

  async findInputAdmission(
    runId: string,
    idempotencyKey: string,
  ): Promise<FlueAdmission | undefined> {
    await this.required(runId);
    const row = await this.#db
      .prepare(
        `SELECT admission_json FROM flary_run_inputs
         WHERE run_id = ? AND idempotency_key = ? LIMIT 1`,
      )
      .bind(runId, idempotencyKey)
      .first<{ admission_json: string }>();
    return row
      ? FlueAdmissionSchema.parse(JSON.parse(row.admission_json))
      : undefined;
  }

  async setAdmission(
    runId: string,
    idempotencyKey: string,
    admissionInput: FlueAdmission,
  ): Promise<boolean> {
    const admission = FlueAdmissionSchema.parse(admissionInput);
    const insert = await this.#db
      .prepare(
        `INSERT OR IGNORE INTO flary_run_inputs (
           run_id, idempotency_key, admission_json, created_at
         ) VALUES (?, ?, ?, ?)`,
      )
      .bind(
        runId,
        idempotencyKey,
        JSON.stringify(admission),
        new Date().toISOString(),
      )
      .run();
    if (!insert.meta.changes) return false;
    const record = await this.required(runId);
    await this.write({
      ...record,
      admission,
      updatedAt: new Date().toISOString(),
    });
    return true;
  }

  async setResult(
    runId: string,
    resultInput: RunResult,
  ): Promise<FlaryRunRecord> {
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
    await this.#db
      .prepare(
        `INSERT OR IGNORE INTO flary_run_events (
           run_id, dedupe_key, event_json, created_at
         ) VALUES (?, ?, ?, ?)`,
      )
      .bind(
        runId,
        dedupeKey,
        JSON.stringify(event),
        new Date().toISOString(),
      )
      .run();
    const row = await this.#db
      .prepare(
        `SELECT sequence, event_json FROM flary_run_events
         WHERE run_id = ? AND dedupe_key = ? LIMIT 1`,
      )
      .bind(runId, dedupeKey)
      .first<{ sequence: number; event_json: string }>();
    if (!row) return undefined;
    const normalized = RunEventSchema.parse({
      ...(JSON.parse(row.event_json) as D1Row),
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
    const rows = await this.#db
      .prepare(
        `SELECT sequence, event_json FROM flary_run_events
         WHERE run_id = ? AND sequence > ?
         ORDER BY sequence ASC`,
      )
      .bind(runId, afterSequence)
      .all<{ sequence: number; event_json: string }>();
    return rows.results.map((row) =>
      RunEventSchema.parse({
        ...(JSON.parse(row.event_json) as D1Row),
        id: `event_${runId}_${row.sequence}`,
        sequence: row.sequence,
      }),
    );
  }

  private async required(runId: string): Promise<FlaryRunRecord> {
    const record = await this.get(runId);
    if (!record) throw new Error("The run was not found");
    return record;
  }

  private async write(recordInput: FlaryRunRecord): Promise<void> {
    const record = FlaryRunRecordSchema.parse(recordInput);
    await this.#db
      .prepare(
        `UPDATE flary_runs SET record_json = ?, updated_at = ?
         WHERE run_id = ?`,
      )
      .bind(JSON.stringify(record), record.updatedAt, record.runId)
      .run();
  }
}

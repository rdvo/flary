import {
  DEFAULT_SESSION_HOT_RECORD_LIMIT,
  SESSION_LEDGER_FORMAT,
  SESSION_LEDGER_SCHEMA_VERSION,
  SessionLedgerCursorSchema,
  SessionLedgerMetadataSchema,
  SessionRecordDraftSchema,
  SessionRecordSchema,
  type SessionLedgerMetadata,
  type SessionRecord,
  type SessionRecordAppendInput,
  type SessionRecordPage,
} from "./contracts.js";
import {
  SessionIntegrityError,
  sealSessionRecord,
  verifySessionChain,
  verifySessionRecord,
} from "./integrity.js";

interface SqlRows<T> {
  toArray(): T[];
}

interface SqlStorage {
  exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): SqlRows<T>;
  transactionSync<T>(closure: () => T): T;
}

interface MetadataRow {
  tenant_id: string;
  application_id: string;
  session_id: string;
  thread_id: string;
  record_count: number;
  latest_sequence: number;
  latest_hash: string | null;
  hot_record_limit: number;
  sealed_through_sequence: number;
  updated_at: string;
}

export interface ListSessionRecordOptions {
  after?: string;
  limit?: number;
}

export interface SqliteSessionLedgerOptions {
  hotRecordLimit?: number;
}

/** Durable Object SQLite adapter for one append-only session ledger. */
export class SqliteSessionLedger {
  readonly #sql: SqlStorage;
  readonly #hotRecordLimit: number;

  constructor(sql: unknown, options: SqliteSessionLedgerOptions = {}) {
    const storage = sql as Partial<SqlStorage>;
    if (typeof storage?.exec !== "function" || typeof storage.transactionSync !== "function") {
      throw new Error("The session ledger needs Durable Object SQLite with transactionSync");
    }
    this.#sql = storage as SqlStorage;
    this.#hotRecordLimit = options.hotRecordLimit ?? DEFAULT_SESSION_HOT_RECORD_LIMIT;
    if (!Number.isInteger(this.#hotRecordLimit) || this.#hotRecordLimit < 1) {
      throw new Error("The hot record limit must be a positive integer");
    }
    this.#sql.exec(`
      CREATE TABLE IF NOT EXISTS flary_session_ledger_records (
        session_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        tenant_id TEXT NOT NULL,
        application_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        record_hash TEXT NOT NULL,
        previous_hash TEXT,
        record_json TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        PRIMARY KEY (session_id, sequence),
        UNIQUE (session_id, record_hash)
      );
      CREATE INDEX IF NOT EXISTS flary_session_ledger_records_cursor
      ON flary_session_ledger_records (session_id, sequence);
      CREATE TABLE IF NOT EXISTS flary_session_ledger_metadata (
        session_id TEXT PRIMARY KEY NOT NULL,
        tenant_id TEXT NOT NULL,
        application_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        record_count INTEGER NOT NULL,
        latest_sequence INTEGER NOT NULL,
        latest_hash TEXT,
        hot_record_limit INTEGER NOT NULL,
        sealed_through_sequence INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
    `);
  }

  async append(input: SessionRecordAppendInput): Promise<SessionRecord> {
    const draft = SessionRecordDraftSchema.parse({
      ...input,
      schemaVersion: input.schemaVersion ?? SESSION_LEDGER_SCHEMA_VERSION,
      format: input.format ?? SESSION_LEDGER_FORMAT,
    });
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const metadata = this.#metadataRow(draft.sessionId);
      this.#assertScope(metadata, draft);
      const sequence = (metadata?.latest_sequence ?? 0) + 1;
      const record = await sealSessionRecord(draft, sequence, metadata?.latest_hash ?? null);
      const inserted = this.#sql.transactionSync(() => {
        const current = this.#metadataRow(draft.sessionId);
        this.#assertScope(current, draft);
        if (
          (current?.latest_sequence ?? 0) !== sequence - 1 ||
          (current?.latest_hash ?? null) !== record.previousHash
        ) {
          return false;
        }
        this.#insertRecord(record);
        return true;
      });
      if (inserted) return record;
    }
    throw new Error("The session record could not be appended");
  }

  /** Append a pre-sealed record during a verified import. */
  async appendRecord(recordInput: SessionRecord): Promise<SessionRecord> {
    const record = SessionRecordSchema.parse(recordInput);
    if (!(await verifySessionRecord(record))) {
      throw new SessionIntegrityError(
        `The record hash does not match at sequence ${record.sequence}`,
        record.sequence,
      );
    }
    this.#sql.transactionSync(() => {
      const metadata = this.#metadataRow(record.sessionId);
      this.#assertScope(metadata, record);
      const expectedSequence = (metadata?.latest_sequence ?? 0) + 1;
      const expectedHash = metadata?.latest_hash ?? null;
      if (record.sequence !== expectedSequence || record.previousHash !== expectedHash) {
        throw new SessionIntegrityError(
          `The imported record does not continue session ${record.sessionId}`,
          record.sequence,
        );
      }
      this.#insertRecord(record);
    });
    return record;
  }

  async list(
    sessionId: string,
    options: ListSessionRecordOptions = {},
  ): Promise<SessionRecordPage> {
    const after = options.after ? decodeSessionCursor(options.after) : 0;
    const limit = options.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error("The session page limit must be from 1 through 1000");
    }
    const rows = this.#sql
      .exec<{ record_json: string }>(
        `SELECT record_json
       FROM flary_session_ledger_records
       WHERE session_id = ? AND sequence > ?
       ORDER BY sequence ASC
       LIMIT ?`,
        sessionId,
        after,
        limit + 1,
      )
      .toArray();
    const hasMore = rows.length > limit;
    const items = rows
      .slice(0, limit)
      .map(({ record_json }) => SessionRecordSchema.parse(JSON.parse(record_json)));
    const last = items.at(-1);
    return {
      items,
      ...(hasMore && last ? { nextCursor: encodeSessionCursor(last.sequence) } : {}),
    };
  }

  async metadata(sessionId: string): Promise<SessionLedgerMetadata | undefined> {
    const row = this.#metadataRow(sessionId);
    if (!row) return undefined;
    const recordsPastHotLimit = Math.max(0, row.record_count - row.hot_record_limit);
    return SessionLedgerMetadataSchema.parse({
      tenantId: row.tenant_id,
      applicationId: row.application_id,
      sessionId: row.session_id,
      threadId: row.thread_id,
      recordCount: row.record_count,
      latestSequence: row.latest_sequence,
      latestHash: row.latest_hash,
      hotRecordLimit: row.hot_record_limit,
      hotStartSequence: Math.max(1, row.latest_sequence - row.hot_record_limit + 1),
      hotRecordCount: Math.min(row.record_count, row.hot_record_limit),
      recordsPastHotLimit,
      archiveRequired: recordsPastHotLimit > row.sealed_through_sequence,
      sealedThroughSequence: row.sealed_through_sequence,
      updatedAt: row.updated_at,
    });
  }

  async markSealedThrough(sessionId: string, sequence: number): Promise<SessionLedgerMetadata> {
    if (!Number.isInteger(sequence) || sequence < 0) {
      throw new Error("The sealed sequence must be a non-negative integer");
    }
    const current = this.#metadataRow(sessionId);
    if (!current) throw new Error(`Session ${sessionId} was not found`);
    if (sequence > current.latest_sequence) {
      throw new Error("The sealed sequence cannot be after the latest record");
    }
    this.#sql.transactionSync(() => {
      this.#sql.exec(
        `UPDATE flary_session_ledger_metadata
         SET sealed_through_sequence = MAX(sealed_through_sequence, ?),
             updated_at = ?
         WHERE session_id = ?`,
        sequence,
        new Date().toISOString(),
        sessionId,
      );
    });
    return (await this.metadata(sessionId))!;
  }

  async verify(sessionId: string): Promise<void> {
    const records = this.#sql
      .exec<{ record_json: string }>(
        `SELECT record_json
       FROM flary_session_ledger_records
       WHERE session_id = ?
       ORDER BY sequence ASC`,
        sessionId,
      )
      .toArray()
      .map(({ record_json }) => SessionRecordSchema.parse(JSON.parse(record_json)));
    const metadata = this.#metadataRow(sessionId);
    if ((metadata?.sealed_through_sequence ?? 0) === 0) {
      await verifySessionChain(records);
    } else {
      for (let index = 0; index < records.length; index += 1) {
        const record = records[index]!;
        if (!(await verifySessionRecord(record))) {
          throw new SessionIntegrityError(
            `The record hash does not match at sequence ${record.sequence}`,
            record.sequence,
          );
        }
        if (index > 0 && record.previousHash !== records[index - 1]!.recordHash) {
          throw new SessionIntegrityError(
            `The hot record chain breaks at sequence ${record.sequence}`,
            record.sequence,
          );
        }
      }
    }
    if (!metadata && records.length === 0) return;
    const last = records.at(-1);
    if (
      !metadata ||
      (metadata.sealed_through_sequence === 0 && metadata.record_count !== records.length) ||
      metadata.latest_sequence !== (last?.sequence ?? 0) ||
      metadata.latest_hash !== (last?.recordHash ?? null)
    ) {
      throw new SessionIntegrityError(
        `The metadata for session ${sessionId} does not match its record chain`,
      );
    }
  }

  #insertRecord(record: SessionRecord): void {
    this.#sql.exec(
      `INSERT INTO flary_session_ledger_records (
         session_id, sequence, tenant_id, application_id, thread_id,
         record_hash, previous_hash, record_json, recorded_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.sessionId,
      record.sequence,
      record.tenantId,
      record.applicationId,
      record.threadId,
      record.recordHash,
      record.previousHash,
      JSON.stringify(record),
      record.recordedAt,
    );
    this.#sql.exec(
      `INSERT INTO flary_session_ledger_metadata (
         session_id, tenant_id, application_id, thread_id, record_count,
         latest_sequence, latest_hash, hot_record_limit,
         sealed_through_sequence, updated_at
       ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, 0, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         record_count = flary_session_ledger_metadata.record_count + 1,
         latest_sequence = excluded.latest_sequence,
         latest_hash = excluded.latest_hash,
         updated_at = excluded.updated_at`,
      record.sessionId,
      record.tenantId,
      record.applicationId,
      record.threadId,
      record.sequence,
      record.recordHash,
      this.#hotRecordLimit,
      record.recordedAt,
    );
  }

  #metadataRow(sessionId: string): MetadataRow | undefined {
    return this.#sql
      .exec<MetadataRow>(
        `SELECT tenant_id, application_id, session_id, thread_id, record_count,
              latest_sequence, latest_hash, hot_record_limit,
              sealed_through_sequence, updated_at
       FROM flary_session_ledger_metadata
       WHERE session_id = ?
       LIMIT 1`,
        sessionId,
      )
      .toArray()[0];
  }

  #assertScope(
    metadata: MetadataRow | undefined,
    record: {
      tenantId: string;
      applicationId: string;
      threadId: string;
      sessionId: string;
    },
  ): void {
    if (
      metadata &&
      (metadata.tenant_id !== record.tenantId ||
        metadata.application_id !== record.applicationId ||
        metadata.thread_id !== record.threadId)
    ) {
      throw new SessionIntegrityError(
        `Session ${record.sessionId} is already owned by a different scope`,
      );
    }
  }
}

export function encodeSessionCursor(sequence: number): string {
  if (!Number.isInteger(sequence) || sequence < 1) {
    throw new Error("The cursor sequence must be a positive integer");
  }
  return SessionLedgerCursorSchema.parse(`v1:${sequence}`);
}

export function decodeSessionCursor(cursor: string): number {
  return Number(SessionLedgerCursorSchema.parse(cursor).slice(3));
}

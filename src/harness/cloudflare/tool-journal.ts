import {
  ToolExecutionJournalRecordSchema,
  type ToolExecutionJournalRecord,
} from "../contracts/tools.js";
import type { ToolExecutionJournal } from "../execution/tool-journal.js";

interface SqlRows<T> {
  toArray(): T[];
}

interface SqlStorage {
  exec<T = Record<string, unknown>>(
    query: string,
    ...bindings: unknown[]
  ): SqlRows<T>;
}

interface ToolJournalRow {
  record_json: string;
  state: ToolExecutionJournalRecord["state"];
}

/**
 * Durable tool-call journal for a thread or run Durable Object.
 *
 * Completed and unknown outcomes are terminal. A restarted write that has
 * only a `started` record is handled as unknown by the scheduler.
 */
export class SqliteToolExecutionJournal implements ToolExecutionJournal {
  readonly #sql: SqlStorage;

  constructor(sql: unknown) {
    this.#sql = sql as SqlStorage;
    this.#sql.exec(`
      CREATE TABLE IF NOT EXISTS flary_tool_execution_journal (
        run_id TEXT NOT NULL,
        call_id TEXT NOT NULL,
        state TEXT NOT NULL,
        record_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (run_id, call_id)
      );
    `);
  }

  async get(
    runId: string,
    callId: string,
  ): Promise<ToolExecutionJournalRecord | undefined> {
    const row = this.#sql
      .exec<ToolJournalRow>(
        `SELECT record_json, state
         FROM flary_tool_execution_journal
         WHERE run_id = ? AND call_id = ?`,
        runId,
        callId,
      )
      .toArray()[0];
    return row
      ? ToolExecutionJournalRecordSchema.parse(JSON.parse(row.record_json))
      : undefined;
  }

  async put(recordInput: ToolExecutionJournalRecord): Promise<void> {
    const record = ToolExecutionJournalRecordSchema.parse(recordInput);
    const current = await this.get(record.runId, record.callId);
    if (
      current &&
      ["completed", "outcome_unknown"].includes(current.state)
    ) {
      if (JSON.stringify(current) === JSON.stringify(record)) return;
      throw new Error(
        `Tool call ${record.callId} already has terminal state ${current.state}`,
      );
    }
    this.#sql.exec(
      `INSERT INTO flary_tool_execution_journal
        (run_id, call_id, state, record_json, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(run_id, call_id) DO UPDATE SET
         state = excluded.state,
         record_json = excluded.record_json,
         updated_at = excluded.updated_at`,
      record.runId,
      record.callId,
      record.state,
      JSON.stringify(record),
      record.completedAt ?? record.startedAt,
    );
  }
}

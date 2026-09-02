import {
  ToolExecutionJournalRecordSchema,
  type ToolExecutionJournalRecord,
} from "../contracts/tools.js";

export interface ToolExecutionJournal {
  get(runId: string, callId: string): Promise<ToolExecutionJournalRecord | undefined>;
  put(record: ToolExecutionJournalRecord): Promise<void>;
}

export class InMemoryToolExecutionJournal implements ToolExecutionJournal {
  readonly #records = new Map<string, ToolExecutionJournalRecord>();

  async get(runId: string, callId: string): Promise<ToolExecutionJournalRecord | undefined> {
    const record = this.#records.get(`${runId}:${callId}`);
    return record ? ToolExecutionJournalRecordSchema.parse(record) : undefined;
  }

  async put(recordValue: ToolExecutionJournalRecord): Promise<void> {
    const record = ToolExecutionJournalRecordSchema.parse(recordValue);
    const key = `${record.runId}:${record.callId}`;
    const current = this.#records.get(key);
    if (record.state === "started" && current?.state === "started") {
      throw new Error(`Tool call ${record.callId} is already running`);
    }
    this.#records.set(key, record);
  }
}

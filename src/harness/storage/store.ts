import { z } from "zod";

import {
  RecordTypeSchema,
  StorageRecordSchema,
  type RecordType,
  type StorageRecord,
} from "./records.js";

export interface StoredRecord<T extends StorageRecord = StorageRecord> {
  readonly sequence: number;
  readonly record: T;
}

export const StoredRecordSchema = z
  .object({
    sequence: z.number().int().positive(),
    record: StorageRecordSchema,
  })
  .strict();

export interface ReadOptions {
  /** Return entries after this sequence number. The boundary is exclusive. */
  afterSequence?: number;
  /** Return entries up to this sequence number. The boundary is inclusive. */
  beforeSequence?: number;
  threadId?: string;
  recordType?: RecordType | readonly RecordType[];
  limit?: number;
}

/**
 * The minimum durable contract for an append-only record log.
 *
 * Implementations must not update or delete an existing entry. Sequence
 * numbers must increase for each successful append and remain stable after a
 * read or restart.
 */
export interface AppendOnlyStore<T extends StorageRecord = StorageRecord> {
  append(record: T): Promise<StoredRecord<T>>;
  appendMany(records: readonly T[]): Promise<readonly StoredRecord<T>[]>;
  read(options?: ReadOptions): Promise<readonly StoredRecord<T>[]>;
  iterate(options?: ReadOptions): AsyncIterable<StoredRecord<T>>;
}

export interface ThreadStore extends AppendOnlyStore<
  Extract<StorageRecord, { recordType: "thread" }>
> {}
export interface TurnStore extends AppendOnlyStore<
  Extract<StorageRecord, { recordType: "turn" }>
> {}
export interface OperationStore extends AppendOnlyStore<
  Extract<StorageRecord, { recordType: "operation" }>
> {}
export interface EventStore extends AppendOnlyStore<
  Extract<StorageRecord, { recordType: "event" }>
> {}
export interface ToolStore extends AppendOnlyStore<
  Extract<StorageRecord, { recordType: "tool" }>
> {}
export interface ArtifactStore extends AppendOnlyStore<
  Extract<StorageRecord, { recordType: "artifact" }>
> {}

/** The storage dependencies used by a harness. No platform binding is assumed. */
export interface HarnessStores {
  readonly threads: ThreadStore;
  readonly turns: TurnStore;
  readonly operations: OperationStore;
  readonly events: EventStore;
  readonly tools: ToolStore;
  readonly artifacts: ArtifactStore;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function matches<T extends StorageRecord>(entry: StoredRecord<T>, options: ReadOptions): boolean {
  if (options.afterSequence !== undefined && entry.sequence <= options.afterSequence) {
    return false;
  }
  if (options.beforeSequence !== undefined && entry.sequence > options.beforeSequence) {
    return false;
  }
  if (options.threadId !== undefined && entry.record.recordType !== "thread") {
    const record = entry.record as StorageRecord & { threadId?: string };
    if (record.threadId !== options.threadId) {
      return false;
    }
  }
  if (options.recordType !== undefined) {
    const types = Array.isArray(options.recordType) ? options.recordType : [options.recordType];
    if (!types.includes(entry.record.recordType)) {
      return false;
    }
  }
  return true;
}

/**
 * A small reference implementation for tests and local adapters. It is not a
 * durable backend; production adapters should implement `AppendOnlyStore`.
 */
export class InMemoryAppendOnlyStore<
  T extends StorageRecord = StorageRecord,
> implements AppendOnlyStore<T> {
  private readonly entries: Array<StoredRecord<T>> = [];
  private nextSequence = 1;
  private readonly schema: z.ZodType<T>;

  constructor(schema: z.ZodType<T> = StorageRecordSchema as unknown as z.ZodType<T>) {
    this.schema = schema;
  }

  async append(record: T): Promise<StoredRecord<T>> {
    const [entry] = await this.appendMany([record]);
    return entry;
  }

  async appendMany(records: readonly T[]): Promise<readonly StoredRecord<T>[]> {
    const canonicalRecords = records.map((record) => this.schema.parse(record));
    const entries = canonicalRecords.map((record) => ({
      sequence: this.nextSequence++,
      record: clone(record),
    }));
    this.entries.push(...entries);
    return entries.map((entry) => ({ sequence: entry.sequence, record: clone(entry.record) }));
  }

  async read(options: ReadOptions = {}): Promise<readonly StoredRecord<T>[]> {
    const limit = options.limit === undefined ? Number.POSITIVE_INFINITY : options.limit;
    if (!Number.isInteger(limit) || limit < 0) {
      throw new RangeError("Read limit must be a non-negative integer");
    }

    const result: Array<StoredRecord<T>> = [];
    for (const entry of this.entries) {
      if (!matches(entry, options)) {
        continue;
      }
      result.push({ sequence: entry.sequence, record: clone(entry.record) });
      if (result.length >= limit) {
        break;
      }
    }
    return result;
  }

  async *iterate(options: ReadOptions = {}): AsyncIterable<StoredRecord<T>> {
    for (const entry of await this.read(options)) {
      yield entry;
    }
  }

  get size(): number {
    return this.entries.length;
  }

  get lastSequence(): number {
    return this.nextSequence - 1;
  }
}

export function parseStoredRecord(value: unknown): StoredRecord {
  return StoredRecordSchema.parse(value);
}

export function recordTypeIs(value: unknown, recordType: RecordType): boolean {
  return (
    RecordTypeSchema.safeParse(recordType).success &&
    StorageRecordSchema.safeParse(value).success &&
    (value as StorageRecord).recordType === recordType
  );
}

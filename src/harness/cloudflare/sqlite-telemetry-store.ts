import {
  MicroUnitCostSchema,
  TelemetryEventSchema,
  type NormalizedUsage,
  type SpanId,
  type TelemetryEvent,
  type TraceId,
} from "../contracts/telemetry.js";
import type {
  StoredTelemetryEvent,
  TelemetryAggregate,
  TelemetryReadOptions,
  TelemetryStore,
} from "../telemetry/store.js";

interface SqlRows<T> {
  toArray(): T[];
}

interface SqlStorage {
  exec<T = Record<string, unknown>>(
    query: string,
    ...bindings: unknown[]
  ): SqlRows<T>;
}

interface TelemetryRow {
  sequence: number;
  event_json: string;
}

/**
 * Durable Object SQLite telemetry storage.
 *
 * Event IDs and sequences are append-only. The sequence is local to the
 * Durable Object that owns this store.
 */
export class SqliteTelemetryStore implements TelemetryStore {
  readonly #sql: SqlStorage;
  readonly #listeners = new Set<(entry: StoredTelemetryEvent) => void>();

  constructor(sql: unknown) {
    this.#sql = sql as SqlStorage;
    this.#sql.exec(`
      CREATE TABLE IF NOT EXISTS flary_telemetry_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        trace_id TEXT NOT NULL,
        run_id TEXT,
        parent_span_id TEXT,
        event_type TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        event_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS flary_telemetry_events_trace
      ON flary_telemetry_events (trace_id, sequence);
      CREATE INDEX IF NOT EXISTS flary_telemetry_events_run
      ON flary_telemetry_events (run_id, sequence)
      WHERE run_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS flary_telemetry_events_parent
      ON flary_telemetry_events (parent_span_id, sequence)
      WHERE parent_span_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS flary_telemetry_events_type
      ON flary_telemetry_events (event_type, sequence);
    `);
  }

  async append(event: TelemetryEvent): Promise<StoredTelemetryEvent> {
    const [entry] = await this.appendMany([event]);
    return entry;
  }

  async appendMany(
    eventInputs: readonly TelemetryEvent[]
  ): Promise<readonly StoredTelemetryEvent[]> {
    const events = eventInputs.map((event) =>
      TelemetryEventSchema.parse(event)
    );
    const batchIds = new Set<string>();
    for (const event of events) {
      if (batchIds.has(event.id) || this.#hasId(event.id)) {
        throw new Error(`Telemetry event '${event.id}' already exists`);
      }
      batchIds.add(event.id);
    }

    const entries = events.map((event) => {
      const row = this.#sql
        .exec<{ sequence: number }>(
          `INSERT INTO flary_telemetry_events
            (event_id, trace_id, run_id, parent_span_id, event_type,
             occurred_at, event_json)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           RETURNING sequence`,
          event.id,
          event.traceContext.traceId,
          event.runId ?? null,
          event.traceContext.parentSpanId ?? null,
          event.type,
          event.occurredAt,
          JSON.stringify(event)
        )
        .toArray()[0];
      if (!row) {
        throw new Error(`Telemetry event '${event.id}' was not stored`);
      }
      return {
        sequence: Number(row.sequence),
        event: clone(event),
      };
    });

    for (const entry of entries) {
      const snapshot = cloneEntry(entry);
      for (const listener of this.#listeners) listener(snapshot);
    }
    return entries.map(cloneEntry);
  }

  async read(
    options: TelemetryReadOptions = {}
  ): Promise<readonly StoredTelemetryEvent[]> {
    const limit = validateLimit(options.limit);
    if (limit === 0) return [];

    const conditions: string[] = [];
    const bindings: unknown[] = [];
    if (options.afterSequence !== undefined) {
      if (
        !Number.isSafeInteger(options.afterSequence) ||
        options.afterSequence < 0
      ) {
        throw new RangeError(
          "Telemetry sequence must be a non-negative safe integer"
        );
      }
      conditions.push("sequence > ?");
      bindings.push(options.afterSequence);
    }
    if (options.traceId !== undefined) {
      conditions.push("trace_id = ?");
      bindings.push(options.traceId);
    }
    if (options.runId !== undefined) {
      conditions.push("run_id = ?");
      bindings.push(options.runId);
    }
    if (options.parentSpanId !== undefined) {
      conditions.push("parent_span_id = ?");
      bindings.push(options.parentSpanId);
    }
    if (options.type !== undefined) {
      const types = Array.isArray(options.type)
        ? [...options.type]
        : [options.type];
      if (types.length === 0) return [];
      conditions.push(`event_type IN (${types.map(() => "?").join(", ")})`);
      bindings.push(...types);
    }

    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limitClause = limit === Number.POSITIVE_INFINITY ? "" : "LIMIT ?";
    if (limit !== Number.POSITIVE_INFINITY) bindings.push(limit);
    return this.#sql
      .exec<TelemetryRow>(
        `SELECT sequence, event_json
         FROM flary_telemetry_events
         ${where}
         ORDER BY sequence ASC
         ${limitClause}`,
        ...bindings
      )
      .toArray()
      .map(parseRow);
  }

  async readTrace(traceId: TraceId): Promise<readonly StoredTelemetryEvent[]> {
    return this.read({ traceId });
  }

  async readRun(runId: string): Promise<readonly StoredTelemetryEvent[]> {
    return this.read({ runId });
  }

  async readChildren(
    parentSpanId: SpanId
  ): Promise<readonly StoredTelemetryEvent[]> {
    return this.read({ parentSpanId });
  }

  async aggregateRun(runId: string): Promise<TelemetryAggregate> {
    const entries = await this.readRun(runId);
    let inputTokens = 0;
    let outputTokens = 0;
    let totalTokens = 0;
    let reasoningTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let costMicroUnits = 0;
    let costUnit: string | undefined;
    let costUnknownReason: string | undefined;
    let hasCost = false;

    for (const { event } of entries) {
      if (event.type !== "model" || event.payload.action !== "completed") {
        continue;
      }
      const usage = event.payload.usage;
      if (usage) {
        inputTokens += usage.inputTokens ?? 0;
        outputTokens += usage.outputTokens ?? 0;
        totalTokens += usage.totalTokens ?? 0;
        reasoningTokens += usage.reasoning?.tokens ?? 0;
        cacheReadTokens += readCacheTokens(usage);
        cacheWriteTokens += writeCacheTokens(usage);
      }
      const reportedCost = event.payload.cost ?? usage?.cost;
      if (!reportedCost) continue;
      hasCost = true;
      if (reportedCost.state === "known") {
        if (costUnit && costUnit !== reportedCost.unit) {
          costUnknownReason = "Telemetry contains multiple cost units";
        } else {
          costUnit = reportedCost.unit;
          costMicroUnits += reportedCost.microUnits;
        }
      } else {
        costUnknownReason = reportedCost.reason ?? "Provider cost is unknown";
      }
    }

    const cost = hasCost
      ? costUnknownReason
        ? {
            state: "unknown" as const,
            unit: costUnit,
            reason: costUnknownReason,
          }
        : {
            state: "known" as const,
            microUnits: costMicroUnits,
            unit: costUnit ?? "unknown",
          }
      : {
          state: "unknown" as const,
          reason: "No provider cost was reported",
        };

    return {
      runId,
      eventCount: entries.length,
      inputTokens,
      outputTokens,
      totalTokens,
      reasoningTokens,
      cacheReadTokens,
      cacheWriteTokens,
      cost: MicroUnitCostSchema.parse(cost),
    };
  }

  async *replay(
    options: TelemetryReadOptions = {}
  ): AsyncIterable<StoredTelemetryEvent> {
    for (const entry of await this.read(options)) yield entry;
  }

  subscribe(listener: (entry: StoredTelemetryEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #hasId(id: string): boolean {
    return (
      this.#sql
        .exec<{ present: number }>(
          `SELECT 1 AS present
           FROM flary_telemetry_events
           WHERE event_id = ?
           LIMIT 1`,
          id
        )
        .toArray().length > 0
    );
  }
}

function validateLimit(limit: number | undefined): number {
  if (limit === undefined) return Number.POSITIVE_INFINITY;
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new RangeError("Telemetry read limit must be a non-negative integer");
  }
  return limit;
}

function parseRow(row: TelemetryRow): StoredTelemetryEvent {
  return {
    sequence: Number(row.sequence),
    event: TelemetryEventSchema.parse(JSON.parse(row.event_json)),
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function cloneEntry(entry: StoredTelemetryEvent): StoredTelemetryEvent {
  return { sequence: entry.sequence, event: clone(entry.event) };
}

function readCacheTokens(usage: NormalizedUsage): number {
  return usage.cache?.readTokens ?? usage.cache?.readInputTokens ?? 0;
}

function writeCacheTokens(usage: NormalizedUsage): number {
  return usage.cache?.writeTokens ?? usage.cache?.writeInputTokens ?? 0;
}

import {
  TelemetryEventSchema,
  type NormalizedUsage,
  type TelemetryEvent,
  type TraceContext,
  type SpanId,
  type TraceId,
} from "../contracts/telemetry.js";
import { MicroUnitCostSchema } from "../contracts/telemetry.js";

export interface TelemetryReadOptions {
  traceId?: TraceId;
  runId?: string;
  parentSpanId?: SpanId;
  type?: TelemetryEvent["type"] | readonly TelemetryEvent["type"][];
  afterSequence?: number;
  limit?: number;
}

export interface StoredTelemetryEvent {
  readonly sequence: number;
  readonly event: TelemetryEvent;
}

export interface TelemetryAggregate {
  readonly runId: string;
  readonly eventCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly reasoningTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly cost: ReturnType<typeof MicroUnitCostSchema.parse>;
}

export interface TelemetryStore {
  append(event: TelemetryEvent): Promise<StoredTelemetryEvent>;
  appendMany(
    events: readonly TelemetryEvent[]
  ): Promise<readonly StoredTelemetryEvent[]>;
  read(
    options?: TelemetryReadOptions
  ): Promise<readonly StoredTelemetryEvent[]>;
  readTrace(traceId: TraceId): Promise<readonly StoredTelemetryEvent[]>;
  readRun(runId: string): Promise<readonly StoredTelemetryEvent[]>;
  readChildren(parentSpanId: SpanId): Promise<readonly StoredTelemetryEvent[]>;
  aggregateRun(runId: string): Promise<TelemetryAggregate>;
  replay(options?: TelemetryReadOptions): AsyncIterable<StoredTelemetryEvent>;
  subscribe(listener: (entry: StoredTelemetryEvent) => void): () => void;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function matches(
  entry: StoredTelemetryEvent,
  options: TelemetryReadOptions
): boolean {
  const { event } = entry;
  if (
    options.afterSequence !== undefined &&
    entry.sequence <= options.afterSequence
  ) {
    return false;
  }
  if (
    options.traceId !== undefined &&
    event.traceContext.traceId !== options.traceId
  ) {
    return false;
  }
  if (options.runId !== undefined && event.runId !== options.runId) {
    return false;
  }
  if (
    options.parentSpanId !== undefined &&
    event.traceContext.parentSpanId !== options.parentSpanId
  ) {
    return false;
  }
  if (options.type !== undefined) {
    const types = Array.isArray(options.type) ? options.type : [options.type];
    if (!types.includes(event.type)) return false;
  }
  return true;
}

/**
 * In-memory reference implementation for local development and tests.
 * Production adapters can use the same interface with DO SQLite or JSONL.
 */
export class InMemoryTelemetryStore implements TelemetryStore {
  private readonly entries: StoredTelemetryEvent[] = [];
  private readonly listeners = new Set<(entry: StoredTelemetryEvent) => void>();
  private readonly ids = new Set<string>();
  private nextSequence = 1;

  async append(eventInput: TelemetryEvent): Promise<StoredTelemetryEvent> {
    const [entry] = await this.appendMany([eventInput]);
    return entry;
  }

  async appendMany(
    eventInputs: readonly TelemetryEvent[]
  ): Promise<readonly StoredTelemetryEvent[]> {
    const events = eventInputs.map((event) =>
      TelemetryEventSchema.parse(event)
    );
    for (const event of events) {
      if (this.ids.has(event.id)) {
        throw new Error(`Telemetry event '${event.id}' already exists`);
      }
    }

    const entries = events.map((event) => ({
      sequence: this.nextSequence++,
      event: clone(event),
    }));
    this.entries.push(...entries);
    for (const entry of entries) {
      this.ids.add(entry.event.id);
      const snapshot = { sequence: entry.sequence, event: clone(entry.event) };
      for (const listener of this.listeners) listener(snapshot);
    }
    return entries.map((entry) => ({
      sequence: entry.sequence,
      event: clone(entry.event),
    }));
  }

  async read(
    options: TelemetryReadOptions = {}
  ): Promise<readonly StoredTelemetryEvent[]> {
    const limit = options.limit ?? Number.POSITIVE_INFINITY;
    if (
      (limit !== Number.POSITIVE_INFINITY && !Number.isInteger(limit)) ||
      limit < 0
    ) {
      throw new RangeError(
        "Telemetry read limit must be a non-negative integer"
      );
    }
    const result: StoredTelemetryEvent[] = [];
    for (const entry of this.entries) {
      if (!matches(entry, options)) continue;
      result.push({ sequence: entry.sequence, event: clone(entry.event) });
      if (result.length >= limit) break;
    }
    return result;
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

    for (const entry of entries) {
      if (
        entry.event.type !== "model" ||
        entry.event.payload.action !== "completed"
      ) {
        continue;
      }
      const usage = entry.event.payload.usage;
      if (usage) {
        addUsage(usage, (key, value) => {
          if (key === "inputTokens") inputTokens += value;
          if (key === "outputTokens") outputTokens += value;
          if (key === "totalTokens") totalTokens += value;
          if (key === "reasoningTokens") reasoningTokens += value;
          if (key === "cacheReadTokens") cacheReadTokens += value;
          if (key === "cacheWriteTokens") cacheWriteTokens += value;
        });
      }
      const reportedCost = entry.event.payload.cost ?? usage?.cost;
      if (reportedCost) {
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
      : { state: "unknown" as const, reason: "No provider cost was reported" };

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
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get size(): number {
    return this.entries.length;
  }
}

function addUsage(
  usage: NormalizedUsage,
  add: (key: string, value: number) => void
): void {
  if (usage.inputTokens !== undefined) add("inputTokens", usage.inputTokens);
  if (usage.outputTokens !== undefined) add("outputTokens", usage.outputTokens);
  if (usage.totalTokens !== undefined) add("totalTokens", usage.totalTokens);
  if (usage.reasoning?.tokens !== undefined)
    add("reasoningTokens", usage.reasoning.tokens);
  if (usage.cache?.readTokens !== undefined) {
    add("cacheReadTokens", usage.cache.readTokens);
  } else if (usage.cache?.readInputTokens !== undefined) {
    add("cacheReadTokens", usage.cache.readInputTokens);
  }
  if (usage.cache?.writeTokens !== undefined) {
    add("cacheWriteTokens", usage.cache.writeTokens);
  } else if (usage.cache?.writeInputTokens !== undefined) {
    add("cacheWriteTokens", usage.cache.writeInputTokens);
  }
}

function randomHex(length: number): string {
  const value = crypto.randomUUID().replaceAll("-", "");
  if (length <= value.length) return value.slice(0, length);
  return `${value}${randomHex(length - value.length)}`;
}

/** Create a valid W3C-compatible trace context for a new span. */
export function createTraceContext(parent?: TraceContext): TraceContext {
  return {
    traceId: parent?.traceId ?? (randomHex(32) as TraceId),
    spanId: randomHex(16) as SpanId,
    traceFlags: parent?.traceFlags ?? "01",
    traceState: parent?.traceState,
    parentSpanId: parent?.spanId,
  };
}

export function traceParent(context: TraceContext): string {
  return `00-${context.traceId}-${context.spanId}-${context.traceFlags}`;
}

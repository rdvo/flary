import {
  ApprovalDecisionSchema,
  UserInputAnswerRequestSchema,
  type RunEvent,
  type RunResult,
} from "../contracts/index.js";
import type {
  FlaryRunService,
  TrustedRunContext,
} from "../host/runs.js";
import type {
  FlaryEvent,
  FlaryRun,
  FlaryRunOptions,
  FlaryRunStorage,
  FlaryRunStore,
  FlaryStepStorage,
  FlaryStepStore,
} from "./types.js";

type Event<Output> = FlaryEvent<Output>;

/**
 * A small process-local run store for local calls and tests.
 *
 * A production Worker should supply a Durable Object-backed store. The
 * callable API does not change when that adapter is used.
 */
export class InMemoryFlaryFunctionRunStore implements FlaryRunStore {
  readonly #runs = new Map<string, LocalRun<unknown>>();

  async create<T>(input: {
    readonly runId: string;
    readonly execute: (signal: AbortSignal) => Promise<T>;
  }): Promise<FlaryRun<T>> {
    if (this.#runs.has(input.runId)) {
      return this.#runs.get(input.runId)!.publicRun() as FlaryRun<T>;
    }
    const run = new LocalRun<T>(input.runId, input.execute);
    this.#runs.set(input.runId, run as LocalRun<unknown>);
    run.start();
    return run.publicRun();
  }

  get<T = unknown>(runId: string): FlaryRun<T> | undefined {
    return this.#runs.get(runId)?.publicRun() as FlaryRun<T> | undefined;
  }
}

interface StoredRunSnapshot {
  readonly runId: string;
  readonly status: FlaryRun<unknown>["status"];
  readonly events: readonly Event<unknown>[];
  readonly output?: unknown;
  readonly error?: { readonly message: string };
}

/**
 * Durable Object-backed run projection.
 *
 * This is a legacy projection adapter for low-level hosts. Its execution
 * closure remains process-local. Function-first `.start()` uses the Flue run
 * service and the generated Cloudflare Durable Object instead; production
 * hosts must not use this adapter as their durable execution engine.
 */
export class DurableObjectFlaryFunctionRunStore implements FlaryRunStore {
  readonly #active = new Map<string, FlaryRun<unknown>>();

  constructor(
    private readonly storage: FlaryRunStorage,
    private readonly prefix = "flary:run",
  ) {}

  async create<T>(input: {
    readonly runId: string;
    readonly execute: (signal: AbortSignal) => Promise<T>;
  }): Promise<FlaryRun<T>> {
    const active = this.#active.get(input.runId);
    if (active) return active as FlaryRun<T>;
    const stored = await this.read(input.runId);
    if (stored && isTerminal(stored.status)) {
      const restored = restoredRun<T>(stored);
      this.#active.set(input.runId, restored as FlaryRun<unknown>);
      return restored;
    }
    const run = await new InMemoryFlaryFunctionRunStore().create(input);
    this.#active.set(input.runId, run as FlaryRun<unknown>);
    void this.watch(run);
    return run;
  }

  async get(runId: string): Promise<FlaryRun | undefined> {
    const active = this.#active.get(runId);
    if (active) return active;
    const stored = await this.read(runId);
    return stored ? restoredRun(stored) : undefined;
  }

  private async watch(run: FlaryRun<unknown>): Promise<void> {
    const events: Event<unknown>[] = [];
    try {
      for await (const event of run.stream()) {
        events.push(event);
        const snapshot: StoredRunSnapshot = {
          runId: run.runId,
          status: run.status,
          events,
          ...(event.type === "output" ? { output: event.output } : {}),
        };
        await this.storage.put(this.key(run.runId), snapshot);
      }
      if (run.status === "failed" || run.status === "cancelled") {
        try {
          await run.result();
        } catch (cause) {
          await this.storage.put(this.key(run.runId), {
            runId: run.runId,
            status: run.status,
            events,
            error: { message: cause instanceof Error ? cause.message : "The run failed" },
          } satisfies StoredRunSnapshot);
        }
      }
    } catch {
      // Projection failures must not change the function result. The host can
      // retry or inspect the underlying Durable Object storage.
    }
  }

  private async read(runId: string): Promise<StoredRunSnapshot | undefined> {
    const value = await this.storage.get<unknown>(this.key(runId));
    if (!isRecord(value) || typeof value.runId !== "string" || !Array.isArray(value.events)) {
      return undefined;
    }
    return value as unknown as StoredRunSnapshot;
  }

  private key(runId: string): string {
    return `${this.prefix}:${encodeURIComponent(runId)}`;
  }
}

export interface FlueBackedFlaryRunOptions<Output> {
  readonly service: FlaryRunService;
  readonly trusted: TrustedRunContext;
  readonly runId: string;
  readonly initialStatus?: RunResult["status"];
  readonly parseOutput: (value: unknown) => Output;
  readonly pollMs?: number;
}

/**
 * Adapt the existing durable Flue run service to the function-first handle.
 *
 * The service owns admission, tenant checks, recovery, events, approval, and
 * input continuation. This adapter does not execute function code.
 */
export function createFlueBackedFlaryRun<Output>(
  options: FlueBackedFlaryRunOptions<Output>,
): FlaryRun<Output> {
  let status = mapRunStatus(options.initialStatus ?? "queued");
  const pollMs = options.pollMs ?? 100;

  const read = async (): Promise<RunResult> => {
    const result = await options.service.get(options.trusted, options.runId);
    status = mapRunStatus(result.status);
    return result;
  };

  return {
    runId: options.runId,
    get status() {
      return status;
    },
    async result(): Promise<Output> {
      while (true) {
        const value = await read();
        if (value.status === "completed") {
          return options.parseOutput(value.output);
        }
        if (value.status === "failed") {
          const error = new Error(value.error?.message ?? "The Flary run failed");
          if (value.error?.code) {
            Object.defineProperty(error, "code", { value: value.error.code });
          }
          throw error;
        }
        if (value.status === "cancelled") {
          throw new DOMException("The Flary run was cancelled", "AbortError");
        }
        await delay(pollMs);
      }
    },
    async *stream(streamOptions = {}): AsyncIterable<FlaryEvent<Output>> {
      for await (const event of options.service.observe(
        options.trusted,
        options.runId,
        {
          afterSequence: 0,
          signal: streamOptions.signal ?? new AbortController().signal,
        },
      )) {
        const mapped = mapServiceEvent(event, options.parseOutput);
        if (mapped) {
          if (mapped.type === "output") status = "completed";
          else if (mapped.type === "failed") status = "failed";
          else if (mapped.type === "cancelled") status = "cancelled";
          else if (mapped.type === "paused") status = "paused";
          else if (mapped.type === "started") status = "running";
          yield mapped;
        }
      }
    },
    async cancel(reason?: string): Promise<void> {
      const value = await options.service.cancel(
        options.trusted,
        options.runId,
        {
          idempotencyKey: `cancel_${crypto.randomUUID()}`,
          ...(reason ? { reason } : {}),
        },
      );
      status = mapRunStatus(value.status);
    },
    async approvals() {
      if (!options.service.listApprovals) {
        throw continuationUnavailable("Approval");
      }
      return options.service.listApprovals(options.trusted, options.runId);
    },
    async approve(approvalId, decisionOptions = {}): Promise<void> {
      await decideApproval("approved", approvalId, decisionOptions);
    },
    async reject(approvalId, decisionOptions = {}): Promise<void> {
      await decideApproval("rejected", approvalId, decisionOptions);
    },
    async userInput() {
      if (!options.service.listUserInput) {
        throw continuationUnavailable("User input");
      }
      return options.service.listUserInput(options.trusted, options.runId);
    },
    async respond(requestId, inputValue): Promise<void> {
      if (!options.service.respondToUserInput) {
        throw continuationUnavailable("User input");
      }
      const value = await options.service.respondToUserInput(
        options.trusted,
        options.runId,
        requestId,
        UserInputAnswerRequestSchema.parse(inputValue),
      );
      status = mapRunStatus(value.status);
    },
    async sendInput(input, inputOptions = {}): Promise<void> {
      const value = await options.service.input(
        options.trusted,
        options.runId,
        {
          input: jsonValue(input),
          idempotencyKey:
            inputOptions.idempotencyKey ?? `input_${crypto.randomUUID()}`,
          ...(inputOptions.metadata
            ? { metadata: jsonObject(inputOptions.metadata) }
            : {}),
        },
      );
      status = mapRunStatus(value.status);
    },
  };

  async function decideApproval(
    decision: "approved" | "rejected",
    approvalId: string,
    decisionOptions: {
      readonly comment?: string;
      readonly metadata?: Record<string, unknown>;
    },
  ): Promise<void> {
    if (!options.service.decideApproval) {
      throw continuationUnavailable("Approval");
    }
    const value = await options.service.decideApproval(
      options.trusted,
      options.runId,
      ApprovalDecisionSchema.parse({
        requestId: approvalId,
        status: decision,
        decidedBy: options.trusted.identity,
        decidedAt: new Date().toISOString(),
        ...(decisionOptions.comment
          ? { comment: decisionOptions.comment }
          : {}),
        ...(decisionOptions.metadata
          ? { metadata: decisionOptions.metadata }
          : {}),
      }),
    );
    status = mapRunStatus(value.status);
  }
}

class LocalRun<T> {
  readonly #events: Event<T>[] = [];
  readonly #waiters = new Set<{
    resolve: (value: IteratorResult<Event<T>>) => void;
    reject: (error: unknown) => void;
  }>();
  readonly #abort = new AbortController();
  readonly #result: Promise<T>;
  #resolveResult!: (value: T) => void;
  #rejectResult!: (error: unknown) => void;
  #status: FlaryRun<T>["status"] = "queued";
  #done = false;

  constructor(
    readonly runId: string,
    private readonly execute: (signal: AbortSignal) => Promise<T>,
  ) {
    this.#result = new Promise<T>((resolve, reject) => {
      this.#resolveResult = resolve;
      this.#rejectResult = reject;
    });
    this.emit({ type: "queued", runId, occurredAt: now() });
  }

  start(): void {
    this.#status = "running";
    this.emit({ type: "started", runId: this.runId, occurredAt: now() });
    void this.execute(this.#abort.signal).then(
      (output) => {
        if (this.#done) return;
        if (this.#abort.signal.aborted) {
          this.#status = "cancelled";
          this.#rejectResult(this.#abort.signal.reason ?? new Error("The run was cancelled"));
          this.emit({ type: "cancelled", runId: this.runId, occurredAt: now() });
          this.finish();
          return;
        }
        this.#status = "completed";
        this.#resolveResult(output);
        this.emit({
          type: "output",
          runId: this.runId,
          output,
          occurredAt: now(),
        });
        this.finish();
      },
      (cause: unknown) => {
        if (this.#done) return;
        if (this.#abort.signal.aborted) {
          this.#status = "cancelled";
          this.#rejectResult(cause);
          this.emit({ type: "cancelled", runId: this.runId, occurredAt: now() });
        } else {
          this.#status = "failed";
          const error = errorInfo(cause);
          this.#rejectResult(cause);
          this.emit({ type: "failed", runId: this.runId, error, occurredAt: now() });
        }
        this.finish();
      },
    );
  }

  publicRun(): FlaryRun<T> {
    const thisRun = this;
    return {
      get runId() {
        return thisRun.runId;
      },
      get status() {
        return thisRun.#status;
      },
      result: () => this.#result,
      stream: (options = {}) => this.stream(options.signal),
      cancel: async (reason?: string) => {
        if (this.#done) return;
        this.#abort.abort(reason ?? "The run was cancelled");
      },
      approvals: async () => [],
      approve: async () => {
        throw localContinuationError();
      },
      reject: async () => {
        throw localContinuationError();
      },
      userInput: async () => [],
      respond: async () => {
        throw localContinuationError();
      },
      sendInput: async () => {
        throw localContinuationError();
      },
    };
  }

  async *stream(signal?: AbortSignal): AsyncIterable<Event<T>> {
    let index = 0;
    while (true) {
      while (index < this.#events.length) yield this.#events[index++]!;
      if (this.#done) return;
      const next = await new Promise<IteratorResult<Event<T>>>((resolve, reject) => {
        const waiter = { resolve, reject };
        this.#waiters.add(waiter);
        if (signal) {
          if (signal.aborted) {
            this.#waiters.delete(waiter);
            reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
          } else {
            signal.addEventListener(
              "abort",
              () => {
                this.#waiters.delete(waiter);
                reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
              },
              { once: true },
            );
          }
        }
      });
      if (next.done) return;
      if (next.value) yield next.value;
      index += 1;
    }
  }

  private emit(event: Event<T>): void {
    this.#events.push(event);
    for (const waiter of this.#waiters) waiter.resolve({ value: event, done: false });
    this.#waiters.clear();
  }

  private finish(): void {
    this.#done = true;
    for (const waiter of this.#waiters) waiter.resolve({ value: undefined, done: true });
    this.#waiters.clear();
  }
}

function restoredRun<T>(snapshot: StoredRunSnapshot): FlaryRun<T> {
  return {
    runId: snapshot.runId,
    status: snapshot.status,
    result: () => snapshot.status === "completed"
      ? Promise.resolve(snapshot.output as T)
      : Promise.reject(new Error(snapshot.error?.message ?? "The run is not complete")),
    stream: async function* () {
      for (const event of snapshot.events) yield event as Event<T>;
    },
    cancel: async () => undefined,
    approvals: async () => [],
    approve: async () => {
      throw localContinuationError();
    },
    reject: async () => {
      throw localContinuationError();
    },
    userInput: async () => [],
    respond: async () => {
      throw localContinuationError();
    },
    sendInput: async () => {
      throw localContinuationError();
    },
  };
}

function isTerminal(status: FlaryRun<unknown>["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function now(): string {
  return new Date().toISOString();
}

function errorInfo(cause: unknown): { code: string; message: string } {
  return {
    code: cause instanceof Error && "code" in cause
      ? String((cause as { code: unknown }).code)
      : "flary_function_failed",
    message: cause instanceof Error ? cause.message : "The function failed",
  };
}

export function runId(prefix = "run"): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

/**
 * Durable Object KV adapter for named steps.
 *
 * Durable Object SQLite is the recommended backing store. This adapter uses
 * the small `get`/`put` surface shared by Durable Object storage and test
 * doubles, so step values stay private to the host and never enter model
 * context until the workflow asks for them.
 */
export class DurableObjectFlaryStepStore implements FlaryStepStore {
  constructor(
    private readonly storage: FlaryStepStorage,
    private readonly prefix = "flary:step",
  ) {}

  async get(input: {
    readonly runId: string;
    readonly name: string;
  }): Promise<{ readonly inputHash: string; readonly value: unknown } | undefined> {
    const value = await this.storage.get<unknown>(this.key(input.runId, input.name));
    if (!isRecord(value) || typeof value.inputHash !== "string" || !("value" in value)) {
      return undefined;
    }
    return { inputHash: value.inputHash, value: value.value };
  }

  async put(input: {
    readonly runId: string;
    readonly name: string;
    readonly inputHash: string;
    readonly value: unknown;
  }): Promise<void> {
    // JSON round-tripping rejects functions, symbols, and cyclic values before
    // they can corrupt a durable replay record.
    let value: unknown;
    try {
      value = JSON.parse(JSON.stringify(input.value)) as unknown;
    } catch {
      throw new Error(`Step '${input.name}' returned a non-serializable value.`);
    }
    await this.storage.put(this.key(input.runId, input.name), {
      inputHash: input.inputHash,
      value,
    });
  }

  private key(runId: string, name: string): string {
    return `${this.prefix}:${encodeURIComponent(runId)}:${encodeURIComponent(name)}`;
  }
}

interface FlaryStepSqlStorage {
  exec<T = Record<string, unknown>>(
    query: string,
    ...bindings: unknown[]
  ): { toArray(): T[] };
}

/** Durable Object SQLite adapter for named function steps. */
export class SqliteFlaryStepStore implements FlaryStepStore {
  constructor(
    private readonly sql: FlaryStepSqlStorage,
    private readonly prefix = "flary:step",
  ) {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS flary_function_steps (
        run_id TEXT NOT NULL,
        step_name TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (run_id, step_name)
      )
    `);
  }

  async get(input: {
    readonly runId: string;
    readonly name: string;
  }): Promise<{ readonly inputHash: string; readonly value: unknown } | undefined> {
    const row = this.sql.exec<{ input_hash: string; value_json: string }>(
      `SELECT input_hash, value_json FROM flary_function_steps
       WHERE run_id = ? AND step_name = ? LIMIT 1`,
      input.runId,
      this.key(input.name),
    ).toArray()[0];
    if (!row) return undefined;
    return {
      inputHash: row.input_hash,
      value: JSON.parse(row.value_json) as unknown,
    };
  }

  async put(input: {
    readonly runId: string;
    readonly name: string;
    readonly inputHash: string;
    readonly value: unknown;
  }): Promise<void> {
    let valueJson: string;
    try {
      valueJson = JSON.stringify(input.value);
    } catch {
      throw new Error(`Step '${input.name}' returned a non-serializable value.`);
    }
    if (valueJson === undefined) {
      throw new Error(`Step '${input.name}' returned an undefined value.`);
    }
    this.sql.exec(
      `INSERT INTO flary_function_steps (
         run_id, step_name, input_hash, value_json, updated_at
       ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (run_id, step_name) DO UPDATE SET
         input_hash = excluded.input_hash,
         value_json = excluded.value_json,
         updated_at = excluded.updated_at`,
      input.runId,
      this.key(input.name),
      input.inputHash,
      valueJson,
      new Date().toISOString(),
    );
  }

  private key(name: string): string {
    return `${this.prefix}:${name}`;
  }
}

export type { FlaryRunOptions };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function localContinuationError(): Error {
  return new Error(
    "Approval and input continuation require the Flue-backed run service.",
  );
}

function continuationUnavailable(feature: string): Error {
  return new Error(
    `${feature} continuation is not configured on the Flue run service.`,
  );
}

function mapRunStatus(
  status: RunResult["status"],
): FlaryRun<unknown>["status"] {
  if (status === "waiting") return "paused";
  return status;
}

function mapServiceEvent<Output>(
  event: RunEvent,
  parseOutput: (value: unknown) => Output,
): FlaryEvent<Output> | undefined {
  switch (event.type) {
    case "run.queued":
      return {
        type: "queued",
        runId: event.runId,
        occurredAt: event.occurredAt,
      };
    case "run.started":
      return {
        type: "started",
        runId: event.runId,
        occurredAt: event.occurredAt,
      };
    case "run.waiting":
      return {
        type: "paused",
        runId: event.runId,
        reason: event.payload.reason,
        ...(event.payload.approvalId
          ? { approvalId: event.payload.approvalId }
          : {}),
        occurredAt: event.occurredAt,
      };
    case "approval.requested":
      return {
        type: "paused",
        runId: event.runId,
        reason: event.payload.request.reason,
        approvalId: event.payload.request.id,
        occurredAt: event.occurredAt,
      };
    case "run.completed":
      return {
        type: "output",
        runId: event.runId,
        output: parseOutput(event.payload.output),
        occurredAt: event.occurredAt,
      };
    case "run.failed":
      return {
        type: "failed",
        runId: event.runId,
        error: {
          code: event.payload.error.code,
          message: event.payload.error.message,
        },
        occurredAt: event.occurredAt,
      };
    case "run.cancelled":
      return {
        type: "cancelled",
        runId: event.runId,
        occurredAt: event.occurredAt,
      };
    default:
      return {
        type: "progress",
        runId: event.runId,
        event,
        occurredAt: event.occurredAt,
      };
  }
}

function jsonValue(value: unknown): any {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    throw new Error("Flary run input must be JSON-serializable.");
  }
}

function jsonObject(value: Record<string, unknown>): Record<string, any> {
  const parsed = jsonValue(value);
  if (!isRecord(parsed)) {
    throw new Error("Flary run metadata must be a JSON object.");
  }
  return parsed;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

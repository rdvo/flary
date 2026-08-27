import type { SessionEngine, SessionEngineAdmission, SessionEngineForkArchive } from "./engine.js";

export interface Flue2PinnedSubmission {
  readonly agentId: string;
  readonly threadId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly model: string;
  readonly admission?: SessionEngineAdmission;
}

/** Durable metadata needed to retry one admission with the exact same model. */
export interface Flue2SessionEngineStateStore {
  get(input: Pick<Flue2PinnedSubmission, "agentId" | "threadId" | "idempotencyKey">): Promise<Flue2PinnedSubmission | undefined>;
  reserve(input: Flue2PinnedSubmission): Promise<Flue2PinnedSubmission>;
  admit(input: Flue2PinnedSubmission & { readonly admission: SessionEngineAdmission }): Promise<void>;
}

export interface Flue2SessionEngineTransport {
  submit(input: {
    readonly agentId: string;
    readonly threadId: string;
    readonly message: string;
    readonly idempotencyKey: string;
    readonly model: string;
    readonly thinkingLevel?: string;
    readonly cacheRetention?: "none" | "short" | "long";
    readonly images?: readonly unknown[];
  }): Promise<SessionEngineAdmission>;
  observe(
    admission: SessionEngineAdmission,
    onEvent: (event: Readonly<Record<string, unknown>>) => Promise<void>,
  ): Promise<unknown>;
  cancel(agentId: string, threadId: string): Promise<void>;
}

/**
 * Trusted control surface implemented inside the Flue 2 agent Durable Object.
 *
 * `rollback` appends a canonical reset marker at the active tail. Flary's
 * pinned Flue 2 context builder applies that marker when it reconstructs the
 * active model path. Public history keeps the abandoned records for audit.
 */
export interface Flue2SessionEngineControl {
  compact(agentId: string, threadId: string, reason?: string): Promise<unknown>;
  rollback(input: {
    readonly agentId: string;
    readonly threadId: string;
    readonly turnId: string;
    readonly reason?: string;
    readonly excludeTarget?: boolean;
  }): Promise<unknown>;
  exportCanonical(input: {
    readonly agentId: string;
    readonly threadId: string;
    readonly throughTurnId?: string;
  }): Promise<unknown>;
  restoreCanonical(input: {
    readonly agentId: string;
    readonly threadId: string;
    readonly payload: unknown;
  }): Promise<void>;
  active(agentId: string, threadId: string): Promise<boolean>;
  /** Resume approved calls from their durable journal before observation. */
  resumeApprovals(input: {
    readonly agentId: string;
    readonly threadId: string;
    readonly submissionId: string;
  }): Promise<void>;
}

export interface CreateFlue2SessionEngineOptions {
  readonly state: Flue2SessionEngineStateStore;
  readonly transport: Flue2SessionEngineTransport;
  readonly control: Flue2SessionEngineControl;
  /** Resolve once before admission. The result is durably pinned. */
  readonly resolveModel: (input: {
    readonly agentId: string;
    readonly threadId: string;
    readonly requested?: string;
  }) => Promise<string> | string;
  readonly revision?: string;
}

/** Flue 2 session adapter with durable admission metadata and exact controls. */
export function createFlue2SessionEngine(
  options: CreateFlue2SessionEngineOptions,
): SessionEngine {
  return {
    pin: {
      id: "flue-2",
      version: "2.0.2",
      revision: options.revision ?? "npm:@flue/runtime@2.0.2",
    },
    capabilities: {
      durableAdmission: true,
      durableObservation: true,
      manualCompaction: true,
      activePathRollback: true,
      exactCanonicalExport: true,
      exactCanonicalRestore: true,
      perSubmissionModelPin: true,
      approvalContinuation: true,
    },
    async submit(input) {
      const requestHash = await sha256Json({
        agentId: input.agentId,
        threadId: input.threadId,
        message: input.message,
        idempotencyKey: input.idempotencyKey,
        requestedModel: input.model,
        thinkingLevel: input.thinkingLevel,
        cacheRetention: input.cacheRetention,
        images: input.images,
      });
      const stored = await options.state.get(input);
      const pinned = stored ?? await (async () => {
        const model = await options.resolveModel({
          agentId: input.agentId,
          threadId: input.threadId,
          requested: input.model,
        });
        if (!model.trim()) throw new Error("The resolved model pin is empty");
        return options.state.reserve({
          agentId: input.agentId,
          threadId: input.threadId,
          idempotencyKey: input.idempotencyKey,
          requestHash,
          model,
        });
      })();
      if (pinned.requestHash !== requestHash) {
        throw new Error("The idempotency key belongs to a different submission");
      }
      if (pinned.admission) return { ...pinned.admission, duplicate: true };
      const admitted = await options.transport.submit({
        agentId: input.agentId,
        threadId: input.threadId,
        message: input.message,
        idempotencyKey: input.idempotencyKey,
        model: pinned.model,
        ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
        ...(input.cacheRetention ? { cacheRetention: input.cacheRetention } : {}),
        ...(input.images ? { images: input.images } : {}),
      });
      const admission: SessionEngineAdmission = {
        ...admitted,
        agentId: input.agentId,
        threadId: input.threadId,
      };
      await options.state.admit({ ...pinned, admission });
      return admission;
    },
    async observe(admission, onEvent) {
      await options.control.resumeApprovals({
        agentId: admissionAgent(admission),
        threadId: admissionThread(admission),
        submissionId: admission.submissionId,
      });
      return options.transport.observe(admission, onEvent);
    },
    cancel: (agentId, threadId) => options.transport.cancel(agentId, threadId),
    compact: (agentId, threadId, reason) => options.control.compact(agentId, threadId, reason),
    rollback: (input) => options.control.rollback(input),
    async export(input) {
      if (await options.control.active(input.agentId, input.threadId)) {
        throw new Error("An active session cannot be exported");
      }
      const payload = await options.control.exportCanonical(input);
      return {
        format: "flary-session-engine",
        version: 1,
        source: {
          id: "flue-2",
          version: "2.0.2",
          revision: options.revision ?? "npm:@flue/runtime@2.0.2",
        },
        threadId: input.threadId,
        ...(input.throughTurnId ? { throughTurnId: input.throughTurnId } : {}),
        sha256: await sha256Json(payload),
        payload,
      } satisfies SessionEngineForkArchive;
    },
    async restore(input) {
      if (await options.control.active(input.agentId, input.threadId)) {
        throw new Error("An active session cannot be restored");
      }
      if (input.archive.format !== "flary-session-engine" || input.archive.version !== 1) {
        throw new Error("The session engine archive is invalid");
      }
      const actual = await sha256Json(input.archive.payload);
      if (actual !== input.archive.sha256) {
        throw new Error("The session engine archive hash does not match");
      }
      await options.control.restoreCanonical({
        agentId: input.agentId,
        threadId: input.threadId,
        payload: input.archive.payload,
      });
    },
    active: (agentId, threadId) => options.control.active(agentId, threadId),
  };
}

/** In-memory state for local use. Durable Cloudflare hosts use the SQLite store. */
export class InMemoryFlue2SessionEngineStateStore implements Flue2SessionEngineStateStore {
  readonly #records: Map<string, Flue2PinnedSubmission>;

  constructor(records: readonly Flue2PinnedSubmission[] = []) {
    this.#records = new Map(records.map((record) => [submissionKey(record), clonePinned(record)]));
  }

  async get(input: Pick<Flue2PinnedSubmission, "agentId" | "threadId" | "idempotencyKey">): Promise<Flue2PinnedSubmission | undefined> {
    const current = this.#records.get(submissionKey(input));
    return current ? clonePinned(current) : undefined;
  }

  async reserve(input: Flue2PinnedSubmission): Promise<Flue2PinnedSubmission> {
    const key = submissionKey(input);
    const current = this.#records.get(key);
    if (current) return clonePinned(current);
    const record = clonePinned(input);
    this.#records.set(key, record);
    return clonePinned(record);
  }

  async admit(input: Flue2PinnedSubmission & { readonly admission: SessionEngineAdmission }): Promise<void> {
    const key = submissionKey(input);
    const current = this.#records.get(key);
    if (!current || current.requestHash !== input.requestHash || current.model !== input.model) {
      throw new Error("The durable model pin changed before admission completed");
    }
    if (current.admission && !sameAdmission(current.admission, input.admission)) {
      throw new Error("The durable admission changed after it was stored");
    }
    this.#records.set(key, clonePinned(current.admission ? current : input));
  }

  snapshot(): readonly Flue2PinnedSubmission[] {
    return [...this.#records.values()].map(clonePinned);
  }
}

/** Structural subset of Durable Object SQLite used by the model-pin store. */
export interface Flue2SqlStorage {
  exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): {
    toArray(): T[];
  };
}

/** Durable Object SQLite implementation. INSERT OR IGNORE is the admission fence. */
export class SqliteFlue2SessionEngineStateStore implements Flue2SessionEngineStateStore {
  constructor(private readonly sql: Flue2SqlStorage) {
    sql.exec(`CREATE TABLE IF NOT EXISTS flary_flue2_submission_pin (
      agent_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      model TEXT NOT NULL,
      admission_json TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (agent_id, thread_id, idempotency_key)
    )`);
  }

  async get(input: Pick<Flue2PinnedSubmission, "agentId" | "threadId" | "idempotencyKey">): Promise<Flue2PinnedSubmission | undefined> {
    return this.read(input);
  }

  async reserve(input: Flue2PinnedSubmission): Promise<Flue2PinnedSubmission> {
    this.sql.exec(
      `INSERT OR IGNORE INTO flary_flue2_submission_pin
       (agent_id, thread_id, idempotency_key, request_hash, model, admission_json, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`,
      input.agentId,
      input.threadId,
      input.idempotencyKey,
      input.requestHash,
      input.model,
      new Date().toISOString(),
    );
    const record = this.read(input);
    if (!record) throw new Error("The durable model pin was not stored");
    return record;
  }

  async admit(input: Flue2PinnedSubmission & { readonly admission: SessionEngineAdmission }): Promise<void> {
    this.sql.exec(
      `UPDATE flary_flue2_submission_pin
       SET admission_json = COALESCE(admission_json, ?), updated_at = ?
       WHERE agent_id = ? AND thread_id = ? AND idempotency_key = ?
         AND request_hash = ? AND model = ?`,
      JSON.stringify(input.admission),
      new Date().toISOString(),
      input.agentId,
      input.threadId,
      input.idempotencyKey,
      input.requestHash,
      input.model,
    );
    const current = this.read(input);
    if (!current?.admission) {
      throw new Error("The durable model pin changed before admission completed");
    }
    if (!sameAdmission(current.admission, input.admission)) {
      throw new Error("The durable admission changed after it was stored");
    }
  }

  private read(input: Pick<Flue2PinnedSubmission, "agentId" | "threadId" | "idempotencyKey">): Flue2PinnedSubmission | undefined {
    const [row] = this.sql.exec<{
      agent_id: string;
      thread_id: string;
      idempotency_key: string;
      request_hash: string;
      model: string;
      admission_json: string | null;
    }>(
      `SELECT agent_id, thread_id, idempotency_key, request_hash, model, admission_json
       FROM flary_flue2_submission_pin
       WHERE agent_id = ? AND thread_id = ? AND idempotency_key = ?`,
      input.agentId,
      input.threadId,
      input.idempotencyKey,
    ).toArray();
    if (!row) return undefined;
    return {
      agentId: row.agent_id,
      threadId: row.thread_id,
      idempotencyKey: row.idempotency_key,
      requestHash: row.request_hash,
      model: row.model,
      ...(row.admission_json
        ? { admission: JSON.parse(row.admission_json) as SessionEngineAdmission }
        : {}),
    };
  }
}

function admissionAgent(admission: SessionEngineAdmission): string {
  const value = admission as SessionEngineAdmission & { readonly agentId?: string };
  if (!value.agentId) throw new Error("The Flue 2 admission is missing agentId");
  return value.agentId;
}

function admissionThread(admission: SessionEngineAdmission): string {
  const value = admission as SessionEngineAdmission & { readonly threadId?: string };
  if (!value.threadId) throw new Error("The Flue 2 admission is missing threadId");
  return value.threadId;
}

function submissionKey(input: Pick<Flue2PinnedSubmission, "agentId" | "threadId" | "idempotencyKey">): string {
  return `${input.agentId}\0${input.threadId}\0${input.idempotencyKey}`;
}

function clonePinned(input: Flue2PinnedSubmission): Flue2PinnedSubmission {
  return {
    ...input,
    ...(input.admission ? { admission: { ...input.admission } } : {}),
  };
}

function sameAdmission(left: SessionEngineAdmission, right: SessionEngineAdmission): boolean {
  return left.submissionId === right.submissionId
    && left.cursor === right.cursor
    && left.agentId === right.agentId
    && left.threadId === right.threadId;
}

async function sha256Json(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

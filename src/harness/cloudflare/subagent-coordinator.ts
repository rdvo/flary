import {
  DelegationPolicySchema,
  SendSubagentMessageRequestSchema,
  SpawnSubagentRequestSchema,
  SubagentActivityEventSchema,
  SubagentContextSeedSchema,
  SubagentControlRequestSchema,
  SubagentConversationTurnSchema,
  SubagentMailboxMessageSchema,
  SubagentThreadSchema,
  type DelegationPolicy,
  type SendSubagentMessageRequestInput,
  type SpawnSubagentRequestInput,
  type SubagentActivityEvent,
  type SubagentControlRequest,
  type SubagentConversationTurn,
  type SubagentMailboxMessage,
  type SubagentThread,
} from "../contracts/subagents.js";
import { SubagentPolicyError, type SubagentCoordinatorOptions } from "../subagents/coordinator.js";
import { selectSeededTurns } from "../subagents/context.js";

interface SqlRows<T> {
  toArray(): T[];
}

/**
 * The subset of Durable Object SQLite used by the coordinator.
 *
 * `transactionSync` is required because spawn admission and its limit checks
 * must commit as one operation.
 */
export interface SubagentCoordinatorSqlStorage {
  exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): SqlRows<T>;
  transactionSync<T>(closure: () => T): T;
}

export interface SqliteSubagentCoordinatorOptions extends SubagentCoordinatorOptions {
  sql: unknown;
}

type ConfigRow = {
  session_id: string;
  root_thread_id: string;
  policy_json: string;
};

type JsonRow = {
  record_json: string;
};

type CountRow = {
  count: number;
};

type SequenceRow = {
  value: number;
};

/**
 * Durable Object SQLite implementation of the Flary subagent coordinator.
 *
 * One instance owns one session. The Flue child thread remains the execution
 * authority. This coordinator stores delegation admission, lineage, selected
 * parent turns, mailbox messages, activity, and idempotent control results.
 */
export class SqliteSubagentCoordinator {
  readonly #sql: SubagentCoordinatorSqlStorage;
  readonly #sessionId: string;
  readonly #rootThreadId: string;
  readonly #policy: DelegationPolicy;
  readonly #now: () => Date;
  readonly #id: () => string;

  constructor(options: SqliteSubagentCoordinatorOptions) {
    const root = SubagentThreadSchema.parse(options.rootThread);
    if (root.sessionId !== options.sessionId) {
      throw new Error("The root thread must belong to the coordinator session");
    }
    const sql = options.sql as Partial<SubagentCoordinatorSqlStorage>;
    if (typeof sql?.exec !== "function" || typeof sql.transactionSync !== "function") {
      throw new Error(
        "The durable subagent coordinator needs Durable Object SQLite with transactionSync",
      );
    }

    this.#sql = sql as SubagentCoordinatorSqlStorage;
    this.#sessionId = options.sessionId;
    this.#rootThreadId = root.threadId;
    this.#policy = DelegationPolicySchema.parse(options.policy ?? {});
    this.#now = options.now ?? (() => new Date());
    this.#id = options.id ?? (() => crypto.randomUUID());

    this.ensureSchema();
    this.initialize(root);
  }

  get policy(): DelegationPolicy {
    return structuredClone(this.#policy);
  }

  getThread(threadId: string): SubagentThread | undefined {
    const row = this.first<JsonRow>(
      `SELECT record_json
       FROM flary_subagent_threads
       WHERE thread_id = ?`,
      threadId,
    );
    return row
      ? structuredClone(SubagentThreadSchema.parse(JSON.parse(row.record_json)))
      : undefined;
  }

  listThreads(): SubagentThread[] {
    return this.#sql
      .exec<JsonRow>(
        `SELECT record_json
         FROM flary_subagent_threads
         ORDER BY ordinal ASC`,
      )
      .toArray()
      .map((row) => structuredClone(SubagentThreadSchema.parse(JSON.parse(row.record_json))));
  }

  appendTurn(turnInput: SubagentConversationTurn): SubagentConversationTurn {
    const turn = SubagentConversationTurnSchema.parse(
      JSON.parse(JSON.stringify(SubagentConversationTurnSchema.parse(turnInput))),
    );
    this.assertSession(turn.sessionId);
    return this.#sql.transactionSync(() => {
      this.requireThread(turn.threadId);
      const existing = this.first<JsonRow>(
        `SELECT record_json
         FROM flary_subagent_turns
         WHERE owner_thread_id = ? AND turn_id = ?`,
        turn.threadId,
        turn.id,
      );
      if (existing) {
        return structuredClone(
          SubagentConversationTurnSchema.parse(JSON.parse(existing.record_json)),
        );
      }
      this.#sql.exec(
        `INSERT INTO flary_subagent_turns
          (owner_thread_id, turn_id, ordinal, record_json)
         VALUES (?, ?, ?, ?)`,
        turn.threadId,
        turn.id,
        turn.ordinal,
        JSON.stringify(turn),
      );
      return structuredClone(turn);
    });
  }

  spawn(input: SpawnSubagentRequestInput): SubagentThread {
    const request = SpawnSubagentRequestSchema.parse(input);
    this.assertSession(request.sessionId);
    return this.#sql.transactionSync(() => {
      const cached = this.readIdempotent<SubagentThread>(
        "spawn",
        request.idempotencyKey,
        SubagentThreadSchema.parse,
      );
      if (cached) return cached;
      if (this.#policy.mode === "disabled") {
        throw new SubagentPolicyError("Subagent delegation is disabled");
      }

      const parent = this.requireThread(request.parentThreadId);
      const depth = parent.depth + 1;
      if (depth > this.#policy.maxDepth) {
        throw new SubagentPolicyError("Subagent depth limit reached");
      }

      const descendants =
        this.first<CountRow>(
          `SELECT COUNT(*) AS count
         FROM flary_subagent_threads
         WHERE parent_thread_id IS NOT NULL`,
        )?.count ?? 0;
      if (Number(descendants) >= this.#policy.maxTotalChildren) {
        throw new SubagentPolicyError("Subagent total limit reached");
      }

      const activeChildren =
        this.first<CountRow>(
          `SELECT COUNT(*) AS count
         FROM flary_subagent_threads
         WHERE parent_thread_id = ?
           AND status IN ('queued', 'running', 'waiting')`,
          parent.threadId,
        )?.count ?? 0;
      if (Number(activeChildren) >= this.#policy.maxConcurrentChildren) {
        throw new SubagentPolicyError("Subagent concurrency limit reached");
      }

      const now = this.#now().toISOString();
      const seededTurns = selectSeededTurns(this.listTurns(parent.threadId), request.seedTurns);
      const thread = SubagentThreadSchema.parse({
        threadId: `thread_${this.#id()}`,
        sessionId: this.#sessionId,
        rootThreadId: this.#rootThreadId,
        parentThreadId: parent.threadId,
        agentId: request.agentId,
        role: request.role,
        mode: request.mode ?? parent.mode ?? "ask",
        agentPath: `${parent.agentPath.replace(/\/$/, "")}/${request.agentId}`,
        depth,
        status: "queued",
        task: request.task,
        contextSeed: SubagentContextSeedSchema.parse({
          turns: request.seedTurns,
        }),
        seededTurnIds: seededTurns.map((turn) => turn.id),
        ...(request.model ? { model: request.model } : {}),
        ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}),
        ...(request.verbosity ? { verbosity: request.verbosity } : {}),
        ...(request.nickname ? { nickname: request.nickname } : {}),
        createdAt: now,
        updatedAt: now,
        ...(request.metadata ? { metadata: request.metadata } : {}),
      });

      this.insertThread(thread);
      for (const turn of seededTurns) {
        this.#sql.exec(
          `INSERT INTO flary_subagent_turns
            (owner_thread_id, turn_id, ordinal, record_json)
           VALUES (?, ?, ?, ?)`,
          thread.threadId,
          turn.id,
          turn.ordinal,
          JSON.stringify(turn),
        );
      }
      this.emit(thread, "spawned");
      this.writeIdempotent("spawn", request.idempotencyKey, thread);
      return structuredClone(thread);
    });
  }

  send(input: SendSubagentMessageRequestInput): SubagentMailboxMessage {
    const request = SendSubagentMessageRequestSchema.parse(input);
    this.assertSession(request.sessionId);
    return this.#sql.transactionSync(() => {
      const cached = this.readIdempotent<SubagentMailboxMessage>(
        "message",
        request.idempotencyKey,
        SubagentMailboxMessageSchema.parse,
      );
      if (cached) return cached;

      const from = this.requireThread(request.fromThreadId);
      const to = this.requireThread(request.toThreadId);
      if (!this.canCommunicate(from, to)) {
        throw new SubagentPolicyError("Peer messaging is not allowed");
      }
      const message = SubagentMailboxMessageSchema.parse({
        id: `message_${this.#id()}`,
        sessionId: this.#sessionId,
        fromThreadId: from.threadId,
        toThreadId: to.threadId,
        sequence: this.nextSequence(),
        kind: request.kind,
        mode: request.mode,
        content: request.content,
        createdAt: this.#now().toISOString(),
        ...(request.metadata ? { metadata: request.metadata } : {}),
      });
      this.#sql.exec(
        `INSERT INTO flary_subagent_mailbox
          (message_id, to_thread_id, sequence, record_json)
         VALUES (?, ?, ?, ?)`,
        message.id,
        message.toThreadId,
        message.sequence,
        JSON.stringify(message),
      );
      this.emit(to, "interacted", message.id);
      this.writeIdempotent("message", request.idempotencyKey, message);
      return structuredClone(message);
    });
  }

  control(input: SubagentControlRequest): SubagentThread {
    const request = SubagentControlRequestSchema.parse(input);
    this.assertSession(request.sessionId);
    return this.#sql.transactionSync(() => {
      const scope = `control:${request.action}`;
      const cached = this.readIdempotent<SubagentThread>(
        scope,
        request.idempotencyKey,
        SubagentThreadSchema.parse,
      );
      if (cached) return cached;

      const thread = this.requireThread(request.threadId);
      const now = this.#now().toISOString();
      const next = SubagentThreadSchema.parse({
        ...thread,
        status: statusForAction(request.action, thread.status),
        ...(request.output !== undefined
          ? { output: request.output }
          : thread.output !== undefined
            ? { output: thread.output }
            : {}),
        ...(request.error !== undefined
          ? { error: request.error }
          : thread.error !== undefined
            ? { error: thread.error }
            : {}),
        updatedAt: now,
        ...(["complete", "fail", "cancel", "close"].includes(request.action)
          ? { completedAt: now }
          : thread.completedAt
            ? { completedAt: thread.completedAt }
            : {}),
      });
      this.#sql.exec(
        `UPDATE flary_subagent_threads
         SET status = ?, record_json = ?, updated_at = ?
         WHERE thread_id = ?`,
        next.status,
        JSON.stringify(next),
        next.updatedAt,
        next.threadId,
      );
      this.emit(
        next,
        activityForAction(request.action),
        undefined,
        request.targetThreadId ? { targetThreadId: request.targetThreadId } : undefined,
      );
      this.writeIdempotent(scope, request.idempotencyKey, next);
      return structuredClone(next);
    });
  }

  readMessages(threadId: string, afterSequence = 0): SubagentMailboxMessage[] {
    this.requireThread(threadId);
    return this.#sql
      .exec<JsonRow>(
        `SELECT record_json
         FROM flary_subagent_mailbox
         WHERE to_thread_id = ? AND sequence > ?
         ORDER BY sequence ASC`,
        threadId,
        afterSequence,
      )
      .toArray()
      .map((row) =>
        structuredClone(SubagentMailboxMessageSchema.parse(JSON.parse(row.record_json))),
      );
  }

  readActivity(afterSequence = 0): SubagentActivityEvent[] {
    return this.#sql
      .exec<JsonRow>(
        `SELECT record_json
         FROM flary_subagent_activity
         WHERE sequence > ?
         ORDER BY sequence ASC`,
        afterSequence,
      )
      .toArray()
      .map((row) =>
        structuredClone(SubagentActivityEventSchema.parse(JSON.parse(row.record_json))),
      );
  }

  private initialize(root: SubagentThread): void {
    this.#sql.transactionSync(() => {
      const stored = this.first<ConfigRow>(
        `SELECT session_id, root_thread_id, policy_json
         FROM flary_subagent_config
         WHERE singleton = 1`,
      );
      if (stored) {
        if (stored.session_id !== this.#sessionId || stored.root_thread_id !== this.#rootThreadId) {
          throw new Error("The durable subagent coordinator identity does not match this session");
        }
        const storedPolicy = DelegationPolicySchema.parse(JSON.parse(stored.policy_json));
        if (JSON.stringify(storedPolicy) !== JSON.stringify(this.#policy)) {
          throw new Error("The durable subagent coordinator policy is immutable");
        }
        if (!this.getThread(this.#rootThreadId)) {
          throw new Error("The durable subagent coordinator root thread is missing");
        }
        return;
      }

      this.#sql.exec(
        `INSERT INTO flary_subagent_config
          (singleton, session_id, root_thread_id, policy_json, created_at)
         VALUES (1, ?, ?, ?, ?)`,
        this.#sessionId,
        this.#rootThreadId,
        JSON.stringify(this.#policy),
        this.#now().toISOString(),
      );
      this.insertThread(root);
    });
  }

  private ensureSchema(): void {
    this.#sql.exec(`
      CREATE TABLE IF NOT EXISTS flary_subagent_config (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        session_id TEXT NOT NULL,
        root_thread_id TEXT NOT NULL,
        policy_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS flary_subagent_sequence (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        value INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO flary_subagent_sequence (singleton, value)
      VALUES (1, 0);
      CREATE TABLE IF NOT EXISTS flary_subagent_threads (
        ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT NOT NULL UNIQUE,
        parent_thread_id TEXT,
        status TEXT NOT NULL,
        depth INTEGER NOT NULL,
        record_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS flary_subagent_threads_parent_status
      ON flary_subagent_threads (parent_thread_id, status);
      CREATE TABLE IF NOT EXISTS flary_subagent_turns (
        owner_thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        record_json TEXT NOT NULL,
        PRIMARY KEY (owner_thread_id, turn_id)
      );
      CREATE INDEX IF NOT EXISTS flary_subagent_turns_order
      ON flary_subagent_turns (owner_thread_id, ordinal);
      CREATE TABLE IF NOT EXISTS flary_subagent_mailbox (
        message_id TEXT PRIMARY KEY,
        to_thread_id TEXT NOT NULL,
        sequence INTEGER NOT NULL UNIQUE,
        record_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS flary_subagent_mailbox_replay
      ON flary_subagent_mailbox (to_thread_id, sequence);
      CREATE TABLE IF NOT EXISTS flary_subagent_activity (
        event_id TEXT PRIMARY KEY,
        sequence INTEGER NOT NULL UNIQUE,
        record_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS flary_subagent_activity_replay
      ON flary_subagent_activity (sequence);
      CREATE TABLE IF NOT EXISTS flary_subagent_idempotency (
        scope TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        record_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (scope, idempotency_key)
      );
    `);
  }

  private insertThread(thread: SubagentThread): void {
    this.#sql.exec(
      `INSERT INTO flary_subagent_threads
        (thread_id, parent_thread_id, status, depth, record_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      thread.threadId,
      thread.parentThreadId ?? null,
      thread.status,
      thread.depth,
      JSON.stringify(thread),
      thread.createdAt,
      thread.updatedAt,
    );
  }

  private listTurns(threadId: string): SubagentConversationTurn[] {
    return this.#sql
      .exec<JsonRow>(
        `SELECT record_json
         FROM flary_subagent_turns
         WHERE owner_thread_id = ?
         ORDER BY ordinal ASC, rowid ASC`,
        threadId,
      )
      .toArray()
      .map((row) => SubagentConversationTurnSchema.parse(JSON.parse(row.record_json)));
  }

  private emit(
    thread: SubagentThread,
    kind: SubagentActivityEvent["kind"],
    triggerMessageId?: string,
    payload?: Record<string, string>,
  ): void {
    const event = SubagentActivityEventSchema.parse({
      id: `event_${this.#id()}`,
      sessionId: this.#sessionId,
      sequence: this.nextSequence(),
      threadId: thread.threadId,
      parentThreadId: thread.parentThreadId,
      agentPath: thread.agentPath,
      kind,
      occurredAt: this.#now().toISOString(),
      ...(triggerMessageId ? { triggerMessageId } : {}),
      ...(payload ? { payload } : {}),
    });
    this.#sql.exec(
      `INSERT INTO flary_subagent_activity
        (event_id, sequence, record_json)
       VALUES (?, ?, ?)`,
      event.id,
      event.sequence,
      JSON.stringify(event),
    );
  }

  private canCommunicate(from: SubagentThread, to: SubagentThread): boolean {
    return (
      this.#policy.allowPeerMessaging ||
      from.parentThreadId === to.threadId ||
      to.parentThreadId === from.threadId
    );
  }

  private requireThread(threadId: string): SubagentThread {
    const thread = this.getThread(threadId);
    if (!thread) throw new Error(`Subagent thread not found: ${threadId}`);
    return thread;
  }

  private assertSession(sessionId: string): void {
    if (sessionId !== this.#sessionId) {
      throw new Error("The request does not belong to this session");
    }
  }

  private nextSequence(): number {
    const row = this.first<SequenceRow>(
      `UPDATE flary_subagent_sequence
       SET value = value + 1
       WHERE singleton = 1
       RETURNING value`,
    );
    if (!row) throw new Error("The subagent sequence could not be advanced");
    return Number(row.value);
  }

  private readIdempotent<T>(
    scope: string,
    key: string | undefined,
    parse: (value: unknown) => T,
  ): T | undefined {
    if (!key) return undefined;
    const row = this.first<JsonRow>(
      `SELECT record_json
       FROM flary_subagent_idempotency
       WHERE scope = ? AND idempotency_key = ?`,
      scope,
      key,
    );
    return row ? structuredClone(parse(JSON.parse(row.record_json))) : undefined;
  }

  private writeIdempotent(scope: string, key: string | undefined, value: unknown): void {
    if (!key) return;
    this.#sql.exec(
      `INSERT INTO flary_subagent_idempotency
        (scope, idempotency_key, record_json, created_at)
       VALUES (?, ?, ?, ?)`,
      scope,
      key,
      JSON.stringify(value),
      this.#now().toISOString(),
    );
  }

  private first<T>(query: string, ...bindings: unknown[]): T | undefined {
    return this.#sql.exec<T>(query, ...bindings).toArray()[0];
  }
}

function statusForAction(
  action: SubagentControlRequest["action"],
  current: SubagentThread["status"],
): SubagentThread["status"] {
  switch (action) {
    case "start":
    case "resume":
      return "running";
    case "wait":
      return "waiting";
    case "complete":
      return "completed";
    case "fail":
      return "failed";
    case "cancel":
      return "cancelled";
    case "close":
      return "closed";
    case "handoff":
      return current;
  }
}

function activityForAction(
  action: SubagentControlRequest["action"],
): SubagentActivityEvent["kind"] {
  switch (action) {
    case "start":
      return "started";
    case "wait":
      return "waiting";
    case "complete":
      return "completed";
    case "fail":
      return "failed";
    case "cancel":
      return "cancelled";
    case "close":
      return "closed";
    case "resume":
      return "resumed";
    case "handoff":
      return "handed_off";
  }
}

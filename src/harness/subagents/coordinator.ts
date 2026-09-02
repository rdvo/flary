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
import { selectSeededTurns } from "./context.js";

export interface SubagentCoordinatorOptions {
  sessionId: string;
  rootThread: SubagentThread;
  policy?: Partial<DelegationPolicy>;
  now?: () => Date;
  id?: () => string;
}

export class SubagentPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubagentPolicyError";
  }
}

// This is the executable reference model for the durable coordinator. Cloud
// adapters must preserve these state transitions and idempotency rules.
export class InMemorySubagentCoordinator {
  readonly #sessionId: string;
  readonly #rootThreadId: string;
  readonly #policy: DelegationPolicy;
  readonly #now: () => Date;
  readonly #id: () => string;
  readonly #threads = new Map<string, SubagentThread>();
  readonly #turns = new Map<string, SubagentConversationTurn[]>();
  readonly #messages: SubagentMailboxMessage[] = [];
  readonly #events: SubagentActivityEvent[] = [];
  readonly #idempotency = new Map<string, unknown>();
  #sequence = 0;

  constructor(options: SubagentCoordinatorOptions) {
    const root = SubagentThreadSchema.parse(options.rootThread);
    if (root.sessionId !== options.sessionId) {
      throw new Error("The root thread must belong to the coordinator session");
    }
    this.#sessionId = options.sessionId;
    this.#rootThreadId = root.threadId;
    this.#policy = DelegationPolicySchema.parse(options.policy ?? {});
    this.#now = options.now ?? (() => new Date());
    this.#id = options.id ?? (() => crypto.randomUUID());
    this.#threads.set(root.threadId, structuredClone(root));
  }

  get policy(): DelegationPolicy {
    return structuredClone(this.#policy);
  }

  getThread(threadId: string): SubagentThread | undefined {
    const thread = this.#threads.get(threadId);
    return thread ? structuredClone(thread) : undefined;
  }

  listThreads(): SubagentThread[] {
    return [...this.#threads.values()].map((thread) => structuredClone(thread));
  }

  appendTurn(turn: SubagentConversationTurn): SubagentConversationTurn {
    const parsed = SubagentConversationTurnSchema.parse(turn);
    this.assertSession(parsed.sessionId);
    this.requireThread(parsed.threadId);
    const existing = this.#turns.get(parsed.threadId) ?? [];
    if (existing.some((item) => item.id === parsed.id)) {
      return structuredClone(existing.find((item) => item.id === parsed.id)!);
    }
    existing.push(parsed);
    existing.sort((left, right) => left.ordinal - right.ordinal);
    this.#turns.set(parsed.threadId, existing);
    return structuredClone(parsed);
  }

  spawn(input: SpawnSubagentRequestInput): SubagentThread {
    const request = SpawnSubagentRequestSchema.parse(input);
    this.assertSession(request.sessionId);
    const cached = this.readIdempotent<SubagentThread>("spawn", request.idempotencyKey);
    if (cached) return cached;
    if (this.#policy.mode === "disabled") {
      throw new SubagentPolicyError("Subagent delegation is disabled");
    }

    const parent = this.requireThread(request.parentThreadId);
    const depth = parent.depth + 1;
    if (depth > this.#policy.maxDepth) {
      throw new SubagentPolicyError("Subagent depth limit reached");
    }

    const descendants = [...this.#threads.values()].filter(
      (thread) => thread.parentThreadId !== undefined,
    );
    if (descendants.length >= this.#policy.maxTotalChildren) {
      throw new SubagentPolicyError("Subagent total limit reached");
    }
    const activeChildren = descendants.filter(
      (thread) =>
        thread.parentThreadId === parent.threadId &&
        ["queued", "running", "waiting"].includes(thread.status),
    );
    if (activeChildren.length >= this.#policy.maxConcurrentChildren) {
      throw new SubagentPolicyError("Subagent concurrency limit reached");
    }

    const now = this.#now().toISOString();
    const seededTurns = selectSeededTurns(
      this.#turns.get(parent.threadId) ?? [],
      request.seedTurns,
    );
    const threadId = `thread_${this.#id()}`;
    const thread = SubagentThreadSchema.parse({
      threadId,
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
      model: request.model,
      reasoningEffort: request.reasoningEffort,
      verbosity: request.verbosity,
      nickname: request.nickname,
      createdAt: now,
      updatedAt: now,
      metadata: request.metadata,
    });
    this.#threads.set(thread.threadId, thread);
    this.#turns.set(thread.threadId, seededTurns);
    this.emit(thread, "spawned");
    this.writeIdempotent("spawn", request.idempotencyKey, thread);
    return structuredClone(thread);
  }

  send(input: SendSubagentMessageRequestInput): SubagentMailboxMessage {
    const request = SendSubagentMessageRequestSchema.parse(input);
    this.assertSession(request.sessionId);
    const cached = this.readIdempotent<SubagentMailboxMessage>("message", request.idempotencyKey);
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
      metadata: request.metadata,
    });
    this.#messages.push(message);
    this.emit(to, "interacted", message.id);
    this.writeIdempotent("message", request.idempotencyKey, message);
    return structuredClone(message);
  }

  control(input: SubagentControlRequest): SubagentThread {
    const request = SubagentControlRequestSchema.parse(input);
    this.assertSession(request.sessionId);
    const cached = this.readIdempotent<SubagentThread>(
      `control:${request.action}`,
      request.idempotencyKey,
    );
    if (cached) return cached;
    const thread = this.requireThread(request.threadId);
    const now = this.#now().toISOString();
    const next = SubagentThreadSchema.parse({
      ...thread,
      status: statusForAction(request.action, thread.status),
      output: request.output ?? thread.output,
      error: request.error ?? thread.error,
      updatedAt: now,
      completedAt: ["complete", "fail", "cancel", "close"].includes(request.action)
        ? now
        : thread.completedAt,
    });
    this.#threads.set(next.threadId, next);
    this.emit(
      next,
      activityForAction(request.action),
      undefined,
      request.targetThreadId ? { targetThreadId: request.targetThreadId } : undefined,
    );
    this.writeIdempotent(`control:${request.action}`, request.idempotencyKey, next);
    return structuredClone(next);
  }

  readMessages(threadId: string, afterSequence = 0): SubagentMailboxMessage[] {
    this.requireThread(threadId);
    return this.#messages
      .filter((message) => message.toThreadId === threadId && message.sequence > afterSequence)
      .map((message) => structuredClone(message));
  }

  readActivity(afterSequence = 0): SubagentActivityEvent[] {
    return this.#events
      .filter((event) => event.sequence > afterSequence)
      .map((event) => structuredClone(event));
  }

  private emit(
    thread: SubagentThread,
    kind: SubagentActivityEvent["kind"],
    triggerMessageId?: string,
    payload?: Record<string, string>,
  ): void {
    this.#events.push(
      SubagentActivityEventSchema.parse({
        id: `event_${this.#id()}`,
        sessionId: this.#sessionId,
        sequence: this.nextSequence(),
        threadId: thread.threadId,
        parentThreadId: thread.parentThreadId,
        agentPath: thread.agentPath,
        kind,
        occurredAt: this.#now().toISOString(),
        triggerMessageId,
        payload,
      }),
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
    const thread = this.#threads.get(threadId);
    if (!thread) throw new Error(`Subagent thread not found: ${threadId}`);
    return thread;
  }

  private assertSession(sessionId: string): void {
    if (sessionId !== this.#sessionId) {
      throw new Error("The request does not belong to this session");
    }
  }

  private nextSequence(): number {
    this.#sequence += 1;
    return this.#sequence;
  }

  private idempotencyKey(scope: string, key: string): string {
    return `${scope}:${key}`;
  }

  private readIdempotent<T>(scope: string, key: string | undefined): T | undefined {
    if (!key) return undefined;
    const value = this.#idempotency.get(this.idempotencyKey(scope, key));
    return value === undefined ? undefined : structuredClone(value as T);
  }

  private writeIdempotent(scope: string, key: string | undefined, value: unknown): void {
    if (!key) return;
    this.#idempotency.set(this.idempotencyKey(scope, key), structuredClone(value));
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

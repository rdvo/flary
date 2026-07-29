import {
  createFlueClient,
  type AgentSendResult,
  type ConversationStreamChunk,
  type CreateFlueClientOptions,
  type FlueClient,
} from "@flue/sdk";
import { z } from "zod";

import {
  CreateRunRequestSchema,
  IdentifierSchema,
  JsonObjectSchema,
  JsonValueSchema,
  RunEventSchema,
  RunHandleSchema,
  RunInputSchema,
  RunResultSchema,
  TimestampSchema,
  type CreateRunRequest,
  type RunEvent,
  type RunHandle,
  type RunInput,
  type RunResult,
} from "../contracts/index.js";
import {
  TrustedRunContextSchema,
  type FlaryRunService,
  type ObserveRunOptions,
  type TrustedRunContext,
} from "../host/runs.js";
import { FlaryHostError } from "../host/errors.js";

export const FlueAdmissionSchema = z
  .object({
    streamUrl: z.string().url(),
    offset: z.string().min(1),
    submissionId: IdentifierSchema,
  })
  .strict();
export type FlueAdmission = z.infer<typeof FlueAdmissionSchema>;

export const FlaryRunRecordSchema = z
  .object({
    runId: IdentifierSchema,
    trusted: TrustedRunContextSchema,
    request: CreateRunRequestSchema,
    agentName: IdentifierSchema,
    instanceId: IdentifierSchema,
    admission: FlueAdmissionSchema,
    result: RunResultSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export type FlaryRunRecord = z.infer<typeof FlaryRunRecordSchema>;

export type RunEventDraft = RunEvent extends infer Event
  ? Event extends RunEvent
    ? Omit<Event, "id" | "sequence">
    : never
  : never;

/**
 * Host-owned durable storage for the run projection.
 *
 * Flue remains the execution and transcript authority. This store keeps only
 * the host binding, the Flue admission receipt, normalized public events, and
 * the materialized run result.
 */
export interface FlaryRunRepository {
  findByIdempotency(
    trusted: TrustedRunContext,
    idempotencyKey: string,
  ): Promise<FlaryRunRecord | undefined>;
  create(record: FlaryRunRecord): Promise<FlaryRunRecord>;
  get(runId: string): Promise<FlaryRunRecord | undefined>;
  findInputAdmission(
    runId: string,
    idempotencyKey: string,
  ): Promise<FlueAdmission | undefined>;
  setAdmission(
    runId: string,
    idempotencyKey: string,
    admission: FlueAdmission,
  ): Promise<boolean>;
  setResult(runId: string, result: RunResult): Promise<FlaryRunRecord>;
  appendEvent(
    runId: string,
    dedupeKey: string,
    event: RunEventDraft,
  ): Promise<RunEvent | undefined>;
  events(runId: string, afterSequence: number): Promise<RunEvent[]>;
}

/**
 * Process-local repository for tests and local examples.
 *
 * Production hosts must supply durable storage, such as Durable Object
 * SQLite. The service contract stays the same.
 */
export class InMemoryFlaryRunRepository implements FlaryRunRepository {
  readonly #runs = new Map<string, FlaryRunRecord>();
  readonly #events = new Map<string, RunEvent[]>();
  readonly #dedupe = new Set<string>();
  readonly #inputs = new Map<string, FlueAdmission>();

  async findByIdempotency(
    trusted: TrustedRunContext,
    idempotencyKey: string,
  ): Promise<FlaryRunRecord | undefined> {
    for (const record of this.#runs.values()) {
      if (
        record.request.idempotencyKey === idempotencyKey &&
        sameScope(record.trusted, trusted)
      ) {
        return clone(record);
      }
    }
    return undefined;
  }

  async create(recordInput: FlaryRunRecord): Promise<FlaryRunRecord> {
    const record = FlaryRunRecordSchema.parse(recordInput);
    if (this.#runs.has(record.runId)) {
      throw new Error("The run already exists");
    }
    this.#runs.set(record.runId, clone(record));
    this.#events.set(record.runId, []);
    return clone(record);
  }

  async get(runId: string): Promise<FlaryRunRecord | undefined> {
    const record = this.#runs.get(runId);
    return record ? clone(record) : undefined;
  }

  async findInputAdmission(
    runId: string,
    idempotencyKey: string,
  ): Promise<FlueAdmission | undefined> {
    this.required(runId);
    const admission = this.#inputs.get(`${runId}:${idempotencyKey}`);
    return admission ? clone(admission) : undefined;
  }

  async setAdmission(
    runId: string,
    idempotencyKey: string,
    admissionInput: FlueAdmission,
  ): Promise<boolean> {
    const key = `${runId}:${idempotencyKey}`;
    if (this.#inputs.has(key)) return false;
    const record = this.required(runId);
    const admission = FlueAdmissionSchema.parse(admissionInput);
    this.#inputs.set(key, admission);
    this.#runs.set(
      runId,
      FlaryRunRecordSchema.parse({
        ...record,
        admission,
        updatedAt: new Date().toISOString(),
      }),
    );
    return true;
  }

  async setResult(
    runId: string,
    resultInput: RunResult,
  ): Promise<FlaryRunRecord> {
    const record = this.required(runId);
    const result = RunResultSchema.parse(resultInput);
    const next = FlaryRunRecordSchema.parse({
      ...record,
      result,
      updatedAt: new Date().toISOString(),
    });
    this.#runs.set(runId, next);
    return clone(next);
  }

  async appendEvent(
    runId: string,
    dedupeKey: string,
    eventInput: RunEventDraft,
  ): Promise<RunEvent | undefined> {
    const key = `${runId}:${dedupeKey}`;
    if (this.#dedupe.has(key)) return undefined;
    const record = this.required(runId);
    const events = this.#events.get(runId) ?? [];
    const sequence = events.length + 1;
    const event = RunEventSchema.parse({
      ...eventInput,
      id: `event_${runId}_${sequence}`,
      sequence,
    });
    this.#dedupe.add(key);
    events.push(event);
    this.#events.set(runId, events);
    this.#runs.set(
      runId,
      FlaryRunRecordSchema.parse({
        ...record,
        result: {
          ...record.result,
          lastSequence: sequence,
        },
        updatedAt: new Date().toISOString(),
      }),
    );
    return clone(event);
  }

  async events(runId: string, afterSequence: number): Promise<RunEvent[]> {
    this.required(runId);
    return (this.#events.get(runId) ?? [])
      .filter((event) => event.sequence > afterSequence)
      .map(clone);
  }

  private required(runId: string): FlaryRunRecord {
    const record = this.#runs.get(runId);
    if (!record) throw new Error("The run was not found");
    return record;
  }
}

export interface FlueAgentGateway {
  send(
    agentName: string,
    instanceId: string,
    message: string,
  ): Promise<FlueAdmission>;
  wait(
    admission: FlueAdmission,
    onEvent: (event: ConversationStreamChunk) => Promise<void> | void,
  ): Promise<unknown>;
  abort(agentName: string, instanceId: string): Promise<{ aborted: boolean }>;
}

export interface CreateFlueRunServiceOptions {
  readonly repository: FlaryRunRepository;
  readonly gateway: FlueAgentGateway;
  readonly agentName?: (
    trusted: TrustedRunContext,
    request: CreateRunRequest,
  ) => string;
  readonly instanceId?: (
    trusted: TrustedRunContext,
    request: CreateRunRequest,
  ) => string;
  readonly schedule?: (work: Promise<void>) => void;
  readonly pollMs?: number;
  readonly createRunId?: () => string;
}

/**
 * Adapt durable Flue submissions to Flary's stable run API.
 *
 * Flue continues work after the original HTTP request disconnects. The
 * repository makes normalized events and run state replayable by sequence.
 * A new request can restart projection from the stored Flue admission receipt.
 */
export function createFlueRunService(
  options: CreateFlueRunServiceOptions,
): FlaryRunService {
  const active = new Map<string, Promise<void>>();
  const pollMs = options.pollMs ?? 100;

  const track = (record: FlaryRunRecord): Promise<void> => {
    const trackingId = `${record.runId}:${record.admission.submissionId}`;
    const current = active.get(trackingId);
    if (current) return current;
    const work = trackAdmission(record, options)
      .catch(async (cause) => {
        const latest = await options.repository.get(record.runId);
        if (!latest || isTerminal(latest.result.status)) return;
        const failed = RunResultSchema.parse({
          ...latest.result,
          status: "failed",
          error: {
            code: "flue_projection_failed",
            message: errorMessage(cause),
            retryable: true,
          },
          completedAt: new Date().toISOString(),
        });
        await options.repository.setResult(record.runId, failed);
        await options.repository.appendEvent(
          record.runId,
          `projection-failed:${record.admission.submissionId}`,
          eventDraft(record, "run.failed", {
            error: failed.error!,
          }),
        );
      })
      .finally(() => active.delete(trackingId));
    active.set(trackingId, work);
    if (options.schedule) options.schedule(work);
    else void work;
    return work;
  };

  const load = async (
    trusted: TrustedRunContext,
    runId: string,
  ): Promise<FlaryRunRecord> => {
    const record = await options.repository.get(runId);
    if (!record || !sameScope(record.trusted, trusted)) {
      throw new FlaryHostError(404, "run_not_found", "The run was not found");
    }
    return FlaryRunRecordSchema.parse(record);
  };

  return {
    async create(trustedInput, requestInput): Promise<RunHandle> {
      const trusted = TrustedRunContextSchema.parse(trustedInput);
      const request = CreateRunRequestSchema.parse(requestInput);
      if (request.idempotencyKey) {
        const existing = await options.repository.findByIdempotency(
          trusted,
          request.idempotencyKey,
        );
        if (existing) return handle(existing);
      }

      const agentName =
        options.agentName?.(trusted, request) ?? trusted.agentId;
      const instanceId =
        options.instanceId?.(trusted, request) ??
        [
          trusted.tenantId,
          trusted.applicationId,
          trusted.projectId ?? "global",
          request.channelId,
        ].join(".");
      const admission = FlueAdmissionSchema.parse(
        await options.gateway.send(
          IdentifierSchema.parse(agentName),
          IdentifierSchema.parse(instanceId),
          inputMessage(request.input),
        ),
      );
      const now = new Date().toISOString();
      const runId = IdentifierSchema.parse(
        options.createRunId?.() ?? `run_${crypto.randomUUID()}`,
      );
      const result = RunResultSchema.parse({
        runId,
        requestId: request.requestId,
        status: "running",
        channelId: request.channelId,
        execution: request.execution,
        lastSequence: 1,
        ...(request.traceContext ? { traceContext: request.traceContext } : {}),
        startedAt: now,
      });
      const record = FlaryRunRecordSchema.parse({
        runId,
        trusted,
        request,
        agentName,
        instanceId,
        admission,
        result,
        createdAt: now,
        updatedAt: now,
      });
      const stored = await options.repository.create(record);
      await options.repository.appendEvent(
        runId,
        "run-queued",
        eventDraft(stored, "run.queued", {
          requestId: request.requestId,
          target: { kind: "agent", agentId: trusted.agentId },
        }),
      );
      await options.repository.appendEvent(
        runId,
        "run-started",
        eventDraft(stored, "run.started", {
          requestId: request.requestId,
        }),
      );
      track(stored);
      return handle(stored);
    },

    async get(trusted, runId): Promise<RunResult> {
      const record = await load(trusted, runId);
      if (!isTerminal(record.result.status)) track(record);
      return record.result;
    },

    async *observe(
      trusted,
      runId,
      observeOptions: ObserveRunOptions,
    ): AsyncIterable<RunEvent> {
      let cursor = observeOptions.afterSequence;
      let record = await load(trusted, runId);
      if (!isTerminal(record.result.status)) track(record);

      while (!observeOptions.signal.aborted) {
        const events = await options.repository.events(runId, cursor);
        for (const event of events) {
          cursor = Math.max(cursor, event.sequence);
          yield RunEventSchema.parse(event);
        }
        record = await load(trusted, runId);
        if (isTerminal(record.result.status)) {
          const remaining = await options.repository.events(runId, cursor);
          for (const event of remaining) yield RunEventSchema.parse(event);
          return;
        }
        await delay(pollMs, observeOptions.signal);
      }
    },

    async input(trusted, runId, inputValue): Promise<RunResult> {
      const record = await load(trusted, runId);
      const input = RunInputSchema.parse(inputValue);
      if (isTerminal(record.result.status)) {
        throw new FlaryHostError(
          409,
          "run_is_terminal",
          "A terminal run cannot accept more input",
        );
      }
      const existingAdmission =
        await options.repository.findInputAdmission(
          runId,
          input.idempotencyKey,
        );
      if (existingAdmission) return record.result;
      const admission = FlueAdmissionSchema.parse(
        await options.gateway.send(
          record.agentName,
          record.instanceId,
          inputMessage(input.input),
        ),
      );
      const accepted = await options.repository.setAdmission(
        runId,
        input.idempotencyKey,
        admission,
      );
      if (accepted) {
        await options.repository.appendEvent(
          runId,
          `input:${input.idempotencyKey}`,
          eventDraft(record, "run.input.accepted", {
            idempotencyKey: input.idempotencyKey,
          }),
        );
        const next = await load(trusted, runId);
        track(next);
        return next.result;
      }
      return (await load(trusted, runId)).result;
    },

    async cancel(trusted, runId, input): Promise<RunResult> {
      const record = await load(trusted, runId);
      if (isTerminal(record.result.status)) return record.result;
      await options.gateway.abort(record.agentName, record.instanceId);
      const completedAt = new Date().toISOString();
      const result = RunResultSchema.parse({
        ...record.result,
        status: "cancelled",
        completedAt,
      });
      await options.repository.setResult(runId, result);
      await options.repository.appendEvent(
        runId,
        `cancel:${input.idempotencyKey}`,
        eventDraft(record, "run.cancelled", {
          ...(input.reason ? { reason: input.reason } : {}),
        }),
      );
      return result;
    },
  };
}

export function createFlueAgentGateway(
  options: CreateFlueClientOptions | FlueClient,
): FlueAgentGateway {
  const client = "agents" in options ? options : createFlueClient(options);
  return {
    async send(agentName, instanceId, message) {
      return FlueAdmissionSchema.parse(
        await client.agents.send(agentName, instanceId, { message }),
      );
    },
    async wait(admission, onEvent) {
      return client.agents.wait(admission as AgentSendResult, { onEvent });
    },
    abort(agentName, instanceId) {
      return client.agents.abort(agentName, instanceId);
    },
  };
}

async function trackAdmission(
  record: FlaryRunRecord,
  options: CreateFlueRunServiceOptions,
): Promise<void> {
  const toolNames = new Map<string, string>();
  const toolInputs = new Map<string, unknown>();
  let toolCalls = record.result.usage?.toolCalls ?? 0;
  let lastUsage = record.result.usage;

  const output = await options.gateway.wait(
    record.admission,
    async (chunk) => {
      const mapped = mapChunk(record, chunk, toolNames, toolInputs);
      if (!mapped) return;
      if (chunk.type === "tool-input") toolCalls += 1;
      if (chunk.type === "message-completed" && chunk.usage) {
        const billingMode = record.request.metadata?.billingMode;
        const subscription = billingMode === "subscription";
        lastUsage = {
          inputTokens: chunk.usage.input,
          outputTokens: chunk.usage.output,
          totalTokens: chunk.usage.totalTokens,
          toolCalls,
          cache: {
            readTokens: chunk.usage.cacheRead,
            writeTokens: chunk.usage.cacheWrite,
          },
          cost: {
            ...(subscription && chunk.usage.cost.total === 0
              ? {
                  state: "unknown" as const,
                  reason: "Subscription provider did not report a cost",
                }
              : {
                  state: "known" as const,
                  microUnits: Math.max(
                    0,
                    Math.round(chunk.usage.cost.total * 1_000_000),
                  ),
                  unit: "USD" as const,
                }),
          },
          ...(subscription && chunk.usage.cost.total === 0
            ? {}
            : { costUsd: chunk.usage.cost.total }),
        };
      }
      await options.repository.appendEvent(
        record.runId,
        chunkKey(chunk),
        mapped,
      );
    },
  );
  const latest = await options.repository.get(record.runId);
  if (!latest || latest.result.status === "cancelled") return;
  const completedAt = new Date().toISOString();
  const result = RunResultSchema.parse({
    ...latest.result,
    status: "completed",
    output: JsonValueSchema.parse(jsonValue(output)),
    ...(lastUsage ? { usage: lastUsage } : {}),
    completedAt,
  });
  await options.repository.setResult(record.runId, result);
  await options.repository.appendEvent(
    record.runId,
    `completed:${record.admission.submissionId}`,
    eventDraft(record, "run.completed", { output: result.output! }),
  );
}

function mapChunk(
  record: FlaryRunRecord,
  chunk: ConversationStreamChunk,
  toolNames: Map<string, string>,
  toolInputs: Map<string, unknown>,
): RunEventDraft | undefined {
  switch (chunk.type) {
    case "message-delta":
      return eventDraft(
        record,
        chunk.kind === "reasoning" ? "reasoning.delta" : "message.delta",
        { delta: chunk.delta, messageId: chunk.messageId },
      );
    case "tool-input":
      toolNames.set(chunk.toolCallId, chunk.toolName);
      toolInputs.set(chunk.toolCallId, chunk.input);
      return eventDraft(record, "tool.call", {
        call: {
          id: chunk.toolCallId,
          toolId: chunk.toolName,
          arguments: jsonObject(chunk.input),
          runId: record.runId,
          requestedAt: new Date().toISOString(),
        },
      });
    case "tool-output":
    case "tool-output-error": {
      const toolId = toolNames.get(chunk.toolCallId) ?? "unknown";
      return eventDraft(record, "tool.result", {
        result: {
          id: `result_${chunk.toolCallId}`,
          callId: chunk.toolCallId,
          toolId,
          status:
            chunk.type === "tool-output" ? "succeeded" : "failed",
          ...(chunk.type === "tool-output"
            ? { output: jsonObject(chunk.output) }
            : {
                error: {
                  code: "tool_failed",
                  message: chunk.errorText,
                  details: jsonObject(toolInputs.get(chunk.toolCallId)),
                },
              }),
          completedAt: new Date().toISOString(),
        },
      });
    }
    case "message-completed":
      {
      const billingValue = record.request.metadata?.billingMode;
      const billingMode =
        billingValue === "subscription" ||
        billingValue === "byok" ||
        billingValue === "managed"
          ? billingValue
          : undefined;
      const cacheValue = record.request.metadata?.cacheRetention;
      const cacheRetention =
        cacheValue === "none" ||
        cacheValue === "short" ||
        cacheValue === "long"
          ? cacheValue
          : undefined;
      const credentialConnectionRef =
        record.request.metadata?.credentialConnectionRef;
      return eventDraft(record, "model.completed", {
        ...(typeof billingMode === "string" ? { billingMode } : {}),
        ...(typeof cacheRetention === "string" ? { cacheRetention } : {}),
        ...(typeof credentialConnectionRef === "string"
          ? { credentialConnectionRef }
          : {}),
        ...(chunk.usage
          ? {
              usage: {
                inputTokens: chunk.usage.input,
                outputTokens: chunk.usage.output,
                totalTokens: chunk.usage.totalTokens,
                cache: {
                  readTokens: chunk.usage.cacheRead,
                  writeTokens: chunk.usage.cacheWrite,
                },
                cost: {
                  ...(billingMode === "subscription" &&
                  chunk.usage.cost.total === 0
                    ? {
                        state: "unknown" as const,
                        reason:
                          "Subscription provider did not report a cost",
                      }
                    : {
                        state: "known" as const,
                        microUnits: Math.max(
                          0,
                          Math.round(chunk.usage.cost.total * 1_000_000),
                        ),
                        unit: "USD" as const,
                      }),
                },
              },
            }
          : {}),
      });
      }
    case "submission-settled":
      if (chunk.outcome === "aborted") {
        return eventDraft(record, "run.cancelled", {});
      }
      if (chunk.outcome === "failed") {
        return eventDraft(record, "run.failed", {
          error: {
            code: "agent_submission_failed",
            message: errorMessage(chunk.error),
          },
        });
      }
      return undefined;
    default:
      return undefined;
  }
}

function eventDraft<T extends RunEvent["type"]>(
  record: FlaryRunRecord,
  type: T,
  payload: Extract<RunEvent, { type: T }>["payload"],
): RunEventDraft {
  return {
    runId: record.runId,
    occurredAt: new Date().toISOString(),
    type,
    payload,
    ...(record.request.traceContext
      ? { traceContext: record.request.traceContext }
      : {}),
  } as RunEventDraft;
}

function handle(record: FlaryRunRecord): RunHandle {
  const root = `/runs/${encodeURIComponent(record.runId)}`;
  return RunHandleSchema.parse({
    runId: record.runId,
    requestId: record.request.requestId,
    status: record.result.status,
    eventsUrl: `${root}/events`,
    inputUrl: `${root}/input`,
    cancelUrl: `${root}/cancel`,
    cursor: {
      runId: record.runId,
      afterSequence: record.result.lastSequence ?? 0,
    },
  });
}

function sameScope(
  left: TrustedRunContext,
  right: TrustedRunContext,
): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.applicationId === right.applicationId &&
    left.projectId === right.projectId &&
    left.agentId === right.agentId
  );
}

function inputMessage(input: unknown): string {
  return typeof input === "string" ? input : JSON.stringify(input);
}

function chunkKey(chunk: ConversationStreamChunk): string {
  return `${chunk.position.batch}:${chunk.position.index}`;
}

function jsonObject(value: unknown): z.infer<typeof JsonObjectSchema> {
  const parsed = JsonObjectSchema.safeParse(value);
  return parsed.success ? parsed.data : { value: jsonValue(value) };
}

function jsonValue(value: unknown): z.infer<typeof JsonValueSchema> {
  if (value === undefined) return null;
  try {
    return JsonValueSchema.parse(JSON.parse(JSON.stringify(value)) as unknown);
  } catch {
    return String(value);
  }
}

function isTerminal(status: RunResult["status"]): boolean {
  return ["completed", "failed", "cancelled"].includes(status);
}

function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (
    value &&
    typeof value === "object" &&
    "message" in value &&
    typeof value.message === "string"
  ) {
    return value.message;
  }
  return "The Flue submission failed";
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timeout = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

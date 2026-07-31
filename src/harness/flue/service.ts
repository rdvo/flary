import {
  createFlueClient,
  type AgentSendResult,
  type ConversationStreamChunk,
  type CreateFlueClientOptions,
  type FlueEvent,
  type FlueClient,
} from "@flue/sdk";
import { z } from "zod";

import {
  ApprovalDecisionSchema,
  ApprovalRequestSchema,
  CreateRunRequestSchema,
  IdentifierSchema,
  JsonObjectSchema,
  JsonValueSchema,
  RunEventSchema,
  RunHandleSchema,
  RunInputSchema,
  RunResultSchema,
  TimestampSchema,
  UserInputAnswerRequestSchema,
  UserInputRecordSchema,
  type ApprovalDecision,
  type ApprovalRequest,
  type CreateRunRequest,
  type RunEvent,
  type RunHandle,
  type RunInput,
  type RunResult,
  type UserInputAnswerRequest,
  type UserInputRecord,
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
    options?: {
      readonly images?: readonly {
        readonly type: "image";
        readonly data: string;
        readonly mimeType: string;
        readonly filename?: string;
      }[];
      /** Flue's direct submission override. */
      /** Stable admission key used to make retries idempotent. */
      readonly idempotencyKey?: string;
      readonly model?: string;
      readonly thinkingLevel?: string;
      readonly cacheRetention?: "none" | "short" | "long";
    },
  ): Promise<FlueAdmission>;
  wait(
    admission: FlueAdmission,
    onEvent: (event: ConversationStreamChunk) => Promise<void> | void,
  ): Promise<unknown>;
  /** Read the provider-neutral Flue conversation projection for archiving. */
  history?(
    agentName: string,
    instanceId: string,
  ): Promise<unknown>;
  abort(agentName: string, instanceId: string): Promise<{ aborted: boolean }>;
  /** Start a generated Flue workflow for a native function. */
  invokeWorkflow?(
    workflowName: string,
    input: unknown,
  ): Promise<FlueAdmission>;
  /** Wait for the same durable workflow after a host restart. */
  waitWorkflow?(
    admission: FlueAdmission,
    onEvent: (event: FlueEvent) => Promise<void> | void,
    workflowName?: string,
  ): Promise<unknown>;
  /** Cancel the generated durable workflow. */
  abortWorkflow?(
    workflowName: string,
    runId: string,
  ): Promise<{ aborted: boolean }>;
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
  /** Durable host bridge for approval records owned by the Flue agent. */
  readonly listApprovals?: (
    record: FlaryRunRecord,
  ) => Promise<readonly ApprovalRequest[]> | readonly ApprovalRequest[];
  /** Persist the decision and wake the same Flue submission. */
  readonly decideApproval?: (
    record: FlaryRunRecord,
    decision: ApprovalDecision,
  ) => Promise<void> | void;
  /** Durable host bridge for user-input records owned by the Flue agent. */
  readonly listUserInput?: (
    record: FlaryRunRecord,
  ) => Promise<readonly UserInputRecord[]> | readonly UserInputRecord[];
  /** Persist the answer and wake the same Flue submission. */
  readonly respondToUserInput?: (
    record: FlaryRunRecord,
    requestId: string,
    input: UserInputAnswerRequest,
  ) => Promise<void> | void;
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
            code: errorCode(cause),
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

  /**
   * Materialize an external wait in the host projection.
   *
   * Flue keeps the agent submission active while an approval or user-input
   * request is pending. Flary must still expose a stable waiting state to
   * callers and persist it before the next Worker request.
   */
  const refreshWaiting = async (
    record: FlaryRunRecord,
  ): Promise<FlaryRunRecord> => {
    if (isTerminal(record.result.status)) return record;
    const approvals = options.listApprovals
      ? await options.listApprovals(record)
      : [];
    const userInput = options.listUserInput
      ? await options.listUserInput(record)
      : [];
    const approval = approvals[0];
    const request = userInput[0];
    if (!approval && !request) return record;
    if (record.result.status === "waiting") return record;

    const next = await options.repository.setResult(
      record.runId,
      RunResultSchema.parse({
        ...record.result,
        status: "waiting",
      }),
    );
    await options.repository.appendEvent(
      record.runId,
      `waiting:${approval ? "approval" : "input"}:${approval?.id ?? request?.request.id ?? "pending"}`,
      eventDraft(record, "run.waiting", {
        reason: approval
          ? approval.reason
          : "The function is waiting for user input.",
        ...(approval ? { approvalId: approval.id } : {}),
      }),
    );
    return next;
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

      // Allocate the Flary run id before deriving the Flue instance. A
      // function-first run gets one isolated agent instance, which prevents
      // approvals and transcripts from different runs sharing a Codemode
      // journal. Legacy low-level callers keep the older channel-scoped
      // instance behaviour for backwards compatibility.
      const runId = IdentifierSchema.parse(
        options.createRunId?.() ?? `run_${crypto.randomUUID()}`,
      );

      const agentName =
        options.agentName?.(trusted, request) ?? trusted.agentId;
      const instanceId =
        options.instanceId?.(trusted, request) ??
        (isFunctionFirstRequest(request)
          ? runId
          : [
              trusted.tenantId,
              trusted.applicationId,
              trusted.projectId ?? "global",
              request.channelId,
            ].join("."));
      const admission = FlueAdmissionSchema.parse(
        request.execution === "workflow"
          ? options.gateway.invokeWorkflow
            ? await options.gateway.invokeWorkflow(
                IdentifierSchema.parse(agentName),
                {
                  __flary: {
                    runId,
                    revisionId: trusted.revisionId,
                  },
                  input: request.input,
                },
              )
            : (() => {
                throw new FlaryHostError(
                  501,
                  "workflow_gateway_missing",
                  "Native Flary functions need a Flue workflow gateway",
                );
              })()
          : await options.gateway.send(
              IdentifierSchema.parse(agentName),
              IdentifierSchema.parse(instanceId),
              inputMessage(request.input),
            ),
      );
      const now = new Date().toISOString();
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
      const record = await refreshWaiting(await load(trusted, runId));
      if (!isTerminal(record.result.status)) track(record);
      return record.result;
    },

    async *observe(
      trusted,
      runId,
      observeOptions: ObserveRunOptions,
    ): AsyncIterable<RunEvent> {
      let cursor = observeOptions.afterSequence;
      let record = await refreshWaiting(await load(trusted, runId));
      if (!isTerminal(record.result.status)) track(record);

      while (!observeOptions.signal.aborted) {
        const events = await options.repository.events(runId, cursor);
        for (const event of events) {
          cursor = Math.max(cursor, event.sequence);
          yield RunEventSchema.parse(event);
        }
        record = await refreshWaiting(await load(trusted, runId));
        if (isTerminal(record.result.status)) {
          const remaining = await options.repository.events(runId, cursor);
          for (const event of remaining) yield RunEventSchema.parse(event);
          return;
        }
        await delay(pollMs, observeOptions.signal);
      }
    },

    async input(trusted, runId, inputValue): Promise<RunResult> {
      const record = await refreshWaiting(await load(trusted, runId));
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
      if (record.request.execution === "workflow") {
        if (!options.gateway.abortWorkflow) {
          throw new FlaryHostError(
            501,
            "workflow_cancel_unavailable",
            "This Flue host does not support durable workflow cancellation",
          );
        }
        await options.gateway.abortWorkflow(
          record.agentName,
          record.admission.submissionId,
        );
      } else {
        await options.gateway.abort(record.agentName, record.instanceId);
      }
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

    ...(options.listApprovals
      ? {
          async listApprovals(
            trusted: TrustedRunContext,
            runId: string,
          ): Promise<ApprovalRequest[]> {
            const record = await load(trusted, runId);
            const current = await refreshWaiting(record);
            return (await options.listApprovals!(current)).map((value) =>
              ApprovalRequestSchema.parse(value),
            );
          },
        }
      : {}),

    ...(options.decideApproval
      ? {
          async decideApproval(
            trusted: TrustedRunContext,
            runId: string,
            decisionInput: ApprovalDecision,
          ): Promise<RunResult> {
            const record = await load(trusted, runId);
            const decision = ApprovalDecisionSchema.parse(decisionInput);
            await options.decideApproval!(record, decision);
            await options.repository.appendEvent(
              runId,
              `approval:${decision.requestId}:${decision.status}`,
              eventDraft(record, "approval.resolved", { decision }),
            );
            const latest = await load(trusted, runId);
            const resumed = latest.result.status === "waiting"
              ? await options.repository.setResult(
                  latest.runId,
                  RunResultSchema.parse({ ...latest.result, status: "running" }),
                )
              : latest;
            if (!isTerminal(resumed.result.status)) track(resumed);
            return resumed.result;
          },
        }
      : {}),

    ...(options.listUserInput
      ? {
          async listUserInput(
            trusted: TrustedRunContext,
            runId: string,
          ): Promise<UserInputRecord[]> {
            const record = await load(trusted, runId);
            const current = await refreshWaiting(record);
            return (await options.listUserInput!(current)).map((value) =>
              UserInputRecordSchema.parse(value),
            );
          },
        }
      : {}),

    ...(options.respondToUserInput
      ? {
          async respondToUserInput(
            trusted: TrustedRunContext,
            runId: string,
            requestId: string,
            inputValue: UserInputAnswerRequest,
          ): Promise<RunResult> {
            const record = await load(trusted, runId);
            const input = UserInputAnswerRequestSchema.parse(inputValue);
            await options.respondToUserInput!(
              record,
              IdentifierSchema.parse(requestId),
              input,
            );
            const latest = await load(trusted, runId);
            const resumed = latest.result.status === "waiting"
              ? await options.repository.setResult(
                  latest.runId,
                  RunResultSchema.parse({ ...latest.result, status: "running" }),
                )
              : latest;
            if (!isTerminal(resumed.result.status)) track(resumed);
            return resumed.result;
          },
        }
      : {}),
  };
}

export function createFlueAgentGateway(
  options: CreateFlueClientOptions | FlueClient,
): FlueAgentGateway {
  const client = "agents" in options ? options : createFlueClient(options);
  const baseUrl =
    "agents" in options
      ? "https://flue.invalid"
      : options.baseUrl.replace(/\/+$/, "");
  return {
    async send(agentName, instanceId, message, options = {}) {
      return FlueAdmissionSchema.parse(
        await (client.agents.send as unknown as (
          name: string,
          id: string,
          input: Record<string, unknown>,
        ) => Promise<unknown>)(agentName, instanceId, {
          message,
          ...(options.images ? { images: options.images } : {}),
          ...(options.idempotencyKey
            ? { idempotencyKey: options.idempotencyKey }
            : {}),
          ...(options.model ? { model: options.model } : {}),
          ...(options.thinkingLevel
            ? { thinkingLevel: options.thinkingLevel }
            : {}),
          ...(options.cacheRetention
            ? { cacheRetention: options.cacheRetention }
            : {}),
        }),
      );
    },
    async wait(admission, onEvent) {
      return client.agents.wait(admission as AgentSendResult, { onEvent });
    },
    async history(agentName, instanceId) {
      return client.agents.history(agentName, instanceId);
    },
    abort(agentName, instanceId) {
      return client.agents.abort(agentName, instanceId);
    },
    async invokeWorkflow(workflowName, input) {
      const admission = await client.workflows.invoke(workflowName, { input });
      return FlueAdmissionSchema.parse({
        streamUrl: `${baseUrl}/runs/${encodeURIComponent(admission.runId)}`,
        offset: "-1",
        submissionId: admission.runId,
      });
    },
    async waitWorkflow(admission, onEvent) {
      const stream = client.runs.stream(admission.submissionId, {
        offset: admission.offset,
        live: true,
      });
      for await (const event of stream) {
        await onEvent(event);
      }
      const run = await client.runs.get(admission.submissionId);
      if (run.status === "errored" || run.isError) {
        throw new Error(errorMessage(run.error));
      }
      if (run.status !== "completed") {
        throw new Error("The Flue workflow stream ended before completion");
      }
      return run.result;
    },
  };
}

async function trackAdmission(
  record: FlaryRunRecord,
  options: CreateFlueRunServiceOptions,
): Promise<void> {
  if (record.request.execution === "workflow") {
    await trackWorkflowAdmission(record, options);
    return;
  }
  const toolNames = new Map<string, string>();
  const toolInputs = new Map<string, unknown>();
  let toolCalls = record.result.usage?.toolCalls ?? 0;
  let modelSteps = 0;
  let costUsd = record.result.usage?.costUsd ?? 0;
  let lastUsage = record.result.usage;
  const limits = functionLimits(record);
  const delegation = functionDelegation(record);
  let totalDelegations = 0;
  const activeDelegations = new Set<string>();

  const output = await options.gateway.wait(
    record.admission,
    async (chunk: ConversationStreamChunk) => {
      const mapped = mapChunk(record, chunk, toolNames, toolInputs);
      if (chunk.type === "message-started") {
        modelSteps += 1;
        await enforceFunctionLimit(limits.steps, modelSteps, "steps", async () => {
          await options.gateway.abort(record.agentName, record.instanceId);
        });
      }
      if (chunk.type === "tool-input") {
        toolCalls += 1;
        await enforceFunctionLimit(
          limits.toolCalls,
          toolCalls,
          "tool calls",
          async () => {
            await options.gateway.abort(record.agentName, record.instanceId);
          },
        );
        if (chunk.toolName === "task") {
          totalDelegations += 1;
          await enforceDelegationLimit(
            delegation,
            totalDelegations,
            activeDelegations.size + 1,
            async () => {
              await options.gateway.abort(record.agentName, record.instanceId);
            },
          );
          activeDelegations.add(chunk.toolCallId);
        }
      }
      if (
        (chunk.type === "tool-output" || chunk.type === "tool-output-error") &&
        activeDelegations.has(chunk.toolCallId)
      ) {
        activeDelegations.delete(chunk.toolCallId);
      }
      if (chunk.type === "message-completed" && chunk.usage) {
        costUsd += Math.max(0, chunk.usage.cost.total);
        await enforceFunctionLimit(
          limits.costUsd,
          costUsd,
          "cost",
          async () => {
            await options.gateway.abort(record.agentName, record.instanceId);
          },
          "USD",
        );
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
                    Math.round(costUsd * 1_000_000),
                  ),
                  unit: "USD" as const,
                }),
          },
          ...(subscription && chunk.usage.cost.total === 0
            ? {}
            : { costUsd }),
        };
      }
      if (!mapped) return;
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

async function trackWorkflowAdmission(
  record: FlaryRunRecord,
  options: CreateFlueRunServiceOptions,
): Promise<void> {
  const wait = options.gateway.waitWorkflow;
  if (!wait) {
    throw new Error("The Flue workflow gateway cannot resume this run.");
  }
  const limits = functionLimits(record);
  const delegation = functionDelegation(record);
  let totalDelegations = 0;
  const activeDelegations = new Set<string>();
  let costUsd = record.result.usage?.costUsd ?? 0;
  let modelSteps = 0;
  let toolCalls = record.result.usage?.toolCalls ?? 0;
  const output = await wait.call(
    options.gateway,
    record.admission,
    async (event) => {
      if (event.type === "turn_start") {
        modelSteps += 1;
        await enforceFunctionLimit(
          limits.steps,
          modelSteps,
          "steps",
          async () => {
            if (options.gateway.abortWorkflow) {
              await options.gateway.abortWorkflow(record.agentName, record.admission.submissionId);
            }
          },
        );
      } else if (event.type === "tool_start") {
        toolCalls += 1;
        await enforceFunctionLimit(
          limits.toolCalls,
          toolCalls,
          "tool calls",
          async () => {
            if (options.gateway.abortWorkflow) {
              await options.gateway.abortWorkflow(record.agentName, record.admission.submissionId);
            }
          },
        );
      } else if (event.type === "task_start") {
        totalDelegations += 1;
        activeDelegations.add(event.taskId);
        await enforceDelegationLimit(
          delegation,
          totalDelegations,
          activeDelegations.size,
          async () => {
            if (options.gateway.abortWorkflow) {
              await options.gateway.abortWorkflow(record.agentName, record.admission.submissionId);
            }
          },
        );
      } else if (event.type === "task") {
        activeDelegations.delete(event.taskId);
      }
      if (event.type === "turn" && event.response.usage?.cost?.total !== undefined) {
        costUsd += Math.max(0, Number(event.response.usage.cost.total));
        await enforceFunctionLimit(
          limits.costUsd,
          costUsd,
          "cost",
          async () => {
            if (options.gateway.abortWorkflow) {
              await options.gateway.abortWorkflow(record.agentName, record.admission.submissionId);
            }
          },
          "USD",
        );
      }
      const mapped = mapWorkflowEvent(record, event);
      if (!mapped) return;
      await options.repository.appendEvent(
        record.runId,
        `workflow:${record.admission.submissionId}:${event.eventIndex}`,
        mapped,
      );
    },
    record.agentName,
  );
  const latest = await options.repository.get(record.runId);
  if (!latest || latest.result.status === "cancelled") return;
  const result = RunResultSchema.parse({
    ...latest.result,
    status: "completed",
    output: JsonValueSchema.parse(jsonValue(output)),
    usage: {
      ...(latest.result.usage ?? {}),
      ...(toolCalls > 0 ? { toolCalls } : {}),
      ...(costUsd > 0 ? { costUsd } : {}),
    },
    completedAt: new Date().toISOString(),
  });
  await options.repository.setResult(record.runId, result);
  await options.repository.appendEvent(
    record.runId,
    `completed:${record.admission.submissionId}`,
    eventDraft(record, "run.completed", { output: result.output! }),
  );
}

interface FunctionLimits {
  readonly steps?: number;
  readonly toolCalls?: number;
  readonly costUsd?: number;
}

interface FunctionDelegation {
  readonly maxConcurrent?: number;
  readonly maxTotal?: number;
}

function functionLimits(record: FlaryRunRecord): FunctionLimits {
  const value = record.request.metadata?.flaryLimits;
  if (!isRecord(value)) return {};
  return {
    ...(positiveNumber(value.steps) ? { steps: value.steps } : {}),
    ...(positiveNumber(value.toolCalls) ? { toolCalls: value.toolCalls } : {}),
    ...(positiveNumber(value.costUsd) ? { costUsd: value.costUsd } : {}),
  };
}

function functionDelegation(record: FlaryRunRecord): FunctionDelegation {
  const value = record.request.metadata?.flaryDelegation;
  if (!isRecord(value)) return {};
  return {
    ...(positiveNumber(value.maxConcurrent) ? { maxConcurrent: value.maxConcurrent } : {}),
    ...(positiveNumber(value.maxTotal) ? { maxTotal: value.maxTotal } : {}),
  };
}

async function enforceDelegationLimit(
  policy: FunctionDelegation,
  total: number,
  concurrent: number,
  abort: () => Promise<void>,
): Promise<void> {
  if (policy.maxTotal !== undefined && total > policy.maxTotal) {
    await abort();
    throw Object.assign(
      new Error("The function exceeded its total subagent delegation limit."),
      { code: "delegation_limit_exceeded" },
    );
  }
  if (policy.maxConcurrent !== undefined && concurrent > policy.maxConcurrent) {
    await abort();
    throw Object.assign(
      new Error("The function exceeded its concurrent subagent delegation limit."),
      { code: "delegation_limit_exceeded" },
    );
  }
}

async function enforceFunctionLimit(
  limit: number | undefined,
  value: number,
  label: string,
  abort: () => Promise<void>,
  unit = "",
): Promise<void> {
  if (limit === undefined || value <= limit) return;
  await abort();
  throw Object.assign(
    new Error(
      `The function exceeded its ${label} limit${unit ? ` in ${unit}` : ""}.`,
    ),
    { code: "function_limit_exceeded" },
  );
}

function positiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isFunctionFirstRequest(request: CreateRunRequest): boolean {
  return isRecord(request.metadata?.flaryFunction);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(cause: unknown): string {
  if (isRecord(cause) && typeof cause.code === "string" && cause.code.length > 0) {
    return cause.code;
  }
  return "flue_projection_failed";
}

function mapWorkflowEvent(
  record: FlaryRunRecord,
  event: FlueEvent,
): RunEventDraft | undefined {
  switch (event.type) {
    case "text_delta":
      return event.text
        ? eventDraft(record, "message.delta", { delta: event.text })
        : undefined;
    case "thinking_delta":
      return event.delta
        ? eventDraft(record, "reasoning.delta", { delta: event.delta })
        : undefined;
    case "agent_start":
      return eventDraft(record, "agent.started", {
        agentId: record.trusted.agentId,
      });
    case "agent_end":
      return eventDraft(record, "agent.completed", {
        agentId: record.trusted.agentId,
      });
    case "tool_start":
      return eventDraft(record, "tool.call", {
        call: {
          id: event.toolCallId,
          toolId: event.toolName,
          arguments: jsonObject(event.args),
          runId: record.runId,
          requestedAt: event.timestamp,
        },
      });
    case "tool":
      return eventDraft(record, "tool.result", {
        result: {
          id: `result_${event.toolCallId}`,
          callId: event.toolCallId,
          toolId: event.toolName,
          status: event.isError ? "failed" : "succeeded",
          ...(event.isError
            ? {
                error: {
                  code: "tool_failed",
                  message: errorMessage(event.result),
                },
              }
            : { output: jsonObject(event.result) }),
          completedAt: event.timestamp,
        },
      });
    case "run_end":
      if (event.isError) {
        return eventDraft(record, "run.failed", {
          error: {
            code: "workflow_failed",
            message: errorMessage(event.error),
          },
        });
      }
      return undefined;
    default:
      return undefined;
  }
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
    left.agentId === right.agentId &&
    // A durable run is admitted against one immutable function revision.
    // Hosts that do not pin a revision (legacy low-level callers) keep the
    // previous behaviour, while function-first callers fail closed after a
    // deployment changes the build or tool catalog.
    (!left.revisionId || !right.revisionId || left.revisionId === right.revisionId)
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

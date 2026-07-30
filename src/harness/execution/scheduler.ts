import { z } from "zod";
import {
  JsonObjectSchema,
  JsonValueSchema,
  ToolExecutionJournalRecordSchema,
  ToolLifecycleEventSchema,
  type ToolLifecycleEvent,
} from "../contracts/index.js";
import { ApprovalGate } from "./approval.js";
import { checkModeAccess } from "./mode-policy.js";
import { IdempotencyStore, idempotencyKeyForTask } from "./idempotency.js";
import { reduceLimits } from "./limits.js";
import { redactErrorMessage, redactSecrets } from "./redaction.js";
import { resolveModel } from "./models.js";
import {
  normalizeToolDefinition,
  normalizeToolTask,
  parseToolTasks,
} from "./normalize.js";
import { resolveExecutionProfile } from "./profiles.js";
import { deliverBatchedResults } from "./results.js";
import type {
  ExecutionError,
  ExecutionReport,
  ApprovalPolicy,
  SchedulerOptions,
  ToolExecutionResult,
  ToolTask,
  ToolTaskInput,
} from "./types.js";

const capSchema = z.record(z.string().min(1), z.number().int().positive());

export class ToolScheduler {
  readonly #options: SchedulerOptions;

  constructor(options: SchedulerOptions = {}) {
    this.#options = options;
  }

  async execute(
    taskInputs: readonly (ToolTaskInput | ToolTask)[],
  ): Promise<ExecutionReport> {
    const tasks = this.prepareTasks(taskInputs);
    const profile = resolveExecutionProfile(
      this.#options.profile,
      this.#options.profiles,
    );
    const directLimits = {
      ...this.#options.limits,
      maxConcurrency: this.#options.maxConcurrency,
      readParallelism: this.#options.readParallelism,
      batchSize: this.#options.batchSize,
    };
    const limits = reduceLimits(profile.limits, directLimits);
    const maxConcurrency = limits.maxConcurrency ?? 4;
    const readParallelism = limits.readParallelism ?? maxConcurrency;
    const maxToolCalls = limits.maxToolCalls ?? Number.POSITIVE_INFINITY;
    const maxDurationMs = limits.maxDurationMs ?? Number.POSITIVE_INFINITY;
    const caps = capSchema.parse(this.#options.concurrencyCaps ?? {});
    const approval = this.createApprovalGate(profile.approval);
    const idempotency =
      this.#options.idempotencyStore instanceof IdempotencyStore
        ? this.#options.idempotencyStore
        : new IdempotencyStore<unknown>();
    const startedAt = Date.now();
    const pending = new Map(tasks.map((task) => [task.id, task]));
    const results = new Map<string, ToolExecutionResult>();
    const lifecycleStarts = new Map<string, number>();
    let toolCalls = 0;

    while (pending.size > 0) {
      if (Date.now() - startedAt > maxDurationMs) {
        for (const task of pending.values()) {
          results.set(task.id, blockedResult(task, "Execution time limit reached."));
        }
        break;
      }

      this.skipFailedDependants(pending, results);
      const ready = [...pending.values()].filter((task) =>
        task.dependsOn.every((dependency) => results.get(dependency)?.status === "fulfilled"),
      );
      const wave = selectWave(ready, maxConcurrency, readParallelism, caps);

      if (wave.length === 0) {
        for (const task of pending.values()) {
          results.set(
            task.id,
            blockedResult(task, "Task dependencies cannot be resolved."),
          );
        }
        break;
      }

      const remainingCalls = maxToolCalls - toolCalls;
      const executable = wave.slice(0, Math.max(0, remainingCalls));
      const overLimit = wave.slice(executable.length);
      for (const task of overLimit) {
        pending.delete(task.id);
        results.set(task.id, blockedResult(task, "Tool call limit reached."));
      }

      const settled = await Promise.allSettled(
        executable.map((task) =>
          this.executeOne(task, approval, idempotency, lifecycleStarts),
        ),
      );
      toolCalls += executable.length;

      settled.forEach((settlement, index) => {
        const task = executable[index];
        pending.delete(task.id);
        results.set(
          task.id,
          settlement.status === "fulfilled"
            ? settlement.value
            : rejectedResult(task, settlement.reason),
        );
      });
    }

    const ordered = tasks.map((task) =>
      results.get(task.id) ?? blockedResult(task, "Task did not run."),
    );
    for (const [index, result] of ordered.entries()) {
      await this.emitTerminalEvent(
        tasks[index],
        result,
        lifecycleStarts.get(result.id),
      );
    }
    const batchSize = limits.batchSize ?? Math.max(1, ordered.length);
    const batches = this.#options.onBatch
      ? await deliverBatchedResults(ordered, batchSize, this.#options.onBatch)
      : ordered.length === 0
        ? []
        : [ordered];
    const resolvedModel =
      this.#options.models && this.#options.models.length > 0
        ? resolveModel(
            this.#options.model ?? profile.model,
            this.#options.models,
          )
        : undefined;

    return {
      results: ordered,
      batches,
      profile,
      limits,
      resolvedModel,
    };
  }

  private prepareTasks(
    inputs: readonly (ToolTaskInput | ToolTask)[],
  ): ToolTask[] {
    const parsed = parseToolTasks(inputs);
    const registry = this.#options.handlers ?? this.#options.tools ?? {};

    return parsed.map((task, index) => {
      const raw = inputs[index] as ToolTaskInput;
      const entry = registry[task.name];
      if (!entry) return task;
      const definition = normalizeToolDefinition(entry);
      const resourceKey =
        typeof definition.resourceKey === "function"
          ? definition.resourceKey(task)
          : definition.resourceKey;
      return normalizeToolTask({
        ...task,
        operation:
          raw.operation ?? raw.kind ?? raw.type ?? definition.operation ?? task.operation,
        resourceKey: task.resourceKey ?? resourceKey,
        requiresApproval:
          task.requiresApproval || definition.requiresApproval || false,
        concurrencyKey: task.concurrencyKey ?? definition.concurrencyKey,
        execute: task.execute ?? task.handler ?? definition.execute,
      });
    });
  }

  private createApprovalGate(
    profilePolicy: ApprovalPolicy,
  ): ApprovalGate {
    if (this.#options.approvalGate instanceof ApprovalGate) {
      return this.#options.approvalGate;
    }
    const handler =
      typeof this.#options.approvalGate === "function"
        ? this.#options.approvalGate
        : this.#options.approval?.handler;
    return new ApprovalGate({
      policy: this.#options.approval?.policy ?? profilePolicy,
      handler,
    });
  }

  private async executeOne(
    task: ToolTask,
    approval: ApprovalGate,
    idempotency: IdempotencyStore<unknown>,
    lifecycleStarts: Map<string, number>,
  ): Promise<ToolExecutionResult> {
    if (this.#options.signal?.aborted) {
      return baseResult(task, "cancelled", {
        reason: "Execution was aborted.",
      });
    }

    const modeDecision = this.#options.mode
      ? checkModeAccess(this.#options.mode, {
          capability: task.name,
          operation: task.operation,
          resource: task.resourceKey,
          toolId: task.name,
        })
      : { allowed: true as const, requiresApproval: false };
    if (!modeDecision.allowed) {
      return baseResult(task, "denied", { reason: modeDecision.reason });
    }
    const approvalTask = modeDecision.requiresApproval
      ? { ...task, requiresApproval: true }
      : task;
    const decision = await approval.request(approvalTask);
    const approved =
      typeof decision === "boolean" ? decision : decision.approved;
    if (!approved) {
      return baseResult(task, "denied", {
        reason:
          typeof decision === "boolean"
            ? "Approval denied."
            : decision.reason ?? "Approval denied.",
      });
    }

    const handler = task.execute ?? task.handler;
    if (!handler) {
      return baseResult(task, "rejected", {
        error: {
          name: "MissingToolHandlerError",
          message: `No handler is registered for '${task.name}'.`,
        },
      });
    }

    const requireWriteIdempotency =
      this.#options.requireWriteIdempotency ?? true;
    if (
      task.operation === "write" &&
      requireWriteIdempotency &&
      !task.idempotencyKey
    ) {
      return baseResult(task, "rejected", {
        error: {
          name: "MissingIdempotencyKeyError",
          message: "A state-changing tool needs an idempotency key.",
          code: "idempotency_key_required",
        },
      });
    }

    const key = idempotencyKeyForTask(
      task,
      this.#options.enableAutomaticIdempotency ?? task.operation === "write",
    );
    const journal = this.#options.toolJournal;
    const runId = this.#options.runId ?? "run_local";
    const previous = journal ? await journal.get(runId, task.id) : undefined;
    if (previous?.state === "outcome_unknown") {
      return baseResult(task, "outcome_unknown", {
        error: {
          name: "UnknownToolOutcomeError",
          message:
            previous.error?.message ??
            "The prior tool result is unknown and cannot be repeated.",
          code: "tool_outcome_unknown",
        },
        idempotencyKey: previous.idempotencyKey,
      });
    }
    if (previous?.state === "started" && task.operation === "write") {
      const completedAt = new Date().toISOString();
      await journal?.put(
        ToolExecutionJournalRecordSchema.parse({
          ...previous,
          state: "outcome_unknown",
          error: {
            code: "tool_outcome_unknown",
            message:
              "The prior write started but did not record a result. It cannot be repeated safely.",
            retryable: false,
          },
          completedAt,
        }),
      );
      return baseResult(task, "outcome_unknown", {
        error: {
          name: "UnknownToolOutcomeError",
          message:
            "The prior write started but did not record a result. It cannot be repeated safely.",
          code: "tool_outcome_unknown",
        },
        idempotencyKey: previous.idempotencyKey,
      });
    }
    if (previous?.state === "completed") {
      return baseResult(task, "fulfilled", {
        value: previous.output,
        idempotencyKey: previous.idempotencyKey,
        deduplicated: true,
      });
    }
    const lifecycleStartedAt = Date.now();
    lifecycleStarts.set(task.id, lifecycleStartedAt);
    const metadata = lifecycleMetadata(task);
    await this.emitToolEvent({
      type: "tool.started",
      runId,
      callId: task.id,
      toolId: task.name,
      operation: task.operation,
      occurredAt: new Date(lifecycleStartedAt).toISOString(),
      ...(metadata ? { metadata } : {}),
    });
    const startedAt = new Date().toISOString();
    if (journal) {
      await journal.put(
        ToolExecutionJournalRecordSchema.parse({
          runId,
          callId: task.id,
          toolId: task.name,
          operation: task.operation,
          state: "started",
          idempotencyKey: key,
          input: jsonObject(task.input),
          startedAt,
        }),
      );
    }

    try {
      const run = async () =>
        handler(task.input, {
          task,
          signal: this.#options.signal ?? { aborted: false },
          attempt: 1,
        });
      const executed = key
        ? await idempotency.execute(key, run)
        : { value: await run(), reused: false };
      const result = baseResult(task, "fulfilled", {
        value: executed.value,
        idempotencyKey: key,
        deduplicated: executed.reused || undefined,
      });
      enforceResultSize(result, this.#options.limits?.maxResultBytes);
      if (journal) {
        await journal.put(
          ToolExecutionJournalRecordSchema.parse({
            runId,
            callId: task.id,
            toolId: task.name,
            operation: task.operation,
            state: "completed",
            idempotencyKey: key,
            input: jsonObject(task.input),
            output: jsonObject(executed.value),
            startedAt,
            completedAt: new Date().toISOString(),
          }),
        );
      }
      return result;
    } catch (error) {
      const unknown =
        task.operation === "write" &&
        (this.#options.isUnknownToolOutcome?.(error, task) ??
          !isExplicitlySafeToRetry(error));
      if (journal) {
        await journal.put(
          ToolExecutionJournalRecordSchema.parse({
            runId,
            callId: task.id,
            toolId: task.name,
            operation: task.operation,
            state: unknown ? "outcome_unknown" : "failed",
            idempotencyKey: key,
            input: jsonObject(task.input),
            error: {
              code: unknown ? "tool_outcome_unknown" : "tool_failed",
              message: normalizeError(error).message,
              retryable: !unknown,
            },
            startedAt,
            completedAt: new Date().toISOString(),
          }),
        );
      }
      if (unknown) {
        return baseResult(task, "outcome_unknown", {
          error: {
            ...normalizeError(error),
            code: "tool_outcome_unknown",
          },
          idempotencyKey: key,
        });
      }
      return rejectedResult(task, error, key);
    }
  }

  private async emitTerminalEvent(
    task: ToolTask,
    result: ToolExecutionResult,
    startedAt: number | undefined,
  ): Promise<void> {
    if (!this.#options.onToolEvent) return;
    const occurredAt = new Date().toISOString();
    const durationMs = Math.max(
      0,
      startedAt === undefined ? 0 : Date.now() - startedAt,
    );
    const metadata = lifecycleMetadata(task);
    if (result.status === "fulfilled") {
      await this.emitToolEvent({
        type: "tool.completed",
        runId: this.#options.runId ?? "run_local",
        callId: task.id,
        toolId: task.name,
        operation: task.operation,
        occurredAt,
        durationMs,
        deduplicated: result.deduplicated ?? false,
        ...(metadata ? { metadata } : {}),
      });
      return;
    }
    await this.emitToolEvent({
      type: "tool.failed",
      runId: this.#options.runId ?? "run_local",
      callId: task.id,
      toolId: task.name,
      operation: task.operation,
      occurredAt,
      durationMs,
      status: result.status,
      error: {
        code: result.error?.code ?? `tool_${result.status}`,
        message:
          result.error?.message ??
          result.reason ??
          `Tool ${result.name} did not complete`,
      },
      ...(metadata ? { metadata } : {}),
    });
  }

  private async emitToolEvent(event: ToolLifecycleEvent): Promise<void> {
    if (!this.#options.onToolEvent) return;
    await this.#options.onToolEvent(ToolLifecycleEventSchema.parse(event));
  }

  private skipFailedDependants(
    pending: Map<string, ToolTask>,
    results: Map<string, ToolExecutionResult>,
  ): void {
    let changed = true;
    while (changed) {
      changed = false;
      for (const task of pending.values()) {
        const blockedBy = task.dependsOn.filter((dependency) => {
          const result = results.get(dependency);
          return result !== undefined && result.status !== "fulfilled";
        });
        if (blockedBy.length === 0) continue;
        pending.delete(task.id);
        results.set(
          task.id,
          baseResult(task, "skipped", {
            reason: "A dependency did not complete.",
            blockedBy,
          }),
        );
        changed = true;
      }
    }
  }
}

export async function executeToolTasks(
  tasks: readonly (ToolTaskInput | ToolTask)[],
  options: SchedulerOptions = {},
): Promise<ExecutionReport> {
  return new ToolScheduler(options).execute(tasks);
}

function selectWave(
  ready: ToolTask[],
  maxConcurrency: number,
  readParallelism: number,
  caps: Record<string, number>,
): ToolTask[] {
  const selected: ToolTask[] = [];
  const writes = new Set<string>();
  const counts = new Map<string, number>();
  let reads = 0;

  for (const task of ready) {
    if (selected.length >= maxConcurrency) break;
    if (task.operation === "read" && reads >= readParallelism) continue;

    const writeKey =
      task.operation === "write"
        ? task.resourceKey ?? `tool:${task.name}`
        : undefined;
    if (writeKey && writes.has(writeKey)) continue;

    const concurrencyKey = task.concurrencyKey;
    if (concurrencyKey) {
      const count = counts.get(concurrencyKey) ?? 0;
      if (count >= (caps[concurrencyKey] ?? maxConcurrency)) continue;
      counts.set(concurrencyKey, count + 1);
    }

    selected.push(task);
    if (task.operation === "read") reads += 1;
    if (writeKey) writes.add(writeKey);
  }
  return selected;
}

function baseResult(
  task: ToolTask,
  status: ToolExecutionResult["status"],
  extra: Partial<ToolExecutionResult> = {},
): ToolExecutionResult {
  return {
    id: task.id,
    name: task.name,
    operation: task.operation,
    resourceKey: task.resourceKey,
    dependsOn: [...task.dependsOn],
    status,
    ...extra,
  };
}

function blockedResult(task: ToolTask, reason: string): ToolExecutionResult {
  return baseResult(task, "blocked", { reason });
}

function rejectedResult(
  task: ToolTask,
  error: unknown,
  idempotencyKey?: string,
): ToolExecutionResult {
  return baseResult(task, "rejected", {
    error: normalizeError(error),
    idempotencyKey,
  });
}

function normalizeError(error: unknown): ExecutionError {
  if (error instanceof Error) {
    const code =
      "code" in error && typeof error.code === "string"
        ? error.code
        : undefined;
    return {
      name: error.name || "Error",
      message: redactErrorMessage(error.message, "Tool execution failed."),
      code,
    };
  }
  return {
    name: "Error",
    message: redactErrorMessage(error, "Tool execution failed."),
  };
}

function enforceResultSize(
  result: ToolExecutionResult,
  maxResultBytes?: number,
): void {
  if (maxResultBytes === undefined) return;
  const size = new TextEncoder().encode(JSON.stringify(result.value)).byteLength;
  if (size > maxResultBytes) {
    throw new RangeError(`Tool result exceeds ${maxResultBytes} bytes.`);
  }
}

function jsonObject(value: unknown) {
  const object = JsonObjectSchema.safeParse(value);
  if (object.success) return object.data;
  const json = JsonValueSchema.safeParse(value);
  return { value: json.success ? json.data : String(value) };
}

function lifecycleMetadata(task: ToolTask) {
  const metadata = JsonObjectSchema.safeParse(task.lifecycleMetadata);
  if (!metadata.success) return undefined;
  const redacted = JsonObjectSchema.safeParse(redactSecrets(metadata.data));
  return redacted.success ? redacted.data : undefined;
}

function isExplicitlySafeToRetry(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "safeToRetry" in error &&
    error.safeToRetry === true
  );
}

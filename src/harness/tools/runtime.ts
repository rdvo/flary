import {
  LazyToolBatchSchema,
  LazyToolCallSchema,
  ToolCatalogLoadResponseSchema,
  ToolLifecycleEventSchema,
  type AgentMode,
  type LazyToolBatchInput,
  type LazyToolCall,
  type LazyToolCallInput,
  type ToolCatalogDefinition,
  type ToolCatalogLoadResponse,
  type ToolCatalogSearchRequestInput,
  type ToolLifecycleEvent,
} from "../contracts/index";
import type { ExecutionLimitsInput } from "../execution/types";
import {
  modeAllowsCapability,
  modeAllowsWrite,
  modeRequiresApproval,
} from "../execution/mode-policy";
import { executeToolTasks } from "../execution/scheduler";
import { idempotencyKeyForTask } from "../execution/idempotency";
import { redactErrorMessage, redactSecrets } from "../execution/redaction";
import type {
  ExecutionReport,
  ToolExecutionResult,
} from "../execution/types";
import type { ToolExecutionJournal } from "../execution/tool-journal";
import type { CapabilityHandle, ToolCatalog } from "./catalog";

export interface LazyToolSearchResult {
  id: string;
  name: string;
  description?: string;
  capabilities: string[];
  operation: "read" | "write";
  requiresApproval: boolean;
  score: number;
}

export interface LazyToolRuntimeOptions {
  catalog: ToolCatalog;
  mode: AgentMode;
  maxConcurrency?: number;
  readParallelism?: number;
  limits?: ExecutionLimitsInput;
  concurrencyCaps?: Readonly<Record<string, number>>;
  toolJournal?: ToolExecutionJournal;
  runId?: string;
  onToolEvent?: (
    event: ToolLifecycleEvent,
  ) => void | Promise<void>;
  approve?: (
    tool: ToolCatalogDefinition,
    input: unknown,
    context: LazyToolApprovalContext,
  ) => Promise<void> | void;
}

export interface LazyToolApprovalContext {
  readonly runId: string;
  readonly callId: string;
  readonly toolId: string;
  readonly arguments: Record<string, unknown>;
  readonly operation: "read" | "write";
  readonly resourceKey: string;
  readonly idempotencyKey?: string;
}

/**
 * A small model-facing gateway over a private tool catalog.
 *
 * Search returns summaries. Describe loads one schema. Call validates and
 * executes through Flary's scheduler. Direct concurrent calls may read in
 * parallel, while writes to one resource are queued.
 */
export class LazyToolRuntime {
  readonly #options: LazyToolRuntimeOptions;
  readonly #writeTails = new Map<string, Promise<void>>();

  constructor(options: LazyToolRuntimeOptions) {
    this.#options = options;
  }

  async search(
    request: ToolCatalogSearchRequestInput = {},
  ): Promise<LazyToolSearchResult[]> {
    const response = await this.#options.catalog.search(request);
    return response.results
      .filter(({ tool }) => this.isVisible(tool))
      .map(({ tool, score }) => ({
        id: tool.id,
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        capabilities: tool.capabilities,
        operation: tool.operation,
        requiresApproval:
          Boolean(tool.requiresApproval) ||
          this.requiresApproval(tool, tool.id),
        score,
      }));
  }

  async describe(id: string): Promise<ToolCatalogLoadResponse | undefined> {
    const loaded = await this.#options.catalog.load({ id });
    if (!loaded || !this.isVisible(loaded.tool)) return undefined;
    return ToolCatalogLoadResponseSchema.parse(loaded);
  }

  async call(input: LazyToolCallInput): Promise<ToolExecutionResult> {
    const call = LazyToolCallSchema.parse(input);
    const prepared = await this.prepare(call);
    return (await this.executePrepared([prepared])).results[0]!;
  }

  async batch(input: LazyToolBatchInput): Promise<ExecutionReport> {
    const batch = LazyToolBatchSchema.parse(input);
    const prepared = await Promise.all(
      batch.calls.map((call) => this.prepare(call)),
    );
    return this.executePrepared(prepared);
  }

  private async prepare(call: LazyToolCall) {
    const taskId =
      call.callId ??
      call.idempotencyKey ??
      `call_${crypto.randomUUID().replaceAll("-", "")}`;
    const loaded = await this.#options.catalog.load({ id: call.id });
    const handle = await this.#options.catalog.loadHandle({
      id: call.id,
    });
    if (!loaded || !handle || !this.isVisible(loaded.tool)) {
      await this.emitPreflightFailure({
        taskId,
        toolId: call.id,
        operation: loaded?.tool.operation ?? "read",
        metadata: loaded?.tool.metadata,
        code: "tool_not_available",
        message: "The tool is not available in this mode",
      });
      throw new Error(`Tool is not available in this mode: ${call.id}`);
    }
    const resourceKey = handle.resourceKey(call.arguments) ?? call.id;
    if (
      handle.operation === "write" &&
      !modeAllowsWrite(this.#options.mode, {
        capability: loaded.tool.capabilities[0] ?? call.id,
        operation: "write",
        resource: resourceKey,
        toolId: call.id,
      })
    ) {
      await this.emitPreflightFailure({
        taskId,
        toolId: call.id,
        operation: "write",
        metadata: loaded.tool.metadata,
        code: "tool_write_denied",
        message: "The tool cannot write this resource in the current mode",
      });
      throw new Error(`Tool cannot write this resource in ${this.#options.mode.id} mode`);
    }
    if (
      loaded.tool.requiresApproval ||
      this.requiresApproval(loaded.tool, resourceKey)
    ) {
      const prior = await this.priorTerminalCall(taskId);
      if (!prior) {
        if (!this.#options.approve) {
          await this.emitPreflightFailure({
            taskId,
            toolId: call.id,
            operation: handle.operation,
            metadata: loaded.tool.metadata,
            code: "tool_approval_required",
            message: "The tool needs approval before it can run",
          });
          throw new Error(`Approval is required for tool: ${call.id}`);
        }
        try {
          await this.#options.approve(loaded.tool, call.arguments, {
            runId: this.#options.runId ?? "run_local",
            callId: taskId,
            toolId: call.id,
            arguments: call.arguments,
            operation: handle.operation,
            resourceKey,
            ...(this.writeIdempotencyKey(call, handle.operation, resourceKey)
              ? { idempotencyKey: this.writeIdempotencyKey(call, handle.operation, resourceKey) }
              : {}),
          });
        } catch (error) {
          await this.emitPreflightFailure({
            taskId,
            toolId: call.id,
            operation: handle.operation,
            metadata: loaded.tool.metadata,
            code: "tool_approval_denied",
            message: "The tool approval was not granted",
          });
          throw error;
        }
      }
    }
    return {
      call,
      taskId,
      handle,
      resourceKey,
      idempotencyKey: this.writeIdempotencyKey(call, handle.operation, resourceKey),
      lifecycleMetadata: loaded.tool.metadata,
    };
  }

  private executePrepared(
    prepared: Array<{
      call: LazyToolCall;
      taskId: string;
      handle: CapabilityHandle;
      resourceKey: string;
      idempotencyKey?: string;
      lifecycleMetadata?: Record<string, unknown>;
    }>,
  ): Promise<ExecutionReport> {
    return executeToolTasks(
      prepared.map(({ call, taskId, handle, resourceKey, idempotencyKey, lifecycleMetadata }) => ({
        id: taskId,
        name: call.id,
        input: call.arguments,
        operation: handle.operation,
        resourceKey,
        dependsOn: call.dependsOn,
        idempotencyKey,
        concurrencyKey: handle.concurrencyKey,
        lifecycleMetadata,
        execute: (value: unknown) =>
          handle.operation === "write"
            ? this.queueWrite(resourceKey, () => handle.invoke(value))
            : handle.invoke(value),
      })),
      {
        maxConcurrency: this.#options.maxConcurrency ?? 8,
        readParallelism: this.#options.readParallelism ?? 8,
        limits: this.#options.limits,
        concurrencyCaps: this.#options.concurrencyCaps,
        requireWriteIdempotency: true,
        toolJournal: this.#options.toolJournal,
        runId: this.#options.runId,
        onToolEvent: this.#options.onToolEvent,
      },
    );
  }

  private isVisible(tool: ToolCatalogDefinition): boolean {
    return tool.capabilities.length === 0
      ? true
      : tool.capabilities.some((capability) =>
          modeAllowsCapability(this.#options.mode, capability),
        );
  }

  private requiresApproval(
    tool: ToolCatalogDefinition,
    resource: string,
  ): boolean {
    return modeRequiresApproval(this.#options.mode, {
      capability: tool.capabilities[0] ?? tool.id,
      operation: tool.operation,
      resource,
      toolId: tool.id,
    });
  }

  private async queueWrite<T>(
    resourceKey: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const prior = this.#writeTails.get(resourceKey) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = prior.then(() => tail);
    this.#writeTails.set(resourceKey, queued);
    await prior;
    try {
      return await operation();
    } finally {
      release();
      if (this.#writeTails.get(resourceKey) === queued) {
        this.#writeTails.delete(resourceKey);
      }
    }
  }

  private async priorTerminalCall(callId: string): Promise<boolean> {
    if (!this.#options.toolJournal || !this.#options.runId) return false;
    const record = await this.#options.toolJournal.get(
      this.#options.runId,
      callId,
    );
    return (
      record?.state === "completed" ||
      record?.state === "outcome_unknown"
    );
  }

  private async emitPreflightFailure(input: {
    taskId: string;
    toolId: string;
    operation: "read" | "write";
    metadata?: Record<string, unknown>;
    code: string;
    message: string;
  }): Promise<void> {
    if (!this.#options.onToolEvent) return;
    const metadata =
      input.metadata && typeof input.metadata === "object"
        ? (redactSecrets(input.metadata) as Record<string, unknown>)
        : undefined;
    await this.#options.onToolEvent(
      ToolLifecycleEventSchema.parse({
        type: "tool.failed",
        runId: this.#options.runId ?? "run_local",
        callId: input.taskId,
        toolId: input.toolId,
        operation: input.operation,
        occurredAt: new Date().toISOString(),
        durationMs: 0,
        status: "denied",
        error: {
          code: input.code,
          message: redactErrorMessage(
            input.message,
            "The tool request was denied.",
          ),
          retryable: false,
        },
        ...(metadata ? { metadata } : {}),
      }),
    );
  }

  private writeIdempotencyKey(
    call: LazyToolCall,
    operation: "read" | "write",
    resourceKey?: string,
  ): string | undefined {
    if (call.idempotencyKey) return call.idempotencyKey;
    return operation === "write"
      ? idempotencyKeyForTask({
          name: call.id,
          input: call.arguments,
          operation,
          resourceKey,
        })
      : undefined;
  }
}

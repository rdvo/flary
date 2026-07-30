import {
  LazyToolBatchSchema,
  LazyToolCallSchema,
  ToolCatalogLoadResponseSchema,
  type AgentMode,
  type LazyToolBatchInput,
  type LazyToolCall,
  type LazyToolCallInput,
  type ToolCatalogDefinition,
  type ToolCatalogLoadResponse,
  type ToolCatalogSearchRequestInput,
} from "../contracts/index";
import {
  modeAllowsCapability,
  modeAllowsWrite,
  modeRequiresApproval,
} from "../execution/mode-policy";
import { executeToolTasks } from "../execution/scheduler";
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
  toolJournal?: ToolExecutionJournal;
  runId?: string;
  approve?: (
    tool: ToolCatalogDefinition,
    input: unknown,
  ) => Promise<void> | void;
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
    const loaded = await this.#options.catalog.load({ id: call.id });
    const handle = await this.#options.catalog.loadHandle({
      id: call.id,
    });
    if (!loaded || !handle || !this.isVisible(loaded.tool)) {
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
      throw new Error(`Tool cannot write this resource in ${this.#options.mode.id} mode`);
    }
    if (
      loaded.tool.requiresApproval ||
      this.requiresApproval(loaded.tool, resourceKey)
    ) {
      if (!this.#options.approve) {
        throw new Error(`Approval is required for tool: ${call.id}`);
      }
      await this.#options.approve(loaded.tool, call.arguments);
    }
    return { call, handle, resourceKey };
  }

  private executePrepared(
    prepared: Array<{
      call: LazyToolCall;
      handle: CapabilityHandle;
      resourceKey: string;
    }>,
  ): Promise<ExecutionReport> {
    return executeToolTasks(
      prepared.map(({ call, handle, resourceKey }) => ({
        id: call.callId ?? `call_${crypto.randomUUID().replaceAll("-", "")}`,
        name: call.id,
        input: call.arguments,
        operation: handle.operation,
        resourceKey,
        dependsOn: call.dependsOn,
        idempotencyKey: call.idempotencyKey,
        concurrencyKey: handle.concurrencyKey,
        execute: (value: unknown) =>
          handle.operation === "write"
            ? this.queueWrite(resourceKey, () => handle.invoke(value))
            : handle.invoke(value),
      })),
      {
        maxConcurrency: this.#options.maxConcurrency ?? 8,
        readParallelism: this.#options.readParallelism ?? 8,
        requireWriteIdempotency: true,
        toolJournal: this.#options.toolJournal,
        runId: this.#options.runId,
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
}

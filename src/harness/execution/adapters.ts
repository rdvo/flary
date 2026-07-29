import {
  CodeExecutionEventSchema,
  CodeExecutionRequestSchema,
  CodeExecutionResultSchema,
  type CodeExecutionEngine,
  type CodeExecutionEvent,
  type CodeExecutionRequest,
  type CodeExecutionRequestInput,
  type CodeExecutionResult,
} from "../contracts/code-execution";
import {
  JsonValueSchema,
  type JsonValue,
} from "../contracts/common";

export type ExecutionTool = (
  ...args: unknown[]
) => unknown | Promise<unknown>;

export interface CodeExecutionContext {
  signal?: AbortSignal;
  tools?: Record<string, ExecutionTool>;
  toolNamespaces?: Array<{
    name: string;
    tools: Record<string, ExecutionTool>;
  }>;
  environment?: Record<string, string>;
  onOutput?: (stream: "stdout" | "stderr" | "log", text: string) =>
    void | Promise<void>;
}

export interface CodeExecutionAdapter {
  readonly engine: CodeExecutionEngine;
  supports(request: CodeExecutionRequest): boolean;
  execute(
    request: CodeExecutionRequest,
    context: CodeExecutionContext,
  ): Promise<CodeExecutionResult>;
}

export interface CodeExecutionRouterOptions {
  adapters: CodeExecutionAdapter[];
  onEvent?: (event: CodeExecutionEvent) => void | Promise<void>;
}

export class CodeExecutionRouter {
  private readonly adapters: Map<CodeExecutionEngine, CodeExecutionAdapter>;

  constructor(private readonly options: CodeExecutionRouterOptions) {
    this.adapters = new Map(
      options.adapters.map((adapter) => [adapter.engine, adapter]),
    );
  }

  async execute(
    input: CodeExecutionRequestInput,
    context: CodeExecutionContext = {},
  ): Promise<CodeExecutionResult> {
    const request = CodeExecutionRequestSchema.parse(input);
    const adapter = this.resolve(request);
    const startedAt = new Date().toISOString();

    await this.emit({
      id: createExecutionEventId(),
      executionId: request.executionId,
      runId: request.runId,
      engine: adapter.engine,
      operation: request.operation,
      type: "execution.started",
      occurredAt: startedAt,
      metadata: request.metadata,
    });

    try {
      const result = CodeExecutionResultSchema.parse(
        await adapter.execute(
          { ...request, engine: adapter.engine },
          {
            ...context,
            onOutput: async (stream, text) => {
              await context.onOutput?.(stream, text);
              await this.emit({
                id: createExecutionEventId(),
                executionId: request.executionId,
                runId: request.runId,
                engine: adapter.engine,
                operation: request.operation,
                type: "execution.output",
                occurredAt: new Date().toISOString(),
                payload: { stream, text: clipText(text, 32 * 1024) },
                metadata: request.metadata,
              });
            },
          },
        ),
      );
      await this.emit({
        id: createExecutionEventId(),
        executionId: result.executionId,
        runId: result.runId,
        engine: result.engine,
        operation: result.operation,
        type:
          result.status === "completed"
            ? "execution.completed"
            : "execution.failed",
        occurredAt: result.completedAt,
        payload:
          result.status === "completed"
            ? { durationMs: result.durationMs }
            : {
                durationMs: result.durationMs,
                error: result.error?.message ?? "Execution failed",
              },
        metadata: request.metadata,
      });
      return result;
    } catch (cause) {
      const completedAt = new Date().toISOString();
      const message =
        cause instanceof Error ? cause.message : "Execution failed";
      const result = CodeExecutionResultSchema.parse({
        executionId: request.executionId,
        runId: request.runId,
        engine: adapter.engine,
        operation: request.operation,
        status: "failed",
        error: {
          code: "execution_failed",
          message: clipText(message, 8_192),
          retryable: false,
        },
        logs: [],
        startedAt,
        completedAt,
        durationMs:
          new Date(completedAt).getTime() - new Date(startedAt).getTime(),
        metadata: request.metadata,
      });
      await this.emit({
        id: createExecutionEventId(),
        executionId: result.executionId,
        runId: result.runId,
        engine: result.engine,
        operation: result.operation,
        type: "execution.failed",
        occurredAt: completedAt,
        payload: { error: result.error?.message ?? "Execution failed" },
        metadata: request.metadata,
      });
      return result;
    }
  }

  private resolve(request: CodeExecutionRequest): CodeExecutionAdapter {
    if (request.engine !== "auto") {
      if (
        (request.runtime === "isolate" &&
          request.engine !== "dynamic-worker") ||
        (request.runtime === "linux" && request.engine !== "sandbox")
      ) {
        throw new Error(
          `Execution engine ${request.engine} conflicts with runtime ${request.runtime}`,
        );
      }
      const adapter = this.adapters.get(request.engine);
      if (!adapter) {
        throw new Error(
          `Execution engine ${request.engine} is not configured`,
        );
      }
      if (!adapter.supports(request)) {
        throw new Error(
          `Execution engine ${request.engine} does not support ${request.operation}`,
        );
      }
      return adapter;
    }

    const candidates: CodeExecutionEngine[] =
      request.runtime === "isolate"
        ? ["dynamic-worker"]
        : request.runtime === "linux"
          ? ["sandbox"]
          : ["dynamic-worker", "sandbox"];
    for (const engine of candidates) {
      const adapter = this.adapters.get(engine);
      if (adapter?.supports(request)) return adapter;
    }
    throw new Error(`No execution engine supports ${request.operation}`);
  }

  private async emit(event: CodeExecutionEvent): Promise<void> {
    await this.options.onEvent?.(CodeExecutionEventSchema.parse(event));
  }
}

export interface FunctionExecutionAdapterOptions {
  engine: CodeExecutionEngine;
  operations?: string[];
  execute: (
    request: CodeExecutionRequest,
    context: CodeExecutionContext,
  ) => Promise<
    | CodeExecutionResult
    | {
        output?: unknown;
        logs?: string[];
      }
  >;
}

// Adapt an existing trusted runtime without changing its implementation.
export class FunctionExecutionAdapter implements CodeExecutionAdapter {
  readonly engine: CodeExecutionEngine;
  private readonly operations?: Set<string>;

  constructor(private readonly options: FunctionExecutionAdapterOptions) {
    this.engine = options.engine;
    this.operations = options.operations
      ? new Set(options.operations)
      : undefined;
  }

  supports(request: CodeExecutionRequest): boolean {
    return !this.operations || this.operations.has(request.operation);
  }

  async execute(
    request: CodeExecutionRequest,
    context: CodeExecutionContext,
  ): Promise<CodeExecutionResult> {
    const startedAt = new Date().toISOString();
    const value = await this.options.execute(request, context);
    if (
      value &&
      typeof value === "object" &&
      "executionId" in value &&
      "status" in value
    ) {
      return CodeExecutionResultSchema.parse(value);
    }
    const completedAt = new Date().toISOString();
    const partial = value as { output?: unknown; logs?: string[] };
    return CodeExecutionResultSchema.parse({
      executionId: request.executionId,
      runId: request.runId,
      engine: this.engine,
      operation: request.operation,
      status: "completed",
      output:
        partial.output === undefined ? null : toJsonValue(partial.output),
      logs: partial.logs ?? [],
      startedAt,
      completedAt,
      durationMs:
        new Date(completedAt).getTime() - new Date(startedAt).getTime(),
      metadata: request.metadata,
    });
  }
}

export function toJsonValue(value: unknown): JsonValue {
  if (value === undefined) return null;
  const direct = JsonValueSchema.safeParse(value);
  if (direct.success) return direct.data;
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error("Execution output is not JSON serializable");
  }
  return JsonValueSchema.parse(JSON.parse(serialized));
}

export function clipText(value: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= maxBytes) return value;
  return `${new TextDecoder().decode(bytes.slice(0, maxBytes))}…`;
}

function createExecutionEventId(): string {
  return `event_${crypto.randomUUID()}`;
}

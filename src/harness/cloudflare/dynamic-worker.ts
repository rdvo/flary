import type {
  DynamicWorkerExecutor,
  DynamicWorkerExecutorOptions,
  ResolvedProvider,
} from "@cloudflare/codemode";

import {
  CodeModeInputSchema,
  type CodeExecutionRequest,
  type CodeExecutionResult,
} from "../contracts/code-execution.js";
import {
  clipText,
  toJsonValue,
  type CodeExecutionAdapter,
  type CodeExecutionContext,
} from "../execution/adapters.js";
import type { FlaryExecutionToolOptions } from "../flue/toolset.js";

export interface DynamicWorkerAdapterOptions {
  loader: DynamicWorkerExecutorOptions["loader"];
  timeoutMs?: number;
  globalOutbound?: DynamicWorkerExecutorOptions["globalOutbound"];
  modules?: Record<string, string>;
  operation?: string;
}

/**
 * Configure the host-neutral toolset to use Cloudflare Dynamic Workers.
 *
 * Network access stays disabled unless the host sets `globalOutbound`.
 */
export function createCloudflareCodeMode(
  options: DynamicWorkerAdapterOptions,
): FlaryExecutionToolOptions {
  return {
    enabled: true,
    adapter: new CloudflareDynamicWorkerAdapter({
      ...options,
      operation: "code.execute",
    }),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
  };
}

// Run short model-written JavaScript with network access blocked by default.
export class CloudflareDynamicWorkerAdapter implements CodeExecutionAdapter {
  readonly engine = "dynamic-worker" as const;
  private readonly executor: Promise<DynamicWorkerExecutor>;
  private readonly operation: string;

  constructor(private readonly options: DynamicWorkerAdapterOptions) {
    this.operation = options.operation ?? "code.plan";
    this.executor = import("@cloudflare/codemode").then(
      ({ DynamicWorkerExecutor }) =>
        new DynamicWorkerExecutor({
          loader: options.loader,
          timeout: options.timeoutMs ?? 60_000,
          globalOutbound: options.globalOutbound ?? null,
          modules: options.modules,
        }),
    );
  }

  supports(request: CodeExecutionRequest): boolean {
    return request.runtime !== "linux" && request.operation === this.operation;
  }

  async execute(
    request: CodeExecutionRequest,
    context: CodeExecutionContext,
  ): Promise<CodeExecutionResult> {
    const input = CodeModeInputSchema.parse(request.input);
    const startedAt = new Date().toISOString();
    const providers: ResolvedProvider[] = context.toolNamespaces?.map((provider) => ({
      name: provider.name,
      fns: wrapTools(provider.tools),
    })) ?? [
      {
        name: "codemode",
        fns: wrapTools(context.tools ?? {}),
      },
    ];

    const outcome = await (await this.executor).execute(input.code, providers);
    const completedAt = new Date().toISOString();
    const logs = (outcome.logs ?? []).map((line) => clipText(line, request.limits.maxOutputBytes));
    if (outcome.error) {
      return {
        executionId: request.executionId,
        runId: request.runId,
        engine: this.engine,
        operation: request.operation,
        status: "failed",
        error: {
          code: "dynamic_worker_failed",
          message: clipText(outcome.error, 8_192),
          retryable: false,
        },
        logs,
        startedAt,
        completedAt,
        durationMs: new Date(completedAt).getTime() - new Date(startedAt).getTime(),
        metadata: request.metadata,
      };
    }

    return {
      executionId: request.executionId,
      runId: request.runId,
      engine: this.engine,
      operation: request.operation,
      status: "completed",
      output: toJsonValue(outcome.result),
      logs,
      startedAt,
      completedAt,
      durationMs: new Date(completedAt).getTime() - new Date(startedAt).getTime(),
      metadata: request.metadata,
    };
  }
}

function wrapTools(
  tools: Record<string, (...args: unknown[]) => unknown | Promise<unknown>>,
): Record<string, (...args: unknown[]) => Promise<unknown>> {
  return Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => [
      name,
      async (...args: unknown[]) => tool(...args),
    ]),
  );
}

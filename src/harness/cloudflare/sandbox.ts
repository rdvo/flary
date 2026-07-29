import {
  getSandbox,
  type Sandbox,
} from "@cloudflare/sandbox";

import {
  SandboxInputSchema,
  type CodeExecutionRequest,
  type CodeExecutionResult,
} from "../contracts/code-execution";
import {
  clipText,
  type CodeExecutionAdapter,
  type CodeExecutionContext,
} from "../execution/adapters";

export interface SandboxAdapterOptions {
  binding: Parameters<typeof getSandbox<Sandbox>>[0];
  operation?: string;
  sleepAfter?: string | number;
}

// Run commands in a full Linux environment. The bound Sandbox class controls
// network policy. Flary's reference class blocks public internet by default.
export class CloudflareSandboxAdapter implements CodeExecutionAdapter {
  readonly engine = "sandbox" as const;
  private readonly operation: string;

  constructor(private readonly options: SandboxAdapterOptions) {
    this.operation = options.operation ?? "sandbox.command";
  }

  supports(request: CodeExecutionRequest): boolean {
    return (
      request.runtime !== "isolate" &&
      request.operation === this.operation
    );
  }

  async execute(
    request: CodeExecutionRequest,
    context: CodeExecutionContext,
  ): Promise<CodeExecutionResult> {
    const input = SandboxInputSchema.parse(request.input);
    const startedAt = new Date().toISOString();
    const sandbox = getSandbox(this.options.binding, input.sandboxId, {
      transport: "rpc",
      sleepAfter: this.options.sleepAfter ?? "10m",
      enableDefaultSession: true,
      normalizeId: true,
      labels: {
        runId: request.runId,
        operation: request.operation,
      },
    });

    try {
      for (const file of input.files) {
        await sandbox.writeFile(
          `/workspace/${file.path}`,
          file.content,
          file.encoding === "base64"
            ? { encoding: "base64" }
            : { encoding: "utf-8" },
        );
      }
      const result = await sandbox.exec(input.command, {
        cwd: input.cwd,
        timeout: request.limits.timeoutMs,
        env: context.environment,
        signal: context.signal,
        stream: Boolean(context.onOutput),
        onOutput: (stream, text) => {
          void context.onOutput?.(stream, text);
        },
      });
      const completedAt = new Date().toISOString();
      const stdout = clipText(
        result.stdout,
        request.limits.maxOutputBytes,
      );
      const stderr = clipText(
        result.stderr,
        request.limits.maxOutputBytes,
      );
      const response: CodeExecutionResult = result.success
        ? {
            executionId: request.executionId,
            runId: request.runId,
            engine: this.engine,
            operation: request.operation,
            status: "completed",
            output: {
              command: result.command,
              exitCode: result.exitCode,
              stdout,
              stderr,
            },
            logs: [stdout, stderr].filter(Boolean),
            startedAt,
            completedAt,
            durationMs: result.duration,
            metadata: request.metadata,
          }
        : {
            executionId: request.executionId,
            runId: request.runId,
            engine: this.engine,
            operation: request.operation,
            status: "failed",
            error: {
              code: "sandbox_command_failed",
              message: stderr || `Command exited with ${result.exitCode}`,
              retryable: false,
              details: { exitCode: result.exitCode },
            },
            logs: [stdout, stderr].filter(Boolean),
            startedAt,
            completedAt,
            durationMs: result.duration,
            metadata: request.metadata,
          };
      return response;
    } finally {
      if (input.destroyAfter) await sandbox.destroy();
    }
  }
}

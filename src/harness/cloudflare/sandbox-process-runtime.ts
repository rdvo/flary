import type { Sandbox } from "@cloudflare/sandbox";

import {
  SqliteSandboxProcessRegistry,
  type SandboxProcess,
  type SandboxProcessControlRequest,
  type SandboxProcessCreate,
  type SandboxProcessOutputChunk,
} from "./sandbox-process-registry.js";

type LiveSandbox = Pick<
  Sandbox<any>,
  "exec" | "startProcess" | "getProcess" | "killProcess" | "getProcessLogs"
>;

export interface DurableSandboxProcessRuntimeOptions {
  readonly sandbox: LiveSandbox;
  readonly registry: SqliteSandboxProcessRegistry;
  readonly onSettled?: (input: {
    readonly processId: string;
    readonly state: "completed" | "failed" | "cancelled";
    readonly exitCode?: number;
  }) => Promise<void>;
}

/**
 * Connect durable process records to Cloudflare Sandbox process operations.
 *
 * The Sandbox SDK does not expose a direct stdin method. Flary gives each
 * process a private FIFO and writes bounded base64 data through `sandbox.exec`.
 */
export class DurableSandboxProcessRuntime {
  readonly #sandbox: LiveSandbox;
  readonly #registry: SqliteSandboxProcessRegistry;
  readonly #onSettled?: DurableSandboxProcessRuntimeOptions["onSettled"];
  readonly #notified = new Set<string>();

  constructor(options: DurableSandboxProcessRuntimeOptions) {
    this.#sandbox = options.sandbox;
    this.#registry = options.registry;
    this.#onSettled = options.onSettled;
  }

  async start(input: SandboxProcessCreate): Promise<SandboxProcess> {
    const record = await this.#registry.create(input);
    const fifo = stdinPath(record.id);
    const command = [
      `mkdir -p ${shellQuote(processDirectory(record.id))}`,
      `rm -f ${shellQuote(fifo)}`,
      `mkfifo ${shellQuote(fifo)}`,
      `exec ${record.command} < ${shellQuote(fifo)}`,
    ].join(" && ");
    try {
      await this.#sandbox.startProcess(command, {
        processId: record.id,
        autoCleanup: false,
        cwd: record.cwd,
        onOutput: (stream, data) => {
          void this.#registry.appendOutput({
            processId: record.id,
            stream,
            text: data,
          });
        },
        onExit: (code) => {
          void this.#finish(
            record.id,
            code === null || code !== 0 ? "failed" : "completed",
            code ?? undefined,
          );
        },
        onError: () => {
          void this.#finish(record.id, "failed", undefined, "sandbox_process_error");
        },
      });
      return this.#registry.start(record.id);
    } catch (error) {
      await this.#registry.fail(record.id, "sandbox_start_failed");
      throw error;
    }
  }

  async attach(
    processId: string,
    afterCursor = 0,
  ): Promise<{
    readonly process: SandboxProcess;
    readonly output: readonly SandboxProcessOutputChunk[];
    readonly live: boolean;
  }> {
    const record = await this.#registry.get(processId);
    if (!record) throw new Error(`Sandbox process '${processId}' was not found`);
    const live = await this.#sandbox.getProcess(processId);
    await this.#refresh(record, live);
    return {
      process: (await this.#registry.get(processId))!,
      output: await this.#registry.readOutput(processId, { afterCursor }),
      live: live !== null,
    };
  }

  async stdin(input: {
    readonly requestId: string;
    readonly processId: string;
    readonly data: string;
  }): Promise<SandboxProcessControlRequest> {
    const request = await this.#registry.requestStdin({
      id: input.requestId,
      processId: input.processId,
      data: input.data,
    });
    try {
      const base64 = bytesToBase64(new TextEncoder().encode(input.data));
      const result = await this.#sandbox.exec(
        `printf %s ${shellQuote(base64)} | base64 -d > ${shellQuote(stdinPath(input.processId))}`,
      );
      if (!result.success) throw new Error("The sandbox rejected stdin");
      return this.#registry.resolveControlRequest({
        requestId: request.id,
        status: "delivered",
      });
    } catch (error) {
      await this.#registry.resolveControlRequest({
        requestId: request.id,
        status: "failed",
        errorCode: "stdin_delivery_failed",
      });
      throw error;
    }
  }

  async signal(input: {
    readonly requestId: string;
    readonly processId: string;
    readonly signal:
      | "SIGHUP"
      | "SIGINT"
      | "SIGTERM"
      | "SIGKILL"
      | "SIGUSR1"
      | "SIGUSR2"
      | "SIGSTOP"
      | "SIGCONT";
  }): Promise<SandboxProcessControlRequest> {
    const request = await this.#registry.requestSignal({
      id: input.requestId,
      processId: input.processId,
      signal: input.signal,
    });
    try {
      await this.#sandbox.killProcess(input.processId, input.signal);
      if (input.signal === "SIGSTOP") {
        await this.#registry.sleep(input.processId);
      } else if (input.signal === "SIGCONT") {
        await this.#registry.wake(input.processId);
      } else if (input.signal === "SIGKILL" || input.signal === "SIGTERM") {
        await this.#registry.cancel(input.processId);
      }
      return this.#registry.resolveControlRequest({
        requestId: request.id,
        status: "delivered",
      });
    } catch (error) {
      await this.#registry.resolveControlRequest({
        requestId: request.id,
        status: "failed",
        errorCode: "signal_delivery_failed",
      });
      throw error;
    }
  }

  sleep(processId: string, requestId: string) {
    return this.signal({ processId, requestId, signal: "SIGSTOP" });
  }

  wake(processId: string, requestId: string) {
    return this.signal({ processId, requestId, signal: "SIGCONT" });
  }

  async #refresh(
    record: SandboxProcess,
    live: Awaited<ReturnType<LiveSandbox["getProcess"]>>,
  ): Promise<void> {
    if (!live) return;
    const logs = await this.#sandbox.getProcessLogs(record.id);
    if (record.outputBytes === 0) {
      if (logs.stdout) {
        await this.#registry.appendOutput({
          processId: record.id,
          stream: "stdout",
          text: logs.stdout,
        });
      }
      if (logs.stderr) {
        await this.#registry.appendOutput({
          processId: record.id,
          stream: "stderr",
          text: logs.stderr,
        });
      }
    }
    const status = await live.getStatus();
    if (status === "completed") {
      await this.#finish(record.id, "completed", live.exitCode ?? 0);
    } else if (status === "failed" || status === "error") {
      await this.#finish(record.id, "failed", live.exitCode, "sandbox_process_failed");
    } else if (status === "killed") {
      await this.#registry.cancel(record.id);
      await this.#notify(record.id, "cancelled", live.exitCode);
    }
  }

  async #finish(
    processId: string,
    state: "completed" | "failed",
    exitCode?: number,
    errorCode = "process_failed",
  ): Promise<void> {
    const current = await this.#registry.get(processId);
    if (
      current?.status === "completed" ||
      current?.status === "failed" ||
      current?.status === "cancelled"
    ) {
      await this.#notify(processId, current.status, current.exitCode);
      return;
    }
    if (state === "completed") {
      await this.#registry.complete(processId, exitCode ?? 0);
    } else {
      await this.#registry.fail(processId, errorCode, exitCode);
    }
    await this.#notify(processId, state, exitCode);
  }

  async #notify(
    processId: string,
    state: "completed" | "failed" | "cancelled",
    exitCode?: number,
  ): Promise<void> {
    const key = `${processId}:${state}`;
    if (!this.#onSettled || this.#notified.has(key)) return;
    this.#notified.add(key);
    try {
      await this.#onSettled({ processId, state, ...(exitCode === undefined ? {} : { exitCode }) });
    } catch (error) {
      this.#notified.delete(key);
      throw error;
    }
  }
}

function processDirectory(processId: string): string {
  return `/tmp/flary-processes/${processId}`;
}

function stdinPath(processId: string): string {
  return `${processDirectory(processId)}/stdin`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function bytesToBase64(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value);
}

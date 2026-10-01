import type { Sandbox } from "@cloudflare/sandbox";

import {
  SqliteSandboxProcessRegistry,
  type SandboxProcess,
  type SandboxProcessControlRequest,
  type SandboxProcessCreate,
  type SandboxProcessOutputChunk,
} from "./sandbox-process-registry.js";

type LiveSandbox = Pick<Sandbox<any>, "exec" | "startProcess" | "getProcess" | "getProcessLogs">;

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
  readonly #readyProcesses = new Set<string>();
  readonly #pendingProcessOperations = new Map<string, Array<() => Promise<void>>>();
  readonly #processOperations = new Map<string, Promise<void>>();
  readonly #requestedCancellations = new Set<string>();

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
      `exec 3<> ${shellQuote(fifo)} && exec ${record.command} <&3 3<&-`,
    ].join(" && ");
    try {
      await this.#sandbox.startProcess(command, {
        processId: record.id,
        autoCleanup: false,
        cwd: record.cwd,
        onOutput: (stream, data) => {
          void this.#dispatch(record.id, async () => {
            await this.#registry.appendOutput({
              processId: record.id,
              stream,
              text: data,
            });
          }).catch(() => undefined);
        },
        onExit: (code) => {
          void this.#dispatch(record.id, () =>
            this.#finish(
              record.id,
              code === null || code !== 0 ? "failed" : "completed",
              code ?? undefined,
            ),
          ).catch(() => undefined);
        },
        onError: () => {
          void this.#dispatch(record.id, () =>
            this.#finish(record.id, "failed", undefined, "sandbox_process_error"),
          ).catch(() => undefined);
        },
      });
      const started = await this.#registry.start(record.id);
      await this.#activate(record.id);
      return (await this.#registry.get(record.id)) ?? started;
    } catch (error) {
      this.#pendingProcessOperations.delete(record.id);
      this.#readyProcesses.delete(record.id);
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
    await this.#enqueue(processId, () => this.#refresh(record, live));
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
    if (request.status === "delivered") return request;
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
      "SIGHUP" | "SIGINT" | "SIGTERM" | "SIGKILL" | "SIGUSR1" | "SIGUSR2" | "SIGSTOP" | "SIGCONT";
  }): Promise<SandboxProcessControlRequest> {
    const request = await this.#registry.requestSignal({
      id: input.requestId,
      processId: input.processId,
      signal: input.signal,
    });
    if (request.status === "delivered") return request;
    const requestsCancellation = input.signal === "SIGKILL" || input.signal === "SIGTERM";
    if (requestsCancellation) this.#requestedCancellations.add(input.processId);
    try {
      // SDK 0.12.4 accepts a signal argument but its implementation drops it.
      // Use the live process PID so STOP/CONT and the requested signal reach
      // the process rather than all being converted into termination.
      const live = await this.#sandbox.getProcess(input.processId);
      const pid = live?.pid;
      if (!Number.isSafeInteger(pid) || pid === undefined || pid <= 0) {
        throw new Error("The Sandbox did not return a valid live process PID");
      }
      const delivered = await this.#sandbox.exec(`/bin/kill -s ${input.signal.slice(3)} -- ${pid}`);
      if (!delivered.success) throw new Error("The Sandbox rejected the process signal");
      if (input.signal === "SIGSTOP") {
        await this.#registry.sleep(input.processId);
      } else if (input.signal === "SIGCONT") {
        await this.#registry.wake(input.processId);
      } else if (requestsCancellation) {
        await this.#enqueue(input.processId, async () => {
          const current = await this.#registry.get(input.processId);
          if (
            current &&
            current.status !== "completed" &&
            current.status !== "failed" &&
            current.status !== "cancelled"
          ) {
            await this.#registry.cancel(input.processId);
          }
          const settled = await this.#registry.get(input.processId);
          if (settled?.status === "cancelled") {
            await this.#notify(input.processId, "cancelled", settled.exitCode);
          }
        });
        this.#requestedCancellations.delete(input.processId);
      }
      return this.#registry.resolveControlRequest({
        requestId: request.id,
        status: "delivered",
      });
    } catch (error) {
      if (requestsCancellation) this.#requestedCancellations.delete(input.processId);
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
    let logs: Awaited<ReturnType<LiveSandbox["getProcessLogs"]>> | undefined;
    try {
      logs = await this.#sandbox.getProcessLogs(record.id);
    } catch (error) {
      if (live) throw error;
    }
    if (logs) {
      await this.#registry.reconcileOutput({
        processId: record.id,
        stream: "stdout",
        text: logs.stdout,
      });
      await this.#registry.reconcileOutput({
        processId: record.id,
        stream: "stderr",
        text: logs.stderr,
      });
    }
    if (!live) return;
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
    if (this.#requestedCancellations.has(processId)) {
      await this.#registry.cancel(processId);
      await this.#notify(processId, "cancelled", exitCode);
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

  #dispatch(processId: string, operation: () => Promise<void>): Promise<void> {
    if (!this.#readyProcesses.has(processId)) {
      const pending = this.#pendingProcessOperations.get(processId) ?? [];
      pending.push(operation);
      this.#pendingProcessOperations.set(processId, pending);
      return Promise.resolve();
    }
    return this.#enqueue(processId, operation);
  }

  async #activate(processId: string): Promise<void> {
    this.#readyProcesses.add(processId);
    const pending = this.#pendingProcessOperations.get(processId) ?? [];
    this.#pendingProcessOperations.delete(processId);
    await Promise.all(pending.map((operation) => this.#enqueue(processId, operation)));
  }

  #enqueue(processId: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.#processOperations.get(processId) ?? Promise.resolve();
    const current = previous.then(operation, operation);
    const settled = current.then(
      () => undefined,
      () => undefined,
    );
    this.#processOperations.set(processId, settled);
    void settled.then(() => {
      if (this.#processOperations.get(processId) === settled) {
        this.#processOperations.delete(processId);
      }
    });
    return current;
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

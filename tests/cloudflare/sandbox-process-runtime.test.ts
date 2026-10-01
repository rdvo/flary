import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { cwd } from "node:process";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  DurableSandboxProcessRuntime,
  SqliteSandboxProcessRegistry,
} from "../../src/harness/cloudflare/index.ts";

test("durable sandbox runtime drives live start, stdin, signals, and attach", async () => {
  const storage = sqlite();
  const calls: Array<{ name: string; values: unknown[] }> = [];
  const settlements: unknown[] = [];
  let onExit: ((code: number | null) => void) | undefined;
  const process = {
    id: "process_1",
    pid: 123,
    command: "node server.js",
    status: "running" as const,
    startTime: new Date(),
    async kill(signal?: string) {
      calls.push({ name: "kill", values: [signal] });
    },
    async getStatus() {
      return "running" as const;
    },
    async getLogs() {
      return { stdout: "ready\n", stderr: "" };
    },
    async waitForLog() {
      throw new Error("not used");
    },
    async waitForPort() {},
    async waitForExit() {
      throw new Error("not used");
    },
  };
  const runtime = new DurableSandboxProcessRuntime({
    registry: new SqliteSandboxProcessRegistry(storage.sql),
    async onSettled(input) {
      settlements.push(input);
    },
    sandbox: {
      async startProcess(command, options) {
        calls.push({ name: "start", values: [command, options] });
        onExit = options?.onExit;
        return process;
      },
      async exec(command) {
        calls.push({ name: "exec", values: [command] });
        return {
          command,
          exitCode: 0,
          success: true,
          stdout: "",
          stderr: "",
          duration: 1,
          timestamp: new Date().toISOString(),
        };
      },
      async getProcess() {
        return process;
      },
      async killProcess(id, signal) {
        calls.push({ name: "signal", values: [id, signal] });
      },
      async getProcessLogs() {
        return { processId: "process_1", stdout: "ready\n", stderr: "" };
      },
    } as never,
  });

  await runtime.start({
    id: "process_1",
    runId: "run_1",
    sandboxId: "sandbox_1",
    command: "node server.js",
    cwd: "/workspace",
  });
  await runtime.stdin({
    requestId: "stdin_1",
    processId: "process_1",
    data: "hello\n",
  });
  await runtime.stdin({ requestId: "stdin_1", processId: "process_1", data: "hello\n" });
  await runtime.sleep("process_1", "sleep_1");
  await runtime.sleep("process_1", "sleep_1");
  await runtime.wake("process_1", "wake_1");
  await runtime.wake("process_1", "wake_1");
  const attached = await runtime.attach("process_1");

  assert.equal(attached.live, true);
  assert.equal(attached.process.status, "running");
  assert.equal(attached.output[0]?.text, "ready\n");
  assert.deepEqual(
    calls
      .filter((call) => call.name === "exec" && String(call.values[0]).startsWith("/bin/kill"))
      .map((call) => call.values[0]),
    ["/bin/kill -s STOP -- 123", "/bin/kill -s CONT -- 123"],
  );
  assert.match(String(calls.find((call) => call.name === "exec")?.values[0]), /base64 -d/);
  assert.equal(
    calls.filter((call) => call.name === "exec" && String(call.values[0]).includes("base64 -d"))
      .length,
    1,
    "delivered stdin request IDs must not write again",
  );
  onExit?.(0);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(settlements, [
    {
      processId: "process_1",
      state: "completed",
      exitCode: 0,
    },
  ]);
});

test("sandbox process starts before stdin writers and accepts repeated writes", async () => {
  const processId = "process_real_shell";
  const storage = sqlite();
  let child: ChildProcess | undefined;
  let status: "running" | "completed" | "failed" = "running";
  let exitCode: number | undefined;
  let stdout = "";
  let stderr = "";
  let outputCallback: ((stream: "stdout" | "stderr", data: string) => void) | undefined;
  let exitCallback: ((code: number | null) => void) | undefined;
  const process = {
    id: processId,
    get pid() {
      return child?.pid;
    },
    command: "shell stdin regression",
    get status() {
      return status;
    },
    get exitCode() {
      return exitCode;
    },
    startTime: new Date(),
    async kill(signal?: string) {
      child?.kill(signal as NodeJS.Signals | undefined);
    },
    async getStatus() {
      return status;
    },
    async getLogs() {
      return { stdout, stderr };
    },
    async waitForLog() {
      throw new Error("not used");
    },
    async waitForPort() {},
    async waitForExit() {
      throw new Error("not used");
    },
  };
  const runtime = new DurableSandboxProcessRuntime({
    registry: new SqliteSandboxProcessRegistry(storage.sql),
    sandbox: {
      async startProcess(
        command: string,
        options?: {
          cwd?: string;
          processId?: string;
          onOutput?: (stream: "stdout" | "stderr", data: string) => void;
          onExit?: (code: number | null) => void;
        },
      ) {
        outputCallback = options?.onOutput;
        exitCallback = options?.onExit;
        child = spawn("/bin/bash", ["-c", command], { cwd: options?.cwd });
        child.stdout?.on("data", (chunk: Buffer) => {
          const data = chunk.toString("utf8");
          stdout += data;
          outputCallback?.("stdout", data);
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          const data = chunk.toString("utf8");
          stderr += data;
          outputCallback?.("stderr", data);
        });
        child.on("close", (code) => {
          status = code === 0 ? "completed" : "failed";
          exitCode = code ?? undefined;
          exitCallback?.(code);
        });
        return process;
      },
      async exec(command: string) {
        const result = spawnSync("/bin/bash", ["-c", command], {
          encoding: "utf8",
          timeout: 3_000,
        });
        if (result.error) throw result.error;
        return {
          command,
          exitCode: result.status ?? 1,
          success: result.status === 0,
          stdout: result.stdout,
          stderr: result.stderr,
          duration: 1,
          timestamp: new Date().toISOString(),
        };
      },
      async getProcess(id: string) {
        return id === processId ? process : null;
      },
      async killProcess(id: string, signal?: string) {
        if (id === processId) child?.kill(signal as NodeJS.Signals | undefined);
      },
      async getProcessLogs(id: string) {
        return { processId: id, stdout, stderr };
      },
    } as never,
  });

  try {
    await runtime.start({
      id: processId,
      runId: "run_real_shell",
      sandboxId: "sandbox_real_shell",
      command:
        `sh -c 'printf "ready\\n"; IFS= read -r first; IFS= read -r second; ` +
        `printf "received:%s:%s\\n" "$first" "$second"'`,
      cwd: cwd(),
    });
    await waitFor(() => stdout.includes("ready\n"));
    await runtime.sleep(processId, "pause_real_shell");
    await runtime.stdin({ requestId: "stdin_real_shell_1", processId, data: "one\n" });
    await runtime.stdin({ requestId: "stdin_real_shell_2", processId, data: "two\n" });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(
      stdout.includes("received:"),
      false,
      "a stopped process must not consume its stdin",
    );
    assert.equal((await runtime.attach(processId)).process.status, "sleeping");
    await runtime.wake(processId, "resume_real_shell");
    await waitFor(() => stdout.includes("received:one:two\n"));
    const attached = await runtime.attach(processId);

    assert.equal(attached.process.status, "completed");
    assert.equal(exitCode, 0);
    assert.equal(attached.output.map((chunk) => chunk.text).join(""), "ready\nreceived:one:two\n");
  } finally {
    child?.kill("SIGKILL");
    rmSync("/tmp/flary-processes/process_real_shell", { recursive: true, force: true });
  }
});

test("process output recovery deduplicates callbacks against durable stream snapshots", async () => {
  const storage = sqlite();
  const logs = { stdout: "", stderr: "" };
  let onOutput: ((stream: "stdout" | "stderr", data: string) => void) | undefined;
  const process = {
    id: "process_recovery",
    command: "node server.js",
    status: "running" as const,
    startTime: new Date(),
    async kill() {},
    async getStatus() {
      return "running" as const;
    },
    async getLogs() {
      return logs;
    },
    async waitForLog() {
      throw new Error("not used");
    },
    async waitForPort() {},
    async waitForExit() {
      throw new Error("not used");
    },
  };
  const sandbox = {
    async startProcess(
      _command: string,
      options?: {
        onOutput?: (stream: "stdout" | "stderr", data: string) => void;
      },
    ) {
      onOutput = options?.onOutput;
      onOutput?.("stdout", "prior 😀\n");
      onOutput?.("stderr", "warning\n");
      return process;
    },
    async exec(command: string) {
      return {
        command,
        exitCode: 0,
        success: true,
        stdout: "",
        stderr: "",
        duration: 1,
        timestamp: new Date().toISOString(),
      };
    },
    async getProcess() {
      return process;
    },
    async killProcess() {},
    async getProcessLogs(processId: string) {
      return { processId, ...logs };
    },
  };
  const firstRuntime = new DurableSandboxProcessRuntime({
    registry: new SqliteSandboxProcessRegistry(storage.sql),
    sandbox: sandbox as never,
  });
  await firstRuntime.start({
    id: "process_recovery",
    runId: "run_recovery",
    sandboxId: "sandbox_recovery",
    command: "node server.js",
  });

  logs.stdout = "prior 😀\nrecovered\n";
  logs.stderr = "warning\nrecovered warning\n";
  const firstAttach = await firstRuntime.attach("process_recovery");
  assert.equal(
    firstAttach.output
      .filter((chunk) => chunk.stream === "stdout")
      .map((chunk) => chunk.text)
      .join(""),
    "prior 😀\nrecovered\n",
  );
  assert.equal(
    firstAttach.output
      .filter((chunk) => chunk.stream === "stderr")
      .map((chunk) => chunk.text)
      .join(""),
    "warning\nrecovered warning\n",
  );

  // A delayed callback can repeat bytes already included by getProcessLogs().
  onOutput?.("stdout", "recovered\n");
  onOutput?.("stderr", "recovered warning\n");
  const restartedRuntime = new DurableSandboxProcessRuntime({
    registry: new SqliteSandboxProcessRegistry(storage.sql),
    sandbox: sandbox as never,
  });
  const repeatedAttach = await restartedRuntime.attach("process_recovery");
  assert.deepEqual(repeatedAttach.output, firstAttach.output);

  logs.stdout += "tail\n";
  logs.stderr += "tail warning\n";
  const finalAttach = await restartedRuntime.attach(
    "process_recovery",
    firstAttach.output.at(-1)?.cursor,
  );
  assert.deepEqual(
    finalAttach.output.map((chunk) => [chunk.stream, chunk.text]),
    [
      ["stdout", "tail\n"],
      ["stderr", "tail warning\n"],
    ],
  );
});

test("successful terminate signals remain cancelled when the SDK exit callback races", async () => {
  const storage = sqlite();
  const settlements: unknown[] = [];
  let onExit: ((code: number | null) => void) | undefined;
  const process = {
    id: "process_signal_race",
    pid: 123,
    command: "sleep 10",
    status: "running" as const,
    startTime: new Date(),
    async kill() {},
    async getStatus() {
      return "running" as const;
    },
    async getLogs() {
      return { stdout: "", stderr: "" };
    },
    async waitForLog() {
      throw new Error("not used");
    },
    async waitForPort() {},
    async waitForExit() {
      throw new Error("not used");
    },
  };
  const runtime = new DurableSandboxProcessRuntime({
    registry: new SqliteSandboxProcessRegistry(storage.sql),
    async onSettled(input) {
      settlements.push(input);
    },
    sandbox: {
      async startProcess(_command: string, options?: { onExit?: (code: number | null) => void }) {
        onExit = options?.onExit;
        return process;
      },
      async exec(command: string) {
        if (command.startsWith("/bin/kill")) onExit?.(143);
        return {
          command,
          exitCode: 0,
          success: true,
          stdout: "",
          stderr: "",
          duration: 1,
          timestamp: new Date().toISOString(),
        };
      },
      async getProcess() {
        return process;
      },
      async killProcess() {
        onExit?.(143);
      },
      async getProcessLogs(processId: string) {
        return { processId, stdout: "", stderr: "" };
      },
    } as never,
  });

  await runtime.start({
    id: "process_signal_race",
    runId: "run_signal_race",
    sandboxId: "sandbox_signal_race",
    command: "sleep 10",
  });
  const request = await runtime.signal({
    requestId: "signal_terminate_race",
    processId: "process_signal_race",
    signal: "SIGTERM",
  });
  const attached = await runtime.attach("process_signal_race");

  assert.equal(request.status, "delivered");
  assert.equal(attached.process.status, "cancelled");
  assert.deepEqual(settlements, [
    { processId: "process_signal_race", state: "cancelled", exitCode: 143 },
  ]);
});

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for sandbox process output");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

function sqlite() {
  const database = new DatabaseSync(":memory:");
  return {
    sql: {
      exec<T>(query: string, ...bindings: unknown[]) {
        const lower = query.trimStart().toLowerCase();
        if (bindings.length === 0 && !lower.startsWith("select")) {
          database.exec(query);
          return { toArray: () => [] as T[] };
        }
        const statement = database.prepare(query);
        if (lower.startsWith("select") || lower.includes(" returning ")) {
          return { toArray: () => statement.all(...bindings) as T[] };
        }
        statement.run(...bindings);
        return { toArray: () => [] as T[] };
      },
    },
  };
}

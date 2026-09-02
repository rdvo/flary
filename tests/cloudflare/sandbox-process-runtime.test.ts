import assert from "node:assert/strict";
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
  await runtime.sleep("process_1", "sleep_1");
  await runtime.wake("process_1", "wake_1");
  const attached = await runtime.attach("process_1");

  assert.equal(attached.live, true);
  assert.equal(attached.process.status, "running");
  assert.equal(attached.output[0]?.text, "ready\n");
  assert.deepEqual(
    calls.filter((call) => call.name === "signal").map((call) => call.values[1]),
    ["SIGSTOP", "SIGCONT"],
  );
  assert.match(String(calls.find((call) => call.name === "exec")?.values[0]), /base64 -d/);
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

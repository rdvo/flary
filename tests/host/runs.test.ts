import assert from "node:assert/strict";
import test from "node:test";

import {
  createFlaryRunRouter,
  type FlaryRunService,
  type TrustedRunContext,
} from "../../src/harness/host/runs.js";
import type {
  CancelRunRequest,
  CreateRunRequest,
  RunEvent,
  RunHandle,
  RunInput,
  RunResult,
} from "../../src/harness/contracts/index.js";

const trusted: TrustedRunContext = {
  tenantId: "tenant_123",
  applicationId: "relayr",
  projectId: "project_123",
  agentId: "research",
  revisionId: "revision_1",
  identity: { id: "user_123", kind: "user", version: "1" },
  roles: ["owner"],
  scopes: ["agents.run"],
};

function result(status: RunResult["status"]): RunResult {
  return {
    runId: "run_123",
    requestId: "request_123",
    status,
    ...(status === "completed" ? { output: { ok: true } } : {}),
    ...(status === "failed"
      ? { error: { code: "failed", message: "Failed" } }
      : {}),
  };
}

test("run router keeps trusted context outside the public request", async () => {
  let admitted: TrustedRunContext | undefined;
  const service: FlaryRunService = {
    async create(context, _request: CreateRunRequest): Promise<RunHandle> {
      admitted = context;
      return {
        runId: "run_123",
        requestId: "request_123",
        status: "queued",
        eventsUrl: "/runs/run_123/events",
        inputUrl: "/runs/run_123/input",
        cancelUrl: "/runs/run_123/cancel",
        cursor: { runId: "run_123", afterSequence: 0 },
      };
    },
    async get() {
      return result("running");
    },
    async *observe(): AsyncGenerator<RunEvent> {
      yield {
        id: "event_1",
        runId: "run_123",
        sequence: 1,
        occurredAt: new Date().toISOString(),
        type: "run.queued",
        payload: {
          requestId: "request_123",
          target: { kind: "agent", agentId: "research" },
        },
      };
    },
    async input(
      _context: TrustedRunContext,
      _runId: string,
      _input: RunInput,
    ) {
      return result("running");
    },
    async cancel(
      _context: TrustedRunContext,
      _runId: string,
      _input: CancelRunRequest,
    ) {
      return result("cancelled");
    },
  };
  const router = createFlaryRunRouter<object>({
    resolveContext: () => trusted,
    service,
    heartbeatMs: 60_000,
  });
  const response = await router.request("/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      requestId: "request_123",
      channelId: "channel_123",
      input: { question: "Hello" },
      idempotencyKey: "idempotency_123",
    }),
  });

  assert.equal(response.status, 202);
  assert.equal(admitted?.tenantId, "tenant_123");
  assert.equal(admitted?.agentId, "research");
});

test("run event replay accepts Last-Event-ID and emits normalized SSE", async () => {
  let afterSequence = -1;
  const service: FlaryRunService = {
    async create() {
      throw new Error("unused");
    },
    async get() {
      return result("running");
    },
    async *observe(_context, _runId, options): AsyncGenerator<RunEvent> {
      afterSequence = options.afterSequence;
      yield {
        id: "event_8",
        runId: "run_123",
        sequence: 8,
        occurredAt: new Date().toISOString(),
        type: "message.delta",
        payload: { delta: "hello" },
      };
    },
    async input() {
      return result("running");
    },
    async cancel() {
      return result("cancelled");
    },
  };
  const router = createFlaryRunRouter<object>({
    resolveContext: () => trusted,
    service,
    heartbeatMs: 60_000,
  });
  const response = await router.request("/runs/run_123/events", {
    headers: { "Last-Event-ID": "7" },
  });
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.equal(afterSequence, 7);
  assert.match(body, /id: 8/);
  assert.match(body, /event: message\.delta/);
});

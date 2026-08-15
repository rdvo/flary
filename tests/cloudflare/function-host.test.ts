import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  createFlaryCodemodeApprovalHooks,
  createFlaryDurableRunService,
  createCloudflareFlueGateway,
  handleFlaryDurableRunObjectRequest,
  type FlaryDurableObjectNamespace,
  type FlaryDurableObjectState,
} from "../../src/harness/cloudflare/function-host.ts";
import type { FlueAgentGateway } from "../../src/harness/flue/service.ts";
import type { FlaryRunRecord } from "../../src/harness/flue/service.ts";
import type { ApprovalDecision } from "../../src/harness/contracts/index.ts";
import type { TrustedRunContext } from "../../src/harness/host/runs.ts";

type SqlDatabase = {
  exec(query: string): void;
  prepare(query: string): {
    all(...bindings: unknown[]): unknown[];
    run(...bindings: unknown[]): unknown;
  };
};

function sqlStore() {
  const database = new DatabaseSync(":memory:") as unknown as SqlDatabase;
  return {
    exec<T = Record<string, unknown>>(
      query: string,
      ...bindings: unknown[]
    ): { toArray(): T[] } {
      const trimmed = query.trim().toLowerCase();
      if (
        bindings.length === 0 &&
        !/^(select|with|pragma|explain)\b/.test(trimmed)
      ) {
        database.exec(query);
        return { toArray: () => [] };
      }
      const statement = database.prepare(query);
      if (
        /^(select|with|pragma|explain)\b/.test(trimmed) ||
        /\breturning\b/.test(trimmed)
      ) {
        return { toArray: () => statement.all(...bindings) as T[] };
      }
      statement.run(...bindings);
      return { toArray: () => [] };
    },
  };
}

const tenantOne: TrustedRunContext = {
  tenantId: "tenant_1",
  applicationId: "app_1",
  agentId: "support",
  identity: { id: "user_1", kind: "user", version: "1" },
  roles: [],
  scopes: [],
};

function gateway(): FlueAgentGateway {
  return {
    async send() {
      return {
        streamUrl: "https://example.com/stream",
        offset: "0",
        submissionId: "submission_host",
      };
    },
    async wait() {
      return { answer: "done" };
    },
    async abort() {
      return { aborted: true };
    },
  };
}

test("Runtime Durable Object RPC persists ownership across handler recreation", async () => {
  const sql = sqlStore();
  const state: FlaryDurableObjectState = {
    storage: { sql },
    waitUntil(work) {
      void work;
    },
  };
  const options = {
    createGateway: () => gateway(),
    schedule: (_state: FlaryDurableObjectState, work: Promise<void>) => {
      void work;
    },
  };
  const request = (method: string, body: Record<string, unknown>) =>
    new Request(`https://flary.internal/rpc/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const call = async (method: string, body: Record<string, unknown>) =>
    handleFlaryDurableRunObjectRequest({
      state,
      env: {},
      request: request(method, body),
      options,
    });

  const created = await call("create", {
    context: tenantOne,
    request: {
      requestId: "request_host",
      channelId: "support",
      execution: "agent",
      input: "hello",
      requestedAt: new Date().toISOString(),
    },
  });
  assert.equal(created.status, 200);
  const handle = (await created.json()) as { runId: string };

  // Recreate the service boundary. The SQLite record remains the authority.
  const restarted = await call("get", { context: tenantOne, runId: handle.runId });
  assert.equal(restarted.status, 200);
  assert.equal((await restarted.json() as { runId: string }).runId, handle.runId);

  const otherTenant = await call("get", {
    context: { ...tenantOne, tenantId: "tenant_2" },
    runId: handle.runId,
  });
  assert.equal(otherTenant.status, 404);
  assert.equal((await otherTenant.json() as { error: { code: string } }).error.code, "run_not_found");
});

test("Worker-side durable run service calls the Runtime Durable Object", async () => {
  const sql = sqlStore();
  const state: FlaryDurableObjectState = {
    storage: { sql },
    waitUntil() {
      // The fake host does not need to run projection work for this RPC test.
    },
  };
  const namespace: FlaryDurableObjectNamespace = {
    idFromName: (name) => ({ toString: () => name }),
    get: () => ({
      fetch: (request) =>
        handleFlaryDurableRunObjectRequest({
          state,
          env: {},
          request,
          options: { createGateway: () => gateway() },
        }),
    }),
  };
  const service = createFlaryDurableRunService({ namespace });
  const handle = await service.create(tenantOne, {
    requestId: "request_proxy",
    channelId: "support",
    execution: "agent",
    input: "hello",
    requestedAt: new Date().toISOString(),
  });
  assert.equal((await service.get(tenantOne, handle.runId)).runId, handle.runId);
});

test("Runtime Durable Object approval hooks use the owning agent route", async () => {
  const token = "i".repeat(32);
  let receivedDecision: ApprovalDecision | undefined;
  const namespace: FlaryDurableObjectNamespace = {
    idFromName: (name) => ({ toString: () => name }),
    get: () => ({
      async fetch(request) {
        assert.equal(request.headers.get("authorization"), `Bearer ${token}`);
        const url = new URL(request.url);
        if (url.searchParams.get("flary") === "approvals") {
          return new Response(JSON.stringify({ approvals: [{
            id: "codemode_exec_1_0",
            runId: "agent-instance",
            action: "tool-call",
            reason: "Approval is required",
            requestedBy: { id: "flary", kind: "agent", version: "1" },
            requestedAt: new Date().toISOString(),
          }] }), { headers: { "content-type": "application/json" } });
        }
        if (url.searchParams.get("flary") === "wake") {
          assert.equal(request.method, "GET");
          return new Response(JSON.stringify({ ok: true }), {
            headers: { "content-type": "application/json" },
          });
        }
        receivedDecision = await request.json() as ApprovalDecision;
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        });
      },
    }),
  };
  const env = {
    FLARY_INTERNAL_TOKEN: token,
    FLUE_SUPPORT_AGENT: namespace,
  };
  const factory = createFlaryCodemodeApprovalHooks(env);
  const hooks = factory!(env);
  const record = {
    runId: "run_1",
    agentName: "support",
    instanceId: "agent-instance",
  } as unknown as FlaryRunRecord;
  const approvals = await hooks!.listApprovals!(record);
  assert.equal(approvals[0]?.runId, "run_1");
  await hooks!.decideApproval!(record, {
    requestId: "codemode_exec_1_0",
    status: "approved",
    decidedBy: { id: "operator", kind: "user", version: "1" },
    decidedAt: new Date().toISOString(),
  });
  assert.equal(receivedDecision?.status, "approved");
});

test("Cloudflare Flue gateway preserves the pinned direct model payload", async () => {
  const token = "t".repeat(32);
  let received: Record<string, unknown> | undefined;
  const namespace: FlaryDurableObjectNamespace = {
    idFromName: (name) => ({ toString: () => name }),
    get: () => ({
      async fetch(request) {
        received = await request.json() as Record<string, unknown>;
        return Response.json({
          streamUrl: "https://example.com/stream",
          offset: "0",
          submissionId: "submission_pinned",
        });
      },
    }),
  };
  const gateway = createCloudflareFlueGateway({
    FLUE_SUPPORT_AGENT: namespace,
  }, { token });
  const admission = await gateway.send("support", "thread_1", "continue", {
    idempotencyKey: "admission_1",
    model: "anthropic/claude-sonnet",
    thinkingLevel: "high",
    cacheRetention: "none",
  });
  assert.equal(admission.submissionId, "submission_pinned");
  assert.deepEqual(received, {
    message: "continue",
    idempotencyKey: "admission_1",
    model: "anthropic/claude-sonnet",
    thinkingLevel: "high",
    cacheRetention: "none",
  });
});

test("Cloudflare Flue gateway sends authenticated canonical deletion", async () => {
  const token = "d".repeat(32);
  let requestSeen: Request | undefined;
  const namespace: FlaryDurableObjectNamespace = {
    idFromName: (name) => ({ toString: () => name }),
    get: () => ({
      async fetch(request) {
        requestSeen = request;
        return Response.json({ ok: true });
      },
    }),
  };
  const gateway = createCloudflareFlueGateway({
    FLUE_SUPPORT_AGENT: namespace,
  }, { token });

  await gateway.delete!("support", "thread_1");

  assert.equal(requestSeen?.method, "POST");
  assert.equal(new URL(requestSeen!.url).searchParams.get("flary"), "delete");
  assert.equal(requestSeen?.headers.get("authorization"), `Bearer ${token}`);
});

test("Cloudflare Flue gateway accepts the terminal destroy exception", async () => {
  const namespace: FlaryDurableObjectNamespace = {
    idFromName: (name) => ({ toString: () => name }),
    get: () => ({
      async fetch() {
        throw { message: "destroyed" };
      },
    }),
  };
  const gateway = createCloudflareFlueGateway({
    FLUE_SUPPORT_AGENT: namespace,
  });

  await gateway.delete!("support", "thread_1");
});

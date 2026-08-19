import assert from "node:assert/strict";
import test from "node:test";

import {
  flary,
  defineFlaryInteractiveAgent,
} from "../../src/harness/functions/index.ts";
import type {
  FlaryThreadHostService,
  FlaryThreadScope,
  FlaryThreadTarget,
} from "../../src/harness/host/types.ts";
import type {
  ThreadBinding,
  ThreadCreateRequest,
  ThreadMessageRequest,
} from "../../src/harness/contracts/index.ts";

function binding(): ThreadBinding {
  return {
    thread: {
      organizationId: "tenant",
      appId: "coder",
      agentId: "coder",
      threadId: "thread_1",
    },
    workspace: {
      organizationId: "tenant",
      appId: "coder",
      projectId: "project",
      workspaceId: "workspace",
      branch: "main",
    },
    agentId: "coder",
    defaultMode: "build",
    defaultThinkingLevel: "high",
    connectionIds: [],
    createdBy: { id: "user", kind: "user" },
    status: "active",
    createdAt: "2026-07-30T12:00:00.000Z",
    updatedAt: "2026-07-30T12:00:00.000Z",
  };
}

test("app.agent compiles to Flue and serves durable thread controls", async () => {
  const messages: ThreadMessageRequest[] = [];
  const service: FlaryThreadHostService = {
    async list(_scope: FlaryThreadScope) {
      return [binding()];
    },
    async create(_scope: FlaryThreadScope, _input: ThreadCreateRequest) {
      return binding();
    },
    async inspect(_target: FlaryThreadTarget) {
      return binding();
    },
    async archive() {
      return { ...binding(), status: "archived" };
    },
    async fork() {
      return binding();
    },
    async setMode() {
      return binding();
    },
    async setConnections() {
      return binding();
    },
    async submit(_target, input) {
      messages.push(input);
      return {
        streamUrl: "/flue",
        offset: "1",
        submissionId: "submission_1",
      };
    },
    async listApprovals() {
      return [];
    },
    async decideApproval() {},
  };
  const app = flary({
    model: "openai/gpt-5",
    defaultIdentity: { tenantId: "tenant", userId: "user" },
    threadService: service,
  });
  const review = app.skill({
    name: "review",
    instructions: "Review the final changes.",
  });
  const coder = app.agent({
    name: "coder",
    instructions: "Work on the repository.",
    thinking: "high",
    mode: "build",
    skills: [review],
    compaction: { mode: "auto", reserveTokens: 8_000 },
    models: {
      allow: ["openai/gpt-5", "anthropic/claude-sonnet"],
      switching: "user",
      fallback: "none",
    },
  });

  assert.equal(coder.kind, "agent");
  assert.match(coder.revision, /^rev_[0-9a-f]{16}$/);
  assert.ok(defineFlaryInteractiveAgent(coder));

  const worker = app.serve({ coder }, { prefix: "/api/flary" });
  const list = await worker.request("http://local/api/flary/agents");
  assert.equal(list.status, 200);
  assert.deepEqual((await list.json()).agents[0].name, "coder");

  const send = await worker.request(
    "http://local/api/flary/apps/coder/threads/thread_1/messages",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "Change course.",
        mode: "steer",
        model: "anthropic/claude-sonnet",
      }),
    },
  );
  assert.equal(send.status, 202);
  assert.equal(messages[0]?.mode, "steer");
  assert.equal((messages[0] as { model?: string }).model, "anthropic/claude-sonnet");
});

test("durable subagents use their own provider and the root runtime binding", async () => {
  const actions: Array<{ action: string; input: Record<string, unknown> }> = [];
  const service: FlaryThreadHostService = {
    async list() { return [binding()]; },
    async create() { return binding(); },
    async inspect(target) {
      return {
        ...binding(),
        thread: {
          ...binding().thread,
          threadId: target.threadId,
          agentId: target.threadId === "thread_child" ? "reviewer" : "coder",
        },
        agentId: target.threadId === "thread_child" ? "reviewer" : "coder",
        metadata: target.threadId === "thread_child"
          ? { flarySubagentRootThreadId: "thread_1", flaryRuntimeAgentId: "coder" }
          : { flaryRuntimeAgentId: "coder" },
      };
    },
    async archive() { return binding(); },
    async fork() { return binding(); },
    async setMode() { return binding(); },
    async setConnections() { return binding(); },
    async submit() {
      return { streamUrl: "https://local/stream", offset: "1", submissionId: "submission" };
    },
    async subagentAction(_target, action, input) {
      actions.push({ action, input: { ...input } });
      return { accepted: true };
    },
    async listApprovals() { return []; },
    async decideApproval() {},
  };
  const app = flary({
    model: "anthropic/claude-sonnet",
    defaultIdentity: { tenantId: "tenant", userId: "user" },
    threadService: service,
  });
  const reviewer = app.agent({
    name: "reviewer",
    model: "openai/gpt-5.6-sol",
    models: { allow: ["openai/gpt-5.6-sol"] },
    instructions: "Review the change.",
  });
  const coder = app.agent({
    name: "coder",
    model: "anthropic/claude-sonnet",
    models: { allow: ["anthropic/claude-sonnet"] },
    subagents: { reviewer },
    delegation: { mode: "auto", allowPeerMessaging: true },
  });
  const runtime = defineFlaryInteractiveAgent(coder) as unknown as {
    initialize(input: { env: object; id: string }): Promise<{
      model: string;
      tools: Array<{ name: string; run(input: { input: any }): Promise<unknown> }>;
    }>;
  };

  const parent = await runtime.initialize({
    env: {},
    id: "tenant:coder:coder:thread_1",
  });
  assert.equal(parent.model, "anthropic/claude-sonnet");
  const spawn = parent.tools.find((tool) => tool.name === "spawn_agent");
  assert.ok(spawn);
  await spawn.run({ input: { agent: "reviewer", task: "Review it." } });
  assert.equal(actions[0]?.action, "spawn");
  assert.deepEqual(actions[0]?.input.model, {
    provider: "openai",
    model: "gpt-5.6-sol",
  });
  assert.equal(
    (actions[0]?.input.metadata as Record<string, unknown>).flaryRuntimeAgentId,
    "coder",
  );

  const child = await runtime.initialize({
    env: {},
    id: "tenant:coder:reviewer:thread_child",
  });
  assert.equal(child.model, "openai/gpt-5.6-sol");

  const worker = app.serve({ coder }, { prefix: "/api/flary" });
  const response = await worker.request(
    "http://local/api/flary/apps/coder/threads/thread_1/subagents/spawn",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "reviewer", task: "Review through the API." }),
    },
  );
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(actions[1]?.input.agentId, "reviewer");
  assert.deepEqual(actions[1]?.input.model, {
    provider: "openai",
    model: "gpt-5.6-sol",
  });
});

test("interactive agents prepare trusted thread providers before model resolution", async () => {
  const prepared: string[] = [];
  const app = flary({
    model: "runtime-alias/model",
    prepareThreadRuntime({ runId }) {
      prepared.push(runId);
    },
  });
  const agent = app.agent({
    name: "coder",
    instructions: "Use the prepared provider.",
  });
  const runtime = defineFlaryInteractiveAgent(agent) as unknown as {
    initialize(input: { env: object; id: string }): Promise<{ model: string }>;
  };

  const result = await runtime.initialize({ env: {}, id: "tenant:app:coder:thread_1" });
  assert.deepEqual(prepared, ["tenant:app:coder:thread_1"]);
  assert.equal(result.model, "runtime-alias/model");
});

test("durable agent tools restore admitted roles and scopes", async () => {
  let stored = binding();
  let observedIdentity: unknown;
  const service: FlaryThreadHostService = {
    async list() { return [stored]; },
    async create(_scope, input) {
      stored = { ...binding(), metadata: input.metadata };
      return stored;
    },
    async inspect() { return stored; },
    async archive() { return stored; },
    async fork() { return stored; },
    async setMode() { return stored; },
    async setConnections() { return stored; },
    async submit() {
      return { streamUrl: "https://local/stream", offset: "1", submissionId: "submission" };
    },
    async listApprovals() { return []; },
    async decideApproval() {},
  };
  const app = flary({
    defaultIdentity: {
      tenantId: "tenant",
      userId: "user",
      roles: ["admin"],
      scopes: ["analytics.read"],
    },
    threadService: service,
    code: {
      async execute(input) {
        observedIdentity = input.context.identity;
        return null;
      },
    },
  });
  const probe = app.fn({
    name: "probe",
    run: async () => ({ ok: true }),
  });
  const coder = app.agent({ name: "coder", tools: app.tools({ probe }) });
  const worker = app.serve({ coder }, { prefix: "/api/flary" });
  const created = await worker.request("http://local/api/flary/apps/coder/threads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      threadId: "thread_1",
      workspace: binding().workspace,
    }),
  });
  assert.equal(created.status, 201, await created.clone().text());
  assert.deepEqual(stored.metadata?.flaryAdmittedRoles, ["admin"]);
  assert.deepEqual(stored.metadata?.flaryAdmittedScopes, ["analytics.read"]);

  await app.executeAgentCode(coder, {
    code: "return null",
    runId: "tenant:coder:coder:thread_1",
    bindings: undefined,
  });
  assert.deepEqual(observedIdentity, {
    tenantId: "tenant",
    userId: "user",
    roles: ["admin"],
    scopes: ["analytics.read"],
    applicationId: "coder",
    projectId: "project",
    workspaceId: "workspace",
    branch: "main",
  });
});

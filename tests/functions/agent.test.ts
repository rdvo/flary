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

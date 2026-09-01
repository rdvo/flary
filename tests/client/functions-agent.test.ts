import assert from "node:assert/strict";
import test from "node:test";

import { flary as createApp } from "../../src/harness/functions/index.ts";
import { flary as createClient } from "../../src/harness/client/functions.ts";

test("the typed function client exposes persistent agent thread handles", async () => {
  const app = createApp();
  const coder = app.agent({ name: "coder", instructions: "Code." });
  const functions = { coder };
  const requests: Array<{ path: string; method: string; body?: unknown }> = [];
  const binding = {
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
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const body = await request.json().catch(() => undefined);
    requests.push({
      path: new URL(request.url).pathname,
      method: request.method,
      ...(body === undefined ? {} : { body }),
    });
    if (request.url.endsWith("/messages")) {
      return Response.json({
        streamUrl: "https://flue.invalid/stream",
        offset: "1",
        submissionId: "submission_1",
      });
    }
    if (request.url.endsWith("/audit")) {
      return Response.json({ records: [] });
    }
    if (request.url.endsWith("/model/history")) {
      return Response.json({ history: [] });
    }
    if (request.url.endsWith("/models")) {
      return Response.json({
        models: [{ provider: "openai", model: "gpt-5" }],
      });
    }
    if (request.url.endsWith("/model")) {
      return Response.json({ model: { provider: "openai", model: "gpt-5" } });
    }
    return Response.json({ binding }, { status: 201 });
  };
  const api = createClient<typeof functions>({
    baseUrl: "https://example.com/api/flary",
    fetch: fetcher,
  });

  const thread = await api.coder.threads.create({
    workspace: binding.workspace,
    mode: "build",
    thinkingLevel: "high",
  });
  await thread.send({ message: "Implement it.", mode: "steer" });
  await thread.model.set("openai/gpt-5");
  await thread.model.get();
  await thread.model.list();
  await thread.model.history();
  await thread.audit.list();

  assert.deepEqual(
    requests.map(({ path }) => path),
    [
      "/api/flary/apps/coder/threads",
      "/api/flary/apps/coder/threads/thread_1/messages",
      "/api/flary/apps/coder/threads/thread_1/model",
      "/api/flary/apps/coder/threads/thread_1/model",
      "/api/flary/apps/coder/threads/thread_1/models",
      "/api/flary/apps/coder/threads/thread_1/model/history",
      "/api/flary/apps/coder/threads/thread_1/audit",
    ]
  );
  assert.ok(requests[1]);
  assert.equal((requests[1].body as { mode?: string }).mode, "steer");
});

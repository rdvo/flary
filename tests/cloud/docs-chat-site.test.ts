import assert from "node:assert/strict";
import test from "node:test";

import site from "../../apps/cloud/worker/site.ts";

type SessionPayload = {
  messages: unknown[];
  settlements: unknown[];
  session: { id: string; reference: string };
};

function testEnvironment() {
  type TestThread = {
    binding: {
      thread: Record<string, unknown>;
      workspace: Record<string, unknown>;
      agentId: string;
      persona?: string;
      defaultMode: string;
      defaultModel?: unknown;
      defaultThinkingLevel: string;
      connectionIds: string[];
      createdBy: { id: string; kind: "user"; version: "1" };
      status: string;
      createdAt: string;
      updatedAt: string;
      metadata: Record<string, unknown>;
    };
    messages: unknown[];
    settlements: unknown[];
    offset: string;
  };
  const threads = new Map<string, TestThread>();
  const calls: Array<{ method: string; path: string; tenant?: string }> = [];
  const createInputs: Array<Record<string, unknown>> = [];
  const agent = {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const tenant = request.headers.get("x-flary-docs-tenant") ?? undefined;
      calls.push({ method: request.method, path: url.pathname, tenant });
      const segments = url.pathname.split("/");
      const lastSegment = segments.at(-1);
      const requestedThreadId = ["conversation", "messages", "rename"].includes(lastSegment ?? "")
        ? segments.at(-2)
        : lastSegment;
      const key = `${tenant}:${requestedThreadId}`;
      if (request.method === "GET" && url.pathname === "/apps/docs/threads") {
        return Response.json({
          threads: [...threads.entries()]
            .filter(([storedKey]) => storedKey.startsWith(`${tenant}:`))
            .map(([, stored]) => ({
              thread: stored.binding.thread,
              updatedAt: stored.binding.updatedAt,
              metadata: stored.binding.metadata,
            })),
        });
      }
      if (request.method === "GET" && /^\/apps\/docs\/threads\/chat_[^/]+$/.test(url.pathname)) {
        const stored = threads.get(key);
        return stored
          ? Response.json({ binding: stored.binding })
          : Response.json({ error: { message: "Thread was not found" } }, { status: 404 });
      }
      if (request.method === "POST" && url.pathname === "/apps/docs/threads") {
        const input = (await request.json()) as Record<string, unknown> & {
          threadId: string;
          agentId: string;
          workspace: Record<string, unknown> & { organizationId: string };
          metadata: Record<string, unknown>;
        };
        createInputs.push(input);
        const storedKey = `${input.workspace.organizationId}:${input.threadId}`;
        const prior = threads.get(storedKey);
        const now = new Date().toISOString();
        const binding: TestThread["binding"] = {
          thread: {
            organizationId: input.workspace.organizationId,
            appId: input.workspace.appId,
            agentId: input.agentId,
            threadId: input.threadId,
          },
          workspace: input.workspace,
          agentId: input.agentId,
          ...(typeof input.persona === "string" ? { persona: input.persona } : {}),
          defaultMode: typeof input.mode === "string" ? input.mode : "ask",
          ...(input.model !== undefined ? { defaultModel: input.model } : {}),
          defaultThinkingLevel:
            typeof input.thinkingLevel === "string" ? input.thinkingLevel : "medium",
          connectionIds: Array.isArray(input.connectionIds)
            ? (input.connectionIds as string[])
            : [],
          createdBy: { id: "docs-chat", kind: "user", version: "1" },
          status: "active",
          createdAt: now,
          updatedAt: now,
          metadata: {
            ...input.metadata,
            flaryAgentRevision: "current-docs-revision",
            flaryLimits: { timeoutMs: 90_000 },
          },
        };
        threads.set(storedKey, {
          binding,
          messages: prior?.messages ?? [],
          settlements: prior?.settlements ?? [],
          offset: prior?.offset ?? "0_0",
        });
        return Response.json({ binding }, { status: 201 });
      }
      if (request.method === "POST" && url.pathname.endsWith("/rename")) {
        const current = threads.get(key);
        const input = (await request.json()) as { title: string };
        if (!current)
          return Response.json({ error: { message: "Thread was not found" } }, { status: 404 });
        current.binding.metadata.title = input.title;
        current.binding.updatedAt = new Date().toISOString();
        return Response.json({ ok: true });
      }
      if (request.method === "GET" && url.pathname.endsWith("/conversation")) {
        const stored = threads.get(key);
        return Response.json({
          conversation: {
            messages: stored?.messages ?? [],
            settlements: stored?.settlements ?? [],
            offset: stored?.offset ?? "0_0",
          },
        });
      }
      if (request.method === "POST" && url.pathname.endsWith("/messages")) {
        threads.get(key)?.messages.push({
          id: "user-message",
          role: "user",
          parts: [{ type: "text", text: "new message" }],
        });
        return Response.json({ submissionId: "submission-1", offset: "0_0" }, { status: 202 });
      }
      if (request.method === "DELETE" && url.pathname.startsWith("/apps/docs/threads/chat_")) {
        threads.delete(key);
        return Response.json({ ok: true });
      }
      return Response.json({ error: { message: "Unexpected test route" } }, { status: 500 });
    },
  };
  const env = {
    APP_ENV: "production",
    FLARY_DOCS_AGENT_TOKEN: "test-docs-agent-token-that-is-long-enough",
    FLARY_DOCS_AGENT: agent,
    DOCS_CHAT_RATE_LIMITER: {
      async limit() {
        return { success: true };
      },
    },
  };
  return { env, calls, threads, createInputs };
}

function browserCookie(response: Response): string {
  const setCookie = response.headers.get("set-cookie");
  assert.ok(setCookie, "the response must create a browser owner cookie");
  return setCookie.split(";", 1)[0]!;
}

test("docs chat creates, restores, and deletes browser-owned sessions", async () => {
  const { env, calls } = testEnvironment();
  const created = await site.request(
    "https://docs.flary.dev/api/docs-chat/session",
    {
      method: "POST",
    },
    env,
  );
  assert.equal(created.status, 200);
  const cookie = browserCookie(created);
  const first = (await created.json()) as SessionPayload;
  assert.match(first.session.id, /^[a-f0-9]{36}$/);
  assert.match(first.session.reference, /^v1\.[a-f0-9]{36}\.[A-Za-z0-9_-]+$/);

  const restored = await site.request(
    "https://docs.flary.dev/api/docs-chat/session",
    {
      method: "POST",
      headers: {
        cookie,
        "x-flary-docs-session-ref": first.session.reference,
      },
    },
    env,
  );
  assert.equal(restored.status, 200);
  assert.deepEqual(((await restored.json()) as SessionPayload).session, first.session);

  const next = await site.request(
    "https://docs.flary.dev/api/docs-chat/session",
    {
      method: "POST",
      headers: {
        cookie,
        "x-flary-docs-new-session": "1",
      },
    },
    env,
  );
  assert.equal(next.status, 200);
  const second = (await next.json()) as SessionPayload;
  assert.notEqual(second.session.id, first.session.id);

  const deleted = await site.request(
    "https://docs.flary.dev/api/docs-chat/session",
    {
      method: "DELETE",
      headers: {
        cookie,
        "x-flary-docs-session-ref": second.session.reference,
      },
    },
    env,
  );
  assert.equal(deleted.status, 200);
  assert.equal(calls.at(-1)?.method, "DELETE");
});

test("docs chat refreshes only the exhausted browser widget policy without losing history", async () => {
  const { env, threads, createInputs } = testEnvironment();
  const created = await site.request(
    "https://docs.flary.dev/api/docs-chat/session",
    { method: "POST" },
    env,
  );
  const cookie = browserCookie(created);
  const first = (await created.json()) as SessionPayload;
  const expectedThreadId = `chat_${first.session.id}`;
  const entry = [...threads.entries()].find(([key]) => key.endsWith(`:${expectedThreadId}`));
  assert.ok(entry, "the browser session must have a stored thread");
  const [storedKey, stored] = entry;
  stored.binding.createdAt = "2024-01-02T03:04:05.000Z";
  stored.binding.metadata = {
    ...stored.binding.metadata,
    title: "Saved docs conversation",
    channel: "docs-widget",
    anonymousBrowser: true,
    flaryLimits: { steps: 8, toolCalls: 12, timeoutMs: 90_000 },
  };
  const original = structuredClone(stored.binding);
  stored.messages = [
    { id: "saved-user", role: "user", parts: [{ type: "text", text: "Old question" }] },
    { id: "saved-assistant", role: "assistant", parts: [{ type: "text", text: "Old answer" }] },
  ];

  const restored = await site.request(
    "https://docs.flary.dev/api/docs-chat/session",
    {
      method: "POST",
      headers: {
        cookie,
        "x-flary-docs-session-ref": first.session.reference,
      },
    },
    env,
  );
  assert.equal(restored.status, 200);
  const resumed = (await restored.json()) as SessionPayload;
  assert.equal(resumed.session.id, first.session.id);
  assert.ok(
    resumed.messages.some((message) => (message as { text?: string }).text === "Old answer"),
  );
  assert.equal(createInputs.length, 2, "one initial create plus one policy refresh");
  assert.equal(createInputs[1]?.threadId, expectedThreadId);
  assert.deepEqual(createInputs[1]?.workspace, original.workspace);
  assert.deepEqual(createInputs[1]?.model, original.defaultModel);
  assert.equal(createInputs[1]?.mode, original.defaultMode);

  const migrated = threads.get(storedKey)!;
  assert.deepEqual(migrated.binding.workspace, original.workspace);
  assert.equal(migrated.binding.thread.threadId, expectedThreadId);
  assert.equal(migrated.binding.metadata.title, "Saved docs conversation");
  assert.equal(migrated.binding.metadata.channel, "docs-widget");
  assert.equal(migrated.binding.metadata.anonymousBrowser, true);
  assert.equal(migrated.binding.metadata.flaryDocsChatPolicyMigration, "server-limits-v1");
  assert.deepEqual(migrated.binding.metadata.flaryLimits, { timeoutMs: 90_000 });
  assert.equal(migrated.messages.length, 2);
  assert.notEqual(migrated.binding.createdAt, original.createdAt);

  const listed = await site.request(
    "https://docs.flary.dev/api/docs-chat/sessions",
    { headers: { cookie } },
    env,
  );
  const listPayload = (await listed.json()) as {
    sessions: Array<{ id: string; title?: string }>;
  };
  assert.equal(
    listPayload.sessions.find((session) => session.id === first.session.id)?.title,
    "Saved docs conversation",
  );

  const idempotentRestore = await site.request(
    "https://docs.flary.dev/api/docs-chat/session",
    {
      method: "POST",
      headers: {
        cookie,
        "x-flary-docs-session-ref": first.session.reference,
      },
    },
    env,
  );
  assert.equal(idempotentRestore.status, 200);
  assert.equal(createInputs.length, 2, "the migrated thread is not recreated again");
});

test("docs chat leaves unrelated policies and non-widget threads unchanged", async () => {
  for (const mismatch of ["limits", "channel", "anonymous-browser"] as const) {
    const { env, threads, createInputs } = testEnvironment();
    const created = await site.request(
      "https://docs.flary.dev/api/docs-chat/session",
      { method: "POST" },
      env,
    );
    const cookie = browserCookie(created);
    const first = (await created.json()) as SessionPayload;
    const expectedThreadId = `chat_${first.session.id}`;
    const entry = [...threads.entries()].find(([key]) => key.endsWith(`:${expectedThreadId}`));
    assert.ok(entry, "the browser session must have a stored thread");
    const stored = entry[1];
    stored.binding.metadata = {
      ...stored.binding.metadata,
      flaryLimits: { steps: 8, toolCalls: 12, timeoutMs: 90_000 },
    };
    if (mismatch === "limits") {
      stored.binding.metadata.flaryLimits = { steps: 8, toolCalls: 11, timeoutMs: 90_000 };
    } else if (mismatch === "channel") {
      stored.binding.metadata.channel = "docs-api";
    } else {
      stored.binding.metadata.anonymousBrowser = false;
    }

    const restored = await site.request(
      "https://docs.flary.dev/api/docs-chat/session",
      {
        method: "POST",
        headers: {
          cookie,
          "x-flary-docs-session-ref": first.session.reference,
        },
      },
      env,
    );
    assert.equal(restored.status, 200, mismatch);
    assert.equal(createInputs.length, 1, `must not migrate ${mismatch}`);
  }
});

test("docs chat admits a first message from an already-open page without a session", async () => {
  const { env, calls } = testEnvironment();
  const admitted = await site.request(
    "https://flary.dev/api/docs-chat/messages",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "What is the latest version?" }),
    },
    env,
  );
  assert.equal(admitted.status, 202);
  const cookie = browserCookie(admitted);
  const first = (await admitted.json()) as SessionPayload & { submissionId: string };
  assert.equal(first.submissionId, "submission-1");
  assert.match(first.session.reference, /^v1\./);
  assert.equal(calls.at(-1)?.path, `/apps/docs/threads/chat_${first.session.id}/messages`);

  const history = await site.request(
    "https://flary.dev/api/docs-chat/history",
    { headers: { cookie, "x-flary-docs-session-ref": first.session.reference } },
    env,
  );
  assert.equal(history.status, 200);
  assert.equal(calls.at(-1)?.path, `/apps/docs/threads/chat_${first.session.id}/conversation`);

  const invalid = await site.request(
    "https://flary.dev/api/docs-chat/messages",
    {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        "x-flary-docs-session-ref": "invalid",
      },
      body: JSON.stringify({ message: "What is the latest version?" }),
    },
    env,
  );
  assert.equal(invalid.status, 401);
  assert.equal(
    ((await invalid.json()) as { error: { type: string } }).error.type,
    "chat_session_invalid",
  );
});

test("docs chat lists and renames every durable session owned by the browser", async () => {
  const { env } = testEnvironment();
  const firstResponse = await site.request(
    "https://docs.flary.dev/api/docs-chat/session",
    {
      method: "POST",
    },
    env,
  );
  const cookie = browserCookie(firstResponse);
  const first = (await firstResponse.json()) as SessionPayload;
  const secondResponse = await site.request(
    "https://docs.flary.dev/api/docs-chat/session",
    {
      method: "POST",
      headers: { cookie, "x-flary-docs-new-session": "1" },
    },
    env,
  );
  const second = (await secondResponse.json()) as SessionPayload;

  const renamed = await site.request(
    "https://docs.flary.dev/api/docs-chat/session/title",
    {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        "x-flary-docs-session-ref": second.session.reference,
      },
      body: JSON.stringify({ title: "Workspace tools" }),
    },
    env,
  );
  assert.equal(renamed.status, 200);

  const listed = await site.request(
    "https://docs.flary.dev/api/docs-chat/sessions",
    {
      headers: { cookie },
    },
    env,
  );
  assert.equal(listed.status, 200);
  const payload = (await listed.json()) as {
    sessions: Array<{ id: string; reference: string; title?: string }>;
  };
  assert.deepEqual(
    new Set(payload.sessions.map((session) => session.id)),
    new Set([first.session.id, second.session.id]),
  );
  assert.equal(
    payload.sessions.find((session) => session.id === second.session.id)?.title,
    "Workspace tools",
  );
  assert.ok(payload.sessions.every((session) => session.reference.startsWith("v1.")));

  const deleted = await site.request(
    "https://docs.flary.dev/api/docs-chat/session",
    {
      method: "DELETE",
      headers: { cookie, "x-flary-docs-session-ref": second.session.reference },
    },
    env,
  );
  assert.equal(deleted.status, 200);
  const afterDelete = await site.request(
    "https://docs.flary.dev/api/docs-chat/sessions",
    {
      headers: { cookie },
    },
    env,
  );
  const remaining = (await afterDelete.json()) as {
    sessions: Array<{ id: string }>;
  };
  assert.deepEqual(
    remaining.sessions.map((session) => session.id),
    [first.session.id],
  );
});

test("docs chat rejects a session reference from another browser", async () => {
  const { env } = testEnvironment();
  const owner = await site.request(
    "https://docs.flary.dev/api/docs-chat/session",
    {
      method: "POST",
    },
    env,
  );
  const ownerSession = (await owner.json()) as SessionPayload;

  const other = await site.request(
    "https://docs.flary.dev/api/docs-chat/session",
    {
      method: "POST",
    },
    env,
  );
  const response = await site.request(
    "https://docs.flary.dev/api/docs-chat/history",
    {
      headers: {
        cookie: browserCookie(other),
        "x-flary-docs-session-ref": ownerSession.session.reference,
      },
    },
    env,
  );

  assert.equal(response.status, 401);
  assert.equal(
    ((await response.json()) as { error: { type: string } }).error.type,
    "chat_session_invalid",
  );
});

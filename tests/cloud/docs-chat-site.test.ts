import assert from "node:assert/strict";
import test from "node:test";

import site from "../../apps/cloud/worker/site.ts";

type SessionPayload = {
  messages: unknown[];
  settlements: unknown[];
  session: { id: string; reference: string };
};

function testEnvironment() {
  const threads = new Map<string, { id: string; title?: string; updatedAt: string }>();
  const calls: Array<{ method: string; path: string; tenant?: string }> = [];
  const agent = {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const tenant = request.headers.get("x-flary-docs-tenant") ?? undefined;
      calls.push({ method: request.method, path: url.pathname, tenant });
      const key = `${tenant}:${url.pathname.split("/").at(-1)}`;
      if (request.method === "GET" && url.pathname === "/apps/docs/threads") {
        return Response.json({
          threads: [...threads.entries()]
            .filter(([storedKey]) => storedKey.startsWith(`${tenant}:`))
            .map(([, thread]) => ({
              thread: { threadId: thread.id },
              updatedAt: thread.updatedAt,
              metadata: thread.title ? { title: thread.title } : undefined,
            })),
        });
      }
      if (request.method === "GET" && /^\/apps\/docs\/threads\/chat_/.test(url.pathname)) {
        return threads.has(key)
          ? Response.json({ threadId: url.pathname.split("/").at(-1) })
          : Response.json({ error: { message: "Thread was not found" } }, { status: 404 });
      }
      if (request.method === "POST" && url.pathname === "/apps/docs/threads") {
        const input = await request.json() as { threadId: string; workspace: { organizationId: string } };
        threads.set(`${input.workspace.organizationId}:${input.threadId}`, {
          id: input.threadId,
          updatedAt: new Date().toISOString(),
        });
        return Response.json({ threadId: input.threadId }, { status: 201 });
      }
      if (request.method === "POST" && /\/rename$/.test(url.pathname)) {
        const id = url.pathname.split("/").at(-2)!;
        const storedKey = `${tenant}:${id}`;
        const current = threads.get(storedKey);
        const input = await request.json() as { title: string };
        if (!current) return Response.json({ error: { message: "Thread was not found" } }, { status: 404 });
        threads.set(storedKey, { ...current, title: input.title, updatedAt: new Date().toISOString() });
        return Response.json({ ok: true });
      }
      if (request.method === "GET" && /\/conversation$/.test(url.pathname)) {
        return Response.json({
          conversation: { messages: [], settlements: [], offset: "0_0" },
        });
      }
      if (request.method === "DELETE" && /^\/apps\/docs\/threads\/chat_/.test(url.pathname)) {
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
  };
  return { env, calls };
}

function browserCookie(response: Response): string {
  const setCookie = response.headers.get("set-cookie");
  assert.ok(setCookie, "the response must create a browser owner cookie");
  return setCookie.split(";", 1)[0]!;
}

test("docs chat creates, restores, and deletes browser-owned sessions", async () => {
  const { env, calls } = testEnvironment();
  const created = await site.request("https://docs.flary.dev/api/docs-chat/session", {
    method: "POST",
  }, env);
  assert.equal(created.status, 200);
  const cookie = browserCookie(created);
  const first = await created.json() as SessionPayload;
  assert.match(first.session.id, /^[a-f0-9]{36}$/);
  assert.match(first.session.reference, /^v1\.[a-f0-9]{36}\.[A-Za-z0-9_-]+$/);

  const restored = await site.request("https://docs.flary.dev/api/docs-chat/session", {
    method: "POST",
    headers: {
      cookie,
      "x-flary-docs-session-ref": first.session.reference,
    },
  }, env);
  assert.equal(restored.status, 200);
  assert.deepEqual((await restored.json() as SessionPayload).session, first.session);

  const next = await site.request("https://docs.flary.dev/api/docs-chat/session", {
    method: "POST",
    headers: {
      cookie,
      "x-flary-docs-new-session": "1",
    },
  }, env);
  assert.equal(next.status, 200);
  const second = await next.json() as SessionPayload;
  assert.notEqual(second.session.id, first.session.id);

  const deleted = await site.request("https://docs.flary.dev/api/docs-chat/session", {
    method: "DELETE",
    headers: {
      cookie,
      "x-flary-docs-session-ref": second.session.reference,
    },
  }, env);
  assert.equal(deleted.status, 200);
  assert.equal(calls.at(-1)?.method, "DELETE");
});

test("docs chat lists and renames every durable session owned by the browser", async () => {
  const { env } = testEnvironment();
  const firstResponse = await site.request("https://docs.flary.dev/api/docs-chat/session", {
    method: "POST",
  }, env);
  const cookie = browserCookie(firstResponse);
  const first = await firstResponse.json() as SessionPayload;
  const secondResponse = await site.request("https://docs.flary.dev/api/docs-chat/session", {
    method: "POST",
    headers: { cookie, "x-flary-docs-new-session": "1" },
  }, env);
  const second = await secondResponse.json() as SessionPayload;

  const renamed = await site.request("https://docs.flary.dev/api/docs-chat/session/title", {
    method: "POST",
    headers: {
      cookie,
      "content-type": "application/json",
      "x-flary-docs-session-ref": second.session.reference,
    },
    body: JSON.stringify({ title: "Workspace tools" }),
  }, env);
  assert.equal(renamed.status, 200);

  const listed = await site.request("https://docs.flary.dev/api/docs-chat/sessions", {
    headers: { cookie },
  }, env);
  assert.equal(listed.status, 200);
  const payload = await listed.json() as {
    sessions: Array<{ id: string; reference: string; title?: string }>;
  };
  assert.deepEqual(new Set(payload.sessions.map((session) => session.id)), new Set([
    first.session.id,
    second.session.id,
  ]));
  assert.equal(
    payload.sessions.find((session) => session.id === second.session.id)?.title,
    "Workspace tools",
  );
  assert.ok(payload.sessions.every((session) => session.reference.startsWith("v1.")));

  const deleted = await site.request("https://docs.flary.dev/api/docs-chat/session", {
    method: "DELETE",
    headers: { cookie, "x-flary-docs-session-ref": second.session.reference },
  }, env);
  assert.equal(deleted.status, 200);
  const afterDelete = await site.request("https://docs.flary.dev/api/docs-chat/sessions", {
    headers: { cookie },
  }, env);
  const remaining = await afterDelete.json() as { sessions: Array<{ id: string }> };
  assert.deepEqual(remaining.sessions.map((session) => session.id), [first.session.id]);
});

test("docs chat rejects a session reference from another browser", async () => {
  const { env } = testEnvironment();
  const owner = await site.request("https://docs.flary.dev/api/docs-chat/session", {
    method: "POST",
  }, env);
  const ownerSession = await owner.json() as SessionPayload;

  const other = await site.request("https://docs.flary.dev/api/docs-chat/session", {
    method: "POST",
  }, env);
  const response = await site.request("https://docs.flary.dev/api/docs-chat/history", {
    headers: {
      cookie: browserCookie(other),
      "x-flary-docs-session-ref": ownerSession.session.reference,
    },
  }, env);

  assert.equal(response.status, 401);
  assert.equal((await response.json() as { error: { type: string } }).error.type, "chat_session_invalid");
});

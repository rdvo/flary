import { Hono } from "hono";

type SiteBindings = {
  APP_ENV: string;
  ASSETS?: Fetcher;
  DOCS_CHAT_RATE_LIMITER?: {
    limit(input: { key: string }): Promise<{ success: boolean }>;
  };
  FLARY_DOCS_AGENT?: Fetcher;
  FLARY_DOCS_AGENT_TOKEN?: string;
  FLARY_RUNTIME?: Fetcher;
};

type SiteContext = {
  Bindings: SiteBindings;
};

const app = new Hono<SiteContext>();
const api = new Hono<SiteContext>();
const DOCS_HOSTNAME = "docs.flary.dev";
const DOCS_CHAT_COOKIE = "flary_docs_chat_v5";
const DOCS_CHAT_BROWSER_COOKIE = "flary_docs_browser_v1";
const DOCS_CHAT_AGENT = "docs";
const DOCS_CHAT_ORGANIZATION = "flary-docs";
const DOCS_CHAT_MODEL = {
  provider: "flary-docs-gateway",
  model: "openai/gpt-5.5",
} as const;

type DocsChatSession = {
  id: string;
  reference: string;
  browserId: string;
  tenantId: string;
  cookies: string[];
  fresh?: boolean;
};

type DocsChatBrowser = {
  browserId: string;
  tenantId: string;
  cookies: string[];
};

function resolveAssetRequest(request: Request): Request | Response {
  const url = new URL(request.url);

  if (url.hostname !== DOCS_HOSTNAME) {
    if (
      url.pathname.startsWith("/docs/") &&
      !url.pathname.endsWith("/") &&
      !(url.pathname.split("/").at(-1) ?? "").includes(".")
    ) {
      const target = new URL(url);
      target.pathname += "/";
      return Response.redirect(target, 308);
    }
    return request;
  }

  if (url.pathname === "/docs" || url.pathname.startsWith("/docs/")) {
    const target = new URL(url);
    target.pathname =
      url.pathname === "/docs" || url.pathname === "/docs/"
        ? "/"
        : url.pathname.slice("/docs".length);
    return Response.redirect(target, 308);
  }

  const lastSegment = url.pathname.split("/").at(-1) ?? "";
  const isStaticAsset =
    url.pathname.startsWith("/_astro/") ||
    url.pathname.startsWith("/fonts/") ||
    lastSegment.includes(".");

  if (isStaticAsset) {
    return request;
  }

  if (url.pathname !== "/" && !url.pathname.endsWith("/")) {
    const target = new URL(url);
    target.pathname += "/";
    return Response.redirect(target, 308);
  }

  const target = new URL(url);
  target.pathname =
    url.pathname === "/" ? "/docs/" : `/docs${url.pathname}`;
  return new Request(target, request);
}

app.use("*", async (context, next) => {
  await next();
  context.header("X-Content-Type-Options", "nosniff");
  context.header("Referrer-Policy", "strict-origin-when-cross-origin");
  context.header("X-Frame-Options", "DENY");
  context.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
});

app.get("/health", (context) =>
  context.json({
    ok: true,
    service: "flary-web",
    environment: context.env.APP_ENV,
  }),
);

api.get("/health", (context) =>
  context.json({
    ok: true,
    service: "flary-web",
    runtimeConnected: Boolean(context.env.FLARY_RUNTIME),
    docsAgentConnected: Boolean(context.env.FLARY_DOCS_AGENT),
  }),
);

api.post("/docs-chat/session", async (context) => {
  const session = await docsChatSession(context.req.raw, context.env);
  if (session instanceof Response) return session;
  const upstream = await ensureDocsThread(context.env, session);
  const response = upstream.ok
    ? await docsChatHistory(context.env, session)
    : safeUpstreamResponse(upstream);
  return withDocsSession(response, session);
});

api.get("/docs-chat/sessions", async (context) => {
  const browser = await docsChatBrowser(context.req.raw, context.env);
  if (browser instanceof Response) return browser;
  const upstream = await fetchDocsAgent(
    context.env,
    {
      id: browser.browserId,
      reference: "",
      ...browser,
    },
    `/apps/${DOCS_CHAT_AGENT}/threads`,
  );
  if (!upstream.ok) return withDocsCookies(safeUpstreamResponse(upstream), browser.cookies);
  const payload = await upstream.json().catch(() => ({})) as {
    threads?: Array<{
      thread?: { threadId?: unknown };
      updatedAt?: unknown;
      metadata?: { title?: unknown };
    }>;
  };
  const sessions = await Promise.all((payload.threads ?? []).flatMap((binding) => {
    const value = typeof binding.thread?.threadId === "string"
      ? /^chat_([a-f0-9]{36})$/.exec(binding.thread.threadId)
      : null;
    if (!value) return [];
    const id = value[1]!;
    return [createSessionReference(id, browser.browserId, context.env.FLARY_DOCS_AGENT_TOKEN!).then(
      (reference) => ({
        id,
        reference,
        ...(typeof binding.metadata?.title === "string"
          ? { title: binding.metadata.title }
          : {}),
        updatedAt: typeof binding.updatedAt === "string"
          ? binding.updatedAt
          : new Date(0).toISOString(),
      }),
    )];
  }));
  return withDocsCookies(context.json({ sessions }), browser.cookies);
});

api.get("/docs-chat/history", async (context) => {
  const session = await docsChatSession(context.req.raw, context.env, false);
  if (session instanceof Response) return session;
  return docsChatHistory(context.env, session);
});

api.delete("/docs-chat/session", async (context) => {
  const session = await docsChatSession(context.req.raw, context.env, false);
  if (session instanceof Response) return session;
  const upstream = await fetchDocsAgent(
    context.env,
    session,
    `/apps/${DOCS_CHAT_AGENT}/threads/${encodeURIComponent(threadId(session.id))}`,
    { method: "DELETE" },
  );
  if (upstream.status === 404) return context.json({ ok: true });
  if (!upstream.ok) return safeUpstreamResponse(upstream);
  const value = await upstream.json().catch(() => ({ ok: true }));
  // The docs endpoint keeps its historical 200 response. The upstream
  // thread API has already accepted the asynchronous purge.
  return withDocsCookies(context.json(value), session.cookies);
});

api.post("/docs-chat/session/title", async (context) => {
  const session = await docsChatSession(context.req.raw, context.env, false);
  if (session instanceof Response) return session;
  const input = await context.req.json().catch(() => null) as { title?: unknown } | null;
  const title = typeof input?.title === "string"
    ? input.title.trim().replace(/\s+/g, " ").slice(0, 64)
    : "";
  if (!title) {
    return context.json(
      { error: { type: "invalid_title", message: "Enter a chat name." } },
      400,
    );
  }
  const upstream = await fetchDocsAgent(
    context.env,
    session,
    `/apps/${DOCS_CHAT_AGENT}/threads/${encodeURIComponent(threadId(session.id))}/rename`,
    {
      method: "POST",
      body: JSON.stringify({ title }),
    },
  );
  return upstream.ok ? context.json({ ok: true, title }) : safeUpstreamResponse(upstream);
});

api.get("/docs-chat/events", async (context) => {
  const session = await docsChatSession(context.req.raw, context.env, false);
  if (session instanceof Response) return session;
  const offset = context.req.query("offset") ?? "-1";
  if (offset !== "-1" && !/^\d+_\d+$/.test(offset)) {
    return context.json(
      { error: { type: "invalid_offset", message: "The event cursor is invalid." } },
      400,
    );
  }
  const query = new URLSearchParams({ view: "updates", offset, live: "sse" });
  const upstream = await fetchDocsAgent(
    context.env,
    session,
    `/api/apps/${DOCS_CHAT_AGENT}/threads/${encodeURIComponent(threadId(session.id))}/conversation?${query}`,
  );
  if (!upstream.ok) return safeUpstreamResponse(upstream);
  return new Response(upstream.body, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      "x-content-type-options": "nosniff",
    },
  });
});

api.post("/docs-chat/realtime-ticket", async (context) => {
  const session = await docsChatSession(context.req.raw, context.env, false);
  if (session instanceof Response) return session;
  const input = await context.req.json().catch(() => ({})) as { after?: unknown };
  const after = typeof input.after === "number" && Number.isSafeInteger(input.after) && input.after >= 0
    ? input.after
    : 0;
  const upstream = await fetchDocsAgent(
    context.env,
    session,
    `/apps/${DOCS_CHAT_AGENT}/threads/${encodeURIComponent(threadId(session.id))}/realtime-ticket`,
    {
      method: "POST",
      body: JSON.stringify({ after, includeChildren: false }),
    },
  );
  if (!upstream.ok) return safeUpstreamResponse(upstream);
  const ticket = await upstream.json() as { url?: unknown; expiresAt?: unknown };
  if (typeof ticket.url !== "string" || typeof ticket.expiresAt !== "string") {
    return context.json(
      { error: { type: "invalid_realtime_ticket", message: "The realtime service returned an invalid ticket." } },
      502,
    );
  }
  const internal = new URL(ticket.url);
  const publicUrl = new URL(context.req.url);
  publicUrl.protocol = publicUrl.protocol === "https:" ? "wss:" : "ws:";
  publicUrl.pathname = "/api/docs-chat/realtime";
  publicUrl.search = internal.search;
  publicUrl.searchParams.set("session", session.reference);
  return context.json({ url: publicUrl.toString(), expiresAt: ticket.expiresAt });
});

api.get("/docs-chat/realtime", async (context) => {
  const session = await docsChatSession(context.req.raw, context.env, false);
  if (session instanceof Response) return session;
  if (context.req.header("upgrade")?.toLowerCase() !== "websocket") {
    return context.json(
      { error: { type: "websocket_required", message: "A WebSocket upgrade is required." } },
      426,
    );
  }
  const ticket = context.req.query("ticket") ?? "";
  if (!/^[A-Za-z0-9._-]{16,512}$/.test(ticket)) {
    return context.json(
      { error: { type: "invalid_realtime_ticket", message: "The realtime ticket is invalid." } },
      401,
    );
  }
  return fetchDocsAgent(
    context.env,
    session,
    `/apps/${DOCS_CHAT_AGENT}/threads/${encodeURIComponent(threadId(session.id))}/realtime?ticket=${encodeURIComponent(ticket)}`,
    { headers: { upgrade: "websocket" } },
  );
});

api.post("/docs-chat/messages", async (context) => {
  const session = await docsChatSession(context.req.raw, context.env, false);
  if (session instanceof Response) return session;
  if (!context.env.DOCS_CHAT_RATE_LIMITER && context.env.APP_ENV === "production") {
    return context.json(
      { error: { type: "rate_limit_unavailable", message: "Docs chat is not available." } },
      503,
    );
  }
  const rate = await context.env.DOCS_CHAT_RATE_LIMITER?.limit({ key: session.id });
  if (rate && !rate.success) {
    return context.json(
      { error: { type: "rate_limited", message: "Please wait before you send another message." } },
      429,
    );
  }
  const input = await context.req.json().catch(() => null) as { message?: unknown } | null;
  const message = typeof input?.message === "string" ? input.message.trim() : "";
  if (!message || message.length > 2_000) {
    return context.json(
      { error: { type: "invalid_message", message: "Enter a message of 2,000 characters or less." } },
      400,
    );
  }
  const thread = await ensureDocsThread(context.env, session);
  if (!thread.ok) return safeUpstreamResponse(thread);
  const upstream = await fetchDocsAgent(
    context.env,
    session,
    `/apps/${DOCS_CHAT_AGENT}/threads/${threadId(session.id)}/messages`,
    {
      method: "POST",
      body: JSON.stringify({
        message,
        mode: "queue",
        idempotencyKey: crypto.randomUUID(),
      }),
    },
  );
  return withDocsSession(safeUpstreamResponse(upstream), session);
});

api.all("/runtime/*", async (context) => {
  if (!context.env.FLARY_RUNTIME) {
    return context.json(
      {
        error: {
          type: "runtime_unavailable",
          message: "The Flary runtime service binding is not configured.",
        },
      },
      503,
    );
  }

  const target = new URL(context.req.url);
  target.pathname =
    target.pathname.replace(/^\/api\/runtime/, "") || "/";

  return context.env.FLARY_RUNTIME.fetch(
    new Request(target, context.req.raw),
  );
});

api.notFound((context) =>
  context.json(
    {
      error: {
        type: "not_found",
        message: "API route not found.",
      },
    },
    404,
  ),
);

app.route("/api", api);

app.all("/api/*", (context) =>
  context.json(
    {
      error: {
        type: "not_found",
        message: "API route not found.",
      },
    },
    404,
  ),
);

app.get("/app/*", async (context) => {
  if (!context.env.ASSETS) {
    return context.json(
      {
        error: {
          type: "assets_unavailable",
          message: "The website asset binding is not available.",
        },
      },
      503,
    );
  }

  const target = new URL("/app/index.html", context.req.url);
  return context.env.ASSETS.fetch(new Request(target, context.req.raw));
});

app.all("*", async (context) => {
  if (context.env.ASSETS) {
    const assetRequest = resolveAssetRequest(context.req.raw);

    if (assetRequest instanceof Response) {
      return assetRequest;
    }

    return context.env.ASSETS.fetch(assetRequest);
  }
  return context.text("Not found", 404);
});

export default app;

async function docsChatSession(
  request: Request,
  env: SiteBindings,
  create = true,
): Promise<DocsChatSession | Response> {
  const browser = await docsChatBrowser(request, env);
  if (browser instanceof Response) return browser;
  const { browserId: ownerId, tenantId, cookies } = browser;
  const token = env.FLARY_DOCS_AGENT_TOKEN!;
  const cookieHeader = request.headers.get("cookie");
  const forceNew = request.headers.get("x-flary-docs-new-session") === "1";
  const reference = forceNew
    ? undefined
    : request.headers.get("x-flary-docs-session-ref") ??
      new URL(request.url).searchParams.get("session") ??
      undefined;
  const resolved = reference
    ? await verifySessionReference(reference, ownerId, token)
    : undefined;
  if (reference && !resolved) {
    return Response.json(
      { error: { type: "chat_session_invalid", message: "This chat does not belong to this browser." } },
      { status: 401 },
    );
  }
  if (resolved) {
    return {
      id: resolved.id,
      reference: reference!,
      browserId: ownerId,
      tenantId: resolved.legacy ? DOCS_CHAT_ORGANIZATION : tenantId,
      cookies,
    };
  }
  const legacyCookie = forceNew ? undefined : readCookie(cookieHeader, DOCS_CHAT_COOKIE);
  const legacyId = legacyCookie
    ? await verifyLegacySessionCookie(legacyCookie, token)
    : undefined;
  if (legacyId) {
    return {
      id: legacyId,
      reference: await createSessionReference(legacyId, ownerId, token, true),
      browserId: ownerId,
      tenantId: DOCS_CHAT_ORGANIZATION,
      cookies,
    };
  }
  if (!create) {
    return Response.json(
      { error: { type: "chat_session_missing", message: "Start a docs chat first." } },
      { status: 401 },
    );
  }
  const id = randomHex(18);
  return {
    id,
    reference: await createSessionReference(id, ownerId, token),
    browserId: ownerId,
    tenantId,
    cookies,
    fresh: true,
  };
}

async function docsChatBrowser(
  request: Request,
  env: SiteBindings,
): Promise<DocsChatBrowser | Response> {
  const token = env.FLARY_DOCS_AGENT_TOKEN;
  if (!env.FLARY_DOCS_AGENT || !token || token.length < 32) {
    return Response.json(
      { error: { type: "docs_agent_unavailable", message: "Docs chat is not available." } },
      { status: 503 },
    );
  }
  const cookieHeader = request.headers.get("cookie");
  const browserCookie = readCookie(cookieHeader, DOCS_CHAT_BROWSER_COOKIE);
  const browserId = browserCookie
    ? await verifySignedId(browserCookie, token, "browser")
    : undefined;
  const ownerId = browserId ?? randomHex(18);
  const secure = env.APP_ENV === "production" ? "; Secure" : "";
  const cookies = browserId
    ? []
    : [
        `${DOCS_CHAT_BROWSER_COOKIE}=${ownerId}.${await signValue(`browser:${ownerId}`, token)}; Path=/api/docs-chat; HttpOnly; SameSite=Strict; Max-Age=31536000${secure}`,
      ];
  return {
    browserId: ownerId,
    tenantId: browserTenant(ownerId),
    cookies,
  };
}

async function ensureDocsThread(env: SiteBindings, session: DocsChatSession): Promise<Response> {
  const path = `/apps/${DOCS_CHAT_AGENT}/threads/${threadId(session.id)}`;
  if (session.fresh) {
    return fetchDocsAgent(env, session, `/apps/${DOCS_CHAT_AGENT}/threads`, {
      method: "POST",
      body: JSON.stringify({
        threadId: threadId(session.id),
        agentId: DOCS_CHAT_AGENT,
        model: DOCS_CHAT_MODEL,
        workspace: {
          organizationId: session.tenantId,
          appId: DOCS_CHAT_AGENT,
          projectId: "documentation",
          workspaceId: `session_${session.id}`,
          branch: "main",
        },
        mode: "ask",
        metadata: { channel: "docs-widget", anonymousBrowser: true },
      }),
    });
  }
  try {
    const current = await fetchDocsAgent(env, session, path);
    if (current.ok || current.status !== 404) return current;
  } catch (error) {
    if (!(error instanceof Error) || !/thread was not found/i.test(error.message)) {
      throw error;
    }
  }
  const created = await fetchDocsAgent(env, session, `/apps/${DOCS_CHAT_AGENT}/threads`, {
    method: "POST",
    body: JSON.stringify({
      threadId: threadId(session.id),
      agentId: DOCS_CHAT_AGENT,
      model: DOCS_CHAT_MODEL,
      workspace: {
        organizationId: session.tenantId,
        appId: DOCS_CHAT_AGENT,
        projectId: "documentation",
        workspaceId: `session_${session.id}`,
        branch: "main",
      },
      mode: "ask",
      metadata: { channel: "docs-widget", anonymousBrowser: true },
    }),
  });
  return created;
}

async function docsChatHistory(env: SiteBindings, session: DocsChatSession): Promise<Response> {
  let upstream: Response;
  try {
    upstream = await fetchDocsAgent(
      env,
      session,
      `/apps/${DOCS_CHAT_AGENT}/threads/${encodeURIComponent(threadId(session.id))}/conversation`,
    );
  } catch (error) {
    if (error instanceof Error && /thread was not found/i.test(error.message)) {
      return Response.json({ messages: [], settlements: [] });
    }
    throw error;
  }
  if (upstream.status === 404) {
    return Response.json({ messages: [], settlements: [] });
  }
  if (!upstream.ok) return safeUpstreamResponse(upstream);
  const payload = await upstream.json() as {
    conversation?: {
      messages?: Array<{
        id?: string;
        role?: string;
        submissionId?: string;
        parts?: Array<Record<string, unknown>>;
      }>;
      settlements?: unknown[];
      offset?: string;
    };
  };
  const value = payload.conversation ?? {
    messages: [],
    settlements: [],
    offset: undefined,
  };
  return Response.json({
    messages: (value.messages ?? [])
      .filter((message) => message.role === "user" || message.role === "assistant")
      .map((message) => ({
        id: message.id,
        role: message.role,
        submissionId: message.submissionId,
        parts: publicDocsParts(message.parts ?? []),
        text: (message.parts ?? [])
          .filter((part) => part.type === "text" && typeof part.text === "string")
          .map((part) => String(part.text))
          .join(""),
      }))
      .filter((message) => message.text.length > 0 || message.parts.length > 0),
    settlements: value.settlements ?? [],
    cursor: value.offset,
  });
}

function fetchDocsAgent(
  env: SiteBindings,
  session: DocsChatSession,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${env.FLARY_DOCS_AGENT_TOKEN}`);
  headers.set("x-flary-docs-session", session.id);
  headers.set("x-flary-docs-browser", session.browserId);
  headers.set("x-flary-docs-tenant", session.tenantId);
  if (init.body) headers.set("content-type", "application/json");
  return env.FLARY_DOCS_AGENT!.fetch(new Request(`https://docs-agent.internal${path}`, {
    ...init,
    headers,
  }));
}

async function withDocsSession(response: Response, session: DocsChatSession): Promise<Response> {
  const headers = new Headers(response.headers);
  for (const cookie of session.cookies) headers.append("set-cookie", cookie);
  if (!response.ok || !headers.get("content-type")?.includes("application/json")) {
    return new Response(response.body, { status: response.status, headers });
  }
  const value = await response.json().catch(() => ({}));
  const body = value && typeof value === "object" && !Array.isArray(value)
    ? { ...value, session: { id: session.id, reference: session.reference } }
    : { value, session: { id: session.id, reference: session.reference } };
  headers.set("content-type", "application/json; charset=UTF-8");
  return new Response(JSON.stringify(body), { status: response.status, headers });
}

function withDocsCookies(response: Response, cookies: readonly string[]): Response {
  if (cookies.length === 0) return response;
  const headers = new Headers(response.headers);
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(response.body, { status: response.status, headers });
}

function safeUpstreamResponse(upstream: Response): Response {
  const headers = new Headers();
  headers.set("content-type", upstream.headers.get("content-type") ?? "application/json");
  return new Response(upstream.body, { status: upstream.status, headers });
}

function threadId(sessionId: string): string {
  return `chat_${sessionId}`;
}

function publicDocsParts(parts: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];
  for (const part of parts) {
    if (
      (part.type === "text" || part.type === "reasoning") &&
      typeof part.text === "string"
    ) {
      result.push({
        type: part.type,
        text: part.text,
        state: part.state === "streaming" ? "streaming" : "done",
      });
      continue;
    }
    if (
      part.type === "dynamic-tool" &&
      typeof part.toolName === "string" &&
      typeof part.toolCallId === "string"
    ) {
      result.push({
        type: "dynamic-tool",
        toolName: part.toolName,
        toolCallId: part.toolCallId,
        state: typeof part.state === "string" ? part.state : "input-available",
        ...(part.input === undefined ? {} : { input: part.input }),
        ...(typeof part.errorText === "string" ? { errorText: part.errorText } : {}),
      });
    }
  }
  return result;
}

function readCookie(header: string | null, name: string): string | undefined {
  return header
    ?.split(";")
    .map((part) => part.trim().split("="))
    .find(([key]) => key === name)
    ?.slice(1)
    .join("=");
}

async function verifyLegacySessionCookie(value: string, secret: string): Promise<string | undefined> {
  const separator = value.lastIndexOf(".");
  if (separator < 0) return undefined;
  const id = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  if (!/^[a-f0-9]{36}$/.test(id)) return undefined;
  const expected = await signValue(id, secret);
  return sameString(signature, expected) ? id : undefined;
}

async function verifySignedId(
  value: string,
  secret: string,
  purpose: string,
): Promise<string | undefined> {
  const separator = value.lastIndexOf(".");
  if (separator < 0) return undefined;
  const id = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  if (!/^[a-f0-9]{36}$/.test(id)) return undefined;
  const expected = await signValue(`${purpose}:${id}`, secret);
  return sameString(signature, expected) ? id : undefined;
}

async function createSessionReference(
  sessionId: string,
  browserId: string,
  secret: string,
  legacy = false,
): Promise<string> {
  const kind = legacy ? "legacy" : "v1";
  const signature = await signValue(`session:${kind}:${browserId}:${sessionId}`, secret);
  return `${kind}.${sessionId}.${signature}`;
}

async function verifySessionReference(
  reference: string,
  browserId: string,
  secret: string,
): Promise<{ id: string; legacy: boolean } | undefined> {
  const [kind, id, signature, ...extra] = reference.split(".");
  if (
    extra.length > 0 ||
    (kind !== "v1" && kind !== "legacy") ||
    !id ||
    !signature ||
    !/^[a-f0-9]{36}$/.test(id)
  ) return undefined;
  const expected = await signValue(`session:${kind}:${browserId}:${id}`, secret);
  return sameString(signature, expected)
    ? { id, legacy: kind === "legacy" }
    : undefined;
}

async function signValue(value: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return bytesToBase64Url(new Uint8Array(signature));
}

function browserTenant(browserId: string): string {
  return `${DOCS_CHAT_ORGANIZATION}-${browserId}`;
}

function randomHex(bytes: number): string {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function sameString(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

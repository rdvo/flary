import { Hono } from "hono";
import {
  CloudflareMcpOAuthConnections,
  CloudflareProviderOAuthPersistence,
} from "flary/cloudflare";
import { assistant, ask } from "./agents";
import { createAuth } from "./auth";
import { app, type Bindings } from "./flary";
import { connectionsHtml, dashboardHtml } from "./ui";

export const functions = { ask, assistant };
const runtime = app.serve(functions);
const worker = new Hono<{ Bindings: Bindings }>();

class DashboardAuthenticationError extends Error {}

// Owner creation is allowed only through /api/setup. Do not expose Better
// Auth's public registration route before or after the first owner exists.
worker.all("/api/auth/sign-up/*", (context) =>
  context.json({ error: "Registration is closed. Use the first-owner setup page." }, 403));
worker.on(["GET", "POST"], "/api/auth/*", (context) => createAuth(context.env, new URL(context.req.url).origin).handler(context.req.raw));
worker.post("/api/connections/oauth/start", async (context) => {
  const owner = await requireOwner(context.env, context.req.raw);
  const body = await context.req.json<{ provider?: "openai-codex" | "anthropic" }>();
  if (body.provider !== "openai-codex" && body.provider !== "anthropic") return context.json({ error: "Unsupported provider." }, 400);
  const service = providerOAuth(context.env);
  return context.json(await service.start(owner, { provider: body.provider }));
});
worker.get("/api/connections/oauth/:id", async (context) => {
  const owner = await requireOwner(context.env, context.req.raw);
  return context.json(await providerOAuth(context.env).get(owner, context.req.param("id"), context.req.query("poll") === "1"));
});
worker.post("/api/connections/oauth/:id/complete", async (context) => {
  const owner = await requireOwner(context.env, context.req.raw);
  const body = await context.req.json<{ authorizationResult?: string }>();
  if (!body.authorizationResult) return context.json({ error: "Authorization result is required." }, 400);
  return context.json(await providerOAuth(context.env).complete(owner, context.req.param("id"), body.authorizationResult));
});
worker.get("/api/connections/mcp/client-metadata", (context) => {
  const origin = new URL(context.req.url).origin;
  const callback = `${origin}/api/connections/mcp/oauth/callback`;
  const clientId = `${origin}/api/connections/mcp/client-metadata`;
  context.header("cache-control", "public, max-age=300");
  return context.json({
    client_id: clientId,
    client_name: "Flary",
    client_uri: origin,
    redirect_uris: [callback],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  });
});
worker.get("/api/connections/mcp/oauth/callback", async (context) => {
  const state = context.req.query("state");
  if (!state) return context.html(mcpCallbackHtml(false, "The authorization response did not include state."), 400);
  try {
    const connection = await mcpOAuth(context.env, context.req.raw).complete({
      state,
      ...(context.req.query("code") ? { code: context.req.query("code") } : {}),
      ...(context.req.query("error") ? { error: context.req.query("error") } : {}),
      ...(context.req.query("iss") ? { issuer: context.req.query("iss") } : {}),
    });
    return context.html(mcpCallbackHtml(true, `${connection.name} is connected.`));
  } catch (error) {
    return context.html(mcpCallbackHtml(false, safeError(error)), 400);
  }
});
worker.get("/api/connections/mcp", async (context) => {
  const owner = await requireOwner(context.env, context.req.raw);
  return context.json({ connections: await mcpOAuth(context.env, context.req.raw).list(owner) });
});
worker.post("/api/connections/mcp", async (context) => {
  const owner = await requireOwner(context.env, context.req.raw);
  const body = await context.req.json<{ name?: string; namespace?: string; url?: string; scopes?: string[] }>();
  if (!body.name?.trim() || !body.url?.trim()) {
    return context.json({ error: "A connection name and HTTPS MCP URL are required." }, 400);
  }
  try {
    return context.json(await mcpOAuth(context.env, context.req.raw).start(owner, {
      name: body.name,
      namespace: body.namespace,
      url: body.url,
      ...(Array.isArray(body.scopes) ? { scopes: body.scopes } : {}),
    }));
  } catch (error) {
    return context.json({ error: safeError(error) }, 400);
  }
});
worker.post("/api/connections/mcp/:id/disable", async (context) => {
  const owner = await requireOwner(context.env, context.req.raw);
  await mcpOAuth(context.env, context.req.raw).disable(owner, context.req.param("id"));
  return context.json({ ok: true });
});
worker.delete("/api/connections/mcp/:id", async (context) => {
  const owner = await requireOwner(context.env, context.req.raw);
  await mcpOAuth(context.env, context.req.raw).remove(owner, context.req.param("id"));
  return context.json({ ok: true });
});
worker.get("/api/setup/status", async (context) => {
  const current = await installation(context.env);
  return context.json({ open: current?.status !== "ready", status: current?.status ?? "new" });
});
worker.post("/api/setup", async (context) => {
  const body = await context.req.json<{ token?: string; name?: string; email?: string; password?: string }>();
  if (!body.token || !constantTimeEqual(body.token, context.env.FLARY_SETUP_TOKEN)) return context.json({ error: "The setup token is invalid." }, 401);
  const current = await installation(context.env);
  if (current?.status === "ready") return context.json({ error: "Setup is closed." }, 409);
  if (current?.status === "initializing") {
    if (Date.now() - current.createdAt < 5 * 60_000) return context.json({ error: "Owner setup is already running." }, 409);
    const users = await context.env.FLARY_DASHBOARD_DB.prepare("SELECT id, email FROM user ORDER BY created_at ASC LIMIT 2").all<{ id: string; email: string }>();
    if (users.results.length === 1 && users.results[0]?.email === body.email) {
      const owner = users.results[0]!;
      await context.env.FLARY_DASHBOARD_DB.prepare("UPDATE flary_installation SET status = 'ready', owner_user_id = ?, initialized_at = unixepoch() * 1000 WHERE id = 'owner' AND status = 'initializing'").bind(owner.id).run();
      return context.json({ ok: true, owner: owner.email, recovered: true });
    }
    if (users.results.length > 0) return context.json({ error: "Setup needs manual recovery because an unexpected user exists." }, 409);
    await context.env.FLARY_DASHBOARD_DB.prepare("DELETE FROM flary_installation WHERE id = 'owner' AND status = 'initializing'").run();
  }
  const lock = await context.env.FLARY_DASHBOARD_DB.prepare("INSERT OR IGNORE INTO flary_installation (id, status, created_at) VALUES ('owner', 'initializing', unixepoch() * 1000)").run();
  if (!lock.meta.changes) return context.json({ error: "Owner setup is already running." }, 409);
  try {
    const created = await createAuth(context.env, new URL(context.req.url).origin).api.signUpEmail({ body: { name: body.name ?? "Owner", email: body.email ?? "", password: body.password ?? "" } });
    await context.env.FLARY_DASHBOARD_DB.prepare("UPDATE flary_installation SET status = 'ready', owner_user_id = ?, initialized_at = unixepoch() * 1000 WHERE id = 'owner' AND status = 'initializing'").bind(created.user.id).run();
    return context.json({ ok: true, owner: created.user.email });
  } catch {
    const users = await context.env.FLARY_DASHBOARD_DB.prepare("SELECT id, email FROM user ORDER BY created_at ASC LIMIT 2").all<{ id: string; email: string }>();
    const partialOwner = users.results.length === 1 && users.results[0]?.email === body.email
      ? users.results[0]
      : undefined;
    if (partialOwner) {
      await context.env.FLARY_DASHBOARD_DB.prepare("UPDATE flary_installation SET status = 'ready', owner_user_id = ?, initialized_at = unixepoch() * 1000 WHERE id = 'owner' AND status = 'initializing'").bind(partialOwner.id).run();
      return context.json({ ok: true, owner: partialOwner.email, recovered: true });
    }
    await context.env.FLARY_DASHBOARD_DB.prepare("DELETE FROM flary_installation WHERE id = 'owner' AND status = 'initializing'").run();
    return context.json({ error: "Owner setup failed. Check the Worker logs, then try again." }, 400);
  }
});
worker.get("/", async (context) => {
  const open = (await installation(context.env))?.status !== "ready";
  const session = open ? undefined : await createAuth(context.env, new URL(context.req.url).origin).api.getSession({ headers: context.req.raw.headers });
  return context.html(dashboardHtml(open, Boolean(session?.user)));
});
worker.get("/setup", async (context) => context.html(dashboardHtml((await installation(context.env))?.status !== "ready")));
worker.get("/connections", async (context) => {
  try { await requireOwner(context.env, context.req.raw); } catch { return context.redirect("/"); }
  return context.html(connectionsHtml());
});
worker.get("/settings", async (context) => {
  await requireOwner(context.env, context.req.raw);
  return context.json({ secrets: {
    OPENAI_API_KEY: Boolean(context.env.OPENAI_API_KEY),
    ANTHROPIC_API_KEY: Boolean(context.env.ANTHROPIC_API_KEY),
    GEMINI_API_KEY: Boolean(context.env.GEMINI_API_KEY),
    FLARY_SESSION_ARCHIVE_KEY: Boolean(context.env.FLARY_SESSION_ARCHIVE_KEY),
    FLARY_TOKEN_ENCRYPTION_KEY_B64: Boolean(context.env.FLARY_TOKEN_ENCRYPTION_KEY_B64),
  } });
});
// Flary and the template can resolve separate compatible Hono declarations.
// The runtime value is a Hono application at execution time.
worker.route("/", runtime as never);
worker.onError((error, context) => {
  if (error instanceof DashboardAuthenticationError) {
    return context.json({ error: "Authentication is required." }, 401);
  }
  return context.json({ error: "The dashboard request failed." }, 500);
});

async function installation(env: Bindings): Promise<{ status: string; createdAt: number } | undefined> {
  return await env.FLARY_DASHBOARD_DB.prepare("SELECT status, created_at AS createdAt FROM flary_installation WHERE id = 'owner'").first<{ status: string; createdAt: number }>() ?? undefined;
}
function constantTimeEqual(left: string, right: string): boolean {
  if (!left || !right) return false;
  const a = new TextEncoder().encode(left); const b = new TextEncoder().encode(right); let mismatch = a.length ^ b.length;
  const length = Math.max(a.length, b.length); for (let i = 0; i < length; i += 1) mismatch |= (a[i % a.length] ?? 0) ^ (b[i % b.length] ?? 0);
  return mismatch === 0;
}
function providerOAuth(env: Bindings): CloudflareProviderOAuthPersistence {
  return new CloudflareProviderOAuthPersistence({ database: env.FLARY_DASHBOARD_DB, encryptionKey: env.FLARY_TOKEN_ENCRYPTION_KEY_B64 });
}
function mcpOAuth(env: Bindings, request: Request): CloudflareMcpOAuthConnections {
  const origin = new URL(request.url).origin;
  return new CloudflareMcpOAuthConnections({
    database: env.FLARY_DASHBOARD_DB,
    encryptionKey: env.FLARY_TOKEN_ENCRYPTION_KEY_B64,
    callbackUrl: `${origin}/api/connections/mcp/oauth/callback`,
    clientMetadataUrl: `${origin}/api/connections/mcp/client-metadata`,
    clientName: "Flary",
  });
}
function mcpCallbackHtml(ok: boolean, message: string): string {
  const payload = JSON.stringify({ type: "flary:mcp-connected", ok, message }).replaceAll("<", "\\u003c");
  const title = ok ? "MCP connected" : "MCP connection failed";
  return `<!doctype html><meta name="viewport" content="width=device-width"><title>${title}</title><style>body{font-family:system-ui;max-width:34rem;margin:5rem auto;padding:1.5rem;color:#18201c}button{font:inherit;padding:.7rem 1rem}</style><h1>${title}</h1><p id="message"></p><button onclick="window.close()">Close</button><script>const result=${payload};document.querySelector('#message').textContent=result.message;window.opener?.postMessage(result,window.location.origin);</script>`;
}
function safeError(error: unknown): string {
  return error instanceof Error ? error.message : "The MCP connection failed.";
}
async function requireOwner(env: Bindings, request: Request): Promise<{ tenantId: string; userId: string }> {
  const session = await createAuth(env, new URL(request.url).origin).api.getSession({ headers: request.headers });
  if (!session?.user) throw new DashboardAuthenticationError("Authentication is required.");
  return { tenantId: "personal", userId: session.user.id };
}
export default worker;

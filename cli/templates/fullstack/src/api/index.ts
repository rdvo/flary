import { Hono } from "hono";
import { env } from "cloudflare:workers";

const app = new Hono();

// Serve static assets
app.get("/public/*", async (c) => {
  return await env.ASSETS.fetch(c.req.raw);
});
// SPA fallback
app.all("*", async (c) => {
  return await env.ASSETS.fetch(c.req.raw);
});

export default app;

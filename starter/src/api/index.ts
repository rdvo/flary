import { Hono, Context } from "hono";

const app = new Hono<{ Bindings: Env }>();

app.get("/api/*", (c: Context) => {
  return c.json({
    name: "my flary app",
    version: "1.0.0",
    status: "online",
    timestamp: new Date().toISOString(),
  });
});

// Serve static assets from the ASSETS binding
app.get("/public/*", async (c: Context) => {
  return await c.env.ASSETS.fetch(c.req.raw);
});
// Handle all non-API routes for SPA
// This will only run if none of the above routes match
app.all("*", async (c: Context) => {
  // Serve the SPA for all non-API routes
  return await c.env.ASSETS.fetch(c.req.raw);
});

export default app;

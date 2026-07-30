# Flary function starter

This Worker uses Flary's function-first API. A normal TypeScript function is
the complete registration process; there is no handwritten `Env`, router, or
tool catalog.

```bash
npm install
npm run dev
```

Call the support function:

```bash
curl -X POST http://localhost:5173/functions/support \
  -H "content-type: application/json" \
  -d '{"question":"How do I reset my password?"}'
```

The example includes a local Zod-backed documentation tool. Add MCP or
OpenAPI sources with `app.mcp()` and `app.openapi()` in `src/tools.ts`.

For deployment, set `OPENAI_API_KEY` and a random value of at least 32
characters for `FLARY_INTERNAL_TOKEN` as Worker secrets. The Vite integration
generates the Flue agent entry, the `FlaryRuntime` Durable Object, bindings,
and SQLite migration. It also attaches the durable run service to the app, so
`.start()` does not use an in-memory fallback.

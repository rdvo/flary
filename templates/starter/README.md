# Flary backend

This Worker uses Flary's function-first API. A normal TypeScript function is
the complete registration process; there is no handwritten `Env`, router, or
tool catalog.

```bash
npm install
npm run dev
```

Call the support function. A guided setup generates a bearer token in
`.dev.vars`; deployed requests must send that token.

```bash
curl -X POST http://localhost:5173/functions/support \
  -H "content-type: application/json" \
  -d '{"question":"How do I reset my password?"}'
```

The example includes a local Zod-backed documentation tool. Add MCP or
OpenAPI sources with `app.mcp()` and `app.openapi()` in `src/tools.ts`.

The guided personal-backend setup uses a generated bearer token. If you select
existing-application authentication, deployed requests receive `401
Unauthorized` until you add a trusted identity resolver.

Set the required production secrets from this directory:

```bash
npx flary setup
npx flary deploy
```

The setup command stores local secrets in a mode-`0600` `.dev.vars` file. The
deploy command uploads only required secret names through a temporary
mode-`0600` file and removes it when Wrangler finishes.

## GitHub MCP

Run `npx flary setup` and enable **MCP example**. The wizard asks for a
fine-grained GitHub token and generates the read-only GitHub source plus its
trusted credential resolver. The token stays in `.dev.vars` locally and in a
Worker secret after deployment. It does not enter model context or tool
arguments.

The Vite integration generates the durable runtime, bindings, and Cloudflare
configuration. It also attaches the durable run service, so `.start()` does
not use an in-memory fallback after deployment.

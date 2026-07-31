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

The placeholder authentication in `src/flary.ts` accepts only loopback
requests. Deployed requests receive `401 Unauthorized` until you replace it
with your product authentication and return a trusted tenant identity.

Set the required production secrets from this directory:

```bash
npx wrangler secret put OPENAI_API_KEY
openssl rand -hex 32 | npx wrangler secret put FLARY_INTERNAL_TOKEN
```

The first command securely prompts for the provider key. The second command
generates a 64-character internal token and sends it directly to Wrangler.

## Complete GitHub MCP connection

Use
[GitHub's read-only remote MCP endpoint](https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md)
first. Store a fine-grained GitHub personal access token as a Worker secret:

```bash
npx wrangler secret put GITHUB_MCP_PAT
```

Add the binding and trusted credential resolver to `src/flary.ts`:

```ts
import { createMcpConnection, flary, z } from "flary";

export const BindingsSchema = z.object({
  OPENAI_API_KEY: z.string().optional(),
  FLARY_INTERNAL_TOKEN: z.string().optional(),
  GITHUB_MCP_PAT: z.string().min(1),
  LOADER: z.unknown().optional(),
  FLARY_RUN_SERVICE: z.unknown().optional(),
});

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export const app = flary({
  model: "openai/gpt-5",
  bindings: BindingsSchema,
  auth: async ({ request }) => {
    if (!request || !LOCAL_HOSTS.has(new URL(request.url).hostname)) {
      return undefined;
    }
    return {
      tenantId: "local-development",
      userId: "local-developer",
      roles: ["developer"],
    };
  },
  resolveMcp: (source, { bindings }) => {
    if (source.connection !== "github") {
      throw new Error("The MCP connection is not approved");
    }
    return createMcpConnection(source, {
      credentials: {
        get: async () => ({
          kind: "bearer",
          value: bindings.GITHUB_MCP_PAT,
        }),
      },
    });
  },
});
```

Register the lazy source in `src/tools.ts`:

```ts
const github = app.mcp({
  namespace: "github",
  connection: "github",
  url: "https://api.githubcopilot.com/mcp/readonly",
});

export const tools = app.tools({ searchDocs, github });
```

The PAT stays in trusted host code. It does not enter model context, tool
descriptors, events, or logs.

The Vite integration generates the Flue agent entry, the `FlaryRuntime`
Durable Object, bindings, and SQLite lifecycle configuration. It also
attaches the durable run service to the app, so `.start()` does not use an
in-memory fallback.

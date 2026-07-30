# Flary Workers

This directory contains two separate Cloudflare Workers:

- `flary-cloud` is Flary's managed runtime Worker. It owns the agent API,
  Flue routes, Durable Objects, D1, R2, and containers.
- `flary-web` is the website Worker. Astro prerenders the public pages, React
  provides interactive islands and the `/app/*` SPA, and Hono owns website API
  routes.

In production, `flary-web` uses the `FLARY_RUNTIME` service binding to call
`flary-cloud` without a public network hop.

## What it includes

- Astro pages with static HTML for search engines.
- React islands and a scoped `/app/*` SPA fallback.
- A small Hono website API.
- Better Auth with organization support.
- Drizzle schema and migrations for D1.
- R2 for prompt source, large files, and the immutable history fallback.
- Cloudflare Artifacts for Git-backed project history when the closed-beta
  binding is enabled. The adapter uses Cloudflare Shell's in-memory Git client;
  it falls back to R2 when the binding is not present.
- One SQLite-backed Durable Object per organization for serialized events.
- One SQLite-backed Durable Object per project branch for canonical file
  metadata and files up to 1,500,000 bytes. Larger files spill to R2.
- One native Flue agent Durable Object per chat thread. Flue owns the
  canonical transcript and execution stream; Flary metadata tables do not
  duplicate it.
- Dynamic Workers for short Code Mode plans.
- Cloudflare Sandboxes for full Linux workloads.

This is a Workers application, not a Pages project. The Cloudflare Vite plugin
builds each Worker. Workers Static Assets serves Astro output for the website.
Only `/app/*` uses a single-page fallback. Other missing pages return a real
404 response.

The source layout is:

- `src/pages/` — Astro website routes.
- `src/components/` — React islands and the app shell.
- `worker/site.ts` — small Hono website Worker.
- `worker/` — Flary runtime API, Better Auth, Durable Objects, and integrations.
- `migrations/` — additive D1 migrations.
- `wrangler.site.jsonc` — website Worker configuration.
- `wrangler.jsonc` — runtime Worker configuration.
- `worker-configuration.d.ts` — generated Cloudflare binding types. Run
  `pnpm types` after changing Wrangler bindings.

## Local setup

```bash
cp .dev.vars.example .dev.vars
pnpm install
pnpm --filter flary build
pnpm --dir apps/cloud db:migrate:local
pnpm --dir apps/cloud dev
```

The default `dev` command starts the lightweight website Worker with the
Cloudflare Vite plugin. Use this command for the full runtime Worker:

```bash
pnpm --dir apps/cloud dev:runtime
```

Set `BETTER_AUTH_SECRET` and a base64url-encoded 32-byte
`FLARY_TOKEN_ENCRYPTION_KEY_B64` in `.dev.vars`. To enable Cloudflare BYOK,
also set `CLOUDFLARE_OAUTH_CLIENT_ID` and
`CLOUDFLARE_OAUTH_CLIENT_SECRET`. Docker must be available for local Sandbox
development.

## Production setup

1. Create a D1 database and an R2 bucket. Request Cloudflare Artifacts beta
   access before enabling the `ARTIFACTS` binding.
2. Replace the production database ID, bucket name, `APP_URL`, and Worker name
   in `wrangler.jsonc`. Set `CLOUDFLARE_ACCOUNT_ID` in the shell that deploys.
3. Apply migrations with `pnpm db:migrate:remote`.
4. Create a Cloudflare OAuth client. Set its callback URL to
   `https://your-host/api/cloudflare/oauth/callback` and grant these scopes:
   `account-settings.read memberships.read aig.read aig.run aig.write ai.read`.
5. Add `BETTER_AUTH_SECRET`, `FLARY_TOKEN_ENCRYPTION_KEY_B64`,
   `CLOUDFLARE_OAUTH_CLIENT_ID`, and `CLOUDFLARE_OAUTH_CLIENT_SECRET` with
   `wrangler secret put`.
6. Deploy the runtime with `pnpm deploy:runtime`.
7. Deploy the website with `pnpm deploy:web`.

For the hosted Flary environment, the current Worker URL is
`https://flary-cloud.cosmicmarketing.workers.dev`. A custom domain can be
added later by replacing the `workers_dev` production setting with a route or
custom-domain configuration.

Users can connect their own Cloudflare account from the Cloudflare BYOK card.
The Worker encrypts the OAuth tokens in D1, creates one authenticated AI
Gateway for the connected account, and never returns the tokens to the
browser. Disconnect removes the local credential and revokes the OAuth token;
it does not delete the customer's Cloudflare Gateway.

The open-source provider adapter is available from `flary/providers`:

```ts
import { CloudflareAIGatewayAdapter } from "flary/providers";

const provider = new CloudflareAIGatewayAdapter({
  accountId: "0123456789abcdef0123456789abcdef",
  gatewayId: "flary-user",
  apiToken: process.env.CLOUDFLARE_ACCESS_TOKEN!,
});

const response = await provider.complete({
  model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  messages: [{ role: "user", content: "Say hello." }],
});
```

Keep the token in the server runtime. Do not put it in prompts, browser
storage, or source files.

For the Cloud app, `worker/cloudflare-provider.ts` resolves the connected
user's adapter and refreshes the OAuth token before a model call. Use that
server-side helper when an application route invokes Flary's provider
adapter.

## Branch workspace API

Use a separate opaque `workspaceId` for each project branch or isolated agent
workspace. All operations use a Zod-validated body:

```text
POST /api/apps/:appId/projects/:projectId/workspaces/:workspaceId/files/write
POST /api/apps/:appId/projects/:projectId/workspaces/:workspaceId/files/read
POST /api/apps/:appId/projects/:projectId/workspaces/:workspaceId/files/stat
POST /api/apps/:appId/projects/:projectId/workspaces/:workspaceId/files/list
POST /api/apps/:appId/projects/:projectId/workspaces/:workspaceId/files/edit
POST /api/apps/:appId/projects/:projectId/workspaces/:workspaceId/files/move
POST /api/apps/:appId/projects/:projectId/workspaces/:workspaceId/files/delete
GET  /api/apps/:appId/projects/:projectId/workspaces/:workspaceId/files/health
POST /api/apps/:appId/projects/:projectId/workspaces/:workspaceId/files/upload-ticket
POST /api/apps/:appId/projects/:projectId/workspaces/:workspaceId/files/download-ticket
PUT  /api/apps/:appId/projects/:projectId/workspaces/:workspaceId/files/upload?organizationId=...&ticket=...
GET  /api/apps/:appId/projects/:projectId/workspaces/:workspaceId/files/download?organizationId=...&ticket=...
```

The ticket endpoints require organization membership. A transfer URL is a
short-lived, single-use Worker capability. It is bound to the authenticated
tenant, branch, path, size, media type, and digest. It is not a public R2
object URL and it does not grant access to any other object.

The exact storage boundary is inclusive: `1,500,000` bytes remain in the
workspace Durable Object; `1,500,001` bytes and larger require the private
`WORKSPACE_BLOBS` R2 binding. Production rejects a large write if that binding is
missing. History uses the `ARTIFACTS` repository when that closed-beta binding
is available and otherwise uses tenant-scoped immutable R2 objects.

## Native Flue thread API

The Flue runtime is mounted below `/api/flue` and creates one native agent
Durable Object instance for each opaque thread name:

```text
/api/flue/agents/flary-thread/{organizationId}:{appId}:{agentId}:{threadId}
```

`FlaryThreadAgent` checks the Better Auth session and organization/app
membership before Flue accepts a prompt. Flue owns the transcript, accepted
submissions, stream, attachments, and recovery. Flary stores operational
metadata in the same object for approvals, mode, usage, provider cursors,
sandbox jobs, and run references. It does not write a second message log.

All user turns use the Flary admission route:

```text
POST /api/apps/:appId/threads/:threadId/messages
GET  /api/apps/:appId/threads/:threadId/cursor
GET  /api/apps/:appId/threads/:threadId/history
POST /api/apps/:appId/threads/:threadId/history/diff
GET  /api/apps/:appId/threads/:threadId/recall/search
POST /api/apps/:appId/threads/:threadId/recall/open
```

The admission route validates the immutable thread binding, idempotency key,
mode, connection grants, and provider credentials before it forwards the
submission to Flue. The selected model and reasoning level are stored with the
submission and passed into the pinned Flue patch. Direct Flue POSTs are
rejected so they cannot bypass Flary policy or credential selection. The
`FlaryThreadClient` is stream-first and reconnects through the Flue durable
cursor. `cursor()` exposes normalized `{ flueOffset, flarySequence }`
metadata for a host that stores its own connection state. `historyCheckpoints()`
and `historyDiff()` browse immutable checkpoints without making history a
second execution source.

This repository pins `@flue/runtime` and carries the small patch in
`patches/@flue__runtime@1.0.0-beta.9.patch`. Run `pnpm install` after a clean
checkout so pnpm applies it. Flary stores its wider `none`, `max`, and `ultra`
reasoning vocabulary, then maps those values to Flue's supported boundary
values (`off` and `xhigh`).

Provider secrets are selected by Flary in the trusted Worker runtime. A model
receives only the admitted provider/model identifier and normal tool input; it
never receives the raw API key. Tenant BYOK credentials take precedence over
managed environment credentials. A missing credential returns the typed
`provider_credentials_missing` response before Flue starts work.

Build or deploy the runtime Worker with these commands:

```bash
pnpm build:runtime
pnpm deploy:runtime
```

`build:runtime` generates the `FLUE_*` bindings. The initial migration in
`wrangler.jsonc` must list `FlueFlaryThreadAgent` and `FlueRegistry` with the
application-owned Durable Object classes.

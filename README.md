# Flary

**Durable agent infrastructure for Cloudflare Workers.**

Flary is an open-source TypeScript harness for agents that must keep working
after a request, browser tab, Worker isolate, or provider session ends. It
gives product developers one typed runtime for durable threads, streaming,
tools, MCP connections, approvals, workspaces, provider credentials, prompt
caching, history, recall, and usage.

Use Flary to add a coding agent, support agent, product copilot, research
worker, or automation agent to an existing application. Flary is the agent
backend. Your application owns authentication, billing, product policy, and
the user interface.

## Why Flary

- **Durable threads:** Flue owns the canonical transcript and resumable
  execution stream inside a Durable Object.
- **Provider-neutral sessions:** Use OpenAI, Anthropic, Google, Moonshot, or
  Cloudflare routes without changing the application contract.
- **Native subscription and BYOK credentials:** Resolve the current user's
  subscription first, then tenant BYOK, then a managed credential.
- **Safe tools and MCP:** Search and load tools only when needed. Keep secrets
  behind capability handles and explicit approvals.
- **Tenant-safe workspaces:** Keep branch workspaces in Durable Object SQLite
  and move large immutable blobs to R2.
- **Recoverable history:** Project the durable stream into JSONL, checkpoints,
  diffs, and scoped Recall results.
- **Zod at every public boundary:** Validate threads, events, tools,
  credentials, modes, approvals, usage, and storage references.

## Product boundary

```text
Your product
  ├─ authentication, organizations, billing, and UI
  └─ Flary
      ├─ durable agent threads and streaming
      ├─ prompts, tools, MCP, approvals, and subagents
      ├─ provider sessions, OAuth/BYOK, caching, and usage
      └─ Durable Objects, D1, R2, Artifacts, and sandbox adapters
```

Flary does not force a chat UI, editor, authentication provider, or billing
system on the host application.

## Install the release candidate

```bash
npm install --save-exact flary@0.3.0-rc.4
```

The `next` npm tag points to the current release candidate. Pin the exact
version in production until the live provider gates pass.

## Package entry points

```ts
import { createFlaryHostRouter } from "flary/host";
import { FlaryClient } from "flary/client";
import { defineFlaryAgent } from "flary/flue";
import { compilePrompt } from "flary/prompts";
import { ToolCatalog } from "flary/tools";
```

Flary also exports focused modules for contracts, providers, execution,
storage, history, recall, telemetry, vaults, subagents, MCP, and Cloudflare
adapters.

## Prompt files

Store prompts in Git as `*.prompt.md` files. The path becomes the slug.

```text
prompts/support/answer.prompt.md
→ support/answer
```

```md
---
model: inherit
thinking: high
tools:
  - docs.search

input:
  customer.name: string
  question: string

limits:
  steps: 20
  tools: 40
---

Answer {{customer.name}}:

{{question}}
```

Omit `model` or use `model: inherit` to use the caller or application model.
Set a provider/model slug to lock the prompt:

```yaml
model: anthropic/claude-opus-5
```

```ts
import { compilePrompt } from "flary/prompts";

const prompt = await compilePrompt(source, {
  callerModel: "openai/gpt-5.6-luna",
  values: {
    customer: { name: "Robert" },
    question: "How do I upgrade?",
  },
});
```

Templates permit only strict `{{value.path}}` interpolation. Missing and
unknown values fail before a model call. Secret-like paths are rejected.

### Immutable prompt revisions and rollouts

Cloud prompt uploads keep the logical prompt slug stable and write each changed
source file as a new immutable revision. The source hash, object key, commit,
model, thinking level, creator, and creation time are retained. Reverting a
prompt means selecting an older revision for a new run; it never overwrites
history.

Rollouts use integer basis points. The weights must total `10_000`, and the
assignment is selected with a stable hash of the prompt, rollout, scope, and
assignment subject. There is no uncontrolled random selection.

```ts
import { selectPromptVariant } from "flary/prompts";

const variant = selectPromptVariant(
  {
    rolloutId: "support-answer-v2",
    promptId: "support-answer",
    scope: "user",
    variants: [
      { id: "control", revisionId: "revision-1", allocationBasisPoints: 7_500 },
      { id: "candidate", revisionId: "revision-2", allocationBasisPoints: 2_500 },
    ],
  },
  { scope: "user", subject: "user-42" },
);
```

Client overrides are accepted only with an explicit test or operator
authorization record. Production requests should pass an assignment subject,
not a random number.

## Self-hosted durable runs

Flary OSS does not require Flary Cloud or Better Auth. Your Worker authenticates
the caller and gives Flary a trusted tenant context. The public request cannot
set `tenantId`, `agentId`, roles, or scopes.

Use the stable run API:

```text
POST /runs
GET  /runs/:runId
GET  /runs/:runId/events
POST /runs/:runId/input
POST /runs/:runId/cancel
```

### Subscription login and native prompt caching

Flary can mount user-owned ChatGPT/Codex and Claude Pro/Max connections in the
same authenticated Worker. The host supplies identity and encrypted
persistence. Flary supplies the validated HTTP protocol and the provider login
operations.

```ts
import { createFlaryHostRouter } from "flary/host";

app.route("/v1", createFlaryHostRouter({
  authorize: async ({ request, appId }) => {
    const caller = await authenticateProductRequest(request);
    return {
      organizationId: caller.organizationId,
      actor: { id: caller.userId, kind: "user", version: "1" },
    };
  },
  service: threadService,
  providerOAuth: providerOAuthService,
}));
```

The matching `FlaryClient` methods are `startProviderOAuth`,
`getProviderOAuth`, `completeProviderOAuth`, `cancelProviderOAuth`, and
`disconnectProviderOAuthConnection`. A host can also use
`importEncryptedProviderCredential` to transfer an encrypted, user-owned
credential without returning a raw token through Flary. Hosted OpenAI login uses device
authorization by default. Local self-hosted clients can select
`browser_callback`. Claude uses authorization-code completion.

Flary `0.3.0-rc.4` pins `@flue/runtime` and `@flue/sdk` to
`1.0.0-beta.9`, and pins `@earendil-works/pi-ai` to `0.80.10`. Until the
required changes are available in upstream releases, the npm package applies
the checked-in patches during installation. Run `npm run test:npm-install`
before publishing. This test installs the packed Flary package in an empty
npm project and verifies both patched runtimes.

The three opt-in live provider tests are the stable-release gate. The release
candidate can be installed with `npm install flary@next`. Do not promote it to
the `latest` tag until those live tests pass with real subscription
connections.

The host must store private login state and credentials with authenticated
encryption. Public Flary schemas do not include PKCE verifiers, device
authorization IDs, access tokens, or refresh tokens.

Each thread can request `cacheRetention: "none" | "short" | "long"`. Flary
keeps one opaque cache affinity per provider lineage. Pi maps that policy to
the provider. `none` removes OpenAI prompt-cache affinity and Anthropic cache
control. Normalized usage reports cache reads and writes without exposing
provider credentials.

Define the Flue agent in the host application:

```ts
// src/agents/support.ts
import { defineFlaryAgent } from "flary/flue";

export default defineFlaryAgent<Env>({
  resolveContext: ({ env, id }) => env.RUN_BINDINGS.read(id),
  resolveAgent: ({ trusted }) =>
    envAgentRevision(trusted.tenantId, trusted.agentId, trusted.revisionId),
  resolveModel: ({ env, agent, trusted }) =>
    resolveTenantModel(env, trusted, agent.model),
  resolveTools: ({ env, agent, trusted }) =>
    resolveAllowedTools(env, trusted, agent.mode),
});
```

Mount the authenticated run router in the same Worker:

```ts
import { Hono } from "hono";
import { createFlaryRunRouter } from "flary/host";
import {
  createFlueAgentGateway,
  createFlueRunService,
} from "flary/flue";
import { D1FlaryRunRepository } from "flary/cloudflare";

const app = new Hono<{ Bindings: Env }>();

app.route(
  "/v1/agents/support",
  createFlaryRunRouter<Env>({
    resolveContext: async ({ request, env }) => {
      const caller = await authenticateProductRequest(request, env);
      return {
        tenantId: caller.tenantId,
        applicationId: "my-product",
        projectId: caller.projectId,
        agentId: "support",
        identity: { id: caller.userId, kind: "user" },
        roles: caller.roles,
        scopes: caller.scopes,
      };
    },
    service: (env, execution) =>
      createFlueRunService({
        repository: new D1FlaryRunRepository(env.DB),
        gateway: createFlueAgentGateway({
          baseUrl: "https://internal.flue",
          fetch: env.SELF.fetch.bind(env.SELF),
          headers: { "x-internal-token": env.FLUE_INTERNAL_TOKEN },
        }),
        schedule: (work) => execution.waitUntil(work),
      }),
  }),
);
```

Apply `FLARY_RUNS_D1_MIGRATION` through the host application's D1 migration
process. The D1 tables contain trusted run bindings, Flue admission receipts,
normalized replay events, and materialized results. They do not copy Flue's
canonical transcript.

The Flue submission continues after the original HTTP request disconnects.
Flary can restart event projection from the stored admission receipt after a
Worker restart. State-changing tools still need their own idempotency keys
because an interrupted external effect can have an unknown outcome.

Clients use only the stable Flary contract:

```ts
import { createFlaryRunClient } from "flary/client";

const runs = createFlaryRunClient({
  baseUrl: "https://api.example.com/v1/agents/support",
  token: productApiToken,
});

const run = await runs.create({
  requestId: crypto.randomUUID(),
  channelId: "ticket_42",
  input: { message: "How do I upgrade?" },
  idempotencyKey: crypto.randomUUID(),
});

for await (const event of runs.observe(run.runId)) {
  render(event);
}
```

## Parallel tools

```ts
import { executeToolTasks } from "flary/execution";

const report = await executeToolTasks(tasks, {
  profile: "fast",
  maxConcurrency: 8,
  readParallelism: 8,
  handlers: tools,
});
```

Independent reads run in parallel with `Promise.allSettled`. Writes to the
same resource run in order. The scheduler supports dependencies, approvals,
idempotency, concurrency caps, hard limits, and batched results.

## Modes, tools, and providers

Modes are Zod-backed permission profiles. They are not separate runtimes.
Flary includes `ask`, `plan`, `build`, and `review`:

```ts
import {
  BUILT_IN_AGENT_MODES,
} from "flary/contracts";
import { checkModeAccess } from "flary/execution";

const planMode = BUILT_IN_AGENT_MODES.plan;
const access = checkModeAccess(planMode, {
  capability: "project.file.write",
  operation: "write",
  resource: "src/App.tsx",
});
// access.allowed === false
```

Applications can define their own mode with `AgentModeSchema`. A mode cannot
grant itself a stronger permission profile. State-changing work is checked by
the mode policy and can require an application approval before execution.

Use `flary/tools` for lazy tool discovery. Search returns redacted metadata;
loading a capability returns a private handle. Secrets are resolved only for
the duration of a callback through a secret reference.

```ts
// src/tools/orders.ts
import { z } from "zod";
import { defineFlaryTool } from "flary/tools";

export const getOrder = defineFlaryTool({
  id: "orders.get",
  description: "Read one order",
  input: z.object({ orderId: z.string() }),
  output: z.object({ id: z.string(), status: z.string() }),
  capabilities: ["orders.read"],
  tags: ["orders"],
  secretRefs: ["ORDERS_TOKEN"],
  async execute({ orderId }, context) {
    return context.useSecret(
      "ORDERS_TOKEN",
      (token) => readOrder(orderId, token),
    );
  },
});
```

```ts
// src/tools/index.ts
import { defineFlaryToolset } from "flary/tools";
import { getOrder } from "./orders";

export default defineFlaryToolset([getOrder]);
```

Register the toolset in the host's trusted agent setup:

```ts
import {
  InMemoryToolCatalog,
  LazyToolRuntime,
} from "flary/tools";
import { createFlueLazyTools } from "flary/flue";
import tools from "./tools";

const catalog = new InMemoryToolCatalog({ secretProvider });
tools.register(catalog);

const runtime = new LazyToolRuntime({
  catalog,
  mode,
  approve: approvalService.require,
});

return createFlueLazyTools(runtime);
```

The model sees only four stable gateway schemas: `tool_search`,
`tool_describe`, `tool_call`, and `tool_batch`. Search returns short summaries
without input schemas. Describe loads one selected schema. Batch runs
independent reads in parallel and keeps writes to the same resource in order.
Write calls require an idempotency key. Approval-required tools fail closed
when the host does not provide an approval handler.

### Remote MCP connections

The host product owns connection records, OAuth, encrypted credentials,
organization access, billing, and the list of connections granted to a
thread. Flary owns MCP discovery, schema validation, lazy loading, durable
execution, limits, approvals, and normalized tool events.

```ts
import { SqliteToolExecutionJournal } from "flary/cloudflare";
import { createMcpTools } from "flary/mcp";

const tools = await createMcpTools({
  scope: trusted,
  endpoints: await productConnections.mcpEndpoints(trusted),

  // This callback runs only in trusted host code.
  credentials: ({ scope, endpoint }) =>
    productConnections.resolveCredential(scope, endpoint.connectionId),

  // Return false to keep a discovered tool out of this thread.
  permissions: ({ scope, endpoint, tool }) =>
    productConnections.resolveGrant(
      scope,
      endpoint.connectionId,
      tool.name,
    ),

  mode,
  runId,
  journal: new SqliteToolExecutionJournal(durableObjectStorage.sql),
  approve: ({ id }) => approvals.require(runId, id),
  onEvent: (event) => threadEvents.append(event),
});
```

`createMcpTools()` returns Flue's four lazy gateway tools. MCP input schemas
enter model context only after `tool_describe`. The credential resolver runs
only during protected discovery or invocation. Credential values are not
stored in descriptors, tool events, logs, or model-visible state.
Set the endpoint's opaque `credentialVersion` when a credential rotates so
Flary starts a new authenticated MCP session.

Every state-changing call needs a stable `idempotencyKey`. The journal
deduplicates completed calls. If a Worker stops after a write starts but
before its result is recorded, Flary reports `outcome_unknown` and does not
repeat the write. Independent reads run in parallel. Calls to the same
connection use a bounded concurrency key.

Use `createMcpToolset()` when MCP tools must share one private catalog with
native tools created by `defineFlaryTool()`. Flary also exports
`SqliteMcpDescriptorCache` for redacted descriptor caching across Durable
Object eviction.

Code Mode is optional. It is useful when the model must filter, join, or
transform several read results without putting all intermediate data in the
conversation. Normal tool calls do not need an isolate. Sandbox execution is
separate and is only for explicit Linux build, test, notebook, or deploy jobs.

### Structured user input

Flary owns the Zod schemas, durable pending state, and resume protocol for
`request_user_input`. The host application owns the form, dialog, terminal,
or chat UI.

```ts
import { createFlueRequestUserInputTool } from "flary/flue";

const askUser = createFlueRequestUserInputTool({
  threadKey,
  createRequest: ({ questions }) =>
    threadMetadata.createUserInputRequest({
      questions,
      requestedBy: agentIdentity,
    }),
});
```

The host lists pending requests and sends answers through the mounted thread
API. `FlaryThreadClient.userInput()` and
`FlaryThreadClient.respondToUserInput()` provide the matching client methods.
A live answer resumes the waiting tool call. If the Durable Object restarted,
Flary submits a bounded continuation message with the persisted answer.

Provider adapters keep the session contract stable while the selected provider
changes. `OpenAICompatibleAdapter` covers OpenAI-compatible endpoints such as
Cloudflare AI Gateway and Kimi. `CloudflareAIGatewayAdapter` adds the account
REST URL and authenticated Gateway headers for a connected Cloudflare account.
`AnthropicMessagesAdapter` covers the native Anthropic Messages API. Stream
events use one normalized contract.

```ts
import {
  AnthropicMessagesAdapter,
  CloudflareAIGatewayAdapter,
  OpenAICompatibleAdapter,
  ProviderAdapterRegistry,
} from "flary/providers";

const providers = new ProviderAdapterRegistry({
  adapters: [
    new OpenAICompatibleAdapter({
      id: "gateway",
      baseUrl: "https://gateway.example/v1",
      apiKey: process.env.AI_GATEWAY_TOKEN,
    }),
    new AnthropicMessagesAdapter({
      id: "anthropic",
      apiKey: process.env.ANTHROPIC_API_KEY,
    }),
    new CloudflareAIGatewayAdapter({
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID!,
      gatewayId: process.env.CLOUDFLARE_GATEWAY_ID!,
      apiToken: process.env.CLOUDFLARE_ACCESS_TOKEN!,
    }),
  ],
});
```

The adapters accept a normalized request. They translate output limits,
reasoning effort, tool schemas, tool calls, and streaming events to the
provider API. Provider secrets should come from Flary vault references in a
Worker, not from a prompt or a client bundle.

## Recall and session memory

Recall keeps retrieval separate from the transcript source of truth. Use
`RecallService` to search short results, then open the source by its scoped
reference:

```ts
const result = await recall.search({
  query: "the authentication decision we made last week",
  scope: { kind: "project", organizationId: "org_1", appId: "rend", projectId: "p_1" },
  mode: "hybrid",
  kinds: ["decision", "plan", "message", "file"],
  limit: 10,
});
```

The in-memory index supports deterministic exact and token-overlap retrieval
for tests and self-hosted deployments. `TurbopufferRecallIndex` adds BM25,
vector search, and reciprocal-rank fusion when configured. The index is
derived: every hit keeps its organization, application, project, session,
commit, file, line, and JSONL offset so access checks and source links remain
with the result.

There is no separate memory-write API. Thread entries, plans,
decisions, files, tool results, and checkpoints are the memory. They are
indexed after they are committed, and Recall opens the original session or
artifact record when the agent needs more context. Configure Turbopuffer with `TURBOPUFFER_API_KEY`,
`TURBOPUFFER_BASE_URL`, and `TURBOPUFFER_NAMESPACE` for derived indexing.

## Disconnect recovery

Flue accepts a prompt before it returns the stream coordinates. The thread
Durable Object then continues after a browser disconnect or Worker restart.
Applications reconnect with the returned offset. Completed tool results are
reused. An interrupted state-changing tool with no durable result is recorded
as an unknown outcome and is not repeated automatically.

### Trace and usage telemetry

Telemetry is append-only and uses W3C-compatible trace and span IDs. Model,
tool, retry, approval, cache, sandbox, artifact, run, and agent events carry
the parent span and run chain. Content is represented by a redacted reference
unless an application explicitly stores a separate artifact.

```ts
import { InMemoryTelemetryStore, createTraceContext } from "flary/telemetry";

const telemetry = new InMemoryTelemetryStore();
const traceContext = createTraceContext();
await telemetry.append({
  id: "model-event-1",
  occurredAt: new Date().toISOString(),
  runId: "run-1",
  traceContext,
  spanKind: "client",
  type: "model",
  payload: {
    action: "completed",
    model: { redacted: true, kind: "model", id: "openai/gpt-5" },
    usage: { inputTokens: 100, outputTokens: 40, totalTokens: 140 },
  },
});
const total = await telemetry.aggregateRun("run-1");
```

Cache tokens are reported separately and are not added to total tokens. Cost
uses integer micro-units, and unavailable provider billing is represented as
`{ state: "unknown" }`, never as zero. The Flue run adapter maps provider,
model, token, cache, tool, latency, retry, and cost data into Flary's normalized
run events. Host applications can also append those events to a telemetry
store or exporter.

## Isolated code execution

Use the common Zod contract for both short Code Mode plans and full Linux
commands:

```ts
import { CodeExecutionRouter } from "flary/execution";
import {
  CloudflareDynamicWorkerAdapter,
  CloudflareSandboxAdapter,
} from "flary/cloudflare";

const execution = new CodeExecutionRouter({
  adapters: [
    new CloudflareDynamicWorkerAdapter({ loader: env.LOADER }),
    new CloudflareSandboxAdapter({ binding: env.FLARY_SANDBOX }),
  ],
  onEvent: (event) => durableLog.append(event),
});
```

Set `runtime: "isolate"` for `code.plan`. Direct network access is blocked.
Set `runtime: "linux"` and use `sandbox.command` only when work needs package
installation, Git, Python, a build tool, or a longer process. The router
rejects an engine that conflicts with the declared runtime. The reference
Sandbox class also blocks public internet by default.

## Durable branch workspaces

Coding agents need a branch file tree even when they do not own a VM. Flary
provides a Zod-validated Shell workspace for each project branch:

```ts
const flary = new FlaryClient({
  baseUrl: "https://flary.example.com",
  appId: "rend",
  apiPrefix: "/api",
});

await flary.writeWorkspaceFile("project_123", "branch_main", {
  path: "src/Component.tsx",
  content: "export default function Component() { return <button>Go</button> }",
  mediaType: "text/typescript",
});

await flary.editWorkspaceFile("project_123", "branch_main", {
  path: "src/Component.tsx",
  edits: [{ oldText: ">Go<", newText: ">Continue<" }],
});
```

One SQLite-backed Durable Object owns each branch workspace. Files up to
1,500,000 bytes stay inline. Larger files use tenant-scoped,
content-addressed R2 objects. Every read checks the SHA-256 digest.

### Cloudflare Shell adapter

For Cloudflare Workers, use `ShellWorkspace` when a branch needs Shell's
SQLite-backed filesystem, state tools, or Git provider:

```ts
import { ShellWorkspace } from "flary/storage";
import { InMemoryToolCatalog, registerWorkspaceTools } from "flary/tools";

const workspace = new ShellWorkspace({
  sql: state.storage.sql,
  r2: env.WORKSPACE_BLOBS,
  scope: {
    organizationId: "org_123",
    appId: "rend",
    projectId: "project_123",
    workspaceId: "branch_main",
  },
  requireR2ForLargeFiles: true,
});

const catalog = new InMemoryToolCatalog();
registerWorkspaceTools(catalog, workspace);
```

The adapter keeps exactly `1,500,000` bytes in workspace SQLite. A file of
`1,500,001` bytes uses the tenant-scoped, content-addressed R2 key
`tenants/{organizationId}/applications/{appId}/projects/{projectId}/workspaces/{workspaceId}/blobs/{sha256}`.
Production rejects large writes when R2 is not configured. The adapter also
provides safe `glob`, `grep`, `diff`, and `batchEdit` operations. Git tools are
registered when the host supplies a credential-bound
`WorkspaceGitOperations` adapter; a model never receives a token, password,
or raw Shell provider.

The reference Cloud app exposes short-lived, single-use workspace transfer
tickets for large browser uploads and downloads. Create a ticket through the
authenticated API, then use the returned `uploadUrl` or `downloadUrl` before
it expires. The Worker validates the tenant, project branch, path, size, and
SHA-256 digest again at the transfer boundary.

## Secrets

```ts
import { createSecretsContext } from "flary/vault";

const secrets = createSecretsContext({ provider });

await secrets.with("OPENAI_API_KEY", async (value) => {
  await callProvider(value);
});
```

A missing secret creates a resumable pause event. Secret values do not enter
the prompt, event log, or error record. Envelope encryption uses AES-256-GCM.

## Durable thread integration

The Cloud reference app uses one immutable `ThreadBinding` per Flue agent
instance. Bindings fix the organization, application, project branch, agent,
and connection grants. A workspace change creates or forks a new thread.
Turns are admitted through the Flary API, which records an idempotency key and
the exact model and reasoning choice before forwarding the request to Flue.
The pinned Flue patch keeps those values with the durable submission during
recovery.

Use `FlaryThreadClient` for application integrations:

```ts
const thread = createFlaryThreadClient({ baseUrl: "https://flary.example.com" });

await thread.submit(ref, {
  message: "Inspect the failing tests",
  model: { provider: "anthropic", model: "claude-sonnet" },
  thinkingLevel: "high",
  idempotencyKey: "request_123",
});

const stream = thread.observe(ref, { live: "sse" });
```

The stream can be closed and reopened later. Flue remains the transcript and
execution authority. Flary metadata stores approvals, provider handoff data,
mode state, and replay cursors beside it.

## Package surfaces

- `flary/client`
- `flary/cloudflare`
- `flary/contracts`
- `flary/execution`
- `flary/flue`
- `flary/history`
- `flary/host`
- `flary/mcp`
- `flary/prompts`
- `flary/providers`
- `flary/recall`
- `flary/storage`
- `flary/subagents`
- `flary/telemetry`
- `flary/tools`
- `flary/vault`

## Storage model

- Durable Object SQLite: canonical threads, turns, operations, tools, events,
  approvals, and run state.
- R2: large attachments, artifacts, snapshots, and archives.
- D1: tenant, application, thread, and run indexes.
- Secrets Store plus a tenant vault Durable Object: encryption roots, provider
  keys, and OAuth tokens.

The canonical record stream supports deterministic JSONL import and export.

## Flary Cloud and self-hosting

The reusable runtime stays in this package. The reference Cloudflare control
plane lives in `apps/cloud` and is intentionally separate from the runtime:

- Better Auth and organization membership provide the control-plane identity.
- Drizzle manages the D1 schema and migrations.
- D1 stores tenant, app, prompt, and connection indexes.
- R2 stores prompt source and large artifacts.
- A SQLite-backed Durable Object serializes events for each organization.
- A native Flue agent Durable Object owns each canonical thread, accepted
  prompt, event stream, attachment, and recovery state.
- A SQLite-backed branch-workspace Durable Object stores metadata and small
  files; content-addressed R2 objects store large files.
- Dynamic Workers run short Code Mode plans with direct network access blocked.
- Sandboxes run full Linux workloads with public internet blocked by default.

The native Flue route is mounted at
`/api/flue/agents/flary-thread/{threadName}`. `FlaryThreadAgent` performs
Better Auth and organization/app authorization before Flue accepts a prompt.
Flue owns the canonical thread transcript, accepted submissions, stream,
attachments, and execution recovery. Flary stores only operational metadata
beside it: approvals, mode, usage, provider cursors, sandbox jobs, and run
references. This prevents a second transcript from drifting out of sync.

The reference app also mounts one workspace Durable Object per
`organizationId + appId + projectId + workspaceId`. Use `workspaceId` as an
opaque branch/workspace identity. Keep `main` and agent branches in different
workspace IDs so concurrent agents cannot write the same SQLite namespace.

Build the reference app locally:

```bash
pnpm --dir apps/cloud typecheck
pnpm --dir apps/cloud build
```

The starter wizard in `packages/create-flary` copies the reference app,
creates local secrets, and prints the Cloudflare setup steps. Hosted Flary
users do not connect Cloudflare. A self-hosted operator signs in to Cloudflare
once to deploy and own the complete stack. Run it with:

```bash
pnpm dlx create-flary --yes ./my-flary-app
```

Add `--provision` after `wrangler login` to create the D1 database and R2
bucket, write production secrets, apply migrations, and deploy the Worker.

## License

Apache-2.0

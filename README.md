# Flary

**Build durable AI agents in TypeScript. Deploy them to your Cloudflare account.**

Flary is an open-source framework for typed AI functions and persistent agent threads. It supplies
tools, MCP and OpenAPI connections, approvals, durable history, workspaces, provider switching,
subagents, and realtime events. You own the Worker, Cloudflare resources, provider accounts,
secrets, and data.

Flary does not need a VPS. It generates the Cloudflare Worker and durable resources that your
project uses.

## Create a project

```bash
npx flary create
```

The guided command asks what you want to build:

- **Personal dashboard:** first-owner login, a WebSocket-first durable thread console, provider
  setup, and secret-health status.
- **Agent backend:** typed functions and persistent agents for an existing website, CMS, bot, or
  application.
- **Flary Mail:** a self-hosted business inbox with inbound mail, replies, drafts, sent mail, team
  members, attachments, and live updates.

It then signs in with Wrangler OAuth, lets you choose an AI provider, creates the required
Cloudflare resources, uploads secrets, deploys, and checks the result. Browser Run and Sandbox are
optional. The default setup does not need Docker.

For an automated setup:

```bash
npx flary create my-flary \
  --template backend \
  --provider openai \
  --package-manager npm \
  --deploy \
  --yes
```

Use `flary init` instead when you only want typed Flary files in an existing project and do not want
Flary to change its deployment system.

### Create a mail inbox

```bash
npx flary create my-mail \
  --template mail \
  --domain example.com \
  --mailboxes admin,support \
  --package-manager npm \
  --deploy \
  --yes
```

Flary uses Wrangler OAuth. You do not need a Flary API key or a separate OAuth client for the CLI
flow. The deploy command enables Email Routing and Email Sending for the domain. Enabling Email
Routing replaces the domain's MX records, so use a domain that does not already receive mail
elsewhere.

Mail data stays in your Cloudflare account. D1 stores mailbox state and message metadata. R2 stores
raw messages and attachments. A Queue handles parse and send work. One hibernating Durable Object
per mailbox sends WebSocket updates to connected inbox clients. The responsive web UI uses Tailwind
CSS and is ready for shadcn/ui components. KV is not used.

Cloudflare also offers outbound SMTP submission at `smtp.mx.cloudflare.net:465`. It does not offer
IMAP or POP, so external mail client synchronization requires a separate IMAP/JMAP or provider
bridge.

## A typed function

A function is one finite, typed operation. Zod validates its input and output.

```ts
import { flary, z } from "flary";

const app = flary({ model: "openai/gpt-5" });

export const summarize = app.fn({
  input: z.object({ text: z.string().min(1) }),
  output: z.object({ summary: z.string() }),
  prompt: ({ text }) => `
    Summarize this text.
    Return JSON with one summary string.

    ${text}
  `,
});

const result = await summarize({ text: "The quarter closed above plan." });
```

## A persistent agent

An agent defines persistent behavior. Each thread has durable messages, tools, approvals, usage, and
recovery state.

```ts
const tools = app.tools({
  searchDocs: app.fn({
    description: "Search product documentation",
    input: z.object({ query: z.string().min(1) }),
    output: z.array(
      z.object({
        title: z.string(),
        url: z.string().url(),
      }),
    ),
    run: ({ query }) => searchDocumentation(query),
  }),
  github: app.mcp("github"),
});

export const support = app.agent({
  name: "support",
  instructions: "Help the customer. Use product sources when facts matter.",
  tools,
});
```

The model starts with one bounded `execute` tool and protected user-input and secret controls. Every
persistent agent also gets lazy public `web_search` and `web_fetch` through Parallel's anonymous
Search MCP. Application, MCP, OpenAPI, workspace, and Sandbox tools stay in a private catalog. Code
Mode can search the catalog, load one selected schema, call a tool, or batch independent reads.
Adding many tools does not place every schema in every model request. Set `web: false` on the
application or agent when public web access is not allowed.

Read [Tools, MCP, and OpenAPI](https://flary.dev/docs/tools/) for the exact default tool surface,
lazy discovery flow, approvals, and audit records.

Serve the function and agent from one generated Worker:

```ts
export const functions = { summarize, support };
export default app.serve(functions);
```

Your web UI, Telegram bot, Discord bot, mobile app, or backend can open a thread, send messages,
stream events, reconnect from a cursor, and respond to approvals. You do not write a route for each
agent operation.

### Persistent files

Give each thread a durable serverless filesystem with one option:

```ts
export const writer = app.agent({
  name: "writer",
  workspace: "thread",
  instructions: "Create and edit the requested files.",
});
```

The agent receives lazy `workspace` tools for list, stat, glob, grep, read, diff, write, edit,
apply-patch, batch-edit, copy, move, delete, and Git. Small files stay in Durable Object SQLite.
Large files spill to R2. Flary restores the same workspace when the thread resumes and creates a
checkpoint after each turn.

Use `workspace: "project"` when authenticated threads in one tenant project must share the same
files. Use the detailed form to set draft-write policy, hidden paths, branches, or a custom
namespace:

```ts
workspace: {
  scope: "thread",
  mode: "draft",
  hiddenPaths: [".private"],
}
```

Add `app.sandbox()` to the normal tool registry when the agent must run builds, tests, or long-lived
processes against `/workspace`.

## Core terms

- **Function:** one finite typed operation.
- **Agent:** a persistent behavior definition.
- **Thread:** one durable conversation with an agent.
- **Run:** one finite function invocation.
- **Workspace:** files and Git state for agent work.
- **Connection:** an authorized provider, MCP, or API account.

## Documentation

1. [Quickstart](https://flary.dev/docs/quickstart/)
2. [Deploy to your Cloudflare account](https://flary.dev/docs/deploy/)
3. [Functions](https://flary.dev/docs/functions/)
4. [Persistent agents](https://flary.dev/docs/agents/)
5. [Tools, MCP, and OpenAPI](https://flary.dev/docs/tools/)
6. [Build your UI or bot](https://flary.dev/docs/clients/)
7. [Threads and realtime clients](https://flary.dev/docs/threads/)
8. [Storage and recovery](https://flary.dev/docs/storage-and-recovery/)
9. [Tracked product agent](https://flary.dev/docs/examples/tracked-agent/)
10. [Florist storefront agent](https://flary.dev/docs/examples/florist-agent/)

Advanced low-level modules remain available from focused package exports. Most applications should
start with `flary()`, `app.fn()`, `app.agent()`, `app.tools()`, and the generated host.

## Project policies

- [Architecture](ARCHITECTURE.md)
- [Changelog](CHANGELOG.md)
- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)
- [Node.js version policy](NODE_VERSION_POLICY.md)

## License

Apache-2.0

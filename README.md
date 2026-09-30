# Flary

**Install AI apps and email in your own Cloudflare account.**

Choose a personal AI dashboard, a self-hosted team inbox, or an agent backend for your existing
product. Flary guides you through account setup, creates the project, provisions its resources,
deploys, and checks the result. Each choice gives you a separate application you can customize.

For developers, Flary is also a TypeScript framework for agents that keep working across
conversations, use tools, ask for approval, and preserve their files. Define typed functions and
agents, then connect your application through the clients or React components.

You own the Worker, storage, provider accounts, secrets, and data. The generated deployment uses
Cloudflare's durable resources and does not require a VPS. Cloudflare and model-provider usage are
billed through your accounts.

Read [the full package](https://flary.dev/docs/overview/),
[the Mail guide](https://flary.dev/docs/mail/), or
[the Flue and Agents SDK comparison](https://flary.dev/docs/why-flary/).

## What Flary provides

| Capability                         | What you can build with it                                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Typed functions                    | Finite operations with validated inputs and outputs, called from your application.                                             |
| Persistent agent threads           | Assistants that retain conversation state, resume work, and stream events to reconnecting clients.                             |
| Tools, MCP, and OpenAPI            | Agents that discover and call application actions and connected services without loading every tool schema into every request. |
| Approvals, user input, and secrets | Workflows that pause for a human decision or missing information and continue through the same thread.                         |
| Durable workspaces                 | Agents that read and edit files, keep Git state, and recover their workspace when a thread resumes.                            |
| Models and subagents               | Provider adapters, model selection policies, and delegation to specialized agents.                                             |
| Prompts and skills                 | Markdown prompts with typed placeholders, explicit compilation, revisions, rollout selection, and reusable instructions.       |
| Automation and evaluation          | Thread schedules, evaluation helpers, recall adapters, usage tracking, and execution telemetry.                                |
| Browser and Sandbox adapters       | Optional web interaction and command execution when your deployment supplies the required resources.                           |
| Clients and deployment             | HTTP and realtime clients, React bindings, a local installer, and generated Cloudflare projects.                               |
| Mail application                   | A separate starter for a business inbox with inbound mail, sending, attachments, team access, and live updates.                |

Mail is one application you can deploy with Flary. The framework also supports product assistants,
support agents, document-writing agents, and backend AI operations inside an existing application.
You supply the business logic, data sources, and authorized connections those agents need.

## When to use Flary

Flary is a good fit when you want a TypeScript application with persistent agents, tool access,
human approvals, and files on Cloudflare. Its value is the integration: one authoring API, a host
protocol your UI can consume, durable state, and a generated deployment.

A single text-generation call may only need a provider SDK. An existing application with its own
agent host can use Flary's focused exports without adopting the generated project templates.

## How Flary relates to Flue

Flary builds on [Flue](https://github.com/withastro/flue) for its canonical agent session runtime.
Flue already provides agent authoring, durable execution, tools, sandboxes, and deployment options,
including Cloudflare. Those capabilities overlap; Flary does not claim them as exclusive features.

Flary adds its `flary()`, `app.fn()`, and `app.agent()` API, application and tenant controls,
protected tool execution, workspace and connection adapters, clients, onboarding, and starter
applications around that runtime. Choose Flary when that assembled application layer matches what
you need. Choose Flue directly when you prefer its harness API and deployment model.

Cloudflare's [Agents SDK](https://developers.cloudflare.com/agents/) also provides durable state,
realtime connections, scheduling, recovery, tools, and starter apps. Flary's focus is its own
authoring API and the assembled path to a dashboard, backend, or team inbox. Its value is the
application integration and setup; we have not published comparative performance benchmarks.

## Beginner quick start from a clone

Run the local setup assistant from the repository:

```bash
git clone https://github.com/rdvo/flary.git
cd flary
npm run setup
```

The launcher checks for Node.js `22.19.0` or newer, updates dependencies when needed using the
pinned pnpm `8.15.4` lockfile, builds the CLI when needed, and opens the browser assistant at
`http://127.0.0.1:43817`. It creates the generated project outside the checkout at `~/flary-project`
by default, so an existing checkout and its Git state stay safe. The browser guides you through
**Your assistant**, **Connect accounts**, **Launch**, and **Try it**. Wrangler OAuth is selected
automatically as the account connection when you have not configured a custom Cloudflare OAuth
client.

See the [local quick start](docs/quickstart.md) for recovery, the optional project-directory
argument, and advanced OAuth setup.

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

## Prompts in Markdown

Keep a prompt in TypeScript or a `.prompt.md` file. Markdown prompts support YAML frontmatter and
simple placeholders such as `{{question}}` and `{{customer.name}}`:

```md
---
input:
  question: string
---

Answer this question:

{{question}}
```

Load the file as text, then call `compilePrompt` from `flary/prompts` with its path, content, and
input values. Pass `compiled.rendered` to your function or agent. The compiler validates inputs; it
does not automatically apply model, tool, or limit metadata to your application.

The Vite plugin does not automatically discover prompt files, and inline strings do not render
`{{variables}}`. Loops, conditions, includes, and executable macros are not supported. See
[Prompts and skills](https://flary.dev/docs/prompts/) for a complete integration example.

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

For a web app, use `FlaryAgentConsole` from `flary/react` for the ready thread UI. Assistant answers
render Markdown while streaming, with readable headings, lists, tables, and code blocks with copy
buttons. Styles are included. Use `FlaryMarkdown` in your own layout to get the same rendering. See
[the React UI guide](https://flary.dev/docs/clients/) for examples.

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

## Current scope and gaps

- **Knowledge ingestion:** durable files and R2 tools are available, but the local installer does
  not yet provide a PDF/image upload, OCR, indexing, and cited retrieval pipeline. Connect or build
  that pipeline for your corpus.
- **Connections:** MCP and provider connection primitives are available. Each integration still
  needs its credentials, permissions, and application-specific setup; this is not a universal
  connector marketplace.
- **Cloudflare login:** the standard setup uses Wrangler OAuth. A Flary-branded OAuth client remains
  an optional configuration, rather than the default connection flow.
- **Application channels:** clients can connect your UI or bot to an agent. Telegram, Discord, and
  other channel integrations require application code and are not included as finished templates.
- **Validation:** the repository contains contract, restart, adapter, and packed-consumer checks.
  Live provider tests require configured credentials. Flary does not publish comparative cost,
  speed, or reliability benchmarks against Flue.

See the [architecture](ARCHITECTURE.md) for runtime ownership and the [changelog](CHANGELOG.md) for
released changes.

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

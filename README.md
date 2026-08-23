# Flary

## Quick start

Create a Worker and your first chat widget with the local setup assistant:

```bash
npx flary quickstart my-flary-widget
```

The assistant connects to your Cloudflare account, creates a Gemini-backed
agent, previews the widget, provisions the required resources, deploys the
Worker, verifies it, and prints HTML and React integration code. Credentials
stay in the local process, protected local files, Wrangler, and Worker
secrets. See [the local quick-start guide](docs/quickstart.md).

**Build durable AI agents in TypeScript. Deploy them to your Cloudflare account.**

Flary is an open-source framework for typed AI functions and persistent agent
threads. It supplies tools, MCP and OpenAPI connections, approvals, durable
history, workspaces, provider switching, subagents, and realtime events. You
own the Worker, Cloudflare resources, provider accounts, secrets, and data.

Flary does not need a VPS. It generates the Cloudflare Worker and durable
resources that your project uses.

## Create a project

```bash
npx flary create
```

The guided command asks what you want to build:

- **Personal dashboard:** first-owner login, a WebSocket-first durable thread console,
  provider setup, and secret-health status.
- **Agent backend:** typed functions and persistent agents for an existing
  website, CMS, bot, or application.

It then signs in with Wrangler OAuth, lets you choose an AI provider, creates
the required Cloudflare resources, uploads secrets, deploys, and checks the
result. Browser Run and Sandbox are optional. The default setup does not need
Docker.

For an automated setup:

```bash
npx flary create my-flary \
  --template backend \
  --provider openai \
  --package-manager npm \
  --deploy \
  --yes
```

Use `flary init` instead when you only want typed Flary files in an existing
project and do not want Flary to change its deployment system.

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

const result = await summarize({ text: "A long document..." });
```

## A persistent agent

An agent defines persistent behavior. Each thread has durable messages, tools,
approvals, usage, and recovery state.

```ts
const tools = app.tools({
  searchDocs: app.fn({
    description: "Search product documentation",
    input: z.object({ query: z.string().min(1) }),
    output: z.array(z.object({
      title: z.string(),
      url: z.string().url(),
    })),
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

Serve the function and agent from one generated Worker:

```ts
export const functions = { summarize, support };
export default app.serve(functions);
```

Your web UI, Telegram bot, Discord bot, mobile app, or backend can open a
thread, send messages, stream events, reconnect from a cursor, and respond to
approvals. You do not write a route for each agent operation.

### Persistent files

Give each thread a durable serverless filesystem with one option:

```ts
export const writer = app.agent({
  name: "writer",
  workspace: "thread",
  instructions: "Create and edit the requested files.",
});
```

The agent receives lazy `workspace` tools for list, stat, glob, grep, read,
diff, write, edit, apply-patch, batch-edit, copy, move, delete, and Git. Small
files stay in Durable Object SQLite. Large files spill to R2. Flary restores
the same workspace when the thread resumes and creates a checkpoint after each
turn.

Use `workspace: "project"` when authenticated threads in one tenant project
must share the same files. Use the detailed form to set draft-write policy,
hidden paths, branches, or a custom namespace:

```ts
workspace: {
  scope: "thread",
  mode: "draft",
  hiddenPaths: [".private"],
}
```

Add `app.sandbox()` to the normal tool registry when the agent must run builds,
tests, or long-lived processes against `/workspace`.

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

Advanced low-level modules remain available from focused package exports. Most
applications should start with `flary()`, `app.fn()`, `app.agent()`,
`app.tools()`, and the generated host.

## License

Apache-2.0

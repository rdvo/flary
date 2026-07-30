# Getting started

Flary has two usable layers:

1. Prompt files and typed contracts can run in any TypeScript application.
2. Durable agent threads run in a Cloudflare Worker with Durable Objects.

Start with the smallest layer that your application needs.

## Install

Flary is currently a release candidate. Pin the exact version in production.

```bash
npm install --save-exact flary@0.3.0-rc.5
```

Add a prompt example to an existing project:

```bash
npx flary init
```

Create a small Cloudflare Worker starter:

```bash
npx flary create my-agent
cd my-agent
npm install
npm run dev
```

The starter proves the prompt-file path first. It does not create production
Cloudflare resources. Follow the [support bot](./examples/support-bot.md) or
[coding agent](./examples/coding-agent.md) guide when you add durable threads.

## Use a prompt file without Cloudflare

Create `prompts/support/answer.prompt.md`:

```md
---
model: inherit
thinking: medium
tools:
  - docs.search

input:
  customer.name: string
  question: string
---

Answer {{customer.name}} with a concise, sourced response:

{{question}}
```

Compile it in your application:

```ts
import { readFile } from "node:fs/promises";
import { compilePrompt } from "flary/prompts";

const path = "prompts/support/answer.prompt.md";
const prompt = await compilePrompt(
  {
    path,
    content: await readFile(path, "utf8"),
  },
  {
    callerModel: "openai/gpt-5.6",
    values: {
      customer: { name: "Ada" },
      question: "How do I change my plan?",
    },
  },
);
```

This path needs no Durable Object, D1 database, or R2 bucket.

## Add the durable runtime

A production durable thread uses:

- A Cloudflare Worker as the host.
- One Flue Durable Object for each thread.
- D1 for trusted run bindings, replay events, and materialized results.
- R2 only when the application stores large workspace files or uses the R2
  history fallback.

Your host application supplies authentication, tenant mapping, provider
credentials, and product policy. Flary supplies the typed run API, durable
execution adapter, tool runtime, modes, approvals, and event stream.

Read [Cloudflare resources](./cloudflare-resources.md) before deployment.

## Call the stable run API

```ts
import { createFlaryRunClient } from "flary/client";

const runs = createFlaryRunClient({
  baseUrl: "https://api.example.com/v1/agents/support",
  token: process.env.PRODUCT_API_TOKEN,
});

const run = await runs.create({
  requestId: crypto.randomUUID(),
  channelId: "ticket_42",
  input: { message: "How do I change my plan?" },
  idempotencyKey: crypto.randomUUID(),
});

for await (const event of runs.observe(run.runId)) {
  console.log(event);
}
```

If the client disconnects, call `observe()` again with the last event
sequence. Flary replays stored normalized events before it streams new events.


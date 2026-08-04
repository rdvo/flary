# Clean authoring syntax proposal

Status: design only. The public documentation must use the current API until
one of these forms is implemented and released.

## Design rules

1. The first example must have no runtime limits, durability settings, model
   routing, or policy objects.
2. The application supplies safe defaults for model selection, compaction,
   durability, replay, and limits.
3. The method name states intent: prompt, read, write, or agent.
4. Zod remains the runtime contract for input and output.
5. Advanced controls are optional modifiers, not fields in every definition.
6. Local and remote calls use the same authored value.

## Recommended direction: verbs with optional modifiers

### Application

```ts
import { flary, z } from "flary";

export const app = flary("openai/gpt-5");
```

The object form remains available when an application needs bindings,
authentication, or provider routing.

### Native read tool

```ts
const Doc = z.object({
  title: z.string(),
  url: z.url(),
  excerpt: z.string(),
});

export const searchDocs = app.read(
  "Search product documentation",
  z.object({ query: z.string().min(1) }),
  z.array(Doc),
  ({ query }) => docs.search(query),
);
```

`read` means no approval by default. It replaces a repeated policy object.

### Native write tool

```ts
export const refundOrder = app.write(
  "Refund an order",
  z.object({ orderId: z.string() }),
  Receipt,
  ({ orderId }, context) => billing.refund(orderId, context.idempotencyKey),
);
```

`write` means approval and idempotency by default. A product can relax the
approval only through a trusted application policy.

### Prompt function

```ts
export const support = app.prompt(
  z.object({ question: z.string().min(1) }),
  z.object({
    answer: z.string(),
    sources: z.array(z.url()),
  }),
  ({ question }) => `Answer with product facts and sources.\n\n${question}`,
).using(searchDocs, github);
```

The value stays callable:

```ts
const answer = await support({ question: "How do I upgrade?" });
```

### Persistent agent

```ts
export const coder = app.agent(
  "coder",
  "Help the user complete coding work. Inspect files before changing them.",
).using(workspace, shell, github);
```

The application model, automatic compaction, durable recovery, and safe
limits apply without extra fields.

### MCP and OpenAPI

```ts
const github = app.mcp("github");
const billing = app.api("billing", "./openapi/billing.yaml");

export const tools = app.tools(searchDocs, github, billing);
```

Names come from the declared tool or connection. `app.tools()` rejects a
duplicate name.

### Advanced controls stay readable

```ts
export const coder = app.agent(
  "coder",
  "Implement the task and verify the result.",
)
  .using(workspace, shell, github)
  .models("openai/gpt-5", "anthropic/claude-sonnet")
  .subagents({ reviewer })
  .budget("team");
```

`budget("team")` is a named application preset. The common path does not show
raw step, token, cost, child, and tool-call numbers.

## Alternative A: one compact object

This is closest to the current API and has the smallest implementation cost:

```ts
export const coder = app.agent({
  name: "coder",
  does: "Implement the task and verify the result.",
  uses: [workspace, shell, github],
});
```

It is easy to type, but large definitions can become another configuration
object. Prefer this only if method chaining is rejected.

## Alternative B: schema-first builders

```ts
export const support = app
  .prompt("Answer product questions")
  .takes({ question: z.string().min(1) })
  .returns({ answer: z.string(), sources: z.array(z.url()) })
  .using(searchDocs, github)
  .run(({ question }) => `Answer with sources.\n\n${question}`);
```

This reads well, but it creates more intermediate builder types and makes some
TypeScript errors harder to understand.

## Recommendation

Prototype the verb API as additive overloads:

- `flary(model)`
- `app.read(description, input, output, run)`
- `app.write(description, input, output, run)`
- `app.prompt(input, output, prompt)`
- `app.agent(name, instructions)`
- `app.api(namespace, spec)`
- `app.tools(...sources)`

Keep the current object API as the complete low-level form. Compile both forms
into the same internal definitions. Do not create a second runtime.

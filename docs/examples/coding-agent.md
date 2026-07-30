# Coding agent

A coding agent uses the same thread runtime as a support bot. The difference
is its workspace, mode, and tool policy.

## Define lazy tools

```ts
import {
  createFlueLazyTools,
  createFlueRequestUserInputTool,
  defineFlaryAgent,
} from "flary/flue";

export default defineFlaryAgent<Env>({
  resolveContext: ({ env, id }) => env.RUN_BINDINGS.read(id),

  resolveAgent: ({ trusted }) => ({
    agentId: "coding",
    revisionId: trusted.revisionId,
    instructions:
      "Inspect the bound workspace. Make small changes, run checks, " +
      "and report the exact files changed.",
    model: {
      provider: "openai",
      model: "gpt-5.6-codex",
      cacheRetention: "short",
    },
    thinkingLevel: "high",
    mode: "build",
  }),

  resolveModel: ({ env, agent, trusted }) =>
    env.MODELS.resolve(trusted, agent.model),

  resolveTools: ({ env, trusted }) => [
    ...createFlueLazyTools(env.TOOLS.lazyRuntime(trusted)),
    createFlueRequestUserInputTool(env.INPUT.forThread(trusted)),
  ],
});
```

The model sees a small fixed surface:

- `tool_search`
- `tool_describe`
- `tool_call`
- `tool_batch`
- `request_user_input`

Tool schemas load only after search or describe. `tool_batch` runs independent
reads in parallel. Writes to the same resource run in order.

## Register application tools

```ts
import { InMemoryToolCatalog } from "flary/tools";

export function createWorkspaceTools(workspace: Workspace) {
  const catalog = new InMemoryToolCatalog();

  catalog.register({
    definition: {
      id: "workspace.read_file",
      name: "Read file",
      description: "Read one file from the bound workspace.",
      kind: "native",
      operation: "read",
      capabilities: ["file.read"],
      tags: ["files", "read"],
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
    },
    execute: ({ path }: { path: string }) => workspace.read(path),
  });

  catalog.register({
    definition: {
      id: "workspace.apply_patch",
      name: "Apply patch",
      description: "Apply one checked patch to the bound branch.",
      kind: "native",
      operation: "write",
      capabilities: ["file.write"],
      tags: ["files", "write"],
      requiresApproval: true,
    },
    resourceKey: "workspace",
    execute: (input: PatchInput) => workspace.applyPatch(input),
  });

  return catalog;
}
```

The host can register native tools and use `createMcpTools()` for authorized
remote MCP servers. Raw credentials stay in trusted host code.

## Modes

Flary includes `ask`, `plan`, `build`, and `review` modes. Modes are Zod-backed
permission profiles, not separate runtimes.

```ts
import { resolveAgentMode } from "flary";

const plan = resolveAgentMode("plan");
const build = resolveAgentMode("build");
```

Plan Mode can write only plan artifacts. Build Mode can write the bound
workspace, but risky operations can still require approval. A model cannot
grant itself a stronger mode.


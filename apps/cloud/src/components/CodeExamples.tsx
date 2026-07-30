import Editor, { loader } from "@monaco-editor/react";
import { RotateCcw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

type Example = {
  id: string;
  label: string;
  filename: string;
  language: string;
  code: string;
};

type ExampleGroup = {
  id: "support" | "coding";
  label: string;
  description: string;
  examples: Example[];
};

const groups: ExampleGroup[] = [
  {
    id: "support",
    label: "Support bot",
    description: "A durable support thread with a prompt file and a stable client API.",
    examples: [
      {
        id: "support-prompt",
        label: "Prompt",
        filename: "prompts/support/answer.prompt.md",
        language: "markdown",
        code: `---
model: inherit
thinking: medium
tools:
  - docs.search

input:
  customer.name: string
  question: string

limits:
  steps: 12
  tools: 20
---

Answer {{customer.name}} with a concise response.
Use docs.search for product facts and include the source.

Question:
{{question}}`,
      },
      {
        id: "support-agent",
        label: "Agent",
        filename: "src/agents/support.ts",
        language: "typescript",
        code: `import { defineFlaryAgent } from "flary/flue";

export default defineFlaryAgent<Env>({
  resolveContext: ({ env, id }) =>
    env.RUN_BINDINGS.read(id),

  resolveAgent: ({ trusted }) => ({
    agentId: "support",
    revisionId: trusted.revisionId,
    instructions:
      "Resolve the request with approved support tools. " +
      "Ask before changing customer data.",
    model: { provider: "anthropic", model: "claude-sonnet-4-5" },
    thinkingLevel: "medium",
    mode: "build",
  }),

  resolveModel: ({ env, agent, trusted }) =>
    env.MODELS.resolve(trusted, agent.model),

  resolveTools: ({ env, trusted }) =>
    env.TOOLS.forThread(trusted),
});`,
      },
      {
        id: "support-worker",
        label: "Worker",
        filename: "src/index.ts",
        language: "typescript",
        code: `import { Hono } from "hono";
import { D1FlaryRunRepository } from "flary/cloudflare";
import {
  createFlueAgentGateway,
  createFlueRunService,
} from "flary/flue";
import { createFlaryRunRouter } from "flary/host";

const app = new Hono<{ Bindings: Env }>();

app.route("/v1/agents/support", createFlaryRunRouter<Env>({
  resolveContext: async ({ request, env }) => {
    const user = await authenticateProductRequest(request, env);
    return {
      tenantId: user.organizationId,
      applicationId: "support-console",
      agentId: "support",
      identity: { id: user.id, kind: "user" },
      roles: user.roles,
      scopes: user.scopes,
    };
  },
  service: (env, execution) => createFlueRunService({
    repository: new D1FlaryRunRepository(env.DB),
    gateway: createFlueAgentGateway({
      baseUrl: "https://internal.flue",
      fetch: env.SELF.fetch.bind(env.SELF),
    }),
    schedule: (work) => execution.waitUntil(work),
  }),
}));

export default app;`,
      },
      {
        id: "support-client",
        label: "Client",
        filename: "src/lib/support.ts",
        language: "typescript",
        code: `import { createFlaryRunClient } from "flary/client";

const runs = createFlaryRunClient({
  baseUrl: "/v1/agents/support",
});

const run = await runs.create({
  requestId: crypto.randomUUID(),
  channelId: "ticket_42",
  input: {
    customer: { name: "Ada" },
    question: "How do I change my plan?",
  },
  idempotencyKey: crypto.randomUUID(),
});

for await (const event of runs.observe(run.runId)) {
  renderEvent(event);
}`,
      },
    ],
  },
  {
    id: "coding",
    label: "Coding agent",
    description: "A branch-scoped agent with lazy tools, modes, and structured user input.",
    examples: [
      {
        id: "coding-agent",
        label: "Agent",
        filename: "src/agents/coding.ts",
        language: "typescript",
        code: `import {
  createFlueLazyTools,
  createFlueRequestUserInputTool,
  defineFlaryAgent,
} from "flary/flue";

export default defineFlaryAgent<Env>({
  resolveContext: ({ env, id }) =>
    env.RUN_BINDINGS.read(id),

  resolveAgent: ({ trusted }) => ({
    agentId: "coding",
    revisionId: trusted.revisionId,
    instructions:
      "Inspect the bound workspace. Make small changes, " +
      "run checks, and report the exact files changed.",
    model: { provider: "openai", model: "gpt-5.6-codex" },
    thinkingLevel: "high",
    mode: "build",
  }),

  resolveModel: ({ env, agent, trusted }) =>
    env.MODELS.resolve(trusted, agent.model),

  resolveTools: ({ env, trusted }) => [
    ...createFlueLazyTools(env.TOOLS.lazyRuntime(trusted)),
    createFlueRequestUserInputTool(
      env.INPUT.forThread(trusted),
    ),
  ],
});`,
      },
      {
        id: "coding-tools",
        label: "Tools",
        filename: "src/tools/catalog.ts",
        language: "typescript",
        code: `import { InMemoryToolCatalog } from "flary/tools";

export function createWorkspaceTools(workspace: Workspace) {
  const tools = new InMemoryToolCatalog();

  tools.register({
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
    execute: ({ path }: { path: string }) =>
      workspace.read(path),
  });

  tools.register({
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
    execute: (input: PatchInput) =>
      workspace.applyPatch(input),
  });

  return tools;
}`,
      },
      {
        id: "coding-modes",
        label: "Modes",
        filename: "src/agents/modes.ts",
        language: "typescript",
        code: `import {
  AgentModeSchema,
  resolveAgentMode,
} from "flary";

export const ask = resolveAgentMode("ask");
export const plan = resolveAgentMode("plan");
export const build = resolveAgentMode("build");
export const review = resolveAgentMode("review");

export const diagnose = AgentModeSchema.parse({
  id: "diagnose",
  name: "Diagnose",
  prompt:
    "Inspect files, logs, and history. Explain the cause. " +
    "Do not change the workspace.",
  allowedCapabilities: [
    "file.read",
    "workspace.read",
    "recall.search",
    "tool.search",
  ],
  deniedCapabilities: ["file.write", "network.write"],
  writableScopes: [],
  approvalPolicy: {
    requireForWrites: true,
    requiredCapabilities: [],
    requiredTools: [],
  },
});`,
      },
      {
        id: "coding-client",
        label: "Client",
        filename: "src/lib/coding-agent.ts",
        language: "typescript",
        code: `import { createFlaryRunClient } from "flary/client";

const runs = createFlaryRunClient({
  baseUrl: "/v1/agents/coding",
  headers: () => ({
    authorization: \`Bearer \${sessionToken()}\`,
  }),
});

const run = await runs.create({
  requestId: crypto.randomUUID(),
  channelId: "project_main",
  input: {
    message: "Find and fix the failing authentication test.",
  },
  idempotencyKey: crypto.randomUUID(),
});

let sequence = 0;
for await (const event of runs.observe(run.runId, {
  afterSequence: sequence,
})) {
  sequence = event.sequence;
  renderAgentEvent(event);
}`,
      },
    ],
  },
];

declare global {
  interface Window {
    MonacoEnvironment?: {
      getWorker: (_moduleId: string, label: string) => Worker;
    };
  }
}

function StaticCode({ example }: { example: Example }) {
  return (
    <pre className="code-example__pre">
      <code>{example.code}</code>
    </pre>
  );
}

export function CodeExamples() {
  const [groupId, setGroupId] = useState<ExampleGroup["id"]>("support");
  const group = groups.find((item) => item.id === groupId) ?? groups[0];
  const [activeByGroup, setActiveByGroup] = useState<Record<string, string>>({
    support: "support-prompt",
    coding: "coding-agent",
  });
  const activeId = activeByGroup[group.id] ?? group.examples[0].id;
  const active =
    group.examples.find((example) => example.id === activeId) ??
    group.examples[0];
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [monacoReady, setMonacoReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      import("monaco-editor"),
      import("monaco-editor/editor/editor.worker.js?worker"),
      import("monaco-editor/language/typescript/ts.worker.js?worker"),
    ]).then(([monaco, editorWorker, typescriptWorker]) => {
      if (cancelled) return;
      window.MonacoEnvironment = {
        getWorker(_moduleId, label) {
          return label === "typescript" || label === "javascript"
            ? new typescriptWorker.default()
            : new editorWorker.default();
        },
      };
      loader.config({ monaco });
      setMonacoReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const value = drafts[active.id] ?? active.code;
  const isChanged = value !== active.code;
  const editorOptions = useMemo(
    () => ({
      automaticLayout: true,
      fontFamily:
        "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      fontSize: 13,
      lineHeight: 21,
      lineNumbersMinChars: 3,
      minimap: { enabled: false },
      padding: { top: 20, bottom: 24 },
      renderLineHighlight: "line" as const,
      roundedSelection: false,
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      stickyScroll: { enabled: false },
      tabSize: 2,
      wordWrap: "on" as const,
    }),
    [],
  );

  return (
    <div className="code-example">
      <aside className="code-example__sidebar">
        <div className="code-example__scenario" role="tablist" aria-label="Use cases">
          {groups.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={item.id === group.id}
              className={item.id === group.id ? "active" : undefined}
              onClick={() => setGroupId(item.id)}
            >
              <span>{item.label}</span>
              <small>{item.description}</small>
            </button>
          ))}
        </div>
        <div className="code-example__commands" aria-label="Flary setup commands">
          <div>
            <span>Install</span>
            <code>npm install --save-exact flary@next</code>
          </div>
          <div>
            <span>Add to an app</span>
            <code>npx flary init</code>
          </div>
          <div>
            <span>New Worker</span>
            <code>npx flary create my-agent</code>
          </div>
        </div>
      </aside>

      <div className="code-example__window">
        <div className="code-example__bar">
          <div className="code-example__tabs" role="tablist" aria-label="Example files">
            {group.examples.map((example) => (
              <button
                key={example.id}
                type="button"
                role="tab"
                aria-selected={active.id === example.id}
                className={active.id === example.id ? "active" : undefined}
                onClick={() =>
                  setActiveByGroup((current) => ({
                    ...current,
                    [group.id]: example.id,
                  }))
                }
              >
                {example.label}
              </button>
            ))}
          </div>
          <div className="code-example__file">
            <span>{active.filename}</span>
            <button
              type="button"
              disabled={!isChanged}
              aria-label="Reset example"
              onClick={() =>
                setDrafts((current) => {
                  const next = { ...current };
                  delete next[active.id];
                  return next;
                })
              }
            >
              <RotateCcw size={13} strokeWidth={1.7} />
              Reset
            </button>
          </div>
        </div>
        <div
          className="code-example__editor"
          role="tabpanel"
          aria-label={`${active.filename} editable code example`}
        >
          {monacoReady ? (
            <Editor
              height="500px"
              path={active.filename}
              language={active.language}
              theme="vs-dark"
              value={value}
              options={editorOptions}
              onChange={(next) =>
                setDrafts((current) => ({
                  ...current,
                  [active.id]: next ?? "",
                }))
              }
            />
          ) : (
            <StaticCode example={{ ...active, code: value }} />
          )}
        </div>
      </div>
    </div>
  );
}

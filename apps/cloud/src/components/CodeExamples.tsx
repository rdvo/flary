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
    description: "A typed support function with tools and a stable durable client API.",
    examples: [
      {
        id: "support-app",
        label: "App",
        filename: "src/flary.ts",
        language: "typescript",
        code: `import { flary, z } from "flary";

export const app = flary<Env>({
  name: "support",
  model: "anthropic/claude-sonnet-4-5",
  bindings: z.object({
    ANTHROPIC_API_KEY: z.string().min(1),
    LOADER: z.unknown(),
  }),
  auth: ({ request, bindings }) =>
    authenticateProductRequest(request, bindings),
});`,
      },
      {
        id: "support-function",
        label: "Function",
        filename: "src/support.ts",
        language: "typescript",
        code: `import { z } from "flary";
import { app } from "./flary";
import { tools } from "./tools";

export const support = app.fn({
  input: z.object({ question: z.string().min(1) }),
  output: z.object({ answer: z.string() }),
  tools,
  mode: "ask",
  thinking: "medium",
  prompt: ({ question }) =>
    \`Answer with approved product facts:\\n\\n\${question}\`,
});`,
      },
      {
        id: "support-tools",
        label: "Tools",
        filename: "src/tools.ts",
        language: "typescript",
        code: `import { z } from "flary";
import { app } from "./flary";

const searchDocs = app.fn({
  name: "docs.search",
  input: z.object({ query: z.string() }),
  output: z.array(z.object({
    title: z.string(),
    url: z.string().url(),
  })),
  policy: { operation: "read", capabilities: ["docs.read"] },
  run: ({ query }, { bindings }) =>
    bindings.DOCS.search(query),
});

export const tools = app.tools({ searchDocs });`,
      },
      {
        id: "support-worker",
        label: "Serve",
        filename: "src/index.ts",
        language: "typescript",
        code: `import { app } from "./flary";
import { support } from "./support";

export default app.serve({ support });`,
      },
      {
        id: "support-client",
        label: "Client",
        filename: "src/lib/support.ts",
        language: "typescript",
        code: `import { flary } from "flary/client";
import type { support } from "./support";

const client = flary<{ support: typeof support }>({
  baseUrl: "https://support.example.com",
});

const run = await client.support.start(
  { question: "How do I change my plan?" },
  { idempotencyKey: "ticket_42:turn:7" },
);

for await (const event of run.stream()) {
  renderEvent(event);
}`,
      },
    ],
  },
  {
    id: "coding",
    label: "Coding agent",
    description: "A branch-scoped coding function with lazy tools and approvals.",
    examples: [
      {
        id: "coding-agent",
        label: "Agent",
        filename: "src/agents/coding.ts",
        language: "typescript",
        code: `import { flary, z } from "flary";
import { tools } from "./tools";

const app = flary<Env>({
  name: "coding-agent",
  model: "openai/gpt-5.6-codex",
  bindings: z.object({
    OPENAI_API_KEY: z.string().min(1),
    LOADER: z.unknown(),
  }),
});

export const coding = app.fn({
  input: z.object({ request: z.string() }),
  output: z.object({ summary: z.string() }),
  mode: "build",
  thinking: "high",
  tools,
  prompt: ({ request }) =>
    \`Inspect the workspace and make this change:\\n\\n\${request}\`,
});`,
      },
      {
        id: "coding-tools",
        label: "Tools",
        filename: "src/tools/catalog.ts",
        language: "typescript",
        code: `import { z } from "flary";
import { app } from "./flary";

const readFile = app.fn({
  name: "workspace.read_file",
  input: z.object({ path: z.string() }),
  output: z.object({ content: z.string() }),
  policy: { operation: "read", capabilities: ["file.read"] },
  run: ({ path }, { bindings }) =>
    bindings.WORKSPACE.read(path),
});

const applyPatch = app.fn({
  name: "workspace.apply_patch",
  input: z.object({ patch: z.string() }),
  output: z.object({ changedFiles: z.array(z.string()) }),
  policy: {
    operation: "write",
    capabilities: ["file.write"],
    requiresApproval: true,
  },
  run: ({ patch }, { bindings }) =>
    bindings.WORKSPACE.applyPatch(patch),
});

const tools = app.tools({ readFile, applyPatch });`,
      },
      {
        id: "coding-modes",
        label: "Modes",
        filename: "src/agents/modes.ts",
        language: "typescript",
        code: `import { AgentModeSchema, resolveAgentMode } from "flary";

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
        code: `import { flary } from "flary/client";
import type { coding } from "./coding";

const client = flary<{ coding: typeof coding }>({
  baseUrl: "https://coding.example.com",
  headers: () => ({
    authorization: \`Bearer \${sessionToken()}\`,
  }),
});

const run = await client.coding.start({
  request: "Find and fix the failing authentication test.",
}, { idempotencyKey: "project_main:turn:7" });

for await (const event of run.stream()) {
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
    support: "support-app",
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

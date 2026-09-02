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
  id: "support" | "coding" | "tracked" | "florist";
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
        code: `import { flary } from "flary";

export const app = flary({
  model: "openai/gpt-5",
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
  description: "Search product documentation",
  input: z.object({ query: z.string() }),
  output: z.array(z.object({
    title: z.string(),
    url: z.string().url(),
  })),
  run: ({ query }) => docs.search(query),
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
    description: "A persistent coding thread with cross-provider subagents and checkpoints.",
    examples: [
      {
        id: "coding-agent",
        label: "Agent",
        filename: "src/agents.ts",
        language: "typescript",
        code: `import { app } from "./flary";
import { codingTools } from "./tools";

export const reviewer = app.agent({
  name: "reviewer",
  model: "openai/gpt-5.6-sol",
  instructions: "Review the current diff and run focused checks.",
  tools: codingTools,
});

export const coder = app.agent({
  name: "coder",
  model: "anthropic/claude-sonnet",
  instructions: "Implement the task, run checks, and review the diff.",
  tools: codingTools,
  subagents: { reviewer },
});

export const functions = { coder, reviewer };`,
      },
      {
        id: "coding-tools",
        label: "Tools",
        filename: "src/tools.ts",
        language: "typescript",
        code: `import { app } from "./flary";

export const codingTools = app.tools({
  workspace: app.workspace({ branch: "run" }),
  shell: app.sandbox({ network: "restricted" }),
});`,
      },
      {
        id: "coding-client",
        label: "Client",
        filename: "src/lib/coder.ts",
        language: "typescript",
        code: `import { flary } from "flary/client";
import type { functions } from "../worker";

const api = flary<typeof functions>({
  baseUrl: "https://coding.example.com",
  headers: () => ({
    authorization: \`Bearer \${sessionToken()}\`,
  }),
});

const thread = await api.coder.threads.create({
  title: "Fix authentication",
});

await thread.send({
  message: "Find and fix the failing authentication test.",
});

for await (const event of thread.stream()) {
  renderAgentEvent(event);
}`,
      },
    ],
  },
  {
    id: "tracked",
    label: "Tracked",
    description:
      "A verified SaaS agent with analytics, R2 drafts, approvals, and realtime activity.",
    examples: [
      {
        id: "tracked-agent",
        label: "Agent",
        filename: "worker/flary.ts",
        language: "typescript",
        code: `import { flary } from "flary";

const app = flary({
  name: "tracked-site-agent",
  model: "openai/gpt-5",
  auth: ({ request }) => trackedIdentity(request),
});

export const siteEditor = app.agent({
  name: "siteeditor",
  instructions: trackedInstructions,
  tools: trackedTools,
  eagerTools: ["stats", "trend"],
  workspace: { scope: "thread", mode: "draft" },
});

export default app.serve({ siteeditor: siteEditor });`,
      },
      {
        id: "tracked-tools",
        label: "Tools",
        filename: "worker/tools.ts",
        language: "typescript",
        code: `export const trackedTools = app.tools({
  stats: getStats,
  trend: getTrend,
  breakdown: getBreakdown,
  create_site: createSite,
  create_campaign: createCampaign,
});

// Tracked keeps tenant lookup, R2 roots, and publish policy
// in trusted host code. Flary owns execution and audit.`,
      },
      {
        id: "tracked-client",
        label: "Realtime",
        filename: "src/lib/agent.ts",
        language: "typescript",
        code: `const thread = await api.siteeditor.threads.open({ threadId });
const connection = await thread.connect({ after: savedCursor });

for await (const event of connection.events()) {
  renderAgentEvent(event);
  saveCursor(event.cursor);
}`,
      },
    ],
  },
  {
    id: "florist",
    label: "Florist store",
    description:
      "A verified Astro and Shopify concierge with durable chat and trusted commerce reads.",
    examples: [
      {
        id: "florist-agent",
        label: "Agent",
        filename: "src/florist.ts",
        language: "typescript",
        code: `const daisyTools = app.tools({
  catalog: searchCatalog,
  delivery: checkDelivery,
});

export const daisy = app.agent({
  name: "daisy",
  model: "google/gemini-3.7-flash",
  instructions: "Help customers choose flowers and understand delivery.",
  tools: daisyTools,
  eagerTools: ["catalog", "delivery"],
  delegation: { mode: "disabled" },
  limits: { steps: 12, toolCalls: 16, timeoutMs: 90_000 },
});`,
      },
      {
        id: "florist-client",
        label: "Astro client",
        filename: "src/hooks/useDaisyConversation.ts",
        language: "typescript",
        code: `const api = flary<typeof functions>({ baseUrl: "/api/daisy" });
const thread = await api.daisy.threads.open({
  organizationId: "fairway-storefront",
  threadId: savedThreadId,
});

const live = useFlaryThread({
  thread,
  reconnectMaxMs: 8_000,
});`,
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
    tracked: "tracked-agent",
    florist: "florist-agent",
  });
  const activeId = activeByGroup[group.id] ?? group.examples[0].id;
  const active = group.examples.find((example) => example.id === activeId) ?? group.examples[0];
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
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
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
            <span>Guided setup</span>
            <code>npx flary create</code>
          </div>
          <div>
            <span>Existing app</span>
            <code>npx flary init</code>
          </div>
          <div>
            <span>Install only</span>
            <code>npm install flary</code>
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

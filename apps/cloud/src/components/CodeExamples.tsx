import { useState } from "react";

const examples = [
  {
    id: "prompt",
    label: "Prompt",
    filename: "src/agents/support.ts",
    code: `import { compilePrompt } from "flary/prompts";

export async function supportAgent(input: {
  customer: { name: string };
  question: string;
}) {
  return compilePrompt(promptSource, {
    callerModel: "openai/gpt-5",
    values: input,
  });
}`,
  },
  {
    id: "worker",
    label: "Worker",
    filename: "src/index.ts",
    code: `import { Hono } from "hono";
import { createFlaryHostRouter } from "flary/host";
import { threadService } from "./services/threads";

const app = new Hono<{ Bindings: Env }>();

app.route("/api", createFlaryHostRouter({
  authorize: async ({ request, appId }) => {
    const user = await authenticate(request);
    return {
      organizationId: user.organizationId,
      actor: { id: user.id, kind: "user", version: "1" },
    };
  },
  service: (env) => threadService(env),
}));

export default app;`,
  },
  {
    id: "client",
    label: "Client",
    filename: "src/lib/flary.ts",
    code: `import { createFlaryThreadClient } from "flary/client";

const flary = createFlaryThreadClient({
  baseUrl: "https://agents.example.com",
});

await flary.prompt(
  {
    organizationId: "org_123",
    appId: "support",
    agentId: "support",
    threadId: "thread_123",
  },
  { message: "Help me update my billing address." },
);`,
  },
] as const;

export function CodeExamples() {
  const [activeId, setActiveId] =
    useState<(typeof examples)[number]["id"]>("prompt");
  const active = examples.find((example) => example.id === activeId) ?? examples[0];

  return (
    <div className="code-example">
      <div className="code-example__commands" aria-label="Flary setup commands">
        <div>
          <span>New project</span>
          <code>npx flary create my-agent</code>
        </div>
        <div>
          <span>Existing project</span>
          <code>npx flary init</code>
        </div>
      </div>
      <div className="code-example__window">
        <div className="code-example__bar">
          <div className="code-example__tabs" role="tablist" aria-label="Code examples">
            {examples.map((example) => (
              <button
                key={example.id}
                type="button"
                role="tab"
                id={`code-tab-${example.id}`}
                aria-controls={`code-panel-${example.id}`}
                aria-selected={active.id === example.id}
                className={active.id === example.id ? "active" : undefined}
                onClick={() => setActiveId(example.id)}
              >
                {example.label}
              </button>
            ))}
          </div>
          <span>{active.filename}</span>
        </div>
        <pre
          className="code-example__pre"
          id={`code-panel-${active.id}`}
          role="tabpanel"
          aria-labelledby={`code-tab-${active.id}`}
        >
          <code>{active.code}</code>
        </pre>
      </div>
    </div>
  );
}

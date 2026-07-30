import Editor, { loader, type Monaco } from "@monaco-editor/react";
import * as monacoEditor from "monaco-editor/editor/editor.api.js";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";
import "monaco-editor/language/typescript/monaco.contribution.js";
import TypeScriptWorker from "monaco-editor/language/typescript/ts.worker.js?worker";
import { useState } from "react";

loader.config({ monaco: monacoEditor });

if (typeof self !== "undefined") {
  (
    self as typeof self & {
      MonacoEnvironment: {
        getWorker(moduleId: string, label: string): Worker;
      };
    }
  ).MonacoEnvironment = {
    getWorker(_moduleId, label) {
      if (label === "typescript" || label === "javascript") {
        return new TypeScriptWorker();
      }
      return new EditorWorker();
    },
  };
}

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

const typeDeclarations = `
declare module "flary/prompts" {
  export function compilePrompt(
    source: string,
    options: {
      callerModel: string;
      values: Record<string, unknown>;
    },
  ): Promise<unknown>;
}

declare module "flary/host" {
  export function createFlaryHostRouter<T>(
    options: Record<string, unknown>,
  ): unknown;
}

declare module "flary/client" {
  export function createFlaryThreadClient(options: {
    baseUrl: string;
  }): {
    prompt(
      ref: Record<string, string>,
      input: { message: string },
    ): Promise<unknown>;
  };
}
`;

function configureMonaco(monaco: Monaco) {
  monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
    target: monaco.languages.typescript.ScriptTarget.ES2022,
    module: monaco.languages.typescript.ModuleKind.ESNext,
    moduleResolution:
      monaco.languages.typescript.ModuleResolutionKind.NodeJs,
    allowNonTsExtensions: true,
    strict: true,
  });
  monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: false,
  });
  monaco.languages.typescript.typescriptDefaults.addExtraLib(
    typeDeclarations,
    "file:///node_modules/flary/index.d.ts",
  );
}

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
        <Editor
          beforeMount={configureMonaco}
          height="420px"
          language="typescript"
          path={`file:///${active.filename}`}
          value={active.code}
          theme="vs-dark"
          options={{
            automaticLayout: true,
            contextmenu: false,
            folding: false,
            fontFamily:
              "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
            fontSize: 13,
            lineHeight: 22,
            lineNumbersMinChars: 3,
            minimap: { enabled: false },
            overviewRulerLanes: 0,
            padding: { top: 22, bottom: 22 },
            readOnly: true,
            renderLineHighlight: "none",
            scrollBeyondLastLine: false,
            scrollbar: {
              alwaysConsumeMouseWheel: false,
              horizontalScrollbarSize: 8,
              verticalScrollbarSize: 8,
            },
            smoothScrolling: true,
            tabSize: 2,
            wordWrap: "on",
            wrappingIndent: "indent",
          }}
        />
      </div>
    </div>
  );
}

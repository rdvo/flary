import { ArrowUpRight, Check, Copy, Github } from "lucide-react";
import { useState } from "react";

const capabilities = [
  {
    title: "Durable threads",
    body: "Runs survive disconnects and resume from an exact event cursor.",
  },
  {
    title: "Provider neutral",
    body: "Use OpenAI, Anthropic, Google, Moonshot, or Cloudflare behind one contract.",
  },
  {
    title: "Tools and MCP",
    body: "Discover tools when needed. Keep secrets behind scoped capabilities.",
  },
  {
    title: "Workspaces",
    body: "Give each agent an isolated branch with files, diffs, and checkpoints.",
  },
  {
    title: "History and recall",
    body: "Store canonical JSONL history and retrieve prior work with source references.",
  },
  {
    title: "Typed boundaries",
    body: "Validate events, tools, approvals, credentials, and usage with Zod.",
  },
] as const;

function Mark() {
  return <span className="mark" aria-hidden="true">f</span>;
}

export function App() {
  const [copied, setCopied] = useState(false);

  async function copyInstall() {
    await navigator.clipboard.writeText("npm install flary");
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <main className="page">
      <header className="nav">
        <a className="brand" href="#top" aria-label="Flary home">
          <Mark />
          <span>Flary</span>
        </a>
        <nav aria-label="Main navigation">
          <a href="#details">What it does</a>
          <a href="https://github.com/rdvo/flary" target="_blank" rel="noreferrer">
            GitHub <ArrowUpRight size={13} strokeWidth={1.7} />
          </a>
        </nav>
      </header>

      <section className="hero" id="top">
        <p className="eyebrow">Open-source agent infrastructure</p>
        <h1>Build agents that<br />keep their place.</h1>
        <p className="lede">
          Flary is a durable TypeScript runtime for adding agents to products on
          Cloudflare Workers.
        </p>
        <div className="actions">
          <a className="primary-link" href="https://github.com/rdvo/flary" target="_blank" rel="noreferrer">
            <Github size={16} strokeWidth={1.7} />
            View on GitHub
          </a>
          <button className="install" type="button" onClick={() => void copyInstall()}>
            <code>npm install flary</code>
            <span>{copied ? <Check size={14} /> : <Copy size={14} />}</span>
          </button>
        </div>
        <p className="meta">Apache-2.0 · TypeScript · Cloudflare-native</p>
      </section>

      <section className="details" id="details">
        <div className="section-intro">
          <p className="eyebrow">The runtime layer</p>
          <h2>Your product owns the experience.<br />Flary runs the agent.</h2>
        </div>
        <div className="capability-grid">
          {capabilities.map((capability, index) => (
            <article key={capability.title}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <h3>{capability.title}</h3>
              <p>{capability.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="flow">
        <div>
          <p className="eyebrow">One clean boundary</p>
          <h2>Bring your app.<br />Mount Flary behind it.</h2>
        </div>
        <pre aria-label="Flary application architecture"><code>{`your product
  ↓
flary
  ↓
durable objects · d1 · r2
  ↓
openai · anthropic · google · kimi`}</code></pre>
      </section>

      <footer>
        <a className="brand" href="#top">
          <Mark />
          <span>Flary</span>
        </a>
        <p>Durable agent infrastructure for Cloudflare Workers.</p>
        <a href="https://www.npmjs.com/package/flary" target="_blank" rel="noreferrer">
          npm <ArrowUpRight size={12} strokeWidth={1.7} />
        </a>
      </footer>
    </main>
  );
}

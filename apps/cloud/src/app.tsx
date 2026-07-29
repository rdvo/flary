import { ArrowRight, ArrowUpRight, Braces, Check, CheckCircle2, Cloud, Code2, Copy, Database, GitBranch, History, KeyRound, LoaderCircle, MessageSquare, Moon, Play, Plus, Radio, Server, ShieldCheck, Sun, Webhook, Waypoints, Zap } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { ThreadConsole } from "./thread-console";

type User = { id: string; name: string; email: string };
type Organization = { id: string; name: string; slug: string; role: string };
type AppRecord = { id: string; name: string; slug: string; updatedAt?: string };
type AuthMode = "sign-in" | "sign-up";
type CloudflareAccount = { id: string; name: string };
type CloudflareConnection = {
  connected: boolean;
  pending: boolean;
  oauthConfigured: boolean;
  accountId?: string | null;
  accountName?: string | null;
  gatewayId?: string | null;
  accounts?: CloudflareAccount[];
  scope?: string | null;
  updatedAt?: string | null;
};
type ProviderConnection = {
  id: string;
  name: string;
  provider: "anthropic" | "openai-codex" | string;
  billingMode: "subscription" | "byok" | "managed";
  status: "needs_auth" | "configured" | "ready" | "error" | "disabled";
  ownerUserId?: string | null;
  ownerName?: string | null;
  credentialSubject?: string | null;
  credentialExpiresAt?: string | null;
  credentialRefreshedAt?: string | null;
};
type ProviderOAuthSession = {
  id: string;
  connectionId: string;
  provider: "anthropic" | "openai-codex";
  method: "device_code" | "authorization_code" | "browser_callback";
  status: "pending" | "ready" | "expired" | "cancelled" | "error";
  authorizationUrl?: string;
  verificationUri?: string;
  userCode?: string;
  intervalSeconds?: number;
  expiresAt: string;
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as {
      error?: string | { message?: string };
    } | null;
    const message =
      typeof body?.error === "string"
        ? body.error
        : body?.error?.message;
    throw new Error(message ?? `Request failed (${response.status})`);
  }
  return (await response.json()) as T;
}

function AuthForm({ onSuccess }: { onSuccess: () => Promise<void> }) {
  const [mode, setMode] = useState<AuthMode>("sign-in");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const path = mode === "sign-in" ? "/api/auth/sign-in/email" : "/api/auth/sign-up/email";
      const response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email,
          password,
          ...(mode === "sign-up" ? { name } : {}),
          callbackURL: "/",
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { message?: string; error?: string } | null;
        throw new Error(body?.message ?? body?.error ?? "Authentication failed");
      }
      await onSuccess();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Authentication failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="auth-form" onSubmit={(event) => void submit(event)}>
      <div className="auth-tabs"><button type="button" className={mode === "sign-in" ? "active" : ""} onClick={() => setMode("sign-in")}>Sign in</button><button type="button" className={mode === "sign-up" ? "active" : ""} onClick={() => setMode("sign-up")}>Create account</button></div>
      {mode === "sign-up" && <label>Name<input value={name} onChange={(event) => setName(event.target.value)} minLength={2} required /></label>}
      <label>Email<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></label>
      <label>Password<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={10} required /></label>
      <button className="button primary full" disabled={busy}>{busy ? "Working…" : mode === "sign-in" ? "Sign in" : "Create account"} <ArrowUpRight size={15} /></button>
      {error && <p className="form-error">{error}</p>}
    </form>
  );
}

function BrandGlyph() {
  return (
    <span className="brand-sigil" aria-hidden="true">
      <span className="brand-flare" />
    </span>
  );
}

function PublicLanding({ onSuccess }: { onSuccess: () => Promise<void> }) {
  const [authOpen, setAuthOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [siteTheme, setSiteTheme] = useState<"light" | "dark">(() => {
    const stored = window.localStorage.getItem("flary-site-theme");
    if (stored === "light" || stored === "dark") return stored;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });

  useEffect(() => {
    window.localStorage.setItem("flary-site-theme", siteTheme);
  }, [siteTheme]);

  async function copyInstall() {
    await navigator.clipboard.writeText("npm install flary");
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  return (
    <main className={`public-site theme-${siteTheme}`}>
      <nav className="marketing-nav" aria-label="Main navigation">
        <a className="site-brand" href="#top" aria-label="Flary home">
          <BrandGlyph />
          <span>flary</span>
        </a>
        <div className="marketing-nav-links">
          <a href="#runtime">Why Flary</a>
          <a href="#build">Developers</a>
          <a href="#cloud">Cloud</a>
          <a href="https://github.com/rdvo/flary" target="_blank" rel="noreferrer">GitHub <ArrowUpRight size={12} /></a>
        </div>
        <div className="marketing-nav-actions">
          <button
            className="site-theme-toggle"
            type="button"
            aria-label={`Use ${siteTheme === "dark" ? "light" : "dark"} theme`}
            title={`Use ${siteTheme === "dark" ? "light" : "dark"} theme`}
            onClick={() => setSiteTheme((current) => current === "dark" ? "light" : "dark")}
          >
            {siteTheme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
          </button>
          <button className="site-text-button" onClick={() => setAuthOpen(true)}>Sign in</button>
          <button className="button primary" onClick={() => setAuthOpen(true)}>Try Flary Cloud <ArrowRight size={15} /></button>
        </div>
      </nav>

      <section className="marketing-hero" id="top">
        <div className="marketing-hero-heading">
          <a className="release-note" href="https://github.com/rdvo/flary" target="_blank" rel="noreferrer">
            <span>OPEN SOURCE</span>
            <strong>Flary 0.2 is live</strong>
            <ArrowRight size={13} />
          </a>
          <h1>Agent infrastructure.<br /><em>Without the detour.</em></h1>
        </div>

        <div className="marketing-hero-support">
          <p className="marketing-lede">Add sessions, replayable streams, prompts, tools, subagents, secrets, and recall to your AI product—without building the agent backend yourself.</p>
          <div className="marketing-actions">
            <button className="button primary large" onClick={() => setAuthOpen(true)}>Start with Flary Cloud <ArrowRight size={16} /></button>
            <a className="button large" href="https://github.com/rdvo/flary" target="_blank" rel="noreferrer">Self-host Flary <GitBranch size={15} /></a>
          </div>
          <button className="install-command" type="button" onClick={() => void copyInstall()} aria-label="Copy npm install command">
            <code><span>$</span> npm install flary</code>
            <span>{copied ? <><Check size={14} /> Copied</> : <><Copy size={14} /> Copy</>}</span>
          </button>
        </div>

        <div className="agent-console" aria-label="A live Flary agent session">
          <div className="console-glow" />
          <div className="console-frame">
            <div className="console-bar">
              <span className="console-brand"><BrandGlyph /> session_8ac21</span>
              <span className="console-live"><span /> LIVE</span>
            </div>
            <div className="console-summary">
              <div><span>AGENT</span><strong>support-agent</strong></div>
              <div><span>MODEL</span><strong>provider-neutral</strong></div>
              <div><span>MODE</span><strong>build</strong></div>
            </div>
            <div className="console-events">
              <div><time>00:00.041</time><span className="event-state accepted">ACCEPTED</span><p>Run stored before execution</p></div>
              <div><time>00:00.183</time><span className="event-state">PROMPT</span><p>support/answer <b>revision 18</b></p></div>
              <div><time>00:01.402</time><span className="event-state streaming">STREAM</span><p>Assistant output <i /></p></div>
              <div><time>00:08.917</time><span className="event-state tool">TOOL</span><p>docs.search <b>complete</b></p></div>
              <div className="console-disconnect"><time>00:09.104</time><span className="event-state offline">CLIENT</span><p>Disconnected · run continues</p></div>
              <div><time>00:12.284</time><span className="event-state accepted">REPLAY</span><p>Reconnected from event 184</p></div>
            </div>
            <div className="console-footer">
              <span><Database size={13} /> SQLite checkpoint</span>
              <span><Radio size={13} /> Events replay from cursor</span>
            </div>
          </div>
        </div>
      </section>

      <div className="proof-rail" aria-label="Flary platform details">
        <span>Apache-2.0</span>
        <span>Zod v4 contracts</span>
        <span>Cloudflare-native</span>
        <span>Any model</span>
        <span>MCP ready</span>
      </div>

      <section className="problem-section" id="runtime">
        <div className="section-marker">01 / WHY FLARY</div>
        <div className="problem-heading">
          <h2>Your agent is the feature.<br /><span>The plumbing is not.</span></h2>
          <p>A model call is easy. A production agent needs persistent state, secure tools, reconnectable streams, provider adapters, and history your team can inspect.</p>
        </div>
        <div className="before-after">
          <div className="before-list">
            <p>Without Flary</p>
            <span><i /> Build session storage</span>
            <span><i /> Rebuild streaming and reconnects</span>
            <span><i /> Design tool permissions</span>
            <span><i /> Track prompts and providers</span>
            <span><i /> Debug incomplete runs</span>
          </div>
          <div className="flary-core">
            <div className="core-orbit orbit-one" />
            <div className="core-orbit orbit-two" />
            <BrandGlyph />
            <strong>flary</strong>
            <span>one typed runtime</span>
          </div>
          <div className="after-list">
            <p>With Flary</p>
            <span><Check size={15} /> Persistent sessions</span>
            <span><Check size={15} /> Replayable events</span>
            <span><Check size={15} /> Scoped tools + secrets</span>
            <span><Check size={15} /> Git-native prompts</span>
            <span><Check size={15} /> Complete run history</span>
          </div>
        </div>
      </section>

      <section className="developer-section" id="build">
        <div className="section-marker">02 / BUILD WITH IT</div>
        <div className="developer-grid">
          <div className="developer-copy">
            <h2>A small API for a large amount of infrastructure.</h2>
            <p>Install the open-source runtime in your Worker. Keep your authentication, product logic, and interface. Flary handles the agent layer behind them.</p>
            <ul>
              <li><Waypoints size={16} /><span><strong>Provider-neutral</strong> Switch models without replacing the session.</span></li>
              <li><KeyRound size={16} /><span><strong>Secret-safe</strong> Tools receive capability handles, not exposed keys.</span></li>
              <li><Zap size={16} /><span><strong>Fast tools</strong> Independent reads run in parallel.</span></li>
              <li><History size={16} /><span><strong>Recallable</strong> Every message, tool result, and checkpoint stays searchable.</span></li>
            </ul>
          </div>
          <div className="code-window">
            <div className="code-tabs"><span className="active">run-agent.ts</span><span>support.prompt.md</span></div>
            <pre><code><span className="code-purple">import</span> {"{ FlaryClient }"} <span className="code-purple">from</span> <span className="code-orange">"flary/client"</span>;

<span className="code-purple">const</span> flary = <span className="code-purple">new</span> <span className="code-blue">FlaryClient</span>({"{"}
  baseUrl: <span className="code-orange">"https://agents.example.com"</span>,
  appId: <span className="code-orange">"support"</span>,
  token: env.<span className="code-blue">FLARY_TOKEN</span>,
{"}"});

<span className="code-purple">const</span> run = <span className="code-purple">await</span> flary.<span className="code-blue">run</span>(
  <span className="code-orange">"support/answer"</span>,
  {"{"} values: {"{"} question {"}"} {"}"},
);

<span className="code-comment">// The connection does not own the run.</span>
<span className="code-purple">return await</span> run.<span className="code-blue">result</span>();</code></pre>
            <div className="code-status"><span><i /> run_49fa accepted</span><span>reconnect with runId →</span></div>
          </div>
        </div>
      </section>

      <section className="use-cases-section">
        <div className="section-marker">03 / ONE RUNTIME</div>
        <div className="use-cases-heading"><h2>Build the product.<br />Keep the same backend.</h2><p>Flary is infrastructure, not a chatbot template. Use the same reliable contracts across every agent experience.</p></div>
        <div className="use-case-rows">
          <article><span>01</span><MessageSquare size={20} /><h3>Support agents</h3><p>Answer, act, escalate, and preserve the complete customer history.</p><ArrowUpRight size={17} /></article>
          <article><span>02</span><Code2 size={20} /><h3>Coding agents</h3><p>Run tools, subagents, sandboxes, plans, and recoverable sessions.</p><ArrowUpRight size={17} /></article>
          <article><span>03</span><Webhook size={20} /><h3>Automations</h3><p>React to webhooks, schedules, queues, and human approvals.</p><ArrowUpRight size={17} /></article>
          <article><span>04</span><Braces size={20} /><h3>Product copilots</h3><p>Add a capable agent to the product your customers already use.</p><ArrowUpRight size={17} /></article>
        </div>
      </section>

      <section className="deployment-section" id="cloud">
        <div className="section-marker">04 / YOUR DEPLOYMENT</div>
        <div className="deployment-heading"><h2>Own the runtime.<br />Or skip the operations.</h2><p>Both paths use the same Flary contracts. Start where your team is comfortable and move without rewriting your product.</p></div>
        <div className="deployment-options">
          <article>
            <div className="deployment-top"><GitBranch size={20} /><span>OPEN SOURCE</span></div>
            <h3>Self-host Flary</h3>
            <p>Deploy the runtime in your Cloudflare account. Bring your own storage, providers, and product interface.</p>
            <ul><li><Check size={14} /> Apache-2.0 licensed</li><li><Check size={14} /> Your Cloudflare account</li><li><Check size={14} /> Full runtime control</li></ul>
            <a className="button" href="https://github.com/rdvo/flary" target="_blank" rel="noreferrer">View on GitHub <ArrowUpRight size={15} /></a>
          </article>
          <article className="cloud-option">
            <div className="deployment-top"><Cloud size={20} /><span>MANAGED</span></div>
            <h3>Use Flary Cloud</h3>
            <p>Create workspaces, connect providers, manage prompts, and inspect agents without operating the runtime layer.</p>
            <ul><li><Check size={14} /> Managed infrastructure</li><li><Check size={14} /> BYOK provider access</li><li><Check size={14} /> Team control plane</li></ul>
            <button className="button primary" onClick={() => setAuthOpen(true)}>Create a workspace <ArrowRight size={15} /></button>
          </article>
        </div>
      </section>

      <section className="faq-section">
        <div><div className="section-marker">05 / FAQ</div><h2>Before you wire it in.</h2></div>
        <div className="faq-list">
          <details><summary>Is Flary another agent framework?<Plus size={16} /></summary><p>Flary is the runtime backend around your agent logic. It gives your product stable contracts for sessions, prompts, tools, providers, events, and history.</p></details>
          <details><summary>Does Flary lock us into one model?<Plus size={16} /></summary><p>No. Provider adapters normalize the public session while preserving provider-specific options when your application needs them.</p></details>
          <details><summary>Do we need Flary Cloud?<Plus size={16} /></summary><p>No. The runtime is open source and self-hostable. Flary Cloud is the managed control plane for teams that do not want to operate it.</p></details>
          <details><summary>Where does agent data live?<Plus size={16} /></summary><p>Self-hosted data stays in your Cloudflare account. Flary Cloud uses tenant-scoped persistent storage and keeps provider credentials outside prompts and browser storage.</p></details>
        </div>
      </section>

      <section className="final-cta">
        <div className="final-cta-flare" />
        <div><p>START WITH ONE AGENT</p><h2>Ship the feature.<br />Keep the run.</h2></div>
        <div><p>Add Flary to your Worker, or open a managed workspace and start from the same typed contracts.</p><div className="marketing-actions"><button className="button primary" onClick={() => setAuthOpen(true)}>Try Flary Cloud <ArrowRight size={16} /></button><a className="button" href="https://github.com/rdvo/flary" target="_blank" rel="noreferrer">Read the docs <ArrowUpRight size={15} /></a></div></div>
      </section>

      <footer className="marketing-footer">
        <a className="site-brand" href="#top"><BrandGlyph /><span>flary</span></a>
        <span>Open-source infrastructure for production agents.</span>
        <div><a href="https://github.com/rdvo/flary" target="_blank" rel="noreferrer">GitHub</a><a href="https://www.npmjs.com/package/flary" target="_blank" rel="noreferrer">npm</a><a href="#top">Back to top ↑</a></div>
      </footer>

      {authOpen && <div className="auth-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setAuthOpen(false); }}><div className="auth-dialog" role="dialog" aria-modal="true" aria-label="Start building with Flary"><button className="dialog-close" aria-label="Close" onClick={() => setAuthOpen(false)}>×</button><p className="eyebrow">Flary Cloud</p><h2>Your agent workspace.</h2><p className="dialog-lede">Create a workspace, connect a provider, and start from the same contracts as open-source Flary.</p><AuthForm onSuccess={onSuccess} /></div></div>}
    </main>
  );
}

function CloudflareByokCard({ organizationId }: { organizationId: string }) {
  const [connection, setConnection] = useState<CloudflareConnection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function refresh() {
    setError(null);
    try {
      const result = await api<CloudflareConnection>(
        `/api/organizations/${organizationId}/cloudflare/connection`,
      );
      setConnection(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load Cloudflare connection");
    }
  }

  useEffect(() => {
    void refresh();
  }, [organizationId]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const result = params.get("cloudflare");
    if (!result) return;
    if (result === "connected") setNotice("Cloudflare is connected and its AI Gateway is ready.");
    if (result === "choose_account") setNotice("Choose the Cloudflare account that Flary should use.");
    if (result === "error") setError("Cloudflare connection failed. Check the OAuth client and requested permissions.");
    params.delete("cloudflare");
    params.delete("organizationId");
    const query = params.toString();
    window.history.replaceState({}, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
    void refresh();
  }, []);

  async function selectAccount(account: CloudflareAccount) {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/organizations/${organizationId}/cloudflare/account`, {
        method: "POST",
        body: JSON.stringify(account),
      });
      setNotice("Cloudflare is connected and its AI Gateway is ready.");
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not select the Cloudflare account");
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    if (!window.confirm("Disconnect this Cloudflare account from Flary?")) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/organizations/${organizationId}/cloudflare/connection`, {
        method: "DELETE",
      });
      setNotice("Cloudflare has been disconnected.");
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not disconnect Cloudflare");
    } finally {
      setBusy(false);
    }
  }

  const accounts = connection?.accounts ?? [];

  return (
    <div className="side-card provider-card">
      <div className="card-icon"><Cloud size={17} /></div>
      <div className="provider-title-row"><h3>Cloudflare BYOK</h3><span className="provider-badge">BYOK</span></div>
      <p>Connect your Cloudflare account. Flary creates a dedicated AI Gateway and keeps the OAuth token on the Worker.</p>
      {notice && <p className="provider-notice"><CheckCircle2 size={14} /> {notice}</p>}
      {error && <p className="form-error">{error}</p>}
      {!connection && <p className="provider-muted">Checking connection…</p>}
      {connection && !connection.oauthConfigured && !connection.connected && (
        <div className="provider-setup"><strong>OAuth setup required</strong><span>Add the Cloudflare OAuth client secrets to this deployment.</span></div>
      )}
      {connection?.connected && (
        <div className="provider-connected">
          <div><strong>{connection.accountName}</strong><span>Gateway: {connection.gatewayId}</span></div>
          <button className="button" disabled={busy} onClick={() => void disconnect()}>{busy ? "Working…" : "Disconnect"}</button>
        </div>
      )}
      {connection?.pending && (
        <div className="provider-account-list">
          <strong>Choose an account</strong>
          {accounts.map((account) => <button className="button" disabled={busy} key={account.id} onClick={() => void selectAccount(account)}>{account.name}<span>{account.id}</span></button>)}
        </div>
      )}
      {connection?.oauthConfigured && !connection.connected && !connection.pending && (
        <a className="button primary full" href={`/api/cloudflare/oauth/start?organizationId=${encodeURIComponent(organizationId)}`}>Connect Cloudflare <ArrowUpRight size={15} /></a>
      )}
      <span className="provider-footnote">Cloudflare controls the Workers AI bill. No browser API key is created.</span>
    </div>
  );
}

function SubscriptionProvidersCard({
  appId,
  user,
}: {
  appId: string;
  user: User;
}) {
  const [connections, setConnections] = useState<ProviderConnection[]>([]);
  const [oauth, setOauth] = useState<ProviderOAuthSession | null>(null);
  const [authorizationResult, setAuthorizationResult] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refreshConnections() {
    const result = await api<{ connections: ProviderConnection[] }>(
      `/api/apps/${appId}/connections`,
    );
    setConnections(
      result.connections.filter(
        (connection) => connection.billingMode === "subscription",
      ),
    );
  }

  useEffect(() => {
    setOauth(null);
    setAuthorizationResult("");
    setError(null);
    void refreshConnections().catch((cause) => {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not load provider accounts",
      );
    });
  }, [appId]);

  useEffect(() => {
    if (
      !oauth ||
      oauth.provider !== "openai-codex" ||
      oauth.status !== "pending"
    ) {
      return;
    }
    const timeout = window.setTimeout(async () => {
      try {
        const result = await api<{ oauth: ProviderOAuthSession }>(
          `/api/apps/${appId}/provider-oauth/${oauth.id}?poll=true`,
        );
        setOauth(result.oauth);
        if (result.oauth.status === "ready") {
          await refreshConnections();
        }
      } catch (cause) {
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not check provider login",
        );
      }
    }, Math.max(1, oauth.intervalSeconds ?? 5) * 1_000);
    return () => window.clearTimeout(timeout);
  }, [appId, oauth]);

  async function start(
    provider: "anthropic" | "openai-codex",
    connectionId?: string,
  ) {
    setBusy(true);
    setError(null);
    setAuthorizationResult("");
    try {
      const result = await api<{ oauth: ProviderOAuthSession }>(
        `/api/apps/${appId}/provider-oauth/start`,
        {
          method: "POST",
          body: JSON.stringify({
            provider,
            ...(connectionId ? { connectionId } : {}),
          }),
        },
      );
      setOauth(result.oauth);
      const target =
        result.oauth.authorizationUrl ?? result.oauth.verificationUri;
      if (target) window.open(target, "_blank", "noopener,noreferrer");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not start provider login",
      );
    } finally {
      setBusy(false);
    }
  }

  async function completeAnthropic() {
    if (!oauth || !authorizationResult.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ oauth: ProviderOAuthSession }>(
        `/api/apps/${appId}/provider-oauth/${oauth.id}/complete`,
        {
          method: "POST",
          body: JSON.stringify({
            authorizationResult: authorizationResult.trim(),
          }),
        },
      );
      setOauth(result.oauth);
      await refreshConnections();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not complete provider login",
      );
    } finally {
      setBusy(false);
    }
  }

  async function disconnectProvider(connection: ProviderConnection) {
    if (!window.confirm(`Disconnect ${connection.name}?`)) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/apps/${appId}/connections/${connection.id}/disconnect`, {
        method: "POST",
      });
      setOauth(null);
      await refreshConnections();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not disconnect provider",
      );
    } finally {
      setBusy(false);
    }
  }

  const byProvider = new Map(
    connections.map((connection) => [connection.provider, connection]),
  );

  return (
    <div className="side-card provider-card">
      <div className="card-icon"><KeyRound size={17} /></div>
      <div className="provider-title-row">
        <h3>Subscription models</h3>
        <span className="provider-badge">OAuth</span>
      </div>
      <p>Use your ChatGPT or Claude subscription. Tokens stay encrypted on the Worker.</p>
      {error && <p className="form-error">{error}</p>}
      {(["openai-codex", "anthropic"] as const).map((provider) => {
        const connection = byProvider.get(provider);
        const label =
          provider === "openai-codex" ? "ChatGPT / Codex" : "Claude Pro / Max";
        return (
          <div className="subscription-provider" key={provider}>
            <div>
              <strong>{label}</strong>
              <span>
                {connection?.status === "ready"
                  ? `${connection.ownerName ?? user.name} · connected`
                  : connection?.status === "disabled"
                    ? "Disconnected"
                    : "Not connected"}
              </span>
              {connection?.credentialExpiresAt && (
                <small>
                  Refreshes automatically · token expires{" "}
                  {new Date(connection.credentialExpiresAt).toLocaleString()}
                </small>
              )}
              {connection?.status === "ready" && (
                <small>
                  Subscription billing
                  {connection.credentialRefreshedAt
                    ? ` · refreshed ${new Date(
                        connection.credentialRefreshedAt,
                      ).toLocaleString()}`
                    : ""}
                </small>
              )}
            </div>
            {connection?.status === "ready" ? (
              <button
                className="button"
                disabled={busy}
                onClick={() => void disconnectProvider(connection)}
              >
                Disconnect
              </button>
            ) : (
              <button
                className="button primary"
                disabled={busy}
                onClick={() => void start(provider, connection?.id)}
              >
                Connect
              </button>
            )}
          </div>
        );
      })}
      {oauth?.status === "pending" && (
        <div className="provider-oauth-step">
          {oauth.provider === "openai-codex" ? (
            <>
              <strong>Enter this code in ChatGPT</strong>
              <code>{oauth.userCode}</code>
              {oauth.verificationUri && (
                <a
                  className="button full"
                  href={oauth.verificationUri}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open login <ArrowUpRight size={14} />
                </a>
              )}
              <span>Waiting for approval…</span>
            </>
          ) : (
            <>
              <strong>Finish Claude login</strong>
              {oauth.authorizationUrl && (
                <a
                  className="button full"
                  href={oauth.authorizationUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open Claude <ArrowUpRight size={14} />
                </a>
              )}
              <label>
                Paste the final code or redirect URL
                <textarea
                  value={authorizationResult}
                  onChange={(event) =>
                    setAuthorizationResult(event.target.value)
                  }
                  rows={3}
                />
              </label>
              <button
                className="button primary full"
                disabled={busy || !authorizationResult.trim()}
                onClick={() => void completeAnthropic()}
              >
                Complete connection
              </button>
            </>
          )}
        </div>
      )}
      {oauth?.status === "ready" && (
        <p className="provider-notice">
          <CheckCircle2 size={14} /> Provider connected.
        </p>
      )}
      <span className="provider-footnote">
        Subscription use is owned by {user.name}. Flary reports native cache reads and writes.
      </span>
    </div>
  );
}

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [organizationId, setOrganizationId] = useState<string | null>(null);
  const [apps, setApps] = useState<AppRecord[]>([]);
  const [selectedAppId, setSelectedAppId] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const organization = useMemo(
    () => organizations.find((item) => item.id === organizationId) ?? organizations[0],
    [organizationId, organizations],
  );

  async function refresh(nextOrganizationId?: string) {
    setBusy(true);
    setError(null);
    try {
      const me = await api<{ user: User; organizations: Organization[] }>("/api/me");
      setUser(me.user);
      setOrganizations(me.organizations);
      const callbackOrganizationId = new URLSearchParams(window.location.search).get("organizationId");
      const selectedId = nextOrganizationId ?? organizationId ?? callbackOrganizationId ?? me.organizations[0]?.id;
      setOrganizationId(selectedId ?? null);
      if (!selectedId) return;
      const appResponse = await api<{ apps: AppRecord[] }>(
        `/api/organizations/${selectedId}/apps`,
      );
      setApps(appResponse.apps);
      setSelectedAppId((current) =>
        current && appResponse.apps.some((item) => item.id === current)
          ? current
          : appResponse.apps[0]?.id ?? null,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load Flary Cloud");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function createOrganization() {
    const name = window.prompt("Workspace name");
    if (!name) return;
    await api("/api/organizations", { method: "POST", body: JSON.stringify({ name }) });
    await refresh();
  }

  async function createApp() {
    if (!organization) return;
    const name = window.prompt("App name");
    if (!name) return;
    await api(`/api/organizations/${organization.id}/apps`, { method: "POST", body: JSON.stringify({ name }) });
    await refresh(organization.id);
  }

  async function signOut() {
    await api("/api/auth/sign-out", { method: "POST", body: "{}" });
    setUser(null);
    setOrganizations([]);
    setOrganizationId(null);
    setApps([]);
    setSelectedAppId(null);
    setError("Sign in is required");
  }

  if (busy && !user) {
    return <main className="loading-screen"><LoaderCircle className="spin" size={18} /> Loading Flary…</main>;
  }

  if (error && !user) {
    return <PublicLanding onSuccess={refresh} />;
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand-mark"><BrandGlyph /><span>flary</span></div>
        <div className="topbar-meta"><span>{user?.name}</span><button className="text-button" onClick={() => void signOut()}>Sign out</button></div>
      </header>
      <section className="workspace-head">
        <div><p className="eyebrow">Control plane</p><h1>Keep your agents moving.</h1><p>Prompts, runs, tools, secrets, and deployments in one shared workspace.</p></div>
        <div className="status-chip"><span className="status-dot" /> Cloudflare Worker</div>
      </section>
      <section className="layout-grid">
        <div className="main-column">
          <div className="section-heading"><div><p className="eyebrow">Workspace</p><h2>{organization?.name ?? "Create a workspace"}</h2></div><button className="icon-button" onClick={() => void createOrganization()} title="Create workspace"><Plus size={17} /></button></div>
          {!organization ? <div className="empty-panel"><p>Start with a workspace. It keeps apps, prompts, and connections together.</p><button className="button primary" onClick={() => void createOrganization()}>Create workspace <ArrowUpRight size={15} /></button></div> : <>
            <div className="app-list">{apps.map((item) => <button className={`app-row app-row-button ${selectedAppId === item.id ? "selected" : ""}`} key={item.id} onClick={() => setSelectedAppId(item.id)}><div className="app-icon"><Braces size={16} /></div><div><strong>{item.name}</strong><span>{item.slug}</span></div><span className="row-arrow">›</span></button>)}{apps.length === 0 && <div className="empty-panel compact"><p>No apps yet.</p><button className="button" onClick={() => void createApp()}><Plus size={15} /> Create app</button></div>}</div>
            {organization && apps.find((item) => item.id === selectedAppId) && <ThreadConsole userId={user?.id ?? ""} organization={organization} app={apps.find((item) => item.id === selectedAppId)!} />}
            {apps.length > 0 && <button className="button subtle" onClick={() => void createApp()}><Plus size={15} /> Add app</button>}
          </>}
        </div>
        <aside className="side-column">
          {selectedAppId && user && (
            <SubscriptionProvidersCard appId={selectedAppId} user={user} />
          )}
          {organization && <CloudflareByokCard organizationId={organization.id} />}
          <div className="side-card"><div className="card-icon"><Server size={17} /></div><h3>Managed execution layer</h3><p>Flary Cloud owns the Worker, stateful services, Dynamic Workers, and Sandboxes. Your team only connects model and tool credentials.</p><div className="connected"><Code2 size={15} /> Dynamic Worker + Sandbox</div></div>
          <div className="side-card quiet"><ShieldCheck size={17} /><h3>Safe by default</h3><p>Code Mode has no direct network access. Full Linux work runs in a separate sandbox with public internet blocked by default.</p></div>
        </aside>
      </section>
    </main>
  );
}

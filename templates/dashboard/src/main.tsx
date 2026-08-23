import { StrictMode, useEffect, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { flary } from "flary/client";
import { FlaryAgentConsole } from "flary/react";

import type { functions } from "./index";

const api = flary<typeof functions>({ baseUrl: "" });

type Gate = "loading" | "setup" | "login" | "ready";

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const value = (await response.json()) as T & {
    error?: string | { message?: string };
  };
  if (!response.ok) {
    const message =
      typeof value.error === "string" ? value.error : value.error?.message;
    throw new Error(message || "The request failed.");
  }
  return value;
}

function AccessForm({
  mode,
  onReady,
}: {
  mode: "setup" | "login";
  onReady(): void;
}) {
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const body = JSON.stringify(
        Object.fromEntries(new FormData(event.currentTarget))
      );
      await json(mode === "setup" ? "/api/setup" : "/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      onReady();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The request failed.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="access-shell">
      <section className="access-card">
        <div className="access-mark">✦</div>
        <p className="eyebrow">Flary dashboard</p>
        <h1>{mode === "setup" ? "Create the first owner" : "Welcome back"}</h1>
        <p className="muted">
          {mode === "setup"
            ? "Use the one-time setup token. Registration closes after this owner is created."
            : "Sign in to your durable agent workspace."}
        </p>
        <form onSubmit={(event) => void submit(event)}>
          {mode === "setup" ? (
            <>
              <label>
                Setup token
                <input
                  name="token"
                  type="password"
                  required
                  autoComplete="off"
                />
              </label>
              <label>
                Name
                <input name="name" required autoComplete="name" />
              </label>
            </>
          ) : null}
          <label>
            Email
            <input name="email" type="email" required autoComplete="email" />
          </label>
          <label>
            Password
            <input
              name="password"
              type="password"
              minLength={mode === "setup" ? 10 : undefined}
              required
              autoComplete={
                mode === "setup" ? "new-password" : "current-password"
              }
            />
          </label>
          {error ? <p className="access-error">{error}</p> : null}
          <button disabled={busy}>
            {busy ? "Working" : mode === "setup" ? "Create owner" : "Sign in"}
          </button>
        </form>
      </section>
    </main>
  );
}

function Dashboard() {
  const [gate, setGate] = useState<Gate>("loading");
  useEffect(() => {
    let active = true;
    void (async () => {
      const setup = await json<{ open: boolean }>("/api/setup/status");
      if (setup.open) return active && setGate("setup");
      const session = (await fetch("/api/auth/get-session").then((response) =>
        response.json()
      )) as { user?: unknown } | null;
      if (active) setGate(session?.user ? "ready" : "login");
    })().catch(() => {
      if (active) setGate("login");
    });
    return () => {
      active = false;
    };
  }, []);

  if (gate === "loading") return <div className="boot">Loading Flary</div>;
  if (gate === "setup" || gate === "login")
    return <AccessForm mode={gate} onReady={() => location.reload()} />;
  return (
    <main className="dashboard-shell">
      <FlaryAgentConsole
        agent={api.assistant}
        title="Flary"
        welcomeTitle="Start anywhere"
        welcomeMessage="Ask a question, assign work, or use a connected tool. The thread stays durable when this tab closes."
        suggestions={[
          "Summarize what needs attention",
          "List the tools you can use",
        ]}
        headerActions={
          <nav className="console-nav">
            <a href="/connections">Connections</a>
            <a href="/settings">Secret health</a>
          </nav>
        }
      />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Dashboard />
  </StrictMode>
);

const style = document.createElement("style");
style.textContent = `
:root{font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#121417;background:#f1f3f4;font-synthesis:none}*{box-sizing:border-box}body{margin:0}.dashboard-shell{padding:16px;min-height:100dvh}.dashboard-shell>[data-flary-console]{max-width:1500px;margin:auto}.console-nav{display:flex;gap:6px;margin-left:4px}.console-nav a{border:1px solid #d9dde1;color:#3d444b;text-decoration:none;padding:6px 9px;font-size:12px}.console-nav a:hover{border-color:#1769e0;color:#1769e0}.boot{min-height:100dvh;display:grid;place-items:center;color:#687078}.access-shell{min-height:100dvh;display:grid;place-items:center;padding:24px}.access-card{width:min(430px,100%);border:1px solid #d9dde1;background:#fff;padding:32px;box-shadow:0 18px 60px rgba(18,20,23,.08)}.access-mark{width:38px;height:38px;display:grid;place-items:center;background:#121417;color:#fff;margin-bottom:24px}.eyebrow{text-transform:uppercase;letter-spacing:.14em;font-size:11px;font-weight:700}.access-card h1{font-size:28px;letter-spacing:-.03em;margin:8px 0}.muted{color:#687078;line-height:1.55}.access-card form{display:grid;gap:14px;margin-top:24px}.access-card label{display:grid;gap:6px;font-size:12px;font-weight:700}.access-card input{font:inherit;border:1px solid #bfc5ca;padding:11px 12px;outline:0}.access-card input:focus{border-color:#1769e0;box-shadow:0 0 0 2px rgba(23,105,224,.12)}.access-card button{border:0;background:#121417;color:white;padding:12px;font:inherit;font-weight:700;cursor:pointer}.access-card button:disabled{opacity:.5}.access-error{border-left:2px solid #b42318;color:#b42318;padding-left:10px;margin:0}@media(max-width:720px){.dashboard-shell{padding:0}.console-nav{display:none}}
`;
document.head.appendChild(style);

import { useEffect, useState } from "react";

type Health = {
  ok: boolean;
  service: string;
  runtimeConnected: boolean;
};

export function AppShell() {
  const [health, setHealth] = useState<Health | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();

    void fetch("/api/health", { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error("Health request failed");
        return response.json() as Promise<Health>;
      })
      .then((value) => setHealth(value))
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setFailed(true);
      });

    return () => controller.abort();
  }, []);

  return (
    <main className="app-shell">
      <header>
        <a className="brand" href="/" aria-label="Flary home">
          <span className="mark" aria-hidden="true">f</span>
          <span>Flary</span>
        </a>
        <span className="app-route">/app</span>
      </header>

      <section>
        <p className="eyebrow">React application surface</p>
        <h1>Your Flary app starts here.</h1>
        <p>
          This route is a React SPA served by the Flary website Worker. The
          Hono API stays on the same origin.
        </p>
        <div className="worker-status" aria-live="polite">
          <span className={health?.ok ? "status-dot ready" : "status-dot"} />
          {failed
            ? "Website Worker is unavailable"
            : health
              ? `${health.service} ready · runtime ${health.runtimeConnected ? "connected" : "not connected locally"}`
              : "Checking Website Worker"}
        </div>
      </section>
    </main>
  );
}

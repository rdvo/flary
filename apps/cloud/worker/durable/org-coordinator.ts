import type { Env } from "../env";

type StoredEvent = {
  id: string;
  type: string;
  payload: unknown;
  createdAt: number;
};

export class OrgCoordinator {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {
    this.state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS org_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname.endsWith("/health")) {
      const row = this.state.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM org_events")
        .toArray()[0];
      return Response.json({ ok: true, eventCount: row?.count ?? 0 });
    }

    if (request.method === "GET" && url.pathname.endsWith("/events")) {
      const limit = Math.min(Number(url.searchParams.get("limit") ?? "50"), 200);
      const rows = this.state.storage.sql
        .exec<{ id: string; type: string; payload_json: string; created_at: number }>(
          "SELECT id, type, payload_json, created_at FROM org_events ORDER BY sequence DESC LIMIT ?",
          limit,
        )
        .toArray()
        .reverse()
        .map<StoredEvent>((row) => ({
          id: row.id,
          type: row.type,
          payload: JSON.parse(row.payload_json) as unknown,
          createdAt: row.created_at,
        }));
      return Response.json({ events: rows });
    }

    if (request.method === "POST" && url.pathname.endsWith("/events")) {
      const input = (await request.json()) as { id?: string; type?: string; payload?: unknown };
      if (!input.id || !input.type) {
        return Response.json({ error: "id and type are required" }, { status: 400 });
      }
      this.state.storage.sql.exec(
        "INSERT OR IGNORE INTO org_events (id, type, payload_json, created_at) VALUES (?, ?, ?, ?)",
        input.id,
        input.type,
        JSON.stringify(input.payload ?? null),
        Date.now(),
      );
      return Response.json({ ok: true });
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  }
}

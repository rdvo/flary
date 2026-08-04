import assert from "node:assert/strict";
import test from "node:test";

import { CloudflareMcpOAuthConnections } from "../../src/harness/cloudflare/mcp-oauth.ts";

type Row = Record<string, unknown>;

class MemoryD1 {
  readonly connections = new Map<string, Row>();
  readonly flows = new Map<string, Row>();

  prepare(query: string): MemoryStatement {
    return new MemoryStatement(this, query.replace(/\s+/g, " ").trim());
  }
}

class MemoryStatement {
  #values: unknown[] = [];

  constructor(private readonly database: MemoryD1, private readonly query: string) {}

  bind(...values: unknown[]): this {
    this.#values = values;
    return this;
  }

  async first<T>(): Promise<T | null> {
    if (this.query.includes("FROM flary_mcp_oauth_session WHERE id = ?")) {
      return (this.database.flows.get(String(this.#values[0])) as T | undefined) ?? null;
    }
    if (this.query.includes("FROM flary_connection WHERE id = ?")) {
      const [id, tenantId, userId] = this.#values;
      const row = this.database.connections.get(String(id));
      return row?.tenant_id === tenantId && row.owner_user_id === userId ? row as T : null;
    }
    if (this.query.includes("kind = 'mcp' AND namespace = ?")) {
      const [tenantId, userId, namespace] = this.#values;
      const row = [...this.database.connections.values()].find((item) =>
        item.tenant_id === tenantId && item.owner_user_id === userId && item.namespace === namespace);
      return (row as T | undefined) ?? null;
    }
    throw new Error(`Unhandled first query: ${this.query}`);
  }

  async all<T>(): Promise<{ results: T[] }> {
    if (this.query.includes("FROM flary_connection")) {
      const [tenantId, userId] = this.#values;
      const readyOnly = this.query.includes("status = 'ready'");
      const results = [...this.database.connections.values()].filter((row) =>
        row.tenant_id === tenantId && row.owner_user_id === userId && row.kind === "mcp" &&
        (!readyOnly || row.status === "ready"));
      return { results: results as T[] };
    }
    throw new Error(`Unhandled all query: ${this.query}`);
  }

  async run(): Promise<{ success: boolean; meta: { changes: number } }> {
    if (this.query.startsWith("INSERT INTO flary_connection")) {
      const [id, userId, tenantId, label, status, namespace, endpoint, authType, metadata, createdAt, updatedAt] = this.#values;
      this.database.connections.set(String(id), {
        id, owner_user_id: userId, tenant_id: tenantId, kind: "mcp", label, status,
        encrypted_credential: null, credential_generation: null, credential_expires_at: null,
        namespace, endpoint_url: endpoint, transport: "streamable-http", auth_type: authType,
        metadata_json: metadata, created_at: createdAt, updated_at: updatedAt,
      });
      return changed();
    }
    if (this.query.startsWith("INSERT INTO flary_mcp_oauth_session")) {
      const [id, tenantId, userId, connectionId, privateState, expiresAt, createdAt, updatedAt] = this.#values;
      this.database.flows.set(String(id), {
        id, tenant_id: tenantId, user_id: userId, connection_id: connectionId,
        status: "pending", private_state: privateState, expires_at: expiresAt,
        created_at: createdAt, updated_at: updatedAt,
      });
      return changed();
    }
    if (this.query.startsWith("UPDATE flary_connection SET status = 'ready'")) {
      const [encrypted, generation, expiresAt, metadata, updatedAt, id] = this.#values;
      Object.assign(requiredRow(this.database.connections, id), {
        status: "ready", encrypted_credential: encrypted, credential_generation: generation,
        credential_expires_at: expiresAt, metadata_json: metadata, updated_at: updatedAt,
      });
      return changed();
    }
    if (this.query.startsWith("UPDATE flary_mcp_oauth_session SET status = ?")) {
      const [status, , updatedAt, id] = this.#values;
      Object.assign(requiredRow(this.database.flows, id), {
        status, private_state: status === "pending" ? requiredRow(this.database.flows, id).private_state : "", updated_at: updatedAt,
      });
      return changed();
    }
    if (this.query.startsWith("UPDATE flary_mcp_oauth_session SET status = 'expired'")) {
      const [updatedAt, connectionId, tenantId, userId] = this.#values;
      let count = 0;
      for (const row of this.database.flows.values()) {
        if (row.connection_id === connectionId && row.tenant_id === tenantId && row.user_id === userId && row.status === "pending") {
          Object.assign(row, { status: "expired", private_state: "", updated_at: updatedAt });
          count += 1;
        }
      }
      return { success: true, meta: { changes: count } };
    }
    if (this.query.startsWith("UPDATE flary_connection SET status = ?")) {
      const [status, updatedAt, id] = this.#values;
      Object.assign(requiredRow(this.database.connections, id), { status, updated_at: updatedAt });
      return changed();
    }
    throw new Error(`Unhandled run query: ${this.query}`);
  }
}

function requiredRow(rows: Map<string, Row>, id: unknown): Row {
  const row = rows.get(String(id));
  if (!row) throw new Error(`Missing row ${String(id)}`);
  return row;
}

function changed(): { success: true; meta: { changes: 1 } } {
  return { success: true, meta: { changes: 1 } };
}

test("MCP URL setup discovers OAuth, completes PKCE, and exposes namespaced tools", async () => {
  const database = new MemoryD1();
  const requests: Array<{ url: string; method: string; authorization?: string; body: string }> = [];
  const fetcher: typeof fetch = async (input, init = {}) => {
    const url = input instanceof Request ? input.url : input.toString();
    const headers = new Headers(init.headers);
    const body = typeof init.body === "string" ? init.body : init.body instanceof URLSearchParams ? init.body.toString() : "";
    requests.push({ url, method: init.method ?? "GET", authorization: headers.get("authorization") ?? undefined, body });
    if (url === "https://mcp.example.com/mcp") {
      if (!headers.has("authorization")) {
        return new Response(null, {
          status: 401,
          headers: { "www-authenticate": 'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource", scope="tools.read"' },
        });
      }
      const rpc = JSON.parse(body) as { method: string };
      if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (rpc.method === "initialize") {
        return Response.json({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "test", version: "1" } } }, { headers: { "mcp-session-id": "session-1" } });
      }
      if (rpc.method === "tools/list") {
        return Response.json({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "search", description: "Search", inputSchema: { type: "object" } }] } });
      }
      if (rpc.method === "tools/call") {
        return Response.json({ jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: "done" }] } });
      }
    }
    if (url === "https://mcp.example.com/.well-known/oauth-protected-resource") {
      return Response.json({ resource: "https://mcp.example.com/mcp", authorization_servers: ["https://auth.example.com"], scopes_supported: ["tools.read", "tools.write"] });
    }
    if (url === "https://auth.example.com/.well-known/oauth-authorization-server") {
      return Response.json({
        issuer: "https://auth.example.com",
        authorization_endpoint: "https://auth.example.com/authorize",
        token_endpoint: "https://auth.example.com/token",
        registration_endpoint: "https://auth.example.com/register",
        code_challenge_methods_supported: ["S256"],
        authorization_response_iss_parameter_supported: true,
      });
    }
    if (url === "https://auth.example.com/register") return Response.json({ client_id: "client-1" });
    if (url === "https://auth.example.com/token") {
      assert.match(body, /grant_type=authorization_code/);
      assert.match(body, /code_verifier=/);
      assert.match(body, /resource=https%3A%2F%2Fmcp\.example\.com%2Fmcp/);
      return Response.json({ access_token: "access-1", refresh_token: "refresh-1", token_type: "Bearer", expires_in: 3600, scope: "tools.read" });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const service = new CloudflareMcpOAuthConnections({
    database,
    encryptionKey: Buffer.alloc(32, 7).toString("base64"),
    callbackUrl: "https://agent.example.com/api/connections/mcp/oauth/callback",
    clientMetadataUrl: "https://agent.example.com/api/connections/mcp/client-metadata",
    fetch: fetcher,
    now: () => new Date("2026-08-04T12:00:00.000Z"),
  });
  const scope = { tenantId: "tenant-1", userId: "user-1" };
  const pending = await service.start(scope, { name: "Product Search", url: "https://mcp.example.com/mcp" });
  assert.equal(pending.status, "needs_auth");
  const authorization = new URL(pending.authorizationUrl!);
  assert.equal(authorization.searchParams.get("scope"), "tools.read");
  assert.equal(authorization.searchParams.get("resource"), "https://mcp.example.com/mcp");
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");

  const ready = await service.complete({ state: authorization.searchParams.get("state")!, code: "code-1", issuer: "https://auth.example.com" });
  assert.equal(ready.status, "ready");
  assert.equal(ready.toolCount, 1);
  assert.equal(database.flows.get(authorization.searchParams.get("state")!)?.private_state, "");

  const connection = await service.connection(scope);
  assert.equal(connection.tools?.[0]?.name, "product_search__search");
  const result = await connection.client.callTool({ name: "product_search__search", arguments: { query: "hello" } });
  assert.equal(result.isError, false);
  assert.ok(requests.some((request) => request.authorization === "Bearer access-1"));
});

test("MCP setup prefers a Client ID Metadata Document", async () => {
  const database = new MemoryD1();
  let registrationRequests = 0;
  const fetcher: typeof fetch = async (input) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (url === "https://mcp.example.com/mcp") {
      return new Response(null, { status: 401, headers: {
        "www-authenticate": 'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"',
      } });
    }
    if (url === "https://mcp.example.com/.well-known/oauth-protected-resource") {
      return Response.json({ resource: "https://mcp.example.com/mcp", authorization_servers: ["https://auth.example.com"] });
    }
    if (url === "https://auth.example.com/.well-known/oauth-authorization-server") {
      return Response.json({
        issuer: "https://auth.example.com",
        authorization_endpoint: "https://auth.example.com/authorize",
        token_endpoint: "https://auth.example.com/token",
        registration_endpoint: "https://auth.example.com/register",
        client_id_metadata_document_supported: true,
      });
    }
    if (url === "https://auth.example.com/register") registrationRequests += 1;
    throw new Error(`Unexpected request: ${url}`);
  };
  const clientMetadataUrl = "https://agent.example.com/api/connections/mcp/client-metadata";
  const service = new CloudflareMcpOAuthConnections({
    database,
    encryptionKey: Buffer.alloc(32, 9).toString("base64"),
    callbackUrl: "https://agent.example.com/api/connections/mcp/oauth/callback",
    clientMetadataUrl,
    fetch: fetcher,
  });
  const pending = await service.start(
    { tenantId: "tenant-1", userId: "user-1" },
    { name: "Search", url: "https://mcp.example.com/mcp" },
  );
  assert.equal(new URL(pending.authorizationUrl!).searchParams.get("client_id"), clientMetadataUrl);
  assert.equal(registrationRequests, 0);
});

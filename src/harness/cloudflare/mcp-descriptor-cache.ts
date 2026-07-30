import {
  McpToolDescriptorSchema,
  type McpDescriptorCache,
  type ScopedMcpEndpoint,
} from "../mcp/index.js";
import type {
  McpToolDescriptor,
} from "../mcp/client.js";
import type { TenantContext } from "../contracts/tenancy.js";

interface SqlRows<T> {
  toArray(): T[];
}

interface SqlStorage {
  exec<T = Record<string, unknown>>(
    query: string,
    ...bindings: unknown[]
  ): SqlRows<T>;
}

interface DescriptorCacheRow {
  descriptors_json: string;
  expires_at: string;
}

/**
 * Durable MCP descriptor cache for a thread Durable Object.
 *
 * The cache stores redacted schemas only. It never stores an access token,
 * authorization header, or credential reference.
 */
export class SqliteMcpDescriptorCache implements McpDescriptorCache {
  readonly #sql: SqlStorage;

  constructor(sql: unknown) {
    this.#sql = sql as SqlStorage;
    this.#sql.exec(`
      CREATE TABLE IF NOT EXISTS flary_mcp_descriptor_cache (
        organization_id TEXT NOT NULL,
        app_id TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        endpoint_url TEXT NOT NULL,
        endpoint_transport TEXT NOT NULL,
        server_name TEXT NOT NULL,
        descriptors_json TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (organization_id, app_id, connection_id)
      );
    `);
  }

  async get(request: {
    scope: TenantContext;
    endpoint: ScopedMcpEndpoint;
  }): Promise<readonly McpToolDescriptor[] | undefined> {
    const row = this.#sql
      .exec<DescriptorCacheRow>(
        `SELECT descriptors_json, expires_at
         FROM flary_mcp_descriptor_cache
         WHERE organization_id = ?
           AND app_id = ?
           AND connection_id = ?
           AND endpoint_url = ?
           AND endpoint_transport = ?
           AND server_name = ?`,
        request.scope.organizationId,
        request.scope.appId,
        request.endpoint.connectionId,
        request.endpoint.url,
        request.endpoint.transport,
        request.endpoint.name,
      )
      .toArray()[0];
    if (!row) return undefined;
    if (Date.parse(row.expires_at) <= Date.now()) {
      this.#sql.exec(
        `DELETE FROM flary_mcp_descriptor_cache
         WHERE organization_id = ? AND app_id = ? AND connection_id = ?`,
        request.scope.organizationId,
        request.scope.appId,
        request.endpoint.connectionId,
      );
      return undefined;
    }
    const parsed = McpToolDescriptorSchema.array().max(256).safeParse(
      JSON.parse(row.descriptors_json),
    );
    return parsed.success ? parsed.data : undefined;
  }

  async put(request: {
    scope: TenantContext;
    endpoint: ScopedMcpEndpoint;
    tools: readonly McpToolDescriptor[];
  }): Promise<void> {
    const tools = McpToolDescriptorSchema.array().max(256).parse(request.tools);
    const expiresAt =
      tools
        .map((tool) => tool.expiresAt)
        .sort((left, right) => Date.parse(left) - Date.parse(right))[0] ??
      new Date(Date.now() + 5 * 60_000).toISOString();
    const updatedAt = new Date().toISOString();
    this.#sql.exec(
      `INSERT INTO flary_mcp_descriptor_cache
        (organization_id, app_id, connection_id, endpoint_url,
         endpoint_transport, server_name, descriptors_json, expires_at,
         updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(organization_id, app_id, connection_id) DO UPDATE SET
         endpoint_url = excluded.endpoint_url,
         endpoint_transport = excluded.endpoint_transport,
         server_name = excluded.server_name,
         descriptors_json = excluded.descriptors_json,
         expires_at = excluded.expires_at,
         updated_at = excluded.updated_at`,
      request.scope.organizationId,
      request.scope.appId,
      request.endpoint.connectionId,
      request.endpoint.url,
      request.endpoint.transport,
      request.endpoint.name,
      JSON.stringify(tools),
      expiresAt,
      updatedAt,
    );
  }
}

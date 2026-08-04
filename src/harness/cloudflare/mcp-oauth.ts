import type { FlaryMcpConnection, FlaryMcpSource } from "../functions/types.js";
import { createMcpConnection } from "../functions/mcp.js";
import { assertSafeMcpUrl } from "../mcp/client.js";

interface D1StatementLike {
  bind(...values: unknown[]): D1StatementLike;
  run(): Promise<{ success?: boolean; meta?: { changes?: number } }>;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
}

export interface McpOAuthD1 {
  prepare(query: string): D1StatementLike;
}

export interface CloudflareMcpOAuthScope {
  readonly tenantId: string;
  readonly userId: string;
}

export interface CloudflareMcpOAuthOptions {
  readonly database: McpOAuthD1;
  /** Base64-encoded 32-byte AES key. */
  readonly encryptionKey: string;
  readonly callbackUrl?: string;
  readonly clientMetadataUrl?: string;
  readonly clientName?: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
}

export interface McpConnectionSummary {
  readonly id: string;
  readonly namespace: string;
  readonly name: string;
  readonly url: string;
  readonly authType: "none" | "oauth2";
  readonly status: "needs_auth" | "ready" | "error" | "disabled";
  readonly toolCount?: number;
  readonly scopes: readonly string[];
  readonly expiresAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface McpConnectionStartResult extends McpConnectionSummary {
  readonly authorizationUrl?: string;
}

type ConnectionRow = {
  id: string;
  owner_user_id: string;
  tenant_id: string;
  label: string;
  status: McpConnectionSummary["status"];
  encrypted_credential: string | null;
  credential_generation: string | null;
  credential_expires_at: number | null;
  namespace: string;
  endpoint_url: string;
  transport: "streamable-http" | "sse";
  auth_type: "none" | "oauth2";
  metadata_json: string | null;
  created_at: number;
  updated_at: number;
};

type FlowRow = {
  id: string;
  tenant_id: string;
  user_id: string;
  connection_id: string;
  status: "pending" | "ready" | "expired" | "error";
  private_state: string;
  expires_at: number;
};

type OAuthMetadata = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
  code_challenge_methods_supported?: string[];
  client_id_metadata_document_supported?: boolean;
  authorization_response_iss_parameter_supported?: boolean;
};

type ProtectedResourceMetadata = {
  resource: string;
  authorization_servers: string[];
  scopes_supported?: string[];
};

type PrivateFlow = {
  tenantId: string;
  userId: string;
  connectionId: string;
  endpointUrl: string;
  resource: string;
  issuer: string;
  requireIssuer: boolean;
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  codeVerifier: string;
  scopes: string[];
};

type StoredCredential = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  tokenType: "Bearer";
  scopes: string[];
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  resource: string;
};

const MAX_JSON_BYTES = 256 * 1024;
const FLOW_LIFETIME_MS = 15 * 60_000;

/**
 * Tenant-scoped remote MCP connection storage for a Cloudflare Worker.
 *
 * A user supplies only a name and HTTPS MCP URL. Flary discovers OAuth,
 * performs PKCE and client registration, stores the credential encrypted, and
 * exposes all ready connections through one lazy MCP catalog.
 */
export class CloudflareMcpOAuthConnections {
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;

  constructor(private readonly options: CloudflareMcpOAuthOptions) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? (() => new Date());
    if (decodeBase64(options.encryptionKey).byteLength !== 32) {
      throw new Error("MCP OAuth encryptionKey must contain 32 bytes");
    }
  }

  async start(scope: CloudflareMcpOAuthScope, input: {
    readonly name: string;
    readonly namespace?: string;
    readonly url: string;
    readonly scopes?: readonly string[];
  }): Promise<McpConnectionStartResult> {
    const endpoint = assertSafeMcpUrl(input.url).toString().replace(/\/$/, "");
    const name = input.name.trim().slice(0, 120);
    if (!name) throw new Error("MCP connection name is required");
    const namespace = normalizeNamespace(input.namespace ?? name);
    const existing = await this.loadByNamespace(scope, namespace);
    const connectionId = existing?.id ?? `mcp_${crypto.randomUUID()}`;
    const now = this.#now().getTime();

    const challenge = await probeAuthorization(this.#fetch, endpoint);
    if (!challenge.protected) {
      const runtime = createMcpConnection(
        sourceFor({ id: connectionId, namespace, endpoint_url: endpoint, transport: "streamable-http" }),
        { fetch: this.#fetch },
      );
      const tools = await runtime.fetchTools?.() ?? [];
      await this.expirePendingFlows(scope, connectionId);
      await this.upsertConnection(scope, {
        id: connectionId, name, namespace, endpoint, authType: "none",
        status: "ready", toolCount: tools.length, now,
      });
      return (await this.get(scope, connectionId))!;
    }

    const callbackUrl = this.options.callbackUrl;
    const clientMetadataUrl = this.options.clientMetadataUrl;
    if (!callbackUrl || !clientMetadataUrl) {
      throw new Error("MCP OAuth needs a stable callbackUrl and clientMetadataUrl");
    }
    assertSafePublicUrl(callbackUrl);
    assertSafePublicUrl(clientMetadataUrl);

    const resource = await discoverProtectedResource(
      this.#fetch,
      endpoint,
      challenge.resourceMetadataUrl,
    );
    const metadata = await discoverAuthorizationServer(this.#fetch, resource.authorization_servers[0]!);
    if (metadata.code_challenge_methods_supported && !metadata.code_challenge_methods_supported.includes("S256")) {
      throw new Error("The MCP authorization server does not support PKCE S256");
    }
    const client = await resolveClient(this.#fetch, metadata, {
      callbackUrl,
      clientMetadataUrl,
      clientName: this.options.clientName ?? "Flary",
    });
    const verifier = randomBase64Url(48);
    const challengeValue = await sha256Base64Url(verifier);
    const flowId = crypto.randomUUID();
    const supportedScopes = resource.scopes_supported ?? metadata.scopes_supported ?? [];
    const requestedScopes = input.scopes?.length
      ? [...input.scopes]
      : challenge.scopes?.length
        ? challenge.scopes
        : supportedScopes;
    const scopes = [...new Set(requestedScopes.map((value) => value.trim()).filter(Boolean).slice(0, 64))];
    const authorizationUrl = new URL(metadata.authorization_endpoint);
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set("client_id", client.id);
    authorizationUrl.searchParams.set("redirect_uri", callbackUrl);
    authorizationUrl.searchParams.set("state", flowId);
    authorizationUrl.searchParams.set("code_challenge", challengeValue);
    authorizationUrl.searchParams.set("code_challenge_method", "S256");
    authorizationUrl.searchParams.set("resource", resource.resource);
    if (scopes.length) authorizationUrl.searchParams.set("scope", scopes.join(" "));

    await this.expirePendingFlows(scope, connectionId);
    await this.upsertConnection(scope, {
      id: connectionId, name, namespace, endpoint, authType: "oauth2",
      status: "needs_auth", now,
    });
    const privateState: PrivateFlow = {
      tenantId: scope.tenantId,
      userId: scope.userId,
      connectionId,
      endpointUrl: endpoint,
      resource: resource.resource,
      issuer: metadata.issuer,
      requireIssuer: metadata.authorization_response_iss_parameter_supported === true,
      tokenEndpoint: metadata.token_endpoint,
      clientId: client.id,
      ...(client.secret ? { clientSecret: client.secret } : {}),
      redirectUri: callbackUrl,
      codeVerifier: verifier,
      scopes,
    };
    await this.options.database.prepare(
      `INSERT INTO flary_mcp_oauth_session
       (id, tenant_id, user_id, connection_id, status, private_state, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
    ).bind(
      flowId, scope.tenantId, scope.userId, connectionId,
      await this.encrypt(privateState, associatedFlow(scope, flowId)),
      now + FLOW_LIFETIME_MS, now, now,
    ).run();

    return {
      ...(await this.get(scope, connectionId))!,
      authorizationUrl: authorizationUrl.toString(),
    };
  }

  async complete(input: {
    readonly state: string;
    readonly code?: string;
    readonly error?: string;
    readonly issuer?: string;
  }): Promise<McpConnectionSummary> {
    const row = await this.options.database.prepare(
      "SELECT * FROM flary_mcp_oauth_session WHERE id = ?",
    ).bind(input.state).first<FlowRow>();
    if (!row || row.status !== "pending") throw new Error("The MCP authorization is not pending");
    const scope = { tenantId: row.tenant_id, userId: row.user_id };
    if (row.expires_at <= this.#now().getTime()) {
      await this.setFlowStatus(row.id, "expired");
      throw new Error("The MCP authorization expired. Start it again.");
    }
    try {
      const flow = await this.decrypt<PrivateFlow>(row.private_state, associatedFlow(scope, row.id));
      if (input.issuer && input.issuer !== flow.issuer) {
        throw new Error("The MCP authorization response came from an unexpected issuer");
      }
      if (flow.requireIssuer && !input.issuer) {
        throw new Error("The MCP authorization response did not identify its issuer");
      }
      if (input.error) throw new Error("The MCP authorization was denied");
      if (!input.code) throw new Error("The MCP callback did not contain an authorization code");
      const token = await exchangeAuthorizationCode(this.#fetch, flow, input.code, this.#now().getTime());
      const connection = await this.load(scope, row.connection_id);
      if (!connection) throw new Error("The MCP connection was not found");
      const credential: StoredCredential = {
        accessToken: token.accessToken,
        ...(token.refreshToken ? { refreshToken: token.refreshToken } : {}),
        ...(token.expiresAt ? { expiresAt: token.expiresAt } : {}),
        tokenType: "Bearer",
        scopes: token.scopes.length ? token.scopes : flow.scopes,
        tokenEndpoint: flow.tokenEndpoint,
        clientId: flow.clientId,
        ...(flow.clientSecret ? { clientSecret: flow.clientSecret } : {}),
        resource: flow.resource,
      };
      const runtime = createMcpConnection(sourceFor(connection), {
        fetch: this.#fetch,
        credentials: { get: async () => ({ kind: "bearer", value: credential.accessToken }) },
      });
      const tools = await runtime.fetchTools?.() ?? [];
      const now = this.#now().getTime();
      await this.options.database.prepare(
        `UPDATE flary_connection SET status = 'ready', encrypted_credential = ?,
         credential_generation = ?, credential_expires_at = ?, metadata_json = ?, updated_at = ?
         WHERE id = ? AND tenant_id = ? AND owner_user_id = ? AND kind = 'mcp'`,
      ).bind(
        await this.encrypt(credential, associatedCredential(scope, connection.id)),
        crypto.randomUUID(), credential.expiresAt ?? null,
        JSON.stringify({ toolCount: tools.length, scopes: credential.scopes }),
        now, connection.id, scope.tenantId, scope.userId,
      ).run();
      await this.setFlowStatus(row.id, "ready");
      return (await this.get(scope, connection.id))!;
    } catch (error) {
      await this.setFlowStatus(row.id, "error");
      await this.setConnectionStatus(scope, row.connection_id, "error");
      throw error;
    }
  }

  async list(scope: CloudflareMcpOAuthScope): Promise<readonly McpConnectionSummary[]> {
    const rows = await this.options.database.prepare(
      "SELECT * FROM flary_connection WHERE tenant_id = ? AND owner_user_id = ? AND kind = 'mcp' ORDER BY created_at ASC",
    ).bind(scope.tenantId, scope.userId).all<ConnectionRow>();
    return rows.results.map(publicConnection);
  }

  async get(scope: CloudflareMcpOAuthScope, id: string): Promise<McpConnectionSummary | undefined> {
    const row = await this.load(scope, id);
    return row ? publicConnection(row) : undefined;
  }

  async disable(scope: CloudflareMcpOAuthScope, id: string): Promise<void> {
    await this.options.database.prepare(
      "UPDATE flary_connection SET status = 'disabled', updated_at = ? WHERE id = ? AND tenant_id = ? AND owner_user_id = ? AND kind = 'mcp'",
    ).bind(this.#now().getTime(), id, scope.tenantId, scope.userId).run();
  }

  async remove(scope: CloudflareMcpOAuthScope, id: string): Promise<void> {
    await this.options.database.prepare(
      "DELETE FROM flary_mcp_oauth_session WHERE connection_id = ? AND tenant_id = ? AND user_id = ?",
    ).bind(id, scope.tenantId, scope.userId).run();
    await this.options.database.prepare(
      "DELETE FROM flary_connection WHERE id = ? AND tenant_id = ? AND owner_user_id = ? AND kind = 'mcp'",
    ).bind(id, scope.tenantId, scope.userId).run();
  }

  async connection(scope: CloudflareMcpOAuthScope): Promise<FlaryMcpConnection> {
    const rows = await this.options.database.prepare(
      "SELECT * FROM flary_connection WHERE tenant_id = ? AND owner_user_id = ? AND kind = 'mcp' AND status = 'ready' ORDER BY namespace ASC",
    ).bind(scope.tenantId, scope.userId).all<ConnectionRow>();
    const clients = new Map<string, ReturnType<typeof createMcpConnection>>();
    const clientFor = async (row: ConnectionRow) => {
      const current = clients.get(row.namespace);
      if (current) return current;
      const credential = row.auth_type === "oauth2" ? await this.credential(scope, row) : undefined;
      const runtime = createMcpConnection(sourceFor(row), {
        fetch: this.#fetch,
        ...(credential ? { credentials: { get: async () => ({ kind: "bearer" as const, value: credential.accessToken }) } } : {}),
      });
      clients.set(row.namespace, runtime);
      return runtime;
    };
    const tools: NonNullable<FlaryMcpConnection["tools"]>[number][] = [];
    for (const row of rows.results) {
      const runtime = await clientFor(row);
      for (const tool of await runtime.fetchTools?.() ?? []) {
        tools.push({ ...tool, name: `${row.namespace}__${tool.name}` });
      }
    }
    const revision = await sha256Hex(JSON.stringify({
      sources: rows.results.map((row) => ({
        id: row.id,
        namespace: row.namespace,
        endpoint: row.endpoint_url,
        generation: row.credential_generation,
        updatedAt: row.updated_at,
      })),
      tools,
    }));
    return {
      name: "connections",
      revision,
      tools,
      client: {
        callTool: async (input) => {
          const separator = input.name.indexOf("__");
          if (separator < 1) throw new Error("The MCP tool name does not contain a connection namespace");
          const namespace = input.name.slice(0, separator);
          const tool = input.name.slice(separator + 2);
          const row = rows.results.find((item) => item.namespace === namespace);
          if (!row) throw new Error("The MCP connection is not available");
          return (await clientFor(row)).client.callTool({ name: tool, arguments: input.arguments });
        },
      },
    };
  }

  private async credential(scope: CloudflareMcpOAuthScope, row: ConnectionRow): Promise<StoredCredential> {
    if (!row.encrypted_credential) throw new Error("The MCP connection needs authorization");
    let credential = await this.decrypt<StoredCredential>(row.encrypted_credential, associatedCredential(scope, row.id));
    if (!credential.expiresAt || credential.expiresAt > this.#now().getTime() + 60_000) return credential;
    if (!credential.refreshToken) {
      await this.options.database.prepare(
        "UPDATE flary_connection SET status = 'needs_auth', updated_at = ? WHERE id = ? AND tenant_id = ? AND owner_user_id = ? AND kind = 'mcp'",
      ).bind(this.#now().getTime(), row.id, scope.tenantId, scope.userId).run();
      throw new Error("The MCP connection expired and needs authorization");
    }
    const refreshed = await refreshCredential(this.#fetch, credential, this.#now().getTime());
    credential = { ...credential, ...refreshed };
    await this.options.database.prepare(
      "UPDATE flary_connection SET encrypted_credential = ?, credential_generation = ?, credential_expires_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ? AND owner_user_id = ? AND kind = 'mcp'",
    ).bind(
      await this.encrypt(credential, associatedCredential(scope, row.id)),
      crypto.randomUUID(), credential.expiresAt ?? null, this.#now().getTime(), row.id,
      scope.tenantId, scope.userId,
    ).run();
    return credential;
  }

  private async load(scope: CloudflareMcpOAuthScope, id: string): Promise<ConnectionRow | undefined> {
    return await this.options.database.prepare(
      "SELECT * FROM flary_connection WHERE id = ? AND tenant_id = ? AND owner_user_id = ? AND kind = 'mcp'",
    ).bind(id, scope.tenantId, scope.userId).first<ConnectionRow>() ?? undefined;
  }

  private async loadByNamespace(scope: CloudflareMcpOAuthScope, namespace: string): Promise<ConnectionRow | undefined> {
    return await this.options.database.prepare(
      "SELECT * FROM flary_connection WHERE tenant_id = ? AND owner_user_id = ? AND kind = 'mcp' AND namespace = ?",
    ).bind(scope.tenantId, scope.userId, namespace).first<ConnectionRow>() ?? undefined;
  }

  private async upsertConnection(scope: CloudflareMcpOAuthScope, input: {
    id: string; name: string; namespace: string; endpoint: string;
    authType: "none" | "oauth2"; status: ConnectionRow["status"];
    toolCount?: number; now: number;
  }): Promise<void> {
    await this.options.database.prepare(
      `INSERT INTO flary_connection
       (id, owner_user_id, tenant_id, kind, label, status, namespace,
        endpoint_url, transport, auth_type, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, 'mcp', ?, ?, ?, ?, 'streamable-http', ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET label = excluded.label, status = excluded.status,
         endpoint_url = excluded.endpoint_url, auth_type = excluded.auth_type,
         metadata_json = excluded.metadata_json, encrypted_credential = NULL,
         credential_generation = NULL, credential_expires_at = NULL,
         updated_at = excluded.updated_at`,
    ).bind(
      input.id, scope.userId, scope.tenantId, input.name, input.status,
      input.namespace, input.endpoint, input.authType,
      JSON.stringify({ toolCount: input.toolCount ?? 0, scopes: [] }),
      input.now, input.now,
    ).run();
  }

  private async setFlowStatus(id: string, status: FlowRow["status"]): Promise<void> {
    await this.options.database.prepare(
      "UPDATE flary_mcp_oauth_session SET status = ?, private_state = CASE WHEN ? = 'pending' THEN private_state ELSE '' END, updated_at = ? WHERE id = ?",
    ).bind(status, status, this.#now().getTime(), id).run();
  }

  private async expirePendingFlows(scope: CloudflareMcpOAuthScope, connectionId: string): Promise<void> {
    await this.options.database.prepare(
      `UPDATE flary_mcp_oauth_session SET status = 'expired', private_state = '', updated_at = ?
       WHERE connection_id = ? AND tenant_id = ? AND user_id = ? AND status = 'pending'`,
    ).bind(this.#now().getTime(), connectionId, scope.tenantId, scope.userId).run();
  }

  private async setConnectionStatus(
    scope: CloudflareMcpOAuthScope,
    id: string,
    status: ConnectionRow["status"],
  ): Promise<void> {
    await this.options.database.prepare(
      "UPDATE flary_connection SET status = ?, updated_at = ? WHERE id = ? AND tenant_id = ? AND owner_user_id = ? AND kind = 'mcp'",
    ).bind(status, this.#now().getTime(), id, scope.tenantId, scope.userId).run();
  }

  private async encrypt(value: unknown, associated: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await crypto.subtle.importKey("raw", decodeBase64(this.options.encryptionKey), "AES-GCM", false, ["encrypt"]);
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(associated) }, key, new TextEncoder().encode(JSON.stringify(value)));
    return `${encodeBase64(iv)}.${encodeBase64(new Uint8Array(ciphertext))}`;
  }

  private async decrypt<T>(value: string, associated: string): Promise<T> {
    const [iv, ciphertext] = value.split(".");
    if (!iv || !ciphertext) throw new Error("The encrypted MCP credential is invalid");
    const key = await crypto.subtle.importKey("raw", decodeBase64(this.options.encryptionKey), "AES-GCM", false, ["decrypt"]);
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: decodeBase64(iv), additionalData: new TextEncoder().encode(associated) }, key, decodeBase64(ciphertext));
    return JSON.parse(new TextDecoder().decode(plaintext)) as T;
  }
}

function sourceFor(row: Pick<ConnectionRow, "id" | "namespace" | "endpoint_url" | "transport">): FlaryMcpSource {
  return { kind: "mcp", namespace: row.namespace, connection: row.id, url: row.endpoint_url, transport: row.transport };
}

function normalizeNamespace(value: string): string {
  const result = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80);
  if (!result) throw new Error("MCP namespace must contain a letter or number");
  return result;
}

function publicConnection(row: ConnectionRow): McpConnectionSummary {
  const metadata = parseRecord(row.metadata_json);
  const scopes = Array.isArray(metadata.scopes) ? metadata.scopes.filter((value): value is string => typeof value === "string") : [];
  return {
    id: row.id,
    namespace: row.namespace,
    name: row.label,
    url: row.endpoint_url,
    authType: row.auth_type,
    status: row.status,
    ...(typeof metadata.toolCount === "number" ? { toolCount: metadata.toolCount } : {}),
    scopes,
    ...(row.credential_expires_at ? { expiresAt: new Date(row.credential_expires_at).toISOString() } : {}),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

async function probeAuthorization(fetcher: typeof fetch, endpoint: string): Promise<{
  protected: boolean;
  resourceMetadataUrl?: string;
  scopes?: string[];
}> {
  const response = await safeFetch(fetcher, endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "flary", version: "1" } } }),
  });
  if (response.status === 401) {
    const header = response.headers.get("www-authenticate");
    const resourceMetadataUrl = resourceMetadataFromHeader(header);
    const scopes = scopeFromHeader(header);
    return {
      protected: true,
      ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}),
      ...(scopes.length ? { scopes } : {}),
    };
  }
  if (!response.ok) throw new Error(`The MCP endpoint returned HTTP ${response.status}`);
  return { protected: false };
}

async function discoverProtectedResource(fetcher: typeof fetch, endpoint: string, advertised?: string): Promise<ProtectedResourceMetadata> {
  const url = new URL(endpoint);
  const candidates = [
    advertised,
    new URL(`/.well-known/oauth-protected-resource${url.pathname === "/" ? "" : url.pathname}`, url.origin).toString(),
    new URL("/.well-known/oauth-protected-resource", url.origin).toString(),
  ].filter((value, index, values): value is string => Boolean(value) && values.indexOf(value) === index);
  for (const candidate of candidates) {
    try {
      const value = await fetchJson(fetcher, candidate);
      const auth = Array.isArray(value.authorization_servers)
        ? value.authorization_servers.filter((item): item is string => typeof item === "string")
        : [];
      if (typeof value.resource !== "string" || auth.length === 0) continue;
      assertSafePublicUrl(value.resource);
      for (const issuer of auth) assertSafePublicUrl(issuer);
      return {
        resource: value.resource,
        authorization_servers: auth,
        ...(Array.isArray(value.scopes_supported)
          ? { scopes_supported: value.scopes_supported.filter((item): item is string => typeof item === "string") }
          : {}),
      };
    } catch {
      // Try the next standards-defined metadata location.
    }
  }
  throw new Error("The MCP server requires authorization but did not publish valid protected-resource metadata");
}

async function discoverAuthorizationServer(fetcher: typeof fetch, issuerInput: string): Promise<OAuthMetadata> {
  const issuer = assertSafePublicUrl(issuerInput);
  const path = issuer.pathname === "/" ? "" : issuer.pathname.replace(/\/$/, "");
  const candidates = [
    new URL(`/.well-known/oauth-authorization-server${path}`, issuer.origin).toString(),
    new URL(`${path}/.well-known/openid-configuration`, issuer.origin).toString(),
  ];
  for (const candidate of candidates) {
    try {
      const value = await fetchJson(fetcher, candidate);
      if (typeof value.issuer !== "string" || value.issuer !== issuerInput) continue;
      if (typeof value.authorization_endpoint !== "string" || typeof value.token_endpoint !== "string") continue;
      assertSafePublicUrl(value.issuer);
      assertSafePublicUrl(value.authorization_endpoint);
      assertSafePublicUrl(value.token_endpoint);
      if (typeof value.registration_endpoint === "string") assertSafePublicUrl(value.registration_endpoint);
      return {
        issuer: value.issuer,
        authorization_endpoint: value.authorization_endpoint,
        token_endpoint: value.token_endpoint,
        ...(typeof value.registration_endpoint === "string" ? { registration_endpoint: value.registration_endpoint } : {}),
        ...(Array.isArray(value.scopes_supported) ? { scopes_supported: stringArray(value.scopes_supported) } : {}),
        ...(Array.isArray(value.code_challenge_methods_supported) ? { code_challenge_methods_supported: stringArray(value.code_challenge_methods_supported) } : {}),
        ...(value.client_id_metadata_document_supported === true ? { client_id_metadata_document_supported: true } : {}),
        ...(value.authorization_response_iss_parameter_supported === true
          ? { authorization_response_iss_parameter_supported: true }
          : {}),
      };
    } catch {
      // Try OAuth and OpenID discovery forms.
    }
  }
  throw new Error("The MCP authorization server did not publish usable OAuth metadata");
}

async function resolveClient(fetcher: typeof fetch, metadata: OAuthMetadata, input: {
  callbackUrl: string; clientMetadataUrl: string; clientName: string;
}): Promise<{ id: string; secret?: string }> {
  if (metadata.client_id_metadata_document_supported) return { id: input.clientMetadataUrl };
  if (!metadata.registration_endpoint) {
    throw new Error("The MCP authorization server supports neither Client ID Metadata Documents nor Dynamic Client Registration");
  }
  const response = await safeFetch(fetcher, metadata.registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: input.clientName,
      redirect_uris: [input.callbackUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: "web",
    }),
  });
  const value = await responseJson(response);
  if (!response.ok || typeof value.client_id !== "string") {
    throw new Error("The MCP authorization server could not register this Flary deployment");
  }
  return {
    id: value.client_id,
    ...(typeof value.client_secret === "string" ? { secret: value.client_secret } : {}),
  };
}

async function exchangeAuthorizationCode(fetcher: typeof fetch, flow: PrivateFlow, code: string, now: number): Promise<{
  accessToken: string; refreshToken?: string; expiresAt?: number; scopes: string[];
}> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: flow.redirectUri,
    client_id: flow.clientId,
    code_verifier: flow.codeVerifier,
    resource: flow.resource,
    ...(flow.clientSecret ? { client_secret: flow.clientSecret } : {}),
  });
  const response = await safeFetch(fetcher, flow.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
  });
  const value = await responseJson(response);
  if (!response.ok || typeof value.access_token !== "string" || (value.token_type && String(value.token_type).toLowerCase() !== "bearer")) {
    throw new Error("The MCP authorization server did not return a valid bearer token");
  }
  return {
    accessToken: value.access_token,
    ...(typeof value.refresh_token === "string" ? { refreshToken: value.refresh_token } : {}),
    ...(typeof value.expires_in === "number" ? { expiresAt: now + value.expires_in * 1_000 } : {}),
    scopes: typeof value.scope === "string" ? value.scope.split(/\s+/).filter(Boolean) : [],
  };
}

async function refreshCredential(fetcher: typeof fetch, credential: StoredCredential, now: number): Promise<Partial<StoredCredential>> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: credential.refreshToken!,
    client_id: credential.clientId,
    resource: credential.resource,
    ...(credential.clientSecret ? { client_secret: credential.clientSecret } : {}),
  });
  const response = await safeFetch(fetcher, credential.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
  });
  const value = await responseJson(response);
  if (!response.ok || typeof value.access_token !== "string") throw new Error("The MCP credential could not be refreshed");
  return {
    accessToken: value.access_token,
    ...(typeof value.refresh_token === "string" ? { refreshToken: value.refresh_token } : {}),
    ...(typeof value.expires_in === "number" ? { expiresAt: now + value.expires_in * 1_000 } : {}),
    ...(typeof value.scope === "string" ? { scopes: value.scope.split(/\s+/).filter(Boolean) } : {}),
  };
}

async function fetchJson(fetcher: typeof fetch, url: string): Promise<Record<string, unknown>> {
  const response = await safeFetch(fetcher, url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`OAuth metadata returned HTTP ${response.status}`);
  return responseJson(response);
}

async function responseJson(response: Response): Promise<Record<string, any>> {
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > MAX_JSON_BYTES) throw new Error("OAuth response is too large");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_JSON_BYTES) throw new Error("OAuth response is too large");
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("The OAuth server returned invalid JSON");
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

async function safeFetch(fetcher: typeof fetch, urlInput: string, init: RequestInit): Promise<Response> {
  const url = assertSafePublicUrl(urlInput);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    return await fetcher(url, { ...init, redirect: "manual", signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function assertSafePublicUrl(value: string): URL {
  return assertSafeMcpUrl(value);
}

function resourceMetadataFromHeader(header: string | null): string | undefined {
  if (!header) return undefined;
  return /resource_metadata\s*=\s*["']([^"']+)["']/i.exec(header)?.[1]
    ?? /resource_metadata\s*=\s*([^,\s]+)/i.exec(header)?.[1];
}

function scopeFromHeader(header: string | null): string[] {
  if (!header) return [];
  const value = /(?:^|,)\s*Bearer\s+[^,]*?scope\s*=\s*["']([^"']*)["']/i.exec(header)?.[1]
    ?? /\bscope\s*=\s*["']([^"']*)["']/i.exec(header)?.[1];
  return value ? value.split(/\s+/).filter(Boolean).slice(0, 64) : [];
}

function parseRecord(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function stringArray(value: unknown[]): string[] {
  return value.filter((item): item is string => typeof item === "string").slice(0, 128);
}

function associatedFlow(scope: CloudflareMcpOAuthScope, id: string): string {
  return `flary:mcp-flow:${scope.tenantId}:${scope.userId}:${id}`;
}

function associatedCredential(scope: CloudflareMcpOAuthScope, id: string): string {
  return `flary:mcp-credential:${scope.tenantId}:${scope.userId}:${id}`;
}

function randomBase64Url(bytes: number): string {
  return encodeBase64(crypto.getRandomValues(new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return encodeBase64(digest).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function decodeBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function encodeBase64(value: Uint8Array): string {
  let output = "";
  for (const byte of value) output += String.fromCharCode(byte);
  return btoa(output);
}

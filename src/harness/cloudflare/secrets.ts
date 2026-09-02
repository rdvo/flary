import type { ConnectionSecretMetadata } from "../contracts/connections.js";
import {
  ConnectionSecretInputSchema,
  SecretScopeSchema,
  type ConnectionSecretInput,
  type SecretScope,
} from "../contracts/secrets.js";
import type { FlarySecretHostService, FlaryThreadScope, FlaryThreadTarget } from "../host/types.js";
import {
  decodeBase64Url,
  decryptStringAes256Gcm,
  encodeBase64Url,
  encryptStringAes256Gcm,
} from "../vault/crypto.js";

interface D1StatementLike {
  bind(...values: unknown[]): D1StatementLike;
  run(): Promise<{ success?: boolean; meta?: { changes?: number } }>;
  first<T>(): Promise<T | null>;
}

export interface SecretVaultD1 {
  prepare(query: string): D1StatementLike;
}

export interface CloudflareEncryptedSecretStoreOptions {
  readonly database: SecretVaultD1;
  /** Unpadded base64url-encoded 32-byte AES key. */
  readonly encryptionKey: string;
  readonly keyId?: string;
  readonly now?: () => Date;
  /** Override the durable scope key for product-specific tenancy rules. */
  readonly scopeKey?: (
    scope: FlaryThreadScope | FlaryThreadTarget,
    secretScope: SecretScope,
  ) => string;
}

type SecretRow = {
  tenant_id: string;
  app_id: string;
  scope_key: string;
  connection_id: string;
  name: string;
  scope: SecretScope;
  version: number;
  key_id: string;
  iv: string;
  ciphertext: string;
  description: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * Encrypted D1 credential storage for the open-source Cloudflare host.
 * Public methods return metadata. `resolve` is for trusted connector code.
 */
export class CloudflareEncryptedSecretStore implements FlarySecretHostService {
  private readonly key: Uint8Array;
  private readonly keyId: string;
  private readonly now: () => Date;

  constructor(private readonly options: CloudflareEncryptedSecretStoreOptions) {
    this.key = decodeBase64Url(options.encryptionKey);
    if (this.key.byteLength !== 32) {
      throw new Error("Secret vault encryptionKey must contain 32 bytes");
    }
    this.keyId = options.keyId ?? "flary-secret-v1";
    this.now = options.now ?? (() => new Date());
  }

  async put(
    scope: FlaryThreadScope | FlaryThreadTarget,
    connectionId: string,
    inputValue: ConnectionSecretInput,
  ): Promise<ConnectionSecretMetadata> {
    const input = ConnectionSecretInputSchema.parse(inputValue);
    await this.ensureSchema();
    const tenantId = scope.authorization.organizationId;
    const scopeKey = this.resolveScopeKey(scope, input.scope);
    const additionalData = aad(tenantId, scope.appId, scopeKey, connectionId, input.name);
    const encrypted = await encryptStringAes256Gcm(input.value, this.key, {
      additionalData,
    });
    const timestamp = this.now().toISOString();
    await this.options.database
      .prepare(
        `INSERT INTO flary_connection_secret
       (tenant_id, app_id, scope_key, connection_id, name, scope, version,
        key_id, iv, ciphertext, description, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, app_id, scope_key, connection_id, name)
       DO UPDATE SET scope = excluded.scope,
         version = flary_connection_secret.version + 1,
         key_id = excluded.key_id, iv = excluded.iv,
         ciphertext = excluded.ciphertext,
         description = excluded.description, expires_at = excluded.expires_at,
         updated_at = excluded.updated_at`,
      )
      .bind(
        tenantId,
        scope.appId,
        scopeKey,
        connectionId,
        input.name,
        input.scope,
        this.keyId,
        encodeBase64Url(encrypted.iv),
        encodeBase64Url(encrypted.ciphertext),
        input.description ?? null,
        input.expiresAt ?? null,
        timestamp,
        timestamp,
      )
      .run();
    return metadata(await this.load(scope, connectionId, input.name, input.scope));
  }

  async delete(
    scope: FlaryThreadScope | FlaryThreadTarget,
    connectionId: string,
    secretName: string,
  ): Promise<void> {
    await this.ensureSchema();
    const tenantId = scope.authorization.organizationId;
    // Delete all scopes for this tenant/app/name. The caller has already
    // passed the host authorization boundary.
    await this.options.database
      .prepare(
        `DELETE FROM flary_connection_secret
       WHERE tenant_id = ? AND app_id = ? AND connection_id = ? AND name = ?`,
      )
      .bind(tenantId, scope.appId, connectionId, secretName)
      .run();
  }

  /** Resolve plaintext only inside trusted connector code. Never return it publicly. */
  async resolve(
    scope: FlaryThreadScope | FlaryThreadTarget,
    connectionId: string,
    secretName: string,
    requestedScope: SecretScope,
  ): Promise<string | undefined> {
    await this.ensureSchema();
    const row = await this.loadOptional(scope, connectionId, secretName, requestedScope);
    if (!row) return undefined;
    if (row.expires_at && Date.parse(row.expires_at) <= this.now().getTime()) {
      return undefined;
    }
    return decryptStringAes256Gcm(
      decodeBase64Url(row.ciphertext),
      this.key,
      decodeBase64Url(row.iv),
      {
        additionalData: aad(row.tenant_id, row.app_id, row.scope_key, row.connection_id, row.name),
      },
    );
  }

  private async load(
    scope: FlaryThreadScope | FlaryThreadTarget,
    connectionId: string,
    secretName: string,
    requestedScope: SecretScope,
  ): Promise<SecretRow> {
    const row = await this.loadOptional(scope, connectionId, secretName, requestedScope);
    if (!row) throw new Error("The stored credential metadata is unavailable");
    return row;
  }

  private async loadOptional(
    scope: FlaryThreadScope | FlaryThreadTarget,
    connectionId: string,
    secretName: string,
    requestedScope: SecretScope,
  ): Promise<SecretRow | undefined> {
    const secretScope = SecretScopeSchema.parse(requestedScope);
    const tenantId = scope.authorization.organizationId;
    const scopeKey = this.resolveScopeKey(scope, secretScope);
    const row = await this.options.database
      .prepare(
        `SELECT tenant_id, app_id, scope_key, connection_id, name, scope,
              version, key_id, iv, ciphertext, description, expires_at,
              created_at, updated_at
       FROM flary_connection_secret
       WHERE tenant_id = ? AND app_id = ? AND scope_key = ?
         AND connection_id = ? AND name = ?`,
      )
      .bind(tenantId, scope.appId, scopeKey, connectionId, secretName)
      .first<SecretRow>();
    return row ?? undefined;
  }

  private resolveScopeKey(
    scope: FlaryThreadScope | FlaryThreadTarget,
    secretScope: SecretScope,
  ): string {
    if (this.options.scopeKey) return this.options.scopeKey(scope, secretScope);
    if (secretScope === "organization") {
      return `organization:${scope.authorization.organizationId}`;
    }
    if (secretScope === "project") {
      return `project:${scope.authorization.organizationId}:${scope.appId}`;
    }
    if ("threadId" in scope) {
      return `${secretScope}:${scope.authorization.organizationId}:${scope.appId}:${scope.threadId}`;
    }
    throw new Error(`${secretScope} secret scope requires a thread target`);
  }

  private async ensureSchema(): Promise<void> {
    await this.options.database
      .prepare(
        `CREATE TABLE IF NOT EXISTS flary_connection_secret (
        tenant_id TEXT NOT NULL,
        app_id TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        name TEXT NOT NULL,
        scope TEXT NOT NULL,
        version INTEGER NOT NULL,
        key_id TEXT NOT NULL,
        iv TEXT NOT NULL,
        ciphertext TEXT NOT NULL,
        description TEXT,
        expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, app_id, scope_key, connection_id, name)
      )`,
      )
      .run();
  }
}

function metadata(row: SecretRow): ConnectionSecretMetadata {
  return {
    id: `secret:${row.connection_id.slice(0, 80)}:${row.name.slice(0, 80)}`,
    connectionId: row.connection_id,
    name: row.name,
    scope: row.scope,
    version: row.version,
    keyId: row.key_id,
    description: row.description,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function aad(
  tenantId: string,
  appId: string,
  scopeKey: string,
  connectionId: string,
  name: string,
): Uint8Array {
  return new TextEncoder().encode(JSON.stringify([tenantId, appId, scopeKey, connectionId, name]));
}

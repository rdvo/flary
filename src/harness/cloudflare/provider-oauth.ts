import {
  completeProviderOAuth,
  pollProviderOAuth,
  providerOAuthSubject,
  startProviderOAuth,
  type ProviderOAuthPrivateState,
} from "../providers/oauth.js";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import type { OAuthCredential } from "@earendil-works/pi-ai";
import { registerProvider } from "@flue/runtime";
import type { SubscriptionProvider } from "../contracts/connections.js";

interface D1StatementLike {
  bind(...values: unknown[]): D1StatementLike;
  run(): Promise<{ success?: boolean; meta?: { changes?: number } }>;
  first<T>(): Promise<T | null>;
}

export interface ProviderOAuthD1 {
  prepare(query: string): D1StatementLike;
}

export interface CloudflareProviderOAuthOptions {
  readonly database: ProviderOAuthD1;
  /** Base64-encoded 32-byte AES key. */
  readonly encryptionKey: string;
  readonly now?: () => Date;
}

export interface CloudflareProviderOAuthScope {
  readonly tenantId: string;
  readonly userId: string;
}

/** Secret result for trusted Worker code. Do not return this from an HTTP route. */
export interface TrustedOpenAICodexAccess {
  readonly connectionId: string;
  readonly accessToken: string;
  readonly credentialGeneration: string;
  readonly expiresAt: number;
  readonly accountId?: string;
}

export type TrustedProviderAliasInput = {
  readonly provider: "openai-codex";
  /** A secret-free alias that is unique to one tenant and thread. */
  readonly providerAlias: string;
  readonly accessToken: string;
} | {
  readonly provider: "openai";
  /** A secret-free alias that is unique to one tenant and thread. */
  readonly providerAlias: string;
  readonly apiKey: string;
};

export interface CloudflareProviderOAuthSession {
  readonly id: string;
  readonly provider: SubscriptionProvider;
  readonly method: "device_code" | "authorization_code" | "browser_callback";
  readonly status: "pending" | "ready" | "expired" | "cancelled" | "error";
  readonly authorizationUrl?: string;
  readonly verificationUri?: string;
  readonly userCode?: string;
  readonly intervalSeconds?: number;
  readonly expiresAt: string;
  readonly connectionId: string;
  readonly accountSubject?: string;
}

type OAuthRow = {
  id: string;
  tenant_id: string;
  user_id: string;
  connection_id: string;
  provider: SubscriptionProvider;
  method: CloudflareProviderOAuthSession["method"];
  status: CloudflareProviderOAuthSession["status"];
  authorization_url: string | null;
  verification_uri: string | null;
  user_code: string | null;
  interval_seconds: number | null;
  private_state: string;
  expires_at: number;
  account_subject: string | null;
};

/**
 * Encrypted D1 persistence for hosted provider authorization flows.
 *
 * The adapter stores only encrypted private flow state and credentials. Its
 * public result never contains access tokens, refresh tokens, or verifiers.
 */
export class CloudflareProviderOAuthPersistence {
  private readonly now: () => Date;

  constructor(private readonly options: CloudflareProviderOAuthOptions) {
    this.now = options.now ?? (() => new Date());
    if (decodeBase64(options.encryptionKey).byteLength !== 32) {
      throw new Error("Provider OAuth encryptionKey must contain 32 bytes");
    }
  }

  async start(scope: CloudflareProviderOAuthScope, input: {
    provider: SubscriptionProvider;
    method?: CloudflareProviderOAuthSession["method"];
  }): Promise<CloudflareProviderOAuthSession> {
    const flow = await startProviderOAuth(input);
    const id = crypto.randomUUID();
    const connectionId = `subscription_${scope.userId}_${input.provider}`;
    const expiresAt = this.now().getTime() + flow.expiresInSeconds * 1_000;
    const privateState = await this.encrypt(flow.privateState, associatedData(scope, id, "flow"));
    await this.options.database.prepare(
      `INSERT INTO flary_provider_oauth_session
       (id, tenant_id, user_id, connection_id, provider, method, status,
        authorization_url, verification_uri, user_code, interval_seconds,
        private_state, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id, scope.tenantId, scope.userId, connectionId, input.provider,
      flow.method, flow.authorizationUrl ?? null, flow.verificationUri ?? null,
      flow.userCode ?? null, flow.intervalSeconds ?? null, privateState,
      expiresAt, this.now().getTime(), this.now().getTime(),
    ).run();
    return this.get(scope, id);
  }

  async get(scope: CloudflareProviderOAuthScope, id: string, poll = false): Promise<CloudflareProviderOAuthSession> {
    let row = await this.load(scope, id);
    if (row.status === "pending" && row.expires_at <= this.now().getTime()) {
      await this.setTerminal(row, "expired");
      row = await this.load(scope, id);
    }
    if (poll && row.status === "pending" && row.provider === "openai-codex") {
      try {
        const state = await this.decrypt<ProviderOAuthPrivateState>(row.private_state, associatedData(scope, id, "flow"));
        const result = await pollProviderOAuth({ privateState: state });
        if (result.status === "ready") await this.finish(scope, row, result.credential);
        else {
          const encrypted = await this.encrypt(result.privateState, associatedData(scope, id, "flow"));
          await this.options.database.prepare("UPDATE flary_provider_oauth_session SET private_state = ?, interval_seconds = ?, updated_at = ? WHERE id = ? AND tenant_id = ? AND user_id = ? AND status = 'pending'")
            .bind(encrypted, result.intervalSeconds, this.now().getTime(), id, scope.tenantId, scope.userId).run();
        }
        row = await this.load(scope, id);
      } catch (error) {
        await this.setTerminal(row, "error");
        throw safeOAuthError(error);
      }
    }
    return publicSession(row);
  }

  async complete(scope: CloudflareProviderOAuthScope, id: string, authorizationResult: string): Promise<CloudflareProviderOAuthSession> {
    const row = await this.load(scope, id);
    if (row.status !== "pending") throw new Error("The provider login is not pending");
    try {
      const state = await this.decrypt<ProviderOAuthPrivateState>(row.private_state, associatedData(scope, id, "flow"));
      const credential = await completeProviderOAuth({ privateState: state, authorizationResult });
      await this.finish(scope, row, credential);
      return this.get(scope, id);
    } catch (error) {
      await this.setTerminal(row, "error");
      throw safeOAuthError(error);
    }
  }

  async cancel(scope: CloudflareProviderOAuthScope, id: string): Promise<CloudflareProviderOAuthSession> {
    const row = await this.load(scope, id);
    if (row.status === "pending") await this.setTerminal(row, "cancelled");
    return this.get(scope, id);
  }

  /**
   * Resolve an OpenAI Codex credential for trusted Worker runtime code.
   *
   * This method uses a D1 lock before refresh. It returns only the values that
   * runtime registration needs. Callers must not put this result in a public
   * response, event, durable pin, or log.
   */
  async resolveOpenAICodexAccess(
    scope: CloudflareProviderOAuthScope,
    connectionId: string,
    options: { readonly minValidityMs?: number; readonly signal?: AbortSignal } = {},
  ): Promise<TrustedOpenAICodexAccess> {
    const minValidityMs = options.minValidityMs ?? 60_000;
    let row = await this.loadConnection(scope, connectionId);
    let credential = await this.decrypt<Record<string, unknown>>(
      row.encrypted_credential,
      associatedData(scope, connectionId, "credential"),
    );
    if (usableCodexCredential(credential, this.now().getTime() + minValidityMs)) {
      return trustedAccess(row, credential);
    }

    const lockId = crypto.randomUUID();
    await this.acquireRefreshLock(connectionId, lockId, options.signal);
    try {
      // Another isolate can finish a refresh before this isolate gets the lock.
      row = await this.loadConnection(scope, connectionId);
      credential = await this.decrypt<Record<string, unknown>>(
        row.encrypted_credential,
        associatedData(scope, connectionId, "credential"),
      );
      if (usableCodexCredential(credential, this.now().getTime() + minValidityMs)) {
        return trustedAccess(row, credential);
      }

      const oauth = openaiCodexProvider().auth.oauth;
      if (!oauth) throw new Error("OpenAI Codex OAuth is unavailable");
      const current = toOAuthCredential(credential);
      const refreshed = await oauth.refresh(current, options.signal);
      const complete = { ...credential, ...refreshed, type: "oauth" };
      if (!usableCodexCredential(complete, this.now().getTime())) {
        throw new Error("OpenAI Codex returned an invalid refreshed credential");
      }
      const encrypted = await this.encrypt(
        complete,
        associatedData(scope, connectionId, "credential"),
      );
      const generation = crypto.randomUUID();
      const result = await this.options.database.prepare(
        `UPDATE flary_connection SET encrypted_credential = ?, credential_generation = ?,
           credential_expires_at = ?, updated_at = ?
         WHERE id = ? AND tenant_id = ? AND owner_user_id = ?
           AND kind = 'provider_subscription' AND status = 'ready'
           AND credential_generation = ?`,
      ).bind(
        encrypted,
        generation,
        complete.expires,
        this.now().getTime(),
        connectionId,
        scope.tenantId,
        scope.userId,
        row.credential_generation,
      ).run();
      if (result.meta?.changes !== 1) {
        throw new Error("The provider credential changed during refresh");
      }
      return trustedAccess({ ...row, credential_generation: generation }, complete);
    } finally {
      await this.options.database.prepare(
        "DELETE FROM flary_provider_credential_refresh_lock WHERE connection_id = ? AND lock_id = ?",
      ).bind(connectionId, lockId).run();
    }
  }

  private async finish(scope: CloudflareProviderOAuthScope, row: OAuthRow, credential: Record<string, unknown>): Promise<void> {
    const encrypted = await this.encrypt(credential, associatedData(scope, row.connection_id, "credential"));
    const subject = providerOAuthSubject(credential as never);
    const expires = typeof credential.expires === "number" ? credential.expires : null;
    await this.options.database.prepare(
      `INSERT INTO flary_connection
       (id, owner_user_id, tenant_id, kind, label, status, encrypted_credential,
        credential_generation, credential_expires_at, created_at, updated_at)
       VALUES (?, ?, ?, 'provider_subscription', ?, 'ready', ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status = 'ready', encrypted_credential = excluded.encrypted_credential,
         credential_generation = excluded.credential_generation,
         credential_expires_at = excluded.credential_expires_at, updated_at = excluded.updated_at`,
    ).bind(
      row.connection_id, scope.userId, scope.tenantId, row.provider, encrypted,
      crypto.randomUUID(), expires, this.now().getTime(), this.now().getTime(),
    ).run();
    await this.options.database.prepare(
      "UPDATE flary_provider_oauth_session SET status = 'ready', private_state = '', account_subject = ?, updated_at = ? WHERE id = ? AND tenant_id = ? AND user_id = ? AND status = 'pending'",
    ).bind(subject ?? null, this.now().getTime(), row.id, scope.tenantId, scope.userId).run();
  }

  private async setTerminal(row: OAuthRow, status: "expired" | "cancelled" | "error"): Promise<void> {
    await this.options.database.prepare("UPDATE flary_provider_oauth_session SET status = ?, private_state = '', updated_at = ? WHERE id = ? AND status = 'pending'")
      .bind(status, this.now().getTime(), row.id).run();
  }

  private async load(scope: CloudflareProviderOAuthScope, id: string): Promise<OAuthRow> {
    const row = await this.options.database.prepare("SELECT * FROM flary_provider_oauth_session WHERE id = ? AND tenant_id = ? AND user_id = ?")
      .bind(id, scope.tenantId, scope.userId).first<OAuthRow>();
    if (!row) throw new Error("The provider login was not found");
    return row;
  }

  private async loadConnection(scope: CloudflareProviderOAuthScope, connectionId: string): Promise<ConnectionRow> {
    const row = await this.options.database.prepare(
      `SELECT id, label, status, encrypted_credential, credential_generation, credential_expires_at
       FROM flary_connection
       WHERE id = ? AND tenant_id = ? AND owner_user_id = ? AND kind = 'provider_subscription'`,
    ).bind(connectionId, scope.tenantId, scope.userId).first<ConnectionRow>();
    if (!row || row.status !== "ready" || row.label !== "openai-codex") {
      throw new Error("The OpenAI Codex connection was not found");
    }
    return row;
  }

  private async acquireRefreshLock(connectionId: string, lockId: string, signal?: AbortSignal): Promise<void> {
    await this.options.database.prepare(
      `CREATE TABLE IF NOT EXISTS flary_provider_credential_refresh_lock (
         connection_id TEXT PRIMARY KEY NOT NULL,
         lock_id TEXT NOT NULL,
         expires_at INTEGER NOT NULL
       )`,
    ).run();
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (signal?.aborted) throw new Error("The provider credential refresh was aborted");
      const now = this.now().getTime();
      await this.options.database.prepare(
        "DELETE FROM flary_provider_credential_refresh_lock WHERE connection_id = ? AND expires_at <= ?",
      ).bind(connectionId, now).run();
      const result = await this.options.database.prepare(
        "INSERT OR IGNORE INTO flary_provider_credential_refresh_lock (connection_id, lock_id, expires_at) VALUES (?, ?, ?)",
      ).bind(connectionId, lockId, now + 30_000).run();
      if (result.meta?.changes === 1) return;
      await delay(50);
    }
    throw new Error("The provider credential refresh is busy");
  }

  private async encrypt(value: unknown, associated: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await crypto.subtle.importKey("raw", decodeBase64(this.options.encryptionKey) as unknown as BufferSource, "AES-GCM", false, ["encrypt"]);
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(associated) }, key, new TextEncoder().encode(JSON.stringify(value)));
    return `${encodeBase64(iv)}.${encodeBase64(new Uint8Array(ciphertext))}`;
  }

  private async decrypt<T>(value: string, associated: string): Promise<T> {
    const [iv, ciphertext] = value.split(".");
    if (!iv || !ciphertext) throw new Error("The encrypted provider state is invalid");
    const key = await crypto.subtle.importKey("raw", decodeBase64(this.options.encryptionKey) as unknown as BufferSource, "AES-GCM", false, ["decrypt"]);
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: decodeBase64(iv) as unknown as BufferSource, additionalData: new TextEncoder().encode(associated) }, key, decodeBase64(ciphertext) as unknown as BufferSource);
    return JSON.parse(new TextDecoder().decode(plaintext)) as T;
  }
}

type ConnectionRow = {
  id: string;
  label: string;
  status: string;
  encrypted_credential: string;
  credential_generation: string;
  credential_expires_at: number | null;
};

/** Register one trusted, thread-unique OpenAI or OpenAI Codex provider alias. */
export function registerTrustedProviderAlias(input: TrustedProviderAliasInput): void {
  if (!/^flary-runtime-[a-z0-9][a-z0-9_-]{15,159}$/.test(input.providerAlias)) {
    throw new Error("The runtime provider alias is invalid");
  }
  if (input.provider === "openai-codex") {
    if (!input.accessToken) throw new Error("The OpenAI Codex access token is missing");
    registerProvider(input.providerAlias, {
      catalogProvider: "openai-codex",
      api: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api",
      apiKey: input.accessToken,
    });
    return;
  }
  if (!input.apiKey) throw new Error("The OpenAI API key is missing");
  registerProvider(input.providerAlias, {
    catalogProvider: "openai",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    apiKey: input.apiKey,
  });
}

function toOAuthCredential(value: Record<string, unknown>): OAuthCredential {
  if (typeof value.access !== "string" || typeof value.refresh !== "string" || typeof value.expires !== "number") {
    throw new Error("The stored OpenAI Codex credential is invalid");
  }
  return { ...value, type: "oauth", access: value.access, refresh: value.refresh, expires: value.expires } as OAuthCredential;
}

function usableCodexCredential(value: Record<string, unknown>, after: number): boolean {
  return typeof value.access === "string" && value.access.length > 0 &&
    typeof value.refresh === "string" && value.refresh.length > 0 &&
    typeof value.expires === "number" && value.expires > after;
}

function trustedAccess(row: ConnectionRow, credential: Record<string, unknown>): TrustedOpenAICodexAccess {
  return {
    connectionId: row.id,
    accessToken: credential.access as string,
    credentialGeneration: row.credential_generation,
    expiresAt: credential.expires as number,
    ...(typeof credential.accountId === "string" ? { accountId: credential.accountId } : {}),
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function publicSession(row: OAuthRow): CloudflareProviderOAuthSession {
  return {
    id: row.id, provider: row.provider, method: row.method, status: row.status,
    ...(row.authorization_url ? { authorizationUrl: row.authorization_url } : {}),
    ...(row.verification_uri ? { verificationUri: row.verification_uri } : {}),
    ...(row.user_code ? { userCode: row.user_code } : {}),
    ...(row.interval_seconds ? { intervalSeconds: row.interval_seconds } : {}),
    expiresAt: new Date(row.expires_at).toISOString(), connectionId: row.connection_id,
    ...(row.account_subject ? { accountSubject: row.account_subject } : {}),
  };
}

function associatedData(scope: CloudflareProviderOAuthScope, id: string, kind: string): string {
  return `flary:${kind}:${scope.tenantId}:${scope.userId}:${id}`;
}
function decodeBase64(value: string): Uint8Array { return Uint8Array.from(atob(value), (character) => character.charCodeAt(0)); }
function encodeBase64(value: Uint8Array): string { let output = ""; for (const byte of value) output += String.fromCharCode(byte); return btoa(output); }
function safeOAuthError(error: unknown): Error { return new Error(error instanceof Error ? error.message : "The provider login failed"); }

import {
  createModels,
  type Credential,
  type CredentialInfo,
  type CredentialStore,
  type OAuthCredentials,
} from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { and, eq, inArray } from "drizzle-orm";

import { createDb } from "./db";
import { flaryConnection, secretEnvelope } from "./db/schema";
import type { Env } from "./env";
import {
  decryptToken,
  encryptToken,
  providerCredentialAssociatedData,
} from "./security/tokens";

const LOCK_TTL_MS = 30_000;
const LOCK_WAIT_MS = 10_000;
const LOCK_POLL_MS = 100;
const OAUTH_SECRET_NAMES = [
  "access_token",
  "refresh_token",
  "id_token",
  "account_id",
] as const;

type SupportedSubscriptionProvider = "anthropic" | "openai-codex";

type StoredSecret = {
  id: string;
  name: string;
  version: number;
  ciphertext: string;
  iv: string;
  expiresAt: Date | null;
};

export class ProviderSubscriptionError extends Error {
  constructor(
    public readonly code:
      | "unsupported_provider"
      | "credential_missing"
      | "credential_lock_timeout"
      | "credential_lock_lost"
      | "credential_storage",
    message: string,
  ) {
    super(message);
    this.name = "ProviderSubscriptionError";
  }
}

/**
 * Resolve and refresh one subscription token through Pi's provider adapter.
 *
 * Pi owns provider-specific refresh behavior. Flary owns encrypted storage and
 * a D1 lock that serializes refresh across Worker isolates and threads.
 */
export async function resolveSubscriptionAccessToken(
  env: Env,
  input: {
    organizationId: string;
    userId: string;
    connectionId: string;
    provider: SupportedSubscriptionProvider;
  },
): Promise<string> {
  const provider = parseProvider(input.provider);
  const store = new CloudOAuthCredentialStore(env, {
    organizationId: input.organizationId,
    userId: input.userId,
    connectionId: input.connectionId,
    provider,
  });
  const models = createModels({
    credentials: store,
    authContext: {
      async env() {
        return undefined;
      },
      async fileExists() {
        return false;
      },
    },
  });
  models.setProvider(
    provider === "anthropic" ? anthropicProvider() : openaiCodexProvider(),
  );
  const result = await models.getAuth(provider);
  const token = result?.auth.apiKey;
  if (!token) {
    throw new ProviderSubscriptionError(
      "credential_missing",
      `No usable ${provider} subscription credential is configured`,
    );
  }
  return token;
}

export async function disconnectSubscriptionCredential(
  env: Env,
  input: {
    organizationId: string;
    userId: string;
    connectionId: string;
    provider: SupportedSubscriptionProvider;
  },
): Promise<void> {
  const provider = parseProvider(input.provider);
  const store = new CloudOAuthCredentialStore(env, {
    organizationId: input.organizationId,
    userId: input.userId,
    connectionId: input.connectionId,
    provider,
  });
  await store.delete(provider);
}

export async function saveSubscriptionCredential(
  env: Env,
  input: {
    organizationId: string;
    userId: string;
    connectionId: string;
    provider: string;
    credential: OAuthCredentials;
    subject?: string;
    scopes?: readonly string[];
  },
): Promise<void> {
  const provider = parseProvider(input.provider);
  const store = new CloudOAuthCredentialStore(env, {
    organizationId: input.organizationId,
    userId: input.userId,
    connectionId: input.connectionId,
    provider,
  });
  await store.modify(provider, async () => ({
    type: "oauth",
    ...input.credential,
  }));
  await createDb(env.DB)
    .update(flaryConnection)
    .set({
      status: "ready",
      ownerUserId: input.userId,
      credentialSubject: input.subject ?? null,
      credentialScopesJson: JSON.stringify(input.scopes ?? []),
      credentialExpiresAt: new Date(input.credential.expires),
      credentialRefreshedAt: new Date(),
      credentialRevokedAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(flaryConnection.id, input.connectionId),
        eq(flaryConnection.organizationId, input.organizationId),
        eq(flaryConnection.ownerUserId, input.userId),
      ),
    );
}

class CloudOAuthCredentialStore implements CredentialStore {
  constructor(
    private readonly env: Env,
    private readonly scope: {
      organizationId: string;
      userId: string;
      connectionId: string;
      provider: SupportedSubscriptionProvider;
    },
  ) {}

  async read(providerId: string): Promise<Credential | undefined> {
    this.assertProvider(providerId);
    return this.readUnlocked();
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return (await this.readUnlocked())
      ? [{ providerId: this.scope.provider, type: "oauth" }]
      : [];
  }

  async modify(
    providerId: string,
    update: (
      current: Credential | undefined,
    ) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    this.assertProvider(providerId);
    const ownerId = crypto.randomUUID();
    await acquireCredentialLock(
      this.env,
      this.scope.connectionId,
      ownerId,
    );
    const lease = startCredentialLockRenewal(
      this.env,
      this.scope.connectionId,
      ownerId,
    );
    try {
      const current = await this.readUnlocked();
      const updated = await update(current);
      const next = updated?.type === "oauth"
        ? preserveCodexCredentialFields(current, updated)
        : updated;
      if (next) {
        if (next.type !== "oauth") {
          throw new ProviderSubscriptionError(
            "credential_storage",
            "Subscription refresh returned a non-OAuth credential",
          );
        }
        await lease.assertHeld();
        await this.writeUnlocked(next);
        await lease.assertHeld();
      }
      return this.readUnlocked();
    } finally {
      await lease.stop();
      await releaseCredentialLock(
        this.env,
        this.scope.connectionId,
        ownerId,
      );
    }
  }

  async delete(providerId: string): Promise<void> {
    this.assertProvider(providerId);
    await createDb(this.env.DB)
      .delete(secretEnvelope)
      .where(
        and(
          eq(secretEnvelope.connectionId, this.scope.connectionId),
          inArray(secretEnvelope.name, [...OAUTH_SECRET_NAMES]),
        ),
      );
    await createDb(this.env.DB)
      .update(flaryConnection)
      .set({
        status: "disabled",
        credentialRevokedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(flaryConnection.id, this.scope.connectionId),
          eq(flaryConnection.ownerUserId, this.scope.userId),
        ),
      );
  }

  private assertProvider(providerId: string): void {
    if (providerId !== this.scope.provider) {
      throw new ProviderSubscriptionError(
        "unsupported_provider",
        `Credential store is scoped to ${this.scope.provider}`,
      );
    }
  }

  private async readUnlocked(): Promise<Credential | undefined> {
    const rows = await loadSecrets(this.env, this.scope);
    const access = rows.find((row) => row.name === "access_token");
    const refresh = rows.find((row) => row.name === "refresh_token");
    const idToken = rows.find((row) => row.name === "id_token");
    const accountId = rows.find((row) => row.name === "account_id");
    if (!access || !refresh || !this.env.FLARY_TOKEN_ENCRYPTION_KEY_B64) {
      return undefined;
    }
    const [accessValue, refreshValue, idTokenValue, accountIdValue] = await Promise.all([
      decryptSecret(this.env, this.scope, access),
      decryptSecret(this.env, this.scope, refresh),
      idToken ? decryptSecret(this.env, this.scope, idToken) : undefined,
      accountId ? decryptSecret(this.env, this.scope, accountId) : undefined,
    ]);
    return {
      type: "oauth",
      access: accessValue,
      refresh: refreshValue,
      expires: access.expiresAt?.getTime() ?? 0,
      ...(idTokenValue ? { idToken: idTokenValue } : {}),
      ...(accountIdValue ? { accountId: accountIdValue } : {}),
    };
  }

  private async writeUnlocked(
    credential: Extract<Credential, { type: "oauth" }>,
  ): Promise<void> {
    if (!this.env.FLARY_TOKEN_ENCRYPTION_KEY_B64) {
      throw new ProviderSubscriptionError(
        "credential_storage",
        "Token encryption is not configured",
      );
    }
    const idToken = credentialString(credential, "idToken");
    const accountId = credentialString(credential, "accountId");
    await Promise.all([
      saveSecret(this.env, this.scope, {
        name: "access_token",
        value: credential.access,
        expiresAt: new Date(credential.expires),
      }),
      saveSecret(this.env, this.scope, {
        name: "refresh_token",
        value: credential.refresh,
        expiresAt: null,
      }),
      ...(idToken
        ? [saveSecret(this.env, this.scope, {
            name: "id_token",
            value: idToken,
            expiresAt: new Date(credential.expires),
          })]
        : []),
      ...(accountId
        ? [saveSecret(this.env, this.scope, {
            name: "account_id",
            value: accountId,
            expiresAt: null,
          })]
        : []),
    ]);
    await createDb(this.env.DB)
      .update(flaryConnection)
      .set({
        status: "ready",
        credentialExpiresAt: new Date(credential.expires),
        credentialRefreshedAt: new Date(),
        credentialRevokedAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(flaryConnection.id, this.scope.connectionId),
          eq(flaryConnection.ownerUserId, this.scope.userId),
        ),
      );
  }
}

/** Keep Codex identity fields when a refresh response omits optional values. */
export function preserveCodexCredentialFields(
  current: Credential | undefined,
  next: Extract<Credential, { type: "oauth" }>,
): Extract<Credential, { type: "oauth" }> {
  if (current?.type !== "oauth") return next;
  const idToken = credentialString(next, "idToken") ??
    credentialString(current, "idToken");
  const accountId = credentialString(next, "accountId") ??
    credentialString(current, "accountId");
  return {
    ...next,
    ...(idToken ? { idToken } : {}),
    ...(accountId ? { accountId } : {}),
  };
}

function credentialString(
  credential: Extract<Credential, { type: "oauth" }>,
  key: "idToken" | "accountId",
): string | undefined {
  const value = credential[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseProvider(value: string): SupportedSubscriptionProvider {
  if (value === "anthropic" || value === "openai-codex") return value;
  throw new ProviderSubscriptionError(
    "unsupported_provider",
    `Subscription OAuth is not supported for provider '${value}'`,
  );
}

async function loadSecrets(
  env: Env,
  scope: {
    organizationId: string;
    userId: string;
    connectionId: string;
    provider: SupportedSubscriptionProvider;
  },
): Promise<StoredSecret[]> {
  return createDb(env.DB)
    .select({
      id: secretEnvelope.id,
      name: secretEnvelope.name,
      version: secretEnvelope.version,
      ciphertext: secretEnvelope.ciphertext,
      iv: secretEnvelope.iv,
      expiresAt: secretEnvelope.expiresAt,
    })
    .from(secretEnvelope)
    .innerJoin(
      flaryConnection,
      eq(flaryConnection.id, secretEnvelope.connectionId),
    )
    .where(
      and(
        eq(secretEnvelope.organizationId, scope.organizationId),
        eq(secretEnvelope.connectionId, scope.connectionId),
        eq(flaryConnection.ownerUserId, scope.userId),
        eq(flaryConnection.billingMode, "subscription"),
        eq(flaryConnection.authType, "oauth2"),
        inArray(secretEnvelope.name, [...OAUTH_SECRET_NAMES]),
      ),
    );
}

async function decryptSecret(
  env: Env,
  scope: {
    organizationId: string;
    userId: string;
    connectionId: string;
    provider: SupportedSubscriptionProvider;
  },
  secret: StoredSecret,
): Promise<string> {
  return decryptToken(
    { ciphertext: secret.ciphertext, iv: secret.iv },
    env.FLARY_TOKEN_ENCRYPTION_KEY_B64!,
    providerCredentialAssociatedData(
      scope.organizationId,
      scope.userId,
      scope.connectionId,
      scope.provider,
      secret.name,
    ),
  );
}

async function saveSecret(
  env: Env,
  scope: {
    organizationId: string;
    userId: string;
    provider: string;
    connectionId: string;
  },
  input: {
    name: (typeof OAUTH_SECRET_NAMES)[number];
    value: string;
    expiresAt: Date | null;
  },
): Promise<void> {
  const db = createDb(env.DB);
  const existing = await db
    .select({ id: secretEnvelope.id, version: secretEnvelope.version })
    .from(secretEnvelope)
    .where(
      and(
        eq(secretEnvelope.connectionId, scope.connectionId),
        eq(secretEnvelope.name, input.name),
      ),
    )
    .limit(1);
  const encrypted = await encryptToken(
    input.value,
    env.FLARY_TOKEN_ENCRYPTION_KEY_B64!,
    providerCredentialAssociatedData(
      scope.organizationId,
      scope.userId,
      scope.connectionId,
      scope.provider,
      input.name,
    ),
  );
  const now = new Date();
  await db
    .insert(secretEnvelope)
    .values({
      id: existing[0]?.id ?? crypto.randomUUID(),
      connectionId: scope.connectionId,
      organizationId: scope.organizationId,
      name: input.name,
      scope: "user",
      version: (existing[0]?.version ?? 0) + 1,
      keyId: "flary-token-encryption-key",
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      description: "Provider OAuth credential",
      expiresAt: input.expiresAt,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [secretEnvelope.connectionId, secretEnvelope.name],
      set: {
        version: (existing[0]?.version ?? 0) + 1,
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        expiresAt: input.expiresAt,
        updatedAt: now,
      },
    });
}

async function acquireCredentialLock(
  env: Env,
  connectionId: string,
  ownerId: string,
): Promise<void> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (Date.now() < deadline) {
    const now = Date.now();
    await env.DB.prepare(
      "DELETE FROM provider_credential_lock WHERE connection_id = ? AND expires_at <= ?",
    )
      .bind(connectionId, now)
      .run();
    const result = await env.DB.prepare(
      "INSERT OR IGNORE INTO provider_credential_lock (connection_id, owner_id, expires_at) VALUES (?, ?, ?)",
    )
      .bind(connectionId, ownerId, now + LOCK_TTL_MS)
      .run();
    if ((result.meta.changes ?? 0) > 0) return;
    await delay(LOCK_POLL_MS);
  }
  throw new ProviderSubscriptionError(
    "credential_lock_timeout",
    "Timed out while waiting for the provider credential refresh lock",
  );
}

async function releaseCredentialLock(
  env: Env,
  connectionId: string,
  ownerId: string,
): Promise<void> {
  await env.DB.prepare(
    "DELETE FROM provider_credential_lock WHERE connection_id = ? AND owner_id = ?",
  )
    .bind(connectionId, ownerId)
    .run();
}

function startCredentialLockRenewal(
  env: Env,
  connectionId: string,
  ownerId: string,
): {
  assertHeld(): Promise<void>;
  stop(): Promise<void>;
} {
  let stopped = false;
  let lost: Error | undefined;
  let activeRenewal: Promise<void> = Promise.resolve();
  const timer = setInterval(() => {
    if (stopped || lost) return;
    activeRenewal = renewCredentialLock(env, connectionId, ownerId).catch(
      (error: unknown) => {
        lost =
          error instanceof Error
            ? error
            : new Error("Provider credential refresh lock was lost");
      },
    );
  }, Math.max(1_000, Math.floor(LOCK_TTL_MS / 3)));

  return {
    async assertHeld() {
      await activeRenewal;
      if (lost) throw lost;
      const result = await env.DB.prepare(
        "SELECT owner_id AS ownerId, expires_at AS expiresAt FROM provider_credential_lock WHERE connection_id = ?",
      )
        .bind(connectionId)
        .first<{ ownerId: string; expiresAt: number }>();
      if (
        result?.ownerId !== ownerId ||
        !result.expiresAt ||
        result.expiresAt <= Date.now()
      ) {
        throw new ProviderSubscriptionError(
          "credential_lock_lost",
          "The provider credential refresh lock was lost",
        );
      }
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      await activeRenewal;
    },
  };
}

async function renewCredentialLock(
  env: Env,
  connectionId: string,
  ownerId: string,
): Promise<void> {
  const result = await env.DB.prepare(
    "UPDATE provider_credential_lock SET expires_at = ? WHERE connection_id = ? AND owner_id = ?",
  )
    .bind(Date.now() + LOCK_TTL_MS, connectionId, ownerId)
    .run();
  if ((result.meta.changes ?? 0) !== 1) {
    throw new ProviderSubscriptionError(
      "credential_lock_lost",
      "The provider credential refresh lock was lost",
    );
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

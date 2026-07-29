import { and, desc, eq } from "drizzle-orm";
import {
  completeProviderOAuth,
  pollProviderOAuth,
  providerOAuthSubject,
  startProviderOAuth,
  type ProviderOAuthPrivateState,
} from "flary";
import {
  ProviderOAuthSessionSchema,
  SubscriptionProviderSchema,
  type ProviderOAuthSession,
  type SubscriptionProvider,
} from "flary/contracts";

import { createDb } from "./db";
import {
  flaryConnection,
  providerOAuthSession,
} from "./db/schema";
import type { Env } from "./env";
import {
  saveSubscriptionCredential,
} from "./provider-subscriptions";
import {
  decryptToken,
  encryptToken,
  providerOAuthStateAssociatedData,
} from "./security/tokens";

const PROVIDER_NAMES: Record<SubscriptionProvider, string> = {
  anthropic: "Claude Pro / Max",
  "openai-codex": "ChatGPT / Codex",
};

const PROVIDER_SCOPES: Record<SubscriptionProvider, readonly string[]> = {
  anthropic: [
    "org:create_api_key",
    "user:profile",
    "user:inference",
    "user:sessions:claude_code",
    "user:mcp_servers",
    "user:file_upload",
  ],
  "openai-codex": ["openid", "profile", "email", "offline_access"],
};

export class CloudProviderOAuthError extends Error {
  constructor(
    readonly code:
      | "oauth_not_configured"
      | "oauth_session_not_found"
      | "oauth_session_expired"
      | "oauth_session_not_pending"
      | "oauth_connection_forbidden"
      | "oauth_provider_failed",
    message: string,
  ) {
    super(message);
    this.name = "CloudProviderOAuthError";
  }
}

export async function startCloudProviderOAuth(
  env: Env,
  input: {
    appId: string;
    organizationId: string;
    userId: string;
    provider: string;
    connectionId?: string;
    method?: "device_code" | "authorization_code" | "browser_callback";
  },
): Promise<ProviderOAuthSession> {
  requireEncryption(env);
  const provider = SubscriptionProviderSchema.parse(input.provider);
  const connectionId = await findOrCreateUserConnection(env, {
    ...input,
    provider,
  });
  const flow = await startProviderOAuth({
    provider,
    ...(input.method ? { method: input.method } : {}),
  });
  const id = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + flow.expiresInSeconds * 1_000);
  const privateState = await encryptPrivateState(env, {
    id,
    appId: input.appId,
    organizationId: input.organizationId,
    userId: input.userId,
    state: flow.privateState,
  });
  await createDb(env.DB).insert(providerOAuthSession).values({
    id,
    appId: input.appId,
    organizationId: input.organizationId,
    userId: input.userId,
    connectionId,
    provider,
    method: flow.method,
    status: "pending",
    authorizationUrl: flow.authorizationUrl ?? null,
    verificationUri: flow.verificationUri ?? null,
    userCode: flow.userCode ?? null,
    intervalSeconds: flow.intervalSeconds ?? null,
    privateStateCiphertext: privateState.ciphertext,
    privateStateIv: privateState.iv,
    expiresAt,
    createdAt: now,
    updatedAt: now,
  });
  await createDb(env.DB)
    .update(flaryConnection)
    .set({
      status: "needs_auth",
      credentialRevokedAt: null,
      updatedAt: now,
    })
    .where(eq(flaryConnection.id, connectionId));
  return getCloudProviderOAuth(env, {
    ...input,
    sessionId: id,
    poll: false,
  });
}

export async function getCloudProviderOAuth(
  env: Env,
  input: {
    appId: string;
    organizationId: string;
    userId: string;
    sessionId: string;
    poll?: boolean;
  },
): Promise<ProviderOAuthSession> {
  let row = await loadOwnedSession(env, input);
  if (row.status === "pending" && row.expiresAt.getTime() <= Date.now()) {
    const now = new Date();
    await createDb(env.DB)
      .update(providerOAuthSession)
      .set({
        status: "expired",
        privateStateCiphertext: "",
        privateStateIv: "",
        updatedAt: now,
      })
      .where(eq(providerOAuthSession.id, row.id));
    row = { ...row, status: "expired", updatedAt: now };
  }
  if (
    input.poll &&
    row.status === "pending" &&
    row.provider === "openai-codex"
  ) {
    row = await pollOpenAIProviderOAuth(env, row);
  }
  return publicSession(row);
}

export async function completeCloudProviderOAuth(
  env: Env,
  input: {
    appId: string;
    organizationId: string;
    userId: string;
    sessionId: string;
    authorizationResult: string;
  },
): Promise<ProviderOAuthSession> {
  const row = await loadOwnedSession(env, input);
  assertPending(row);
  if (
    row.provider !== "anthropic" &&
    row.method !== "browser_callback"
  ) {
    throw new CloudProviderOAuthError(
      "oauth_session_not_pending",
      "This provider login completes through status polling",
    );
  }
  try {
    const privateState = await decryptPrivateState(env, row);
    const credential = await completeProviderOAuth({
      privateState,
      authorizationResult: input.authorizationResult,
    });
    await finishLogin(env, row, credential);
  } catch (error) {
    await markLoginError(env, row.id);
    throw safeProviderError(error);
  }
  return getCloudProviderOAuth(env, { ...input, poll: false });
}

export async function cancelCloudProviderOAuth(
  env: Env,
  input: {
    appId: string;
    organizationId: string;
    userId: string;
    sessionId: string;
  },
): Promise<ProviderOAuthSession> {
  const row = await loadOwnedSession(env, input);
  if (row.status === "pending") {
    await createDb(env.DB)
      .update(providerOAuthSession)
      .set({
        status: "cancelled",
        privateStateCiphertext: "",
        privateStateIv: "",
        updatedAt: new Date(),
      })
      .where(eq(providerOAuthSession.id, row.id));
  }
  return getCloudProviderOAuth(env, { ...input, poll: false });
}

type OAuthRow = typeof providerOAuthSession.$inferSelect;

async function pollOpenAIProviderOAuth(
  env: Env,
  row: OAuthRow,
): Promise<OAuthRow> {
  const intervalMs = Math.max(1, row.intervalSeconds ?? 5) * 1_000;
  if (
    row.lastPolledAt &&
    row.lastPolledAt.getTime() + intervalMs > Date.now()
  ) {
    return row;
  }
  try {
    const privateState = await decryptPrivateState(env, row);
    const result = await pollProviderOAuth({ privateState });
    if (result.status === "ready") {
      await finishLogin(env, row, result.credential);
    } else {
      const now = new Date();
      const encrypted = await encryptPrivateState(env, {
        id: row.id,
        appId: row.appId,
        organizationId: row.organizationId,
        userId: row.userId,
        state: result.privateState,
      });
      await createDb(env.DB)
        .update(providerOAuthSession)
        .set({
          intervalSeconds: result.intervalSeconds,
          privateStateCiphertext: encrypted.ciphertext,
          privateStateIv: encrypted.iv,
          lastPolledAt: now,
          updatedAt: now,
        })
        .where(eq(providerOAuthSession.id, row.id));
    }
  } catch (error) {
    await markLoginError(env, row.id);
    throw safeProviderError(error);
  }
  return loadOwnedSession(env, {
    appId: row.appId,
    organizationId: row.organizationId,
    userId: row.userId,
    sessionId: row.id,
  });
}

async function finishLogin(
  env: Env,
  row: OAuthRow,
  credential: {
    access: string;
    refresh: string;
    expires: number;
    [key: string]: unknown;
  },
): Promise<void> {
  const subject = providerOAuthSubject(credential);
  await saveSubscriptionCredential(env, {
    organizationId: row.organizationId,
    userId: row.userId,
    connectionId: row.connectionId,
    provider: row.provider,
    credential,
    ...(subject ? { subject } : {}),
    scopes: PROVIDER_SCOPES[SubscriptionProviderSchema.parse(row.provider)],
  });
  const now = new Date();
  await createDb(env.DB)
    .update(providerOAuthSession)
    .set({
      status: "ready",
      accountSubject: subject ?? null,
      errorCode: null,
      completedAt: now,
      updatedAt: now,
      privateStateCiphertext: "",
      privateStateIv: "",
    })
    .where(eq(providerOAuthSession.id, row.id));
}

async function markLoginError(env: Env, sessionId: string): Promise<void> {
  await createDb(env.DB)
    .update(providerOAuthSession)
    .set({
      status: "error",
      errorCode: "oauth_provider_failed",
      privateStateCiphertext: "",
      privateStateIv: "",
      updatedAt: new Date(),
    })
    .where(eq(providerOAuthSession.id, sessionId));
}

async function findOrCreateUserConnection(
  env: Env,
  input: {
    appId: string;
    organizationId: string;
    userId: string;
    provider: SubscriptionProvider;
    connectionId?: string;
  },
): Promise<string> {
  const db = createDb(env.DB);
  if (input.connectionId) {
    const rows = await db
      .select({ id: flaryConnection.id })
      .from(flaryConnection)
      .where(
        and(
          eq(flaryConnection.id, input.connectionId),
          eq(flaryConnection.appId, input.appId),
          eq(flaryConnection.organizationId, input.organizationId),
          eq(flaryConnection.ownerUserId, input.userId),
          eq(flaryConnection.provider, input.provider),
          eq(flaryConnection.billingMode, "subscription"),
        ),
      )
      .limit(1);
    if (!rows[0]) {
      throw new CloudProviderOAuthError(
        "oauth_connection_forbidden",
        "The subscription connection is not available",
      );
    }
    return rows[0].id;
  }

  const existing = await db
    .select({ id: flaryConnection.id })
    .from(flaryConnection)
    .where(
      and(
        eq(flaryConnection.appId, input.appId),
        eq(flaryConnection.organizationId, input.organizationId),
        eq(flaryConnection.ownerUserId, input.userId),
        eq(flaryConnection.provider, input.provider),
        eq(flaryConnection.billingMode, "subscription"),
      ),
    )
    .orderBy(desc(flaryConnection.updatedAt))
    .limit(1);
  if (existing[0]) return existing[0].id;

  const id = crypto.randomUUID();
  const slugOwner = await shortHash(input.userId);
  const now = new Date();
  await db.insert(flaryConnection).values({
    id,
    appId: input.appId,
    organizationId: input.organizationId,
    name: PROVIDER_NAMES[input.provider],
    slug: `subscription-${input.provider}-${slugOwner}`,
    provider: input.provider,
    type: "api",
    protocol: "http",
    authType: "oauth2",
    billingMode: "subscription",
    status: "needs_auth",
    ownerUserId: input.userId,
    createdBy: input.userId,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

async function loadOwnedSession(
  env: Env,
  input: {
    appId: string;
    organizationId: string;
    userId: string;
    sessionId: string;
  },
): Promise<OAuthRow> {
  const rows = await createDb(env.DB)
    .select()
    .from(providerOAuthSession)
    .where(
      and(
        eq(providerOAuthSession.id, input.sessionId),
        eq(providerOAuthSession.appId, input.appId),
        eq(providerOAuthSession.organizationId, input.organizationId),
        eq(providerOAuthSession.userId, input.userId),
      ),
    )
    .limit(1);
  if (!rows[0]) {
    throw new CloudProviderOAuthError(
      "oauth_session_not_found",
      "The provider login was not found",
    );
  }
  return rows[0];
}

function assertPending(row: OAuthRow): void {
  if (row.expiresAt.getTime() <= Date.now()) {
    throw new CloudProviderOAuthError(
      "oauth_session_expired",
      "The provider login expired",
    );
  }
  if (row.status !== "pending") {
    throw new CloudProviderOAuthError(
      "oauth_session_not_pending",
      "The provider login is not pending",
    );
  }
}

function publicSession(row: OAuthRow): ProviderOAuthSession {
  return ProviderOAuthSessionSchema.parse({
    id: row.id,
    appId: row.appId,
    organizationId: row.organizationId,
    userId: row.userId,
    connectionId: row.connectionId,
    provider: row.provider,
    method: row.method,
    status: row.status,
    ...(row.authorizationUrl
      ? { authorizationUrl: row.authorizationUrl }
      : {}),
    ...(row.verificationUri ? { verificationUri: row.verificationUri } : {}),
    ...(row.userCode ? { userCode: row.userCode } : {}),
    ...(row.intervalSeconds
      ? { intervalSeconds: row.intervalSeconds }
      : {}),
    ...(row.accountSubject
      ? { accountSubject: row.accountSubject }
      : {}),
    ...(row.errorCode ? { errorCode: row.errorCode } : {}),
    expiresAt: row.expiresAt.toISOString(),
    createdAt: (row.createdAt ?? new Date()).toISOString(),
    updatedAt: (row.updatedAt ?? new Date()).toISOString(),
  });
}

async function encryptPrivateState(
  env: Env,
  input: {
    id: string;
    appId: string;
    organizationId: string;
    userId: string;
    state: ProviderOAuthPrivateState;
  },
) {
  return encryptToken(
    JSON.stringify(input.state),
    requireEncryption(env),
    providerOAuthStateAssociatedData(
      input.organizationId,
      input.userId,
      input.appId,
      input.id,
    ),
  );
}

async function decryptPrivateState(
  env: Env,
  row: OAuthRow,
): Promise<ProviderOAuthPrivateState> {
  if (!row.privateStateCiphertext || !row.privateStateIv) {
    throw new CloudProviderOAuthError(
      "oauth_session_not_pending",
      "The provider login no longer has pending state",
    );
  }
  const value = await decryptToken(
    {
      ciphertext: row.privateStateCiphertext,
      iv: row.privateStateIv,
    },
    requireEncryption(env),
    providerOAuthStateAssociatedData(
      row.organizationId,
      row.userId,
      row.appId,
      row.id,
    ),
  );
  return JSON.parse(value) as ProviderOAuthPrivateState;
}

function requireEncryption(env: Env): string {
  if (!env.FLARY_TOKEN_ENCRYPTION_KEY_B64) {
    throw new CloudProviderOAuthError(
      "oauth_not_configured",
      "Provider OAuth encryption is not configured",
    );
  }
  return env.FLARY_TOKEN_ENCRYPTION_KEY_B64;
}

function safeProviderError(error: unknown): CloudProviderOAuthError {
  if (error instanceof CloudProviderOAuthError) return error;
  return new CloudProviderOAuthError(
    "oauth_provider_failed",
    "The provider did not complete authentication",
  );
}

async function shortHash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .slice(0, 8)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

import { and, eq } from "drizzle-orm";

import type { Database } from "./db";
import { cloudflareConnection } from "./db/schema";
import type { Env } from "./env";
import { decryptToken, encryptToken, type EncryptedToken } from "./security/tokens";

const CLOUDFLARE_AUTHORIZE_URL = "https://dash.cloudflare.com/oauth2/auth";
const CLOUDFLARE_TOKEN_URL = "https://dash.cloudflare.com/oauth2/token";
const CLOUDFLARE_REVOKE_URL = "https://dash.cloudflare.com/oauth2/revoke";
const CLOUDFLARE_API_URL = "https://api.cloudflare.com/client/v4";
const CLOUDFLARE_ACCOUNT_ID_PATTERN = /^[a-f0-9]{32}$/i;
const DEFAULT_SCOPES = [
  "account-settings.read",
  "memberships.read",
  "aig.read",
  "aig.run",
  "aig.write",
  "ai.read",
];

export interface CloudflareAccountSummary {
  id: string;
  name: string;
}

export interface CloudflareOAuthTokens {
  accessToken: string;
  refreshToken: string | null;
  accessTokenExpiresAt: Date | null;
  scope: string | null;
}

export class CloudflareOAuthError extends Error {
  constructor(
    public readonly reason:
      | "configuration"
      | "denied"
      | "token"
      | "accounts"
      | "gateway"
      | "request",
    message: string,
  ) {
    super(message);
    this.name = "CloudflareOAuthError";
  }
}

export function isCloudflareOAuthConfigured(env: Env): boolean {
  return Boolean(
    env.CLOUDFLARE_OAUTH_CLIENT_ID?.trim() &&
      env.CLOUDFLARE_OAUTH_CLIENT_SECRET?.trim(),
  );
}

export function cloudflareOAuthScopes(env: Env): string[] {
  const configured = env.CLOUDFLARE_OAUTH_SCOPES?.split(/[\s,]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
  return configured?.length ? configured : [...DEFAULT_SCOPES];
}

export function cloudflareOAuthRedirectUri(
  env: Env,
  requestUrl: string,
): string {
  const origin = env.APP_URL?.trim() || new URL(requestUrl).origin;
  return new URL("/api/cloudflare/oauth/callback", origin).toString();
}

export function buildCloudflareAuthorizationUrl(
  env: Env,
  requestUrl: string,
  state: string,
): string {
  if (!isCloudflareOAuthConfigured(env)) {
    throw new CloudflareOAuthError(
      "configuration",
      "Cloudflare OAuth is not configured",
    );
  }

  const url = new URL(CLOUDFLARE_AUTHORIZE_URL);
  url.searchParams.set("client_id", env.CLOUDFLARE_OAUTH_CLIENT_ID!.trim());
  url.searchParams.set(
    "redirect_uri",
    cloudflareOAuthRedirectUri(env, requestUrl),
  );
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", cloudflareOAuthScopes(env).join(" "));
  url.searchParams.set("state", state);
  return url.toString();
}

export function encryptCloudflareToken(
  env: Env,
  token: string,
  organizationId: string,
  userId: string,
  kind: "access" | "refresh",
): Promise<EncryptedToken> {
  if (!env.FLARY_TOKEN_ENCRYPTION_KEY_B64) {
    throw new CloudflareOAuthError(
      "configuration",
      "Cloudflare token encryption is not configured",
    );
  }
  return encryptToken(
    token,
    env.FLARY_TOKEN_ENCRYPTION_KEY_B64,
    cloudflareTokenAssociatedData(organizationId, userId, kind),
  );
}

export function decryptCloudflareToken(
  env: Env,
  token: EncryptedToken,
  organizationId: string,
  userId: string,
  kind: "access" | "refresh",
): Promise<string> {
  if (!env.FLARY_TOKEN_ENCRYPTION_KEY_B64) {
    throw new CloudflareOAuthError(
      "configuration",
      "Cloudflare token encryption is not configured",
    );
  }
  return decryptToken(
    token,
    env.FLARY_TOKEN_ENCRYPTION_KEY_B64,
    cloudflareTokenAssociatedData(organizationId, userId, kind),
  );
}

export async function exchangeCloudflareCode(
  env: Env,
  code: string,
  requestUrl: string,
): Promise<CloudflareOAuthTokens> {
  return requestCloudflareToken(env, {
    grant_type: "authorization_code",
    code,
    redirect_uri: cloudflareOAuthRedirectUri(env, requestUrl),
  });
}

export async function refreshCloudflareToken(
  env: Env,
  refreshToken: string,
): Promise<CloudflareOAuthTokens> {
  return requestCloudflareToken(env, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
}

export async function fetchCloudflareAccounts(
  accessToken: string,
): Promise<CloudflareAccountSummary[]> {
  const result = await cloudflareApiRequest<CloudflareAccountSummary[]>(
    "/accounts?per_page=100",
    accessToken,
    { method: "GET" },
    "accounts",
  );
  return result
    .filter(
      (account) =>
        typeof account?.id === "string" &&
        CLOUDFLARE_ACCOUNT_ID_PATTERN.test(account.id),
    )
    .map((account) => ({
      id: account.id,
      name: String(account.name || "Cloudflare account").slice(0, 120),
    }));
}

export async function ensureCloudflareGateway(
  accessToken: string,
  accountId: string,
  userId: string,
  existingGatewayId?: string | null,
): Promise<string> {
  if (!CLOUDFLARE_ACCOUNT_ID_PATTERN.test(accountId)) {
    throw new CloudflareOAuthError(
      "gateway",
      "Cloudflare returned an invalid account ID",
    );
  }

  const gatewayId = existingGatewayId?.trim() || buildGatewayId(userId);
  const path = `/accounts/${encodeURIComponent(accountId)}/ai-gateway/gateways/${encodeURIComponent(gatewayId)}`;
  const existing = await fetch(`${CLOUDFLARE_API_URL}${path}`, {
    method: "GET",
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json",
    },
  });
  if (existing.ok) return gatewayId;
  if (existing.status !== 404) {
    throw new CloudflareOAuthError(
      "gateway",
      "Cloudflare did not allow Flary to read the AI Gateway",
    );
  }

  await cloudflareApiRequest(
    `/accounts/${encodeURIComponent(accountId)}/ai-gateway/gateways`,
    accessToken,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: gatewayId,
        authentication: true,
        collect_logs: false,
        cache_ttl: 0,
        cache_invalidate_on_update: true,
        rate_limiting_interval: 0,
        rate_limiting_limit: 0,
      }),
    },
    "gateway",
  );
  return gatewayId;
}

export async function revokeCloudflareToken(
  env: Env,
  token: string,
): Promise<void> {
  if (!isCloudflareOAuthConfigured(env)) return;
  const clientId = env.CLOUDFLARE_OAUTH_CLIENT_ID!.trim();
  const clientSecret = env.CLOUDFLARE_OAUTH_CLIENT_SECRET!.trim();
  const response = await fetch(CLOUDFLARE_REVOKE_URL, {
    method: "POST",
    headers: {
      authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      token,
      token_type_hint: "refresh_token",
      client_id: clientId,
    }),
  });
  if (!response.ok) {
    throw new CloudflareOAuthError(
      "request",
      "Cloudflare token revocation failed",
    );
  }
}

export async function getCloudflareAccessToken(
  env: Env,
  database: Database,
  organizationId: string,
  userId: string,
): Promise<string | null> {
  const rows = await database
    .select()
    .from(cloudflareConnection)
    .where(
      and(
        eq(cloudflareConnection.organizationId, organizationId),
        eq(cloudflareConnection.userId, userId),
      ),
    )
    .limit(1);
  const connection = rows[0];
  if (!connection?.accountId || !connection.gatewayId) return null;

  const accessToken = await decryptCloudflareToken(
    env,
    {
      ciphertext: connection.accessTokenCiphertext,
      iv: connection.accessTokenIv,
    },
    organizationId,
    userId,
    "access",
  );
  if (
    !connection.accessTokenExpiresAt ||
    connection.accessTokenExpiresAt.getTime() > Date.now() + 60_000
  ) {
    return accessToken;
  }
  if (!connection.refreshTokenCiphertext || !connection.refreshTokenIv) {
    return accessToken;
  }

  const refreshToken = await decryptCloudflareToken(
    env,
    {
      ciphertext: connection.refreshTokenCiphertext,
      iv: connection.refreshTokenIv,
    },
    organizationId,
    userId,
    "refresh",
  );
  const refreshed = await refreshCloudflareToken(env, refreshToken);
  const encryptedAccessToken = await encryptCloudflareToken(
    env,
    refreshed.accessToken,
    organizationId,
    userId,
    "access",
  );
  const encryptedRefreshToken = refreshed.refreshToken
    ? await encryptCloudflareToken(
        env,
        refreshed.refreshToken,
        organizationId,
        userId,
        "refresh",
      )
    : null;
  await database
    .update(cloudflareConnection)
    .set({
      accessTokenCiphertext: encryptedAccessToken.ciphertext,
      accessTokenIv: encryptedAccessToken.iv,
      refreshTokenCiphertext:
        encryptedRefreshToken?.ciphertext ?? connection.refreshTokenCiphertext,
      refreshTokenIv:
        encryptedRefreshToken?.iv ?? connection.refreshTokenIv,
      accessTokenExpiresAt: refreshed.accessTokenExpiresAt,
      scope: refreshed.scope ?? connection.scope,
      updatedAt: new Date(),
    })
    .where(eq(cloudflareConnection.id, connection.id));
  return refreshed.accessToken;
}

export function cloudflareTokenAssociatedData(
  organizationId: string,
  userId: string,
  kind: "access" | "refresh",
): string {
  return `cloudflare:${organizationId}:${userId}:${kind}`;
}

async function requestCloudflareToken(
  env: Env,
  values: Record<string, string>,
): Promise<CloudflareOAuthTokens> {
  if (!isCloudflareOAuthConfigured(env)) {
    throw new CloudflareOAuthError(
      "configuration",
      "Cloudflare OAuth is not configured",
    );
  }
  const clientId = env.CLOUDFLARE_OAUTH_CLIENT_ID!.trim();
  const clientSecret = env.CLOUDFLARE_OAUTH_CLIENT_SECRET!.trim();
  const response = await fetch(CLOUDFLARE_TOKEN_URL, {
    method: "POST",
    headers: {
      authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: new URLSearchParams({ ...values, client_id: clientId }),
  });
  const payload = (await response.json().catch(() => null)) as
    | CloudflareTokenResponse
    | null;
  if (!response.ok || !payload?.access_token) {
    throw new CloudflareOAuthError(
      "token",
      "Cloudflare did not return an access token",
    );
  }
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token ?? null,
    accessTokenExpiresAt:
      typeof payload.expires_in === "number"
        ? new Date(Date.now() + payload.expires_in * 1000)
        : null,
    scope: payload.scope ?? null,
  };
}

async function cloudflareApiRequest<T>(
  path: string,
  accessToken: string,
  init: RequestInit,
  reason: "accounts" | "gateway",
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${accessToken}`);
  headers.set("accept", "application/json");
  const response = await fetch(`${CLOUDFLARE_API_URL}${path}`, {
    ...init,
    headers,
  });
  const payload = (await response.json().catch(() => null)) as
    | CloudflareApiResponse<T>
    | null;
  if (!response.ok || !payload?.success) {
    throw new CloudflareOAuthError(
      reason,
      reason === "accounts"
        ? "Cloudflare did not return an account you can use"
        : "Cloudflare did not allow Flary to create the AI Gateway",
    );
  }
  return payload.result as T;
}

function buildGatewayId(userId: string): string {
  const suffix =
    userId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 24) ||
    crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  return `flary-${suffix}`;
}

interface CloudflareTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

interface CloudflareApiResponse<T> {
  success?: boolean;
  result?: T;
}

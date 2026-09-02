import { and, eq } from "drizzle-orm";
import { OpenAICompatibleAdapter } from "flary/providers";

import { createDb } from "./db";
import { cloudflareConnection } from "./db/schema";
import { getCloudflareAccessToken } from "./cloudflare-oauth";
import type { Env } from "./env";

/**
 * Resolve the connected user's Cloudflare Gateway provider on the server.
 * Returns null when the user has not selected a Cloudflare account.
 */
export async function getCloudflareAIGatewayProvider(
  env: Env,
  organizationId: string,
  userId: string,
  metadata?: Record<string, string | number | boolean | null>,
): Promise<OpenAICompatibleAdapter | null> {
  const database = createDb(env.DB);
  const rows = await database
    .select({
      accountId: cloudflareConnection.accountId,
      gatewayId: cloudflareConnection.gatewayId,
    })
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

  const apiToken = await getCloudflareAccessToken(env, database, organizationId, userId);
  if (!apiToken) return null;

  const headers = new Headers();
  headers.set("cf-aig-gateway-id", connection.gatewayId);
  if (metadata) headers.set("cf-aig-metadata", JSON.stringify(metadata));

  return new OpenAICompatibleAdapter({
    id: `cloudflare-${organizationId}-${userId}`,
    baseUrl: `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(connection.accountId)}/ai/v1`,
    apiKey: apiToken,
    headers,
  });
}

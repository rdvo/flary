import { and, eq, inArray } from "drizzle-orm";
import { registerProvider } from "@flue/runtime";
import {
  type ProviderCredential,
  type ProviderCredentialResolver,
} from "flary/providers";
import {
  AdmittedProviderCredentialSchema,
  type AdmittedProviderCredential,
  ProviderKindSchema,
  type ModelSelection,
  type ProviderKind,
} from "flary/contracts";
import { createDb } from "./db";
import { flaryConnection, secretEnvelope } from "./db/schema";
import type { Env } from "./env";
import {
  connectionSecretAssociatedData,
  decryptToken,
} from "./security/tokens";
import { resolveSubscriptionAccessToken } from "./provider-subscriptions";

type ThreadBinding = {
  thread: { threadId: string; agentId: string };
  workspace: { organizationId: string; appId: string };
  connectionIds: string[];
};

type ProviderConnection = {
  connectionId: string;
  organizationId: string;
  provider: string;
  baseUrl: string | null;
  authType: string;
  billingMode: "subscription" | "byok";
  authHeader: string | null;
  secretName: string;
  ciphertext: string;
  iv: string;
  version: number;
  expiresAt: Date | null;
  ownerUserId: string | null;
};

export type PreparedFlueModel = {
  model: string;
  credential: AdmittedProviderCredential;
};

export class CredentialRecoveryUnavailableError extends Error {
  readonly code = "credential_recovery_unavailable" as const;

  constructor(
    readonly credentialConnectionRef: string,
    readonly provider: string,
  ) {
    super(
      `The admitted ${provider} credential is not available for durable recovery`,
    );
    this.name = "CredentialRecoveryUnavailableError";
  }
}

/**
 * Resolve a provider without returning secret material to the model or to a
 * Flue tool. The opaque reference is consumed by the trusted provider patch.
 */
export class CloudProviderCredentialResolver implements ProviderCredentialResolver {
  constructor(private readonly env: Env) {}

  async resolveSubscription(input: {
    tenantId: string;
    connectionIds: readonly string[];
    provider: ProviderKind;
    applicationId?: string;
    userId?: string;
  }): Promise<ProviderCredential | undefined> {
    if (!input.connectionIds.length || !this.env.DB) return undefined;
    const row = await findTenantConnection(this.env, {
      ...input,
      billingMode: "subscription",
    });
    if (!row) return undefined;
    return {
      source: "subscription",
      billingMode: "subscription",
      provider: ProviderKindSchema.parse(input.provider),
      secretRef: `connection:${row.connectionId}:${row.secretName}`,
      connectionId: row.connectionId,
      version: row.version,
      generation: `connection-${row.version}`,
      expiresAt: row.expiresAt?.toISOString(),
      metadata: { connectionId: row.connectionId, authType: row.authType },
    };
  }

  async resolveTenantByok(input: {
    tenantId: string;
    connectionIds: readonly string[];
    provider: ProviderKind;
    applicationId?: string;
  }): Promise<ProviderCredential | undefined> {
    if (!input.connectionIds.length || !this.env.DB) return undefined;
    const row = await findTenantConnection(this.env, {
      ...input,
      billingMode: "byok",
    });
    if (!row) return undefined;
    return {
      source: "tenant_byok",
      billingMode: "byok",
      provider: ProviderKindSchema.parse(input.provider),
      secretRef: `connection:${row.connectionId}:${row.secretName}`,
      connectionId: row.connectionId,
      version: row.version,
      generation: `connection-${row.version}`,
      metadata: { connectionId: row.connectionId, authType: row.authType },
    };
  }

  async resolveManaged(input: {
    provider: ProviderKind;
  }): Promise<ProviderCredential | undefined> {
    const provider = ProviderKindSchema.parse(input.provider);
    const secret = managedSecret(this.env, provider);
    if (!secret) return undefined;
    return {
      source: "managed",
      billingMode: "managed",
      provider,
      secretRef: secret,
      version: 1,
      generation: "managed-v1",
    };
  }
}

export async function resolveCloudProviderCredential(
  env: Env,
  input: {
    tenantId: string;
    applicationId?: string;
    connectionIds: readonly string[];
    selection: ModelSelection;
    userId?: string;
  },
): Promise<ProviderCredential | undefined> {
  const provider = ProviderKindSchema.safeParse(input.selection.provider);
  if (!provider.success) return undefined;
  const resolver = new CloudProviderCredentialResolver(env);
  const scoped = {
    tenantId: input.tenantId,
    applicationId: input.applicationId,
    connectionIds: input.connectionIds,
    provider: provider.data,
    userId: input.userId,
  };
  return (
    (await resolver.resolveSubscription(scoped)) ??
    (await resolver.resolveTenantByok(scoped)) ??
    resolver.resolveManaged({ provider: provider.data })
  );
}

/**
 * Prepare a per-thread Flue provider registration. Flue's beta registry is
 * process-scoped, so every registration uses a thread-specific provider ID.
 * The secret stays in the trusted runtime registration and never enters the
 * model input, tool arguments, or Flary transcript.
 */
export async function prepareFlueModel(
  env: Env,
  binding: ThreadBinding,
  selection: ModelSelection,
  userId: string,
  admitted?: AdmittedProviderCredential,
): Promise<string | undefined> {
  return (
    await prepareAdmittedFlueModel(
      env,
      binding,
      selection,
      userId,
      admitted,
    )
  )?.model;
}

export async function requireRecoveredFlueModel(
  env: Env,
  binding: ThreadBinding,
  selection: ModelSelection,
  userId: string,
  admitted: AdmittedProviderCredential,
): Promise<string> {
  const model = await prepareFlueModel(
    env,
    binding,
    selection,
    userId,
    admitted,
  );
  if (!model) {
    throw new CredentialRecoveryUnavailableError(
      admitted.connectionRef,
      admitted.provider,
    );
  }
  return model;
}

/**
 * Resolve, pin, and register the credential for one admitted model turn.
 *
 * Recovery supplies `admitted`. That path can refresh a subscription inside
 * the same connection lineage, but it cannot select another connection,
 * billing source, or managed key.
 */
export async function prepareAdmittedFlueModel(
  env: Env,
  binding: ThreadBinding,
  selection: ModelSelection,
  userId: string,
  admitted?: AdmittedProviderCredential,
): Promise<PreparedFlueModel | undefined> {
  const provider = ProviderKindSchema.safeParse(selection.provider);
  if (!provider.success) return undefined;
  if (admitted && admitted.provider !== provider.data) return undefined;
  if (provider.data === "cloudflare") {
    if (!env.AI) return undefined;
    const generation = await stableCredentialHash([
      "managed",
      provider.data,
      "cloudflare-ai-binding",
    ]);
    if (admitted && admitted.generation !== generation) return undefined;
    const credential = await createAdmittedCredential(binding, {
      provider: provider.data,
      source: "managed",
      billingMode: "managed",
      version: 1,
      generation,
    });
    return {
      model: `cloudflare/${selection.model}`,
      credential: AdmittedProviderCredentialSchema.parse(credential),
    };
  }

  const exactConnectionId = admitted?.connectionId;
  const candidateConnectionIds = exactConnectionId
    ? [exactConnectionId]
    : binding.connectionIds;
  const subscription =
    (!admitted || admitted.source === "subscription") &&
    (provider.data === "anthropic" || provider.data === "openai-codex")
      ? await findTenantConnection(env, {
          tenantId: binding.workspace.organizationId,
          applicationId: binding.workspace.appId,
          connectionIds: candidateConnectionIds,
          provider: provider.data,
          billingMode: "subscription",
          userId,
        })
      : undefined;
  const connection =
    subscription ??
    ((!admitted || admitted.source === "tenant_byok")
      ? await findTenantConnection(env, {
          tenantId: binding.workspace.organizationId,
          applicationId: binding.workspace.appId,
          connectionIds: candidateConnectionIds,
          provider: provider.data,
          billingMode: "byok",
        })
      : undefined);
  const secret = connection
    ? connection.billingMode === "subscription"
      ? await resolveSubscriptionAccessToken(env, {
          organizationId: connection.organizationId,
          userId,
          connectionId: connection.connectionId,
          provider:
          provider.data === "anthropic" ? "anthropic" : "openai-codex",
        })
      : await readConnectionSecret(env, connection)
    : !admitted || admitted.source === "managed"
      ? managedSecretValue(env, provider.data)
      : undefined;
  if (!secret) return undefined;

  // OAuth refresh can advance the version. It remains in the exact admitted
  // connection lineage. BYOK and managed recovery fail closed on rotation.
  const currentConnection = connection
    ? await findTenantConnection(env, {
        tenantId: binding.workspace.organizationId,
        applicationId: binding.workspace.appId,
        connectionIds: [connection.connectionId],
        provider: provider.data,
        billingMode:
          connection.billingMode === "subscription" ? "subscription" : "byok",
        ...(connection.billingMode === "subscription" ? { userId } : {}),
      })
    : undefined;
  const version = currentConnection?.version ?? 1;
  const generation = connection
    ? `connection-${version}`
    : await stableCredentialHash(["managed", provider.data, secret]);
  if (admitted) {
    if (
      admitted.source !==
        (connection
          ? connection.billingMode === "subscription"
            ? "subscription"
            : "tenant_byok"
          : "managed") ||
      admitted.billingMode !== (connection?.billingMode ?? "managed") ||
      admitted.connectionId !== connection?.connectionId
    ) {
      return undefined;
    }
    if (
      admitted.source !== "subscription" &&
      (admitted.version !== version || admitted.generation !== generation)
    ) {
      return undefined;
    }
    if (admitted.source === "subscription" && version < admitted.version) {
      return undefined;
    }
  }

  const currentCredential = await createAdmittedCredential(binding, {
    provider: provider.data,
    source: connection
      ? connection.billingMode === "subscription"
        ? "subscription"
        : "tenant_byok"
      : "managed",
    billingMode: connection?.billingMode ?? "managed",
    connectionId: connection?.connectionId,
    version,
    generation,
  });
  const credential = admitted ?? currentCredential;
  const route = providerRoute(provider.data, connection?.baseUrl);
  const providerId = `flary_${credential.connectionRef}`;
  registerProvider(providerId, {
    api: route.api,
    baseUrl: route.baseUrl,
    ...(connection?.authType === "bearer"
      ? {
          headers: {
            [connection.authHeader || "authorization"]: `Bearer ${secret}`,
          },
        }
      : { apiKey: secret }),
  });
  return {
    model: `${providerId}/${selection.model}`,
    credential: AdmittedProviderCredentialSchema.parse(credential),
  };
}

async function createAdmittedCredential(
  binding: ThreadBinding,
  input: Omit<AdmittedProviderCredential, "connectionRef">,
): Promise<AdmittedProviderCredential> {
  const connectionRef = await stableCredentialHash([
    binding.workspace.organizationId,
    binding.workspace.appId,
    binding.thread.agentId,
    binding.thread.threadId,
    input.provider,
    input.connectionId ?? "managed",
    String(input.version),
    input.generation,
  ]);
  return { ...input, connectionRef };
}

export async function stableCredentialHash(
  parts: readonly string[],
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(parts)),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function findTenantConnection(
  env: Env,
  input: {
    tenantId: string;
    applicationId?: string;
    connectionIds: readonly string[];
    provider: ProviderKind;
    billingMode?: "subscription" | "byok";
    userId?: string;
  },
): Promise<ProviderConnection | undefined> {
  if (!input.connectionIds.length || !env.DB) return undefined;
  const rows = await createDb(env.DB)
    .select({
      connectionId: flaryConnection.id,
      organizationId: flaryConnection.organizationId,
      provider: flaryConnection.provider,
      baseUrl: flaryConnection.baseUrl,
      authType: flaryConnection.authType,
      billingMode: flaryConnection.billingMode,
      authHeader: flaryConnection.authHeader,
      status: flaryConnection.status,
      secretName: secretEnvelope.name,
      ciphertext: secretEnvelope.ciphertext,
      iv: secretEnvelope.iv,
      version: secretEnvelope.version,
      expiresAt: secretEnvelope.expiresAt,
      ownerUserId: flaryConnection.ownerUserId,
    })
    .from(flaryConnection)
    .innerJoin(secretEnvelope, eq(secretEnvelope.connectionId, flaryConnection.id))
    .where(
      and(
        eq(flaryConnection.organizationId, input.tenantId),
        ...(input.applicationId
          ? [eq(flaryConnection.appId, input.applicationId)]
          : []),
        inArray(flaryConnection.id, [...input.connectionIds]),
        eq(flaryConnection.type, "api"),
        eq(flaryConnection.provider, input.provider),
        ...(input.billingMode
          ? [eq(flaryConnection.billingMode, input.billingMode)]
          : []),
        ...(input.billingMode === "subscription" && input.userId
          ? [eq(flaryConnection.ownerUserId, input.userId)]
          : []),
        inArray(flaryConnection.status, ["configured", "ready"]),
      ),
    )
    .limit(20);
  const selected = rows.find((candidate) => {
    if (
      input.billingMode === "subscription" &&
      !["access", "access_token"].includes(candidate.secretName)
    ) {
      return false;
    }
    if (
      input.billingMode === "byok" &&
      ["refresh", "refresh_token"].includes(candidate.secretName)
    ) {
      return false;
    }
    return (
      input.billingMode === "subscription" ||
      !candidate.expiresAt ||
      candidate.expiresAt.getTime() > Date.now()
    );
  });
  if (
    !selected ||
    (selected.billingMode !== "subscription" &&
      selected.billingMode !== "byok")
  ) {
    return undefined;
  }
  return {
    ...selected,
    billingMode: selected.billingMode,
  };
}

async function readConnectionSecret(
  env: Env,
  connection: ProviderConnection,
): Promise<string | undefined> {
  if (!env.FLARY_TOKEN_ENCRYPTION_KEY_B64) return undefined;
  return decryptToken(
    { ciphertext: connection.ciphertext, iv: connection.iv },
    env.FLARY_TOKEN_ENCRYPTION_KEY_B64,
    connectionSecretAssociatedData(
      connection.organizationId,
      connection.connectionId,
      connection.secretName,
    ),
  );
}

function managedSecret(env: Env, provider: ProviderKind): string | undefined {
  switch (provider) {
    case "openai":
      return env.OPENAI_API_KEY ? "managed:openai" : undefined;
    case "openai-codex":
      return undefined;
    case "anthropic":
      return env.ANTHROPIC_API_KEY ? "managed:anthropic" : undefined;
    case "moonshot":
      return env.MOONSHOT_API_KEY ? "managed:moonshot" : undefined;
    case "cloudflare":
      return env.AI ? "managed:cloudflare-ai" : undefined;
    case "google":
      return env.GOOGLE_API_KEY ? "managed:google" : undefined;
    default:
      return undefined;
  }
}

function managedSecretValue(env: Env, provider: ProviderKind): string | undefined {
  switch (provider) {
    case "openai": return env.OPENAI_API_KEY;
    case "openai-codex": return undefined;
    case "anthropic": return env.ANTHROPIC_API_KEY;
    case "moonshot": return env.MOONSHOT_API_KEY;
    case "google": return env.GOOGLE_API_KEY;
    default: return undefined;
  }
}

function providerRoute(provider: ProviderKind, configuredBaseUrl?: string | null) {
  switch (provider) {
    case "anthropic":
      return { api: "anthropic-messages", baseUrl: configuredBaseUrl ?? "https://api.anthropic.com/v1" };
    case "moonshot":
      return { api: "openai-completions", baseUrl: configuredBaseUrl ?? "https://api.moonshot.ai/v1" };
    case "google":
      return { api: "google-generative-ai", baseUrl: configuredBaseUrl ?? "https://generativelanguage.googleapis.com/v1beta" };
    case "openai":
      return { api: "openai-responses", baseUrl: configuredBaseUrl ?? "https://api.openai.com/v1" };
    case "openai-codex":
      return { api: "openai-codex-responses", baseUrl: configuredBaseUrl ?? "https://chatgpt.com/backend-api" };
    default:
      return { api: "openai-responses", baseUrl: configuredBaseUrl ?? "https://api.openai.com/v1" };
  }
}

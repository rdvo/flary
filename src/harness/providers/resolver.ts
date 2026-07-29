import {
  ModelSelectionSchema,
  ProviderKindSchema,
  type ModelSelection,
  type ProviderKind,
} from "../contracts/provider.js";
import type {
  ProviderCredentialSource,
  ProviderBillingMode,
  ProviderCredentialLifecycle,
} from "../contracts/connections.js";

export interface ProviderCredential {
  readonly source: ProviderCredentialSource;
  readonly billingMode: ProviderBillingMode;
  readonly provider: ProviderKind;
  readonly secretRef: string;
  readonly connectionId?: string;
  readonly version: number;
  readonly generation: string;
  readonly expiresAt?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface ProviderCredentialResolver {
  resolveSubscription?(input: {
    tenantId: string;
    connectionIds: readonly string[];
    provider: ProviderKind;
    applicationId?: string;
    userId?: string;
  }): Promise<ProviderCredential | undefined>;
  resolveTenantByok(input: {
    tenantId: string;
    connectionIds: readonly string[];
    provider: ProviderKind;
    applicationId?: string;
  }): Promise<ProviderCredential | undefined>;
  resolveManaged(input: {
    provider: ProviderKind;
  }): Promise<ProviderCredential | undefined>;
}

/**
 * Host storage used by provider OAuth adapters.
 *
 * `modify` must serialize changes for one connection across isolates. The
 * callback receives the latest value after the lock is acquired. This permits
 * double-checked refresh and prevents two requests from rotating one refresh
 * token at the same time.
 */
export interface ProviderCredentialLifecycleStore {
  read(connectionId: string): Promise<ProviderCredentialLifecycle | undefined>;
  modify(
    connectionId: string,
    update: (
      current: ProviderCredentialLifecycle | undefined,
    ) => Promise<ProviderCredentialLifecycle | undefined>,
  ): Promise<ProviderCredentialLifecycle | undefined>;
  revoke(connectionId: string): Promise<void>;
}

export interface ProviderCredentialRefreshAdapter {
  refresh(
    current: ProviderCredentialLifecycle,
    signal?: AbortSignal,
  ): Promise<ProviderCredentialLifecycle>;
  revoke?(
    current: ProviderCredentialLifecycle,
    signal?: AbortSignal,
  ): Promise<void>;
}

export class ProviderCredentialUnavailableError extends Error {
  readonly code = "provider_credential_unavailable" as const;

  constructor(
    public readonly connectionId: string,
    message: string,
  ) {
    super(message);
    this.name = "ProviderCredentialUnavailableError";
  }
}

/**
 * Return a usable subscription credential and refresh it once when required.
 *
 * The host store supplies the cross-isolate lock through `modify`. The
 * callback checks expiry again after it gets the lock. This prevents duplicate
 * refresh requests when many turns start at the same time.
 */
export async function ensureFreshProviderCredential(
  store: ProviderCredentialLifecycleStore,
  adapter: ProviderCredentialRefreshAdapter,
  input: {
    connectionId: string;
    now?: Date;
    refreshBeforeMs?: number;
    signal?: AbortSignal;
  },
): Promise<ProviderCredentialLifecycle> {
  const now = input.now ?? new Date();
  const refreshBeforeMs = input.refreshBeforeMs ?? 300_000;
  const current = await store.read(input.connectionId);
  if (!current) {
    throw new ProviderCredentialUnavailableError(
      input.connectionId,
      "Provider credential was not found",
    );
  }
  if (current.status === "revoked") {
    throw new ProviderCredentialUnavailableError(
      input.connectionId,
      "Provider credential was revoked",
    );
  }
  if (!credentialNeedsRefresh(current, now, refreshBeforeMs)) return current;

  const refreshed = await store.modify(input.connectionId, async (latest) => {
    if (!latest || latest.status === "revoked") return undefined;
    if (!credentialNeedsRefresh(latest, now, refreshBeforeMs)) return undefined;
    return adapter.refresh(latest, input.signal);
  });
  if (!refreshed || refreshed.status === "revoked") {
    throw new ProviderCredentialUnavailableError(
      input.connectionId,
      "Provider credential became unavailable during refresh",
    );
  }
  return refreshed;
}

export async function revokeProviderCredential(
  store: ProviderCredentialLifecycleStore,
  adapter: ProviderCredentialRefreshAdapter,
  connectionId: string,
  signal?: AbortSignal,
): Promise<void> {
  const current = await store.read(connectionId);
  if (current && current.status !== "revoked") {
    await adapter.revoke?.(current, signal);
  }
  await store.revoke(connectionId);
}

function credentialNeedsRefresh(
  credential: ProviderCredentialLifecycle,
  now: Date,
  refreshBeforeMs: number,
): boolean {
  if (credential.status === "expired" || credential.status === "error") {
    return true;
  }
  if (!credential.expiresAt) return false;
  return Date.parse(credential.expiresAt) <= now.getTime() + refreshBeforeMs;
}

export class ProviderCredentialsMissingError extends Error {
  readonly code = "provider_credentials_missing" as const;
  readonly provider: ProviderKind;

  constructor(provider: ProviderKind) {
    super(`No authorized credentials are configured for provider '${provider}'.`);
    this.name = "ProviderCredentialsMissingError";
    this.provider = provider;
  }
}

/**
 * Resolve credentials in the safe order: authorized subscription, tenant
 * BYOK, then managed.
 * Secret values are never returned by this function. The resolver returns an
 * opaque secret reference that a trusted adapter can exchange at invocation.
 */
export async function resolveProviderCredential(
  resolver: ProviderCredentialResolver,
  input: {
    tenantId: string;
    connectionIds: readonly string[];
    selection: ModelSelection;
    userId?: string;
    applicationId?: string;
  },
): Promise<ProviderCredential> {
  const selection = ModelSelectionSchema.parse(input.selection);
  const provider = ProviderKindSchema.parse(selection.provider);
  const subscription = await resolver.resolveSubscription?.({
    tenantId: input.tenantId,
    connectionIds: input.connectionIds,
    provider,
    applicationId: input.applicationId,
    userId: input.userId,
  });
  if (subscription) return subscription;
  const byok = await resolver.resolveTenantByok({
    tenantId: input.tenantId,
    connectionIds: input.connectionIds,
    provider,
    applicationId: input.applicationId,
  });
  if (byok) return byok;
  const managed = await resolver.resolveManaged({ provider });
  if (managed) return managed;
  throw new ProviderCredentialsMissingError(provider);
}

/** Convert a Flary model selection to Flue's provider/model specifier. */
export function toFlueModelSpecifier(selection: ModelSelection): string {
  const value = ModelSelectionSchema.parse(selection);
  return `${value.provider}/${value.model}`;
}

/** Parse the provider/model form used by Flue into a Flary selection. */
export function parseFlueModelSpecifier(
  value: string,
): ModelSelection | undefined {
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1) return undefined;
  const parsed = ModelSelectionSchema.safeParse({
    provider: value.slice(0, separator),
    model: value.slice(separator + 1),
  });
  return parsed.success ? parsed.data : undefined;
}

import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const timestamp = (name: string) =>
  integer(name, { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`);

export const user = sqliteTable(
  "user",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
    image: text("image"),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at"),
  },
  (table) => [uniqueIndex("user_email_unique").on(table.email)],
);

export const session = sqliteTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    token: text("token").notNull(),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at"),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    activeOrganizationId: text("active_organization_id"),
  },
  (table) => [
    uniqueIndex("session_token_unique").on(table.token),
    index("session_user_idx").on(table.userId),
  ],
);

export const account = sqliteTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: integer("access_token_expires_at", {
      mode: "timestamp_ms",
    }),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", {
      mode: "timestamp_ms",
    }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at"),
  },
  (table) => [
    index("account_user_idx").on(table.userId),
    uniqueIndex("account_provider_unique").on(table.providerId, table.accountId),
  ],
);

export const verification = sqliteTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at"),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

export const organization = sqliteTable(
  "organization",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    logo: text("logo"),
    metadata: text("metadata"),
    createdAt: timestamp("created_at"),
  },
  (table) => [uniqueIndex("organization_slug_unique").on(table.slug)],
);

export const member = sqliteTable(
  "member",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
    createdAt: timestamp("created_at"),
  },
  (table) => [
    uniqueIndex("member_user_org_unique").on(table.userId, table.organizationId),
    index("member_org_idx").on(table.organizationId),
  ],
);

export const invitation = sqliteTable(
  "invitation",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    inviterId: text("inviter_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role"),
    status: text("status").notNull().default("pending"),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: timestamp("created_at"),
  },
  (table) => [
    index("invitation_org_idx").on(table.organizationId),
    index("invitation_email_idx").on(table.email),
  ],
);

export const flaryApp = sqliteTable(
  "flary_app",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at"),
  },
  (table) => [
    uniqueIndex("flary_app_org_slug_unique").on(table.organizationId, table.slug),
    index("flary_app_org_idx").on(table.organizationId),
  ],
);

// D1 is the searchable thread registry. The exact binding is copied into the
// thread Durable Object on first start; the workspace fields are immutable.
export const flaryThread = sqliteTable(
  "flary_thread",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    appId: text("app_id")
      .notNull()
      .references(() => flaryApp.id, { onDelete: "cascade" }),
    agentId: text("agent_id").notNull(),
    threadId: text("thread_id").notNull(),
    projectId: text("project_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    branch: text("branch").notNull().default("main"),
    persona: text("persona"),
    defaultMode: text("default_mode").notNull().default("ask"),
    defaultModelJson: text("default_model_json"),
    defaultThinkingLevel: text("default_thinking_level").notNull().default("medium"),
    connectionIdsJson: text("connection_ids_json").notNull().default("[]"),
    status: text("status").notNull().default("active"),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    parentThreadJson: text("parent_thread_json"),
    metadataJson: text("metadata_json"),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at"),
    archivedAt: integer("archived_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    uniqueIndex("flary_thread_ref_unique").on(
      table.organizationId,
      table.appId,
      table.agentId,
      table.threadId,
    ),
    index("flary_thread_app_idx").on(table.appId, table.updatedAt),
    index("flary_thread_workspace_idx").on(
      table.organizationId,
      table.projectId,
      table.workspaceId,
      table.branch,
    ),
  ],
);

// One admission record per submitted turn. This is an operational handoff
// for the pinned Flue model-override adapter, not a transcript copy.
export const flaryThreadSubmission = sqliteTable(
  "flary_thread_submission",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    appId: text("app_id")
      .notNull()
      .references(() => flaryApp.id, { onDelete: "cascade" }),
    agentId: text("agent_id").notNull(),
    threadId: text("thread_id").notNull(),
    userId: text("user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    modelJson: text("model_json"),
    thinkingLevel: text("thinking_level"),
    cacheRetention: text("cache_retention").notNull().default("short"),
    credentialConnectionId: text("credential_connection_id"),
    credentialSource: text("credential_source").notNull(),
    billingMode: text("billing_mode").notNull(),
    provider: text("provider").notNull(),
    credentialVersion: integer("credential_version").notNull(),
    credentialGeneration: text("credential_generation").notNull(),
    credentialConnectionRef: text("credential_connection_ref").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    status: text("status").notNull().default("admitted"),
    streamUrl: text("stream_url"),
    flueOffset: text("flue_offset"),
    submissionId: text("submission_id"),
    errorCode: text("error_code"),
    settledAt: integer("settled_at", { mode: "timestamp_ms" }),
    createdAt: timestamp("created_at"),
  },
  (table) => [
    uniqueIndex("flary_thread_submission_idempotency_unique").on(
      table.organizationId,
      table.appId,
      table.agentId,
      table.threadId,
      table.idempotencyKey,
    ),
    index("flary_thread_submission_latest_idx").on(
      table.organizationId,
      table.threadId,
      table.createdAt,
    ),
  ],
);

export const prompt = sqliteTable(
  "prompt",
  {
    id: text("id").primaryKey(),
    appId: text("app_id")
      .notNull()
      .references(() => flaryApp.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    sourceHash: text("source_hash").notNull(),
    sourceKey: text("source_key").notNull(),
    sourceCommit: text("source_commit"),
    model: text("model"),
    thinking: text("thinking"),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at"),
  },
  (table) => [
    uniqueIndex("prompt_app_slug_unique").on(table.appId, table.slug),
    index("prompt_app_idx").on(table.appId),
  ],
);

/** Immutable source snapshot for one logical prompt. */
export const promptRevision = sqliteTable(
  "prompt_revision",
  {
    id: text("id").primaryKey(),
    promptId: text("prompt_id")
      .notNull()
      .references(() => prompt.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    sourceHash: text("source_hash").notNull(),
    sourceKey: text("source_key").notNull(),
    sourceCommit: text("source_commit"),
    model: text("model"),
    thinking: text("thinking"),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at"),
  },
  (table) => [
    uniqueIndex("prompt_revision_prompt_number_unique").on(table.promptId, table.revision),
    uniqueIndex("prompt_revision_prompt_hash_unique").on(table.promptId, table.sourceHash),
    index("prompt_revision_prompt_idx").on(table.promptId, table.createdAt),
  ],
);

/** A deterministic rollout variant points at one immutable prompt revision. */
export const promptVariant = sqliteTable(
  "prompt_variant",
  {
    id: text("id").primaryKey(),
    promptId: text("prompt_id")
      .notNull()
      .references(() => prompt.id, { onDelete: "cascade" }),
    rolloutId: text("rollout_id").notNull(),
    scope: text("scope").notNull().default("user"),
    variantId: text("variant_id").notNull(),
    revisionId: text("revision_id")
      .notNull()
      .references(() => promptRevision.id, { onDelete: "restrict" }),
    allocationBasisPoints: integer("allocation_basis_points").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at"),
  },
  (table) => [
    uniqueIndex("prompt_variant_rollout_variant_unique").on(
      table.promptId,
      table.rolloutId,
      table.variantId,
    ),
    index("prompt_variant_rollout_idx").on(table.promptId, table.rolloutId),
  ],
);

export const cloudflareOAuthState = sqliteTable(
  "cloudflare_oauth_state",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    stateHash: text("state_hash").notNull(),
    redirectUri: text("redirect_uri").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: timestamp("created_at"),
  },
  (table) => [index("cloudflare_oauth_state_expiry_idx").on(table.expiresAt)],
);

export const cloudflareConnection = sqliteTable(
  "cloudflare_connection",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    accountId: text("account_id"),
    accountName: text("account_name"),
    gatewayId: text("gateway_id"),
    accountOptionsJson: text("account_options_json").notNull().default("[]"),
    accessTokenCiphertext: text("access_token_ciphertext").notNull(),
    accessTokenIv: text("access_token_iv").notNull(),
    refreshTokenCiphertext: text("refresh_token_ciphertext"),
    refreshTokenIv: text("refresh_token_iv"),
    accessTokenExpiresAt: integer("access_token_expires_at", {
      mode: "timestamp_ms",
    }),
    scope: text("scope"),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at"),
  },
  (table) => [
    uniqueIndex("cloudflare_connection_org_user_unique").on(table.organizationId, table.userId),
    index("cloudflare_connection_org_idx").on(table.organizationId),
  ],
);

// Application-owned API and MCP connection metadata. Secret values live in
// secretEnvelope, never in this table.
export const flaryConnection = sqliteTable(
  "flary_connection",
  {
    id: text("id").primaryKey(),
    appId: text("app_id")
      .notNull()
      .references(() => flaryApp.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    provider: text("provider").notNull(),
    type: text("type").notNull(),
    protocol: text("protocol").notNull().default("http"),
    baseUrl: text("base_url"),
    docsUrl: text("docs_url"),
    authType: text("auth_type").notNull().default("none"),
    billingMode: text("billing_mode").notNull().default("byok"),
    authHeader: text("auth_header"),
    description: text("description"),
    iconUrl: text("icon_url"),
    status: text("status").notNull().default("needs_auth"),
    ownerUserId: text("owner_user_id").references(() => user.id, {
      onDelete: "cascade",
    }),
    credentialSubject: text("credential_subject"),
    credentialScopesJson: text("credential_scopes_json").notNull().default("[]"),
    credentialExpiresAt: integer("credential_expires_at", {
      mode: "timestamp_ms",
    }),
    credentialRefreshedAt: integer("credential_refreshed_at", {
      mode: "timestamp_ms",
    }),
    credentialRevokedAt: integer("credential_revoked_at", {
      mode: "timestamp_ms",
    }),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at"),
  },
  (table) => [
    uniqueIndex("flary_connection_app_slug_unique").on(table.appId, table.slug),
    index("flary_connection_app_idx").on(table.appId),
    index("flary_connection_org_idx").on(table.organizationId),
    index("flary_connection_owner_idx").on(table.ownerUserId),
  ],
);

/**
 * One short-lived, user-owned provider login.
 *
 * PKCE and device state are encrypted with the deployment token key. Public
 * status fields are safe to return only after the owning user is checked.
 */
export const providerOAuthSession = sqliteTable(
  "provider_oauth_session",
  {
    id: text("id").primaryKey(),
    appId: text("app_id")
      .notNull()
      .references(() => flaryApp.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    connectionId: text("connection_id")
      .notNull()
      .references(() => flaryConnection.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    method: text("method").notNull(),
    status: text("status").notNull().default("pending"),
    authorizationUrl: text("authorization_url"),
    verificationUri: text("verification_uri"),
    userCode: text("user_code"),
    intervalSeconds: integer("interval_seconds"),
    privateStateCiphertext: text("private_state_ciphertext").notNull(),
    privateStateIv: text("private_state_iv").notNull(),
    accountSubject: text("account_subject"),
    errorCode: text("error_code"),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    lastPolledAt: integer("last_polled_at", { mode: "timestamp_ms" }),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at"),
  },
  (table) => [
    index("provider_oauth_session_owner_idx").on(table.organizationId, table.userId, table.status),
    index("provider_oauth_session_expiry_idx").on(table.expiresAt),
  ],
);

// One encrypted secret version per connection/name. The ciphertext is bound
// to the organization, connection, and name with AES-GCM associated data.
export const secretEnvelope = sqliteTable(
  "secret_envelope",
  {
    id: text("id").primaryKey(),
    connectionId: text("connection_id")
      .notNull()
      .references(() => flaryConnection.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    scope: text("scope").notNull(),
    version: integer("version").notNull().default(1),
    keyId: text("key_id").notNull(),
    ciphertext: text("ciphertext").notNull(),
    iv: text("iv").notNull(),
    description: text("description"),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at"),
  },
  (table) => [
    uniqueIndex("secret_envelope_connection_name_unique").on(table.connectionId, table.name),
    index("secret_envelope_org_idx").on(table.organizationId),
    index("secret_envelope_connection_idx").on(table.connectionId),
  ],
);

export const schema = {
  user,
  session,
  account,
  verification,
  organization,
  member,
  invitation,
  flaryApp,
  flaryThread,
  flaryThreadSubmission,
  prompt,
  promptRevision,
  promptVariant,
  cloudflareOAuthState,
  cloudflareConnection,
  flaryConnection,
  providerOAuthSession,
  secretEnvelope,
};

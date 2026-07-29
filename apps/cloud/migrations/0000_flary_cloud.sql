CREATE TABLE IF NOT EXISTS "user" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "email" text NOT NULL,
  "email_verified" integer NOT NULL DEFAULT 0,
  "image" text,
  "created_at" integer NOT NULL DEFAULT (unixepoch() * 1000),
  "updated_at" integer NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE UNIQUE INDEX IF NOT EXISTS "user_email_unique" ON "user" ("email");

CREATE TABLE IF NOT EXISTS "session" (
  "id" text PRIMARY KEY NOT NULL,
  "expires_at" integer NOT NULL,
  "token" text NOT NULL,
  "created_at" integer NOT NULL DEFAULT (unixepoch() * 1000),
  "updated_at" integer NOT NULL DEFAULT (unixepoch() * 1000),
  "ip_address" text,
  "user_agent" text,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "active_organization_id" text
);
CREATE UNIQUE INDEX IF NOT EXISTS "session_token_unique" ON "session" ("token");
CREATE INDEX IF NOT EXISTS "session_user_idx" ON "session" ("user_id");

CREATE TABLE IF NOT EXISTS "account" (
  "id" text PRIMARY KEY NOT NULL,
  "account_id" text NOT NULL,
  "provider_id" text NOT NULL,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "access_token" text,
  "refresh_token" text,
  "id_token" text,
  "access_token_expires_at" integer,
  "refresh_token_expires_at" integer,
  "scope" text,
  "password" text,
  "created_at" integer NOT NULL DEFAULT (unixepoch() * 1000),
  "updated_at" integer NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS "account_user_idx" ON "account" ("user_id");
CREATE UNIQUE INDEX IF NOT EXISTS "account_provider_unique" ON "account" ("provider_id", "account_id");

CREATE TABLE IF NOT EXISTS "verification" (
  "id" text PRIMARY KEY NOT NULL,
  "identifier" text NOT NULL,
  "value" text NOT NULL,
  "expires_at" integer NOT NULL,
  "created_at" integer NOT NULL DEFAULT (unixepoch() * 1000),
  "updated_at" integer NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS "verification_identifier_idx" ON "verification" ("identifier");

CREATE TABLE IF NOT EXISTS "organization" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "slug" text NOT NULL,
  "logo" text,
  "metadata" text,
  "created_at" integer NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE UNIQUE INDEX IF NOT EXISTS "organization_slug_unique" ON "organization" ("slug");

CREATE TABLE IF NOT EXISTS "member" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "role" text NOT NULL DEFAULT 'member',
  "created_at" integer NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE UNIQUE INDEX IF NOT EXISTS "member_user_org_unique" ON "member" ("user_id", "organization_id");
CREATE INDEX IF NOT EXISTS "member_org_idx" ON "member" ("organization_id");

CREATE TABLE IF NOT EXISTS "invitation" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "email" text NOT NULL,
  "inviter_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "role" text,
  "status" text NOT NULL DEFAULT 'pending',
  "expires_at" integer NOT NULL,
  "created_at" integer NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS "invitation_org_idx" ON "invitation" ("organization_id");
CREATE INDEX IF NOT EXISTS "invitation_email_idx" ON "invitation" ("email");

CREATE TABLE IF NOT EXISTS "flary_app" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "slug" text NOT NULL,
  "created_by" text NOT NULL REFERENCES "user"("id") ON DELETE RESTRICT,
  "created_at" integer NOT NULL DEFAULT (unixepoch() * 1000),
  "updated_at" integer NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE UNIQUE INDEX IF NOT EXISTS "flary_app_org_slug_unique" ON "flary_app" ("organization_id", "slug");
CREATE INDEX IF NOT EXISTS "flary_app_org_idx" ON "flary_app" ("organization_id");

CREATE TABLE IF NOT EXISTS "prompt" (
  "id" text PRIMARY KEY NOT NULL,
  "app_id" text NOT NULL REFERENCES "flary_app"("id") ON DELETE CASCADE,
  "slug" text NOT NULL,
  "source_hash" text NOT NULL,
  "source_key" text NOT NULL,
  "source_commit" text,
  "model" text,
  "thinking" text,
  "created_at" integer NOT NULL DEFAULT (unixepoch() * 1000),
  "updated_at" integer NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE UNIQUE INDEX IF NOT EXISTS "prompt_app_slug_unique" ON "prompt" ("app_id", "slug");
CREATE INDEX IF NOT EXISTS "prompt_app_idx" ON "prompt" ("app_id");

CREATE TABLE IF NOT EXISTS "cloudflare_oauth_state" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "state_hash" text NOT NULL,
  "redirect_uri" text NOT NULL,
  "expires_at" integer NOT NULL,
  "created_at" integer NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS "cloudflare_oauth_state_expiry_idx" ON "cloudflare_oauth_state" ("expires_at");

CREATE TABLE IF NOT EXISTS "cloudflare_connection" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "account_id" text,
  "account_name" text,
  "account_options_json" text NOT NULL DEFAULT '[]',
  "access_token_ciphertext" text NOT NULL,
  "access_token_iv" text NOT NULL,
  "refresh_token_ciphertext" text,
  "refresh_token_iv" text,
  "access_token_expires_at" integer,
  "scope" text,
  "created_at" integer NOT NULL DEFAULT (unixepoch() * 1000),
  "updated_at" integer NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE UNIQUE INDEX IF NOT EXISTS "cloudflare_connection_org_user_unique" ON "cloudflare_connection" ("organization_id", "user_id");
CREATE INDEX IF NOT EXISTS "cloudflare_connection_org_idx" ON "cloudflare_connection" ("organization_id");

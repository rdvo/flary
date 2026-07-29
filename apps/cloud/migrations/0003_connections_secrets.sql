CREATE TABLE IF NOT EXISTS "flary_connection" (
  "id" text PRIMARY KEY NOT NULL,
  "app_id" text NOT NULL REFERENCES "flary_app"("id") ON DELETE CASCADE,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "slug" text NOT NULL,
  "provider" text NOT NULL,
  "type" text NOT NULL,
  "protocol" text NOT NULL DEFAULT 'http',
  "base_url" text,
  "docs_url" text,
  "auth_type" text NOT NULL DEFAULT 'none',
  "auth_header" text,
  "description" text,
  "icon_url" text,
  "status" text NOT NULL DEFAULT 'needs_auth',
  "created_by" text NOT NULL REFERENCES "user"("id") ON DELETE RESTRICT,
  "created_at" integer NOT NULL DEFAULT (unixepoch() * 1000),
  "updated_at" integer NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE UNIQUE INDEX IF NOT EXISTS "flary_connection_app_slug_unique"
  ON "flary_connection" ("app_id", "slug");
CREATE INDEX IF NOT EXISTS "flary_connection_app_idx"
  ON "flary_connection" ("app_id");
CREATE INDEX IF NOT EXISTS "flary_connection_org_idx"
  ON "flary_connection" ("organization_id");

CREATE TABLE IF NOT EXISTS "secret_envelope" (
  "id" text PRIMARY KEY NOT NULL,
  "connection_id" text NOT NULL REFERENCES "flary_connection"("id") ON DELETE CASCADE,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "scope" text NOT NULL,
  "version" integer NOT NULL DEFAULT 1,
  "key_id" text NOT NULL,
  "ciphertext" text NOT NULL,
  "iv" text NOT NULL,
  "description" text,
  "expires_at" integer,
  "created_at" integer NOT NULL DEFAULT (unixepoch() * 1000),
  "updated_at" integer NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE UNIQUE INDEX IF NOT EXISTS "secret_envelope_connection_name_unique"
  ON "secret_envelope" ("connection_id", "name");
CREATE INDEX IF NOT EXISTS "secret_envelope_org_idx"
  ON "secret_envelope" ("organization_id");
CREATE INDEX IF NOT EXISTS "secret_envelope_connection_idx"
  ON "secret_envelope" ("connection_id");

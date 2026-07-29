CREATE TABLE IF NOT EXISTS "prompt_revision" (
  "id" text PRIMARY KEY NOT NULL,
  "prompt_id" text NOT NULL REFERENCES "prompt"("id") ON DELETE CASCADE,
  "revision" integer NOT NULL,
  "source_hash" text NOT NULL,
  "source_key" text NOT NULL,
  "source_commit" text,
  "model" text,
  "thinking" text,
  "created_by" text NOT NULL REFERENCES "user"("id") ON DELETE RESTRICT,
  "created_at" integer NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE UNIQUE INDEX IF NOT EXISTS "prompt_revision_prompt_number_unique"
  ON "prompt_revision" ("prompt_id", "revision");
CREATE UNIQUE INDEX IF NOT EXISTS "prompt_revision_prompt_hash_unique"
  ON "prompt_revision" ("prompt_id", "source_hash");
CREATE INDEX IF NOT EXISTS "prompt_revision_prompt_idx"
  ON "prompt_revision" ("prompt_id", "created_at");

CREATE TABLE IF NOT EXISTS "prompt_variant" (
  "id" text PRIMARY KEY NOT NULL,
  "prompt_id" text NOT NULL REFERENCES "prompt"("id") ON DELETE CASCADE,
  "rollout_id" text NOT NULL,
  "scope" text NOT NULL DEFAULT 'user',
  "variant_id" text NOT NULL,
  "revision_id" text NOT NULL REFERENCES "prompt_revision"("id") ON DELETE RESTRICT,
  "allocation_basis_points" integer NOT NULL,
  "enabled" integer NOT NULL DEFAULT 1,
  "created_by" text NOT NULL REFERENCES "user"("id") ON DELETE RESTRICT,
  "created_at" integer NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE UNIQUE INDEX IF NOT EXISTS "prompt_variant_rollout_variant_unique"
  ON "prompt_variant" ("prompt_id", "rollout_id", "variant_id");
CREATE INDEX IF NOT EXISTS "prompt_variant_rollout_idx"
  ON "prompt_variant" ("prompt_id", "rollout_id");

INSERT INTO "prompt_revision" (
  "id", "prompt_id", "revision", "source_hash", "source_key",
  "source_commit", "model", "thinking", "created_by", "created_at"
)
SELECT
  'prompt_revision_' || p."id",
  p."id",
  1,
  p."source_hash",
  p."source_key",
  p."source_commit",
  p."model",
  p."thinking",
  a."created_by",
  p."created_at"
FROM "prompt" p
JOIN "flary_app" a ON a."id" = p."app_id"
WHERE NOT EXISTS (
  SELECT 1 FROM "prompt_revision" r WHERE r."prompt_id" = p."id"
);

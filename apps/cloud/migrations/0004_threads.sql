CREATE TABLE IF NOT EXISTS `flary_thread` (
  `id` text PRIMARY KEY NOT NULL,
  `organization_id` text NOT NULL REFERENCES `organization`(`id`) ON DELETE CASCADE,
  `app_id` text NOT NULL REFERENCES `flary_app`(`id`) ON DELETE CASCADE,
  `agent_id` text NOT NULL,
  `thread_id` text NOT NULL,
  `project_id` text NOT NULL,
  `workspace_id` text NOT NULL,
  `branch` text NOT NULL DEFAULT 'main',
  `persona` text,
  `default_mode` text NOT NULL DEFAULT 'ask',
  `default_model_json` text,
  `default_thinking_level` text NOT NULL DEFAULT 'medium',
  `connection_ids_json` text NOT NULL DEFAULT '[]',
  `status` text NOT NULL DEFAULT 'active',
  `created_by` text NOT NULL REFERENCES `user`(`id`) ON DELETE RESTRICT,
  `parent_thread_json` text,
  `metadata_json` text,
  `created_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  `updated_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  `archived_at` integer
);

CREATE UNIQUE INDEX IF NOT EXISTS `flary_thread_ref_unique`
  ON `flary_thread` (`organization_id`, `app_id`, `agent_id`, `thread_id`);
CREATE INDEX IF NOT EXISTS `flary_thread_app_idx`
  ON `flary_thread` (`app_id`, `updated_at`);
CREATE INDEX IF NOT EXISTS `flary_thread_workspace_idx`
  ON `flary_thread` (`organization_id`, `project_id`, `workspace_id`, `branch`);

CREATE TABLE IF NOT EXISTS `flary_thread_submission` (
  `id` text PRIMARY KEY NOT NULL,
  `organization_id` text NOT NULL REFERENCES `organization`(`id`) ON DELETE CASCADE,
  `app_id` text NOT NULL REFERENCES `flary_app`(`id`) ON DELETE CASCADE,
  `agent_id` text NOT NULL,
  `thread_id` text NOT NULL,
  `model_json` text,
  `thinking_level` text,
  `idempotency_key` text NOT NULL,
  `status` text NOT NULL DEFAULT 'admitted',
  `stream_url` text,
  `flue_offset` text,
  `submission_id` text,
  `created_at` integer NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE UNIQUE INDEX IF NOT EXISTS `flary_thread_submission_idempotency_unique`
  ON `flary_thread_submission` (`organization_id`, `app_id`, `agent_id`, `thread_id`, `idempotency_key`);
CREATE INDEX IF NOT EXISTS `flary_thread_submission_latest_idx`
  ON `flary_thread_submission` (`organization_id`, `thread_id`, `created_at`);

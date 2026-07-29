ALTER TABLE `flary_connection` ADD COLUMN `owner_user_id` text
  REFERENCES `user`(`id`) ON DELETE CASCADE;
ALTER TABLE `flary_connection` ADD COLUMN `credential_subject` text;
ALTER TABLE `flary_connection` ADD COLUMN `credential_scopes_json` text
  NOT NULL DEFAULT '[]';
ALTER TABLE `flary_connection` ADD COLUMN `credential_expires_at` integer;
ALTER TABLE `flary_connection` ADD COLUMN `credential_refreshed_at` integer;
ALTER TABLE `flary_connection` ADD COLUMN `credential_revoked_at` integer;
ALTER TABLE `flary_thread_submission` ADD COLUMN `user_id` text
  REFERENCES `user`(`id`) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS `flary_connection_owner_idx`
  ON `flary_connection` (`owner_user_id`);

CREATE TABLE IF NOT EXISTS `provider_oauth_session` (
  `id` text PRIMARY KEY NOT NULL,
  `app_id` text NOT NULL
    REFERENCES `flary_app`(`id`) ON DELETE CASCADE,
  `organization_id` text NOT NULL
    REFERENCES `organization`(`id`) ON DELETE CASCADE,
  `user_id` text NOT NULL
    REFERENCES `user`(`id`) ON DELETE CASCADE,
  `connection_id` text NOT NULL
    REFERENCES `flary_connection`(`id`) ON DELETE CASCADE,
  `provider` text NOT NULL,
  `method` text NOT NULL,
  `status` text NOT NULL DEFAULT 'pending',
  `authorization_url` text,
  `verification_uri` text,
  `user_code` text,
  `interval_seconds` integer,
  `private_state_ciphertext` text NOT NULL,
  `private_state_iv` text NOT NULL,
  `account_subject` text,
  `error_code` text,
  `expires_at` integer NOT NULL,
  `last_polled_at` integer,
  `completed_at` integer,
  `created_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  `updated_at` integer NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX IF NOT EXISTS `provider_oauth_session_owner_idx`
  ON `provider_oauth_session`
    (`organization_id`, `user_id`, `status`);
CREATE INDEX IF NOT EXISTS `provider_oauth_session_expiry_idx`
  ON `provider_oauth_session` (`expires_at`);

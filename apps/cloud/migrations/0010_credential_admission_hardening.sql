ALTER TABLE `flary_thread_submission`
  ADD COLUMN `credential_connection_id` text;
ALTER TABLE `flary_thread_submission`
  ADD COLUMN `credential_source` text NOT NULL DEFAULT 'managed';
ALTER TABLE `flary_thread_submission`
  ADD COLUMN `billing_mode` text NOT NULL DEFAULT 'managed';
ALTER TABLE `flary_thread_submission`
  ADD COLUMN `provider` text NOT NULL DEFAULT 'cloudflare';
ALTER TABLE `flary_thread_submission`
  ADD COLUMN `credential_version` integer NOT NULL DEFAULT 1;
ALTER TABLE `flary_thread_submission`
  ADD COLUMN `credential_generation` text NOT NULL DEFAULT 'legacy';
ALTER TABLE `flary_thread_submission`
  ADD COLUMN `credential_connection_ref` text NOT NULL DEFAULT 'legacy';

CREATE INDEX IF NOT EXISTS `flary_thread_submission_credential_idx`
  ON `flary_thread_submission`
    (`organization_id`, `credential_connection_id`, `credential_version`);

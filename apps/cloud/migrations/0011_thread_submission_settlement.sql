ALTER TABLE `flary_thread_submission`
  ADD COLUMN `error_code` text;
ALTER TABLE `flary_thread_submission`
  ADD COLUMN `settled_at` integer;

CREATE INDEX IF NOT EXISTS `flary_thread_submission_recovery_idx`
  ON `flary_thread_submission`
    (`organization_id`, `app_id`, `agent_id`, `thread_id`, `status`, `created_at`);

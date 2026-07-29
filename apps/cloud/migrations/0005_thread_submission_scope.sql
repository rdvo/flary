DROP INDEX IF EXISTS `flary_thread_submission_idempotency_unique`;

CREATE UNIQUE INDEX IF NOT EXISTS `flary_thread_submission_idempotency_unique`
  ON `flary_thread_submission` (
    `organization_id`,
    `app_id`,
    `agent_id`,
    `thread_id`,
    `idempotency_key`
  );

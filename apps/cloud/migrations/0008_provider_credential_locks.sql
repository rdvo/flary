CREATE TABLE IF NOT EXISTS `provider_credential_lock` (
  `connection_id` text PRIMARY KEY NOT NULL
    REFERENCES `flary_connection`(`id`) ON DELETE CASCADE,
  `owner_id` text NOT NULL,
  `expires_at` integer NOT NULL
);

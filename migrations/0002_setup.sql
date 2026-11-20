-- What this install keeps about itself: `domain`, `host` (its web address), `org_name`, `logo_at` (when the logo in R2 was
-- last changed), `welcomed` (the owner has seen the invite step), `domains` (the installer's list for the wizard),
-- `confirmed` (the domain typed to take over its mail) and `setup_report` (the installer's last run).
CREATE TABLE IF NOT EXISTS setting (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- First-run attempts, for its rate limit. `who` is a SHA-256 of the visitor's address, never the address itself.
CREATE TABLE IF NOT EXISTS setup_attempt (
  who TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS setup_attempt_at ON setup_attempt(at);

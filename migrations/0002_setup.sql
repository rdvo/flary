-- What this install keeps about itself: `domain`, the mail domain picked on the first-run screen.
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

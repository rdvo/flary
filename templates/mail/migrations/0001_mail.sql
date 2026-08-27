PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS user (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, email_verified INTEGER NOT NULL DEFAULT 0, image TEXT, created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000), updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000));
CREATE TABLE IF NOT EXISTS session (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, token TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000), updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000), ip_address TEXT, user_agent TEXT, user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS session_user_idx ON session(user_id);
CREATE TABLE IF NOT EXISTS account (id TEXT PRIMARY KEY, issuer TEXT NOT NULL, account_id TEXT NOT NULL, provider_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE, access_token TEXT, refresh_token TEXT, id_token TEXT, access_token_expires_at INTEGER, refresh_token_expires_at INTEGER, scope TEXT, password TEXT, created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000), updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000), UNIQUE(issuer, account_id));
CREATE INDEX IF NOT EXISTS account_user_idx ON account(user_id);
CREATE TABLE IF NOT EXISTS verification (id TEXT PRIMARY KEY, identifier TEXT NOT NULL, value TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000), updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000));
CREATE INDEX IF NOT EXISTS verification_identifier_idx ON verification(identifier);

CREATE TABLE IF NOT EXISTS mail_installation (
  id TEXT PRIMARY KEY CHECK(id = 'owner'),
  status TEXT NOT NULL CHECK(status IN ('initializing','ready')),
  owner_user_id TEXT,
  created_at INTEGER NOT NULL,
  initialized_at INTEGER
);

CREATE TABLE IF NOT EXISTS mail_member (
  user_id TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('owner','member')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE TABLE IF NOT EXISTS mailbox (
  id TEXT PRIMARY KEY,
  address TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE TABLE IF NOT EXISTS mailbox_member (
  mailbox_id TEXT NOT NULL REFERENCES mailbox(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('manager','member')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (mailbox_id, user_id)
);
CREATE INDEX IF NOT EXISTS mailbox_member_user_idx ON mailbox_member(user_id);

CREATE TABLE IF NOT EXISTS mail_thread (
  id TEXT PRIMARY KEY,
  mailbox_id TEXT NOT NULL REFERENCES mailbox(id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  participants_json TEXT NOT NULL DEFAULT '[]',
  message_count INTEGER NOT NULL DEFAULT 0,
  unread_count INTEGER NOT NULL DEFAULT 0,
  last_message_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS mail_thread_mailbox_time_idx ON mail_thread(mailbox_id, last_message_at DESC);

CREATE TABLE IF NOT EXISTS mail_message (
  id TEXT PRIMARY KEY,
  mailbox_id TEXT NOT NULL REFERENCES mailbox(id) ON DELETE CASCADE,
  thread_id TEXT REFERENCES mail_thread(id) ON DELETE SET NULL,
  direction TEXT NOT NULL CHECK(direction IN ('inbound','outbound')),
  folder TEXT NOT NULL CHECK(folder IN ('inbox','sent','outbox','drafts','archive','spam','trash')),
  status TEXT NOT NULL CHECK(status IN ('draft','queued','sending','sent','delivered','deferred','bounced','failed')),
  message_id TEXT,
  in_reply_to TEXT,
  references_header TEXT,
  from_address TEXT NOT NULL,
  from_name TEXT,
  to_json TEXT NOT NULL DEFAULT '[]',
  cc_json TEXT NOT NULL DEFAULT '[]',
  bcc_json TEXT NOT NULL DEFAULT '[]',
  reply_to TEXT,
  subject TEXT NOT NULL DEFAULT '',
  text_body TEXT NOT NULL DEFAULT '',
  html_body TEXT,
  raw_object_key TEXT,
  is_read INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  sent_at INTEGER,
  delivered_at INTEGER,
  created_by TEXT REFERENCES user(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS mail_message_thread_idx ON mail_message(thread_id, created_at);
CREATE INDEX IF NOT EXISTS mail_message_folder_idx ON mail_message(mailbox_id, folder, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS mail_message_rfc_id_idx ON mail_message(mailbox_id, message_id) WHERE message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS mail_attachment (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES mail_message(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  object_key TEXT NOT NULL,
  content_id TEXT,
  disposition TEXT NOT NULL CHECK(disposition IN ('attachment','inline')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS mail_attachment_message_idx ON mail_attachment(message_id);

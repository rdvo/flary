-- A mailbox is an address that receives mail. Each person has one personal mailbox; shared mailboxes have members.
CREATE TABLE IF NOT EXISTS mailbox (
  id TEXT PRIMARY KEY,
  address TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('personal', 'shared')),
  created_at INTEGER NOT NULL
);

-- A person who signs in. Their sign-in address is their personal mailbox's address.
CREATE TABLE IF NOT EXISTS account (
  id TEXT PRIMARY KEY,
  mailbox_id TEXT NOT NULL UNIQUE REFERENCES mailbox(id),
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  password TEXT NOT NULL,
  must_change INTEGER NOT NULL DEFAULT 1,
  failed INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0,
  totp TEXT,
  totp_pending TEXT,
  totp_step INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mailbox_member (
  mailbox_id TEXT NOT NULL REFERENCES mailbox(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  PRIMARY KEY (mailbox_id, account_id)
);
CREATE INDEX IF NOT EXISTS mailbox_member_account ON mailbox_member(account_id);

-- An extra address that delivers into a mailbox.
CREATE TABLE IF NOT EXISTS alias (
  address TEXT PRIMARY KEY,
  mailbox_id TEXT NOT NULL REFERENCES mailbox(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS alias_mailbox ON alias(mailbox_id);

-- Only a SHA-256 of the cookie is stored.
CREATE TABLE IF NOT EXISTS session (
  token TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS session_account ON session(account_id);

-- auth: Cloudflare's DMARC result for received mail ('pass', 'fail', 'none', 'unknown'), or 'sent' / 'draft'.
-- folder: inbox, archive, sent, drafts, spam, trash. attachments: JSON [{name, type, size, cid?}].
CREATE TABLE IF NOT EXISTS message (
  id TEXT PRIMARY KEY,
  mailbox_id TEXT NOT NULL REFERENCES mailbox(id) ON DELETE CASCADE,
  message_id TEXT,
  thread_id TEXT NOT NULL,
  recipient TEXT NOT NULL DEFAULT '',
  cc TEXT NOT NULL DEFAULT '',
  bcc TEXT NOT NULL DEFAULT '',
  sender TEXT NOT NULL DEFAULT '',
  sender_name TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  html TEXT,
  auth TEXT NOT NULL DEFAULT 'unknown',
  folder TEXT NOT NULL DEFAULT 'inbox',
  starred INTEGER NOT NULL DEFAULT 0,
  attachments TEXT NOT NULL DEFAULT '[]',
  refs TEXT NOT NULL DEFAULT '',
  received_at INTEGER NOT NULL,
  read_at INTEGER,
  UNIQUE (mailbox_id, message_id)
);
CREATE INDEX IF NOT EXISTS message_folder ON message(mailbox_id, folder, received_at DESC);
CREATE INDEX IF NOT EXISTS message_thread ON message(mailbox_id, thread_id);

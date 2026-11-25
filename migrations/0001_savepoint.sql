CREATE TABLE games (
  id TEXT COLLATE NOCASE PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  platform TEXT NOT NULL,
  edition TEXT NOT NULL,
  cover_url TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revision TEXT NOT NULL DEFAULT (lower(hex(randomblob(32))))
);

CREATE TABLE sessions (
  token TEXT PRIMARY KEY NOT NULL,
  authenticated_at INTEGER NOT NULL,
  activity_at INTEGER NOT NULL
);
CREATE INDEX sessions_activity ON sessions(activity_at);

CREATE TABLE rate_limits (
  bucket TEXT PRIMARY KEY NOT NULL,
  started_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL,
  blocked_until INTEGER NOT NULL
);
CREATE INDEX rate_limits_expiry ON rate_limits(started_at);

CREATE TABLE uploads (
  id TEXT PRIMARY KEY NOT NULL,
  owner TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('ai','collection')),
  mode TEXT,
  size INTEGER NOT NULL,
  offset INTEGER NOT NULL DEFAULT 0,
  expires INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'uploading',
  inserted INTEGER
);
CREATE INDEX uploads_active ON uploads(kind, expires);
CREATE TABLE upload_chunks (
  upload_id TEXT NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
  offset INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (upload_id, offset)
);

CREATE TABLE transaction_checks (
  failure TEXT NOT NULL CONSTRAINT savepoint_transaction_check CHECK (failure = '')
);

CREATE TABLE cover_claims (
  key TEXT PRIMARY KEY NOT NULL,
  token TEXT NOT NULL,
  expires INTEGER NOT NULL
);
CREATE INDEX cover_claims_expiry ON cover_claims(expires);

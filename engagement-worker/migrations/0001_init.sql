-- Capture substrate — initial schema.
--
-- Two tables so account-elevation is later a re-pointing, not a migration:
--   sessions  one row per anonymous session; user_id stays NULL until the visitor
--             registers and links it (the future `identity-optional` change). A future
--             `users` table holds email/name — PII never lives here or in `events`.
--   events    one engagement event, keyed by (session_id, target, type). The PRIMARY KEY
--             gives write-time idempotency: favoriting a perk twice is a no-op.
--
-- The logical OWNER of an event = COALESCE(sessions.user_id, events.session_id).
-- Every aggregate dedups by owner, so one person's many linked sessions count once.

CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  user_id    TEXT,
  created_at INTEGER NOT NULL
);

-- Resolve a user's sessions quickly when listing "my X" / counting by owner.
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);

CREATE TABLE IF NOT EXISTS events (
  session_id TEXT    NOT NULL,
  target     TEXT    NOT NULL,
  type       TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, target, type)
);

-- Aggregate reads are "count distinct owners WHERE target IN (...) AND type = ?".
CREATE INDEX IF NOT EXISTS idx_events_target_type ON events (target, type);

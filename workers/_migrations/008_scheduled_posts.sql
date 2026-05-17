-- One-shot timed announcements. c3-content-engine sweeps this on every run and
-- posts anything whose fire_at_utc has passed and status='pending', then marks
-- it 'posted'. Reusable for launch announcements, seat-count alerts, contest
-- deadline pings, etc.
CREATE TABLE IF NOT EXISTS scheduled_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fire_at_utc TEXT NOT NULL,                  -- ISO 8601, e.g. "2026-05-18T12:00:00Z"
  channel_name TEXT NOT NULL,                 -- Discord channel name (resolved to ID at fire time)
  post_kind TEXT NOT NULL DEFAULT 'message',  -- 'message' | 'forum_thread'
  thread_title TEXT,                          -- only used when post_kind='forum_thread'
  body TEXT NOT NULL,                         -- raw text/markdown to post
  tag TEXT,                                   -- free-form label e.g. 'launch-day'
  status TEXT NOT NULL DEFAULT 'pending',     -- 'pending' | 'posted' | 'failed' | 'cancelled'
  result TEXT,                                -- JSON: posted_at, channel_id, message_id, error?
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_scheduled_posts_pending
  ON scheduled_posts (status, fire_at_utc);

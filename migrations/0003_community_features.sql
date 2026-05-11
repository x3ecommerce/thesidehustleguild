-- ============================================================================
-- Migration 0003 — Community Feature Workers
-- Adds: tickets, ticket_messages, faq_tags, polls, poll_votes, channel_stats,
--       events, event_rsvps
-- ============================================================================

-- ── TICKETS ────────────────────────────────────────────────────────────────
CREATE TABLE tickets (
  ticket_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_number    INTEGER NOT NULL,
  category         TEXT NOT NULL CHECK (category IN ('billing','contest','bug','sponsor','other')),
  member_id        INTEGER,
  discord_id       TEXT NOT NULL,
  thread_id        TEXT,
  channel_id       TEXT,
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','escalated')),
  subject          TEXT,
  opened_at        TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  closed_at        TEXT,
  closed_by        TEXT,
  resolution_note  TEXT,
  transcript_url   TEXT
);
CREATE INDEX idx_tickets_status ON tickets(status);
CREATE INDEX idx_tickets_member ON tickets(member_id);
CREATE INDEX idx_tickets_discord ON tickets(discord_id);

CREATE TABLE ticket_messages (
  msg_id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id        INTEGER NOT NULL,
  discord_msg_id   TEXT,
  author_id        TEXT NOT NULL,
  author_name      TEXT,
  is_staff         INTEGER NOT NULL DEFAULT 0,
  content          TEXT,
  occurred_at      TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  FOREIGN KEY (ticket_id) REFERENCES tickets(ticket_id)
);
CREATE INDEX idx_ticket_msgs_ticket ON ticket_messages(ticket_id, occurred_at);

-- ── FAQ TAGS ───────────────────────────────────────────────────────────────
CREATE TABLE faq_tags (
  tag_id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT NOT NULL UNIQUE,
  title            TEXT,
  content          TEXT NOT NULL,
  embed_color      INTEGER DEFAULT 15375675,
  created_by       TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at       TEXT,
  use_count        INTEGER NOT NULL DEFAULT 0,
  enabled          INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_faq_tags_enabled ON faq_tags(enabled, name);

-- Auto-responder triggers — regex/keyword match in messages → reply with tag
CREATE TABLE faq_triggers (
  trigger_id       INTEGER PRIMARY KEY AUTOINCREMENT,
  tag_id           INTEGER NOT NULL,
  pattern          TEXT NOT NULL,
  match_type       TEXT NOT NULL CHECK (match_type IN ('contains','exact','regex')),
  channel_scope    TEXT,
  enabled          INTEGER NOT NULL DEFAULT 1,
  hit_count        INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (tag_id) REFERENCES faq_tags(tag_id)
);

-- ── POLLS ──────────────────────────────────────────────────────────────────
CREATE TABLE polls (
  poll_id          INTEGER PRIMARY KEY AUTOINCREMENT,
  discord_msg_id   TEXT UNIQUE,
  channel_id       TEXT NOT NULL,
  guild_id         TEXT NOT NULL,
  question         TEXT NOT NULL,
  options_json     TEXT NOT NULL,
  is_anonymous     INTEGER NOT NULL DEFAULT 0,
  is_weighted      INTEGER NOT NULL DEFAULT 0,
  required_role_id TEXT,
  multi_select     INTEGER NOT NULL DEFAULT 0,
  created_by       TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  closes_at        TEXT,
  closed_at        TEXT,
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','cancelled'))
);
CREATE INDEX idx_polls_open ON polls(status, closes_at);

CREATE TABLE poll_votes (
  vote_id          INTEGER PRIMARY KEY AUTOINCREMENT,
  poll_id          INTEGER NOT NULL,
  voter_id         TEXT NOT NULL,
  option_index     INTEGER NOT NULL,
  weight           INTEGER NOT NULL DEFAULT 1,
  voted_at         TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  FOREIGN KEY (poll_id) REFERENCES polls(poll_id)
);
CREATE UNIQUE INDEX uniq_poll_voter_option ON poll_votes(poll_id, voter_id, option_index);

-- ── CHANNEL ANALYTICS ──────────────────────────────────────────────────────
CREATE TABLE channel_stats_daily (
  date             TEXT NOT NULL,
  channel_id       TEXT NOT NULL,
  channel_name     TEXT,
  channel_type     TEXT,
  msg_count        INTEGER NOT NULL DEFAULT 0,
  unique_authors   INTEGER NOT NULL DEFAULT 0,
  reaction_count   INTEGER NOT NULL DEFAULT 0,
  thread_count     INTEGER NOT NULL DEFAULT 0,
  computed_at      TEXT NOT NULL,
  PRIMARY KEY (date, channel_id)
);
CREATE INDEX idx_channel_stats_date ON channel_stats_daily(date);

-- ── EVENTS / RSVPs ─────────────────────────────────────────────────────────
CREATE TABLE events (
  event_id         INTEGER PRIMARY KEY AUTOINCREMENT,
  discord_msg_id   TEXT,
  channel_id       TEXT NOT NULL,
  title            TEXT NOT NULL,
  description      TEXT,
  starts_at        TEXT NOT NULL,
  ends_at          TEXT,
  timezone_hint    TEXT,
  location_or_url  TEXT,
  recurring_rule   TEXT,
  created_by       TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  reminder_sent    INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','cancelled','completed'))
);
CREATE INDEX idx_events_starts ON events(starts_at, status);

CREATE TABLE event_rsvps (
  rsvp_id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id         INTEGER NOT NULL,
  discord_id       TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('going','maybe','cant')),
  rsvp_at          TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  reminded_at      TEXT,
  FOREIGN KEY (event_id) REFERENCES events(event_id)
);
CREATE UNIQUE INDEX uniq_event_rsvp ON event_rsvps(event_id, discord_id);

-- Seed agent_status rows for the 5 new workers
INSERT INTO agent_status (agent_id, agent_name, agent_group, cron_schedule, expected_interval_min, health) VALUES
  ('m1_tickets',   'Tickets Worker',          'admin',      'webhook+10min', 60,    'unknown'),
  ('m2_faq',       'FAQ Tags Worker',         'admin',      'webhook',       NULL,  'unknown'),
  ('m3_polls',     'Polls Worker',            'admin',      'webhook+5min',  60,    'unknown'),
  ('m4_analytics', 'Channel Analytics',       'admin',      '0 4 * * *',     1440,  'unknown'),
  ('m5_events',    'Events / RSVPs',          'admin',      '*/10 * * * *',  30,    'unknown');

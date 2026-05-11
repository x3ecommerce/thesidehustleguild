CREATE TABLE leads (
  lead_id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind             TEXT NOT NULL CHECK (kind IN ('sponsor','creator')),
  source           TEXT NOT NULL,
  source_url       TEXT,
  company_name     TEXT,
  contact_name     TEXT,
  contact_title    TEXT,
  contact_email    TEXT,
  social_handle    TEXT,
  platform         TEXT,
  signals_json     TEXT,
  enriched_at      TEXT,
  status           TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','enriched','queued','contacted','replied_positive','replied_negative','bounced','unsubscribed','converted','dead')),
  score            INTEGER NOT NULL DEFAULT 0,
  notes            TEXT,
  created_at       TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at       TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
CREATE UNIQUE INDEX uniq_leads_kind_email ON leads(kind, contact_email) WHERE contact_email IS NOT NULL;
CREATE INDEX idx_leads_status ON leads(status, kind);
CREATE INDEX idx_leads_score ON leads(score DESC);

CREATE TABLE outreach (
  outreach_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id          INTEGER NOT NULL,
  sequence_step    INTEGER NOT NULL DEFAULT 1,
  channel          TEXT NOT NULL CHECK (channel IN ('email','linkedin','x','discord')),
  subject          TEXT,
  body             TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','queued','sent','bounced','opened','clicked','replied','unsubscribed','suppressed')),
  scheduled_for    TEXT,
  sent_at          TEXT,
  opened_at        TEXT,
  clicked_at       TEXT,
  replied_at       TEXT,
  external_id      TEXT,
  agent_id         TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  FOREIGN KEY (lead_id) REFERENCES leads(lead_id)
);
CREATE INDEX idx_outreach_lead ON outreach(lead_id, sequence_step);
CREATE INDEX idx_outreach_status ON outreach(status, scheduled_for);

CREATE TABLE replies (
  reply_id         INTEGER PRIMARY KEY AUTOINCREMENT,
  outreach_id      INTEGER,
  lead_id          INTEGER,
  channel          TEXT NOT NULL,
  sender           TEXT,
  subject          TEXT,
  body             TEXT,
  classification   TEXT CHECK (classification IN ('positive','negative','autoresp','unsubscribe','spam','unknown')),
  received_at      TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  routed_to_ticket INTEGER,
  FOREIGN KEY (outreach_id) REFERENCES outreach(outreach_id)
);
CREATE INDEX idx_replies_lead ON replies(lead_id);

CREATE TABLE suppression_list (
  email            TEXT PRIMARY KEY,
  reason           TEXT NOT NULL,
  added_at         TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

-- Settings table for mailing address + other org-level config
CREATE TABLE IF NOT EXISTS org_settings (
  key              TEXT PRIMARY KEY,
  value            TEXT NOT NULL,
  updated_at       TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

INSERT OR IGNORE INTO org_settings (key, value) VALUES
  ('mailing_address', 'X3 E-Commerce LLC dba The Side Hustle Guild · 1942 Broadway St Ste 314C · Boulder CO 80302'),
  ('sender_name', 'Joshua at The Side Hustle Guild'),
  ('sender_email', 'sales@thesidehustleguild.com'),
  ('unsub_url', 'https://thesidehustleguild.com/unsubscribe'),
  ('daily_brand_quota', '10'),
  ('daily_creator_quota', '20');

INSERT INTO agent_status (agent_id, agent_name, agent_group, cron_schedule, expected_interval_min, health) VALUES
  ('s1_sponsor_hunter', 'Sponsor Hunter',    'admin', '0 14,18 * * *', 360,  'unknown'),
  ('s2_creator_hunter', 'Creator Hunter',    'admin', '0 15,19 * * *', 360,  'unknown'),
  ('s3_reply_handler',  'Reply Handler',     'admin', '*/15 * * * *',  30,   'unknown');

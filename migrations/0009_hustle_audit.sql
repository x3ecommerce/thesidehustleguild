-- 0009_hustle_audit — store every Hustle Audit report for member retrieval.

CREATE TABLE IF NOT EXISTS hustle_audits (
  audit_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id   INTEGER NOT NULL,
  member_email    TEXT NOT NULL,
  report_markdown TEXT NOT NULL,
  generated_at    TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  delivered_at    TEXT,                          -- when DM/email actually sent
  cost_cents      REAL,                          -- Anthropic cost for the run
  clarification_used INTEGER NOT NULL DEFAULT 0  -- 0 = free round still available
);

CREATE INDEX IF NOT EXISTS idx_hustle_audits_sub ON hustle_audits (submission_id);
CREATE INDEX IF NOT EXISTS idx_hustle_audits_email ON hustle_audits (member_email);

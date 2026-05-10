-- ============================================================================
-- Migration 0002 — Agent Fleet Observability + Money-In Tracking
-- Adds: agent_runs (append-only log), agent_status (current health),
--       prize_pool_state (current pool snapshot), money_in_daily (rev rollup),
--       member_count_snapshot (subscriber counter audit trail).
-- ============================================================================

-- agent_runs — every execution of every agent. Append-only.
CREATE TABLE agent_runs (
  run_id              INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id            TEXT NOT NULL,
  agent_name          TEXT NOT NULL,
  started_at          TEXT NOT NULL,
  finished_at         TEXT,
  duration_ms         INTEGER,
  status              TEXT NOT NULL CHECK (status IN ('running','success','warn','error','skipped')),
  output_summary      TEXT,
  error_message       TEXT,
  metadata            TEXT,
  triggered_by        TEXT NOT NULL DEFAULT 'cron',
  created_at          TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
CREATE INDEX idx_agent_runs_agent_started ON agent_runs(agent_id, started_at);
CREATE INDEX idx_agent_runs_status ON agent_runs(status);

CREATE TRIGGER no_update_agent_runs BEFORE UPDATE ON agent_runs
WHEN OLD.status = 'success' OR OLD.status = 'error' OR OLD.status = 'warn'
BEGIN
  SELECT RAISE(ABORT, 'agent_runs are append-only after terminal status');
END;
CREATE TRIGGER no_delete_agent_runs BEFORE DELETE ON agent_runs
BEGIN
  SELECT RAISE(ABORT, 'agent_runs cannot be deleted');
END;

-- agent_status — single row per agent, updated each run. Health is computed.
CREATE TABLE agent_status (
  agent_id            TEXT PRIMARY KEY,
  agent_name          TEXT NOT NULL,
  agent_group         TEXT NOT NULL CHECK (agent_group IN ('finance','contest','engagement','admin')),
  cron_schedule       TEXT,
  last_run_id         INTEGER,
  last_run_started_at TEXT,
  last_run_status     TEXT,
  last_success_at     TEXT,
  consecutive_errors  INTEGER NOT NULL DEFAULT 0,
  health              TEXT NOT NULL DEFAULT 'unknown' CHECK (health IN ('green','yellow','red','unknown')),
  latest_message      TEXT,
  expected_interval_min INTEGER,
  updated_at          TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

-- prize_pool_state — current contest period pool. One row per contest period.
CREATE TABLE prize_pool_state (
  period_id           TEXT PRIMARY KEY,
  period_label        TEXT NOT NULL,
  period_start        TEXT NOT NULL,
  period_end          TEXT NOT NULL,
  paid_member_count   INTEGER NOT NULL DEFAULT 0,
  gross_mrr_cents     INTEGER NOT NULL DEFAULT 0,
  pool_cents          INTEGER NOT NULL DEFAULT 0,
  rookie_alloc_cents  INTEGER NOT NULL DEFAULT 0,
  builder_alloc_cents INTEGER NOT NULL DEFAULT 0,
  operator_alloc_cents INTEGER NOT NULL DEFAULT 0,
  peoples_choice_cents INTEGER NOT NULL DEFAULT 0,
  lucky_sponsor_cents INTEGER NOT NULL DEFAULT 0,
  contest_active      INTEGER NOT NULL DEFAULT 0,
  funded              INTEGER NOT NULL DEFAULT 0,
  computed_at         TEXT NOT NULL,
  computed_by_agent   TEXT NOT NULL,
  notes               TEXT
);
CREATE INDEX idx_prize_pool_period ON prize_pool_state(period_start);

-- money_in_daily — daily revenue rollup. Recomputed by Revenue Manager each run.
CREATE TABLE money_in_daily (
  date                TEXT PRIMARY KEY,
  gross_subscription_cents INTEGER NOT NULL DEFAULT 0,
  gross_sponsor_cents INTEGER NOT NULL DEFAULT 0,
  refunds_cents       INTEGER NOT NULL DEFAULT 0,
  chargebacks_cents   INTEGER NOT NULL DEFAULT 0,
  net_cents           INTEGER NOT NULL DEFAULT 0,
  new_paid_members    INTEGER NOT NULL DEFAULT 0,
  churned_members     INTEGER NOT NULL DEFAULT 0,
  computed_at         TEXT NOT NULL,
  computed_by_agent   TEXT NOT NULL
);

-- member_count_snapshot — daily snapshot for the 100-member countdown.
CREATE TABLE member_count_snapshot (
  snapshot_at         TEXT PRIMARY KEY,
  paid_member_count   INTEGER NOT NULL,
  founder_count       INTEGER NOT NULL,
  lab_member_count    INTEGER NOT NULL,
  delta_24h           INTEGER NOT NULL DEFAULT 0,
  delta_7d            INTEGER NOT NULL DEFAULT 0,
  contest_active      INTEGER NOT NULL DEFAULT 0,
  recorded_by_agent   TEXT NOT NULL
);

-- agent_alerts — yellow/red events that need founder attention. Soft-delete via resolved_at.
CREATE TABLE agent_alerts (
  alert_id            INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id            TEXT NOT NULL,
  severity            TEXT NOT NULL CHECK (severity IN ('warn','error','critical')),
  title               TEXT NOT NULL,
  detail              TEXT,
  raised_at           TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  resolved_at         TEXT,
  resolved_by         TEXT,
  resolution_note     TEXT,
  notified_founder    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_agent_alerts_open ON agent_alerts(resolved_at, severity) WHERE resolved_at IS NULL;
CREATE INDEX idx_agent_alerts_agent ON agent_alerts(agent_id, raised_at);

-- Seed agent_status with all 11 known agents so the dashboard has rows from day one.
INSERT INTO agent_status (agent_id, agent_name, agent_group, cron_schedule, expected_interval_min, health) VALUES
  ('f1_cfo',          'CFO Agent',                  'finance',    '30 7 * * *',   1440, 'unknown'),
  ('f2_revenue',      'Revenue Manager',            'finance',    '0 * * * *',      75, 'unknown'),
  ('f3_payouts',      'Payouts Manager',            'finance',    '0 13 * * *',   1440, 'unknown'),
  ('f4_controller',   'Controller',                 'finance',    '0 6 * * *',    1440, 'unknown'),
  ('f5_reporting',    'Reporting Agent',            'finance',    '0 11 * * *',   1440, 'unknown'),
  ('f6_fpa',          'FP&A Agent',                 'finance',    '0 12 * * 1',  10080, 'unknown'),
  ('c1_subcounter',   'Subscriber Counter Agent',   'contest',    '0 13 * * *',   1440, 'unknown'),
  ('c2_pricepool',    'Prize Pool Calculator',      'contest',    '0 8 * * *',    1440, 'unknown'),
  ('e1_role_grant',   'Whop→Discord Role Grant',    'engagement', 'webhook',       NULL, 'unknown'),
  ('e2_concierge',    'Concierge Auto-DM',          'engagement', 'webhook',       NULL, 'unknown'),
  ('a1_admin',        'Admin Assistant Agent',      'admin',      '*/15 * * * *',   30, 'unknown');

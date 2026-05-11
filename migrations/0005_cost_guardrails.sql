CREATE TABLE anthropic_spend (
  call_id          INTEGER PRIMARY KEY AUTOINCREMENT,
  worker_id        TEXT NOT NULL,
  model            TEXT NOT NULL,
  input_tokens     INTEGER NOT NULL,
  output_tokens    INTEGER NOT NULL,
  cost_cents       REAL NOT NULL,
  occurred_at      TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
CREATE INDEX idx_anthropic_spend_day ON anthropic_spend(date(occurred_at), worker_id);

INSERT INTO org_settings (key, value) VALUES
  ('daily_anthropic_cap_cents', '500'),
  ('monthly_anthropic_cap_cents', '5000'),
  ('per_worker_minute_cap', '10');

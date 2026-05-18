-- 0008_concierge_pro — log every /concierge slash command invocation.
-- p1-concierge-pro is the only worker that writes here.

CREATE TABLE IF NOT EXISTS concierge_calls (
  call_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  discord_id     TEXT NOT NULL,
  subcommand     TEXT NOT NULL CHECK (subcommand IN (
                    'pricing','stuck','submit-review','wins-of-week','next-move'
                 )),
  input          TEXT,
  member_id      INTEGER,
  called_at      TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  response_chars INTEGER,
  cost_cents     REAL
);
CREATE INDEX IF NOT EXISTS idx_concierge_calls_member ON concierge_calls (member_id, called_at);
CREATE INDEX IF NOT EXISTS idx_concierge_calls_sub ON concierge_calls (subcommand, called_at);

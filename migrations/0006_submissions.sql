-- 0006_submissions — native contest submissions stored in D1.
-- Designed to coexist with the existing Tally→Discord webhook (which keeps working
-- as a fallback). The new native /submit POSTs here, writes the row, uploads images
-- to R2, then syndicates to Discord — same forum thread shape as Tally — so the
-- existing /submissions browse page picks it up automatically.

CREATE TABLE IF NOT EXISTS submissions (
  submission_id       INTEGER PRIMARY KEY AUTOINCREMENT,
  slug                TEXT NOT NULL UNIQUE,
  cycle_month         TEXT NOT NULL,
  member_id           INTEGER,
  display_name        TEXT NOT NULL,
  email               TEXT NOT NULL,

  title               TEXT NOT NULL,
  category            TEXT NOT NULL CHECK (category IN (
                          'digital_product','service','saas_app','content',
                          'physical_product','other'
                      )),
  target_audience     TEXT NOT NULL,
  problem             TEXT NOT NULL,

  tools_used          TEXT NOT NULL,
  timeline            TEXT NOT NULL,
  what_built          TEXT NOT NULL,

  outcome             TEXT NOT NULL,
  biggest_lesson      TEXT,
  links               TEXT,

  is_public           INTEGER NOT NULL DEFAULT 1,
  status              TEXT NOT NULL DEFAULT 'submitted'
                      CHECK (status IN ('submitted','judging','winner','nonwinner','hidden')),
  winner_rank         INTEGER,
  prize_amount_cents  INTEGER,
  payout_txn_id       TEXT,
  judge_notes         TEXT,
  reaction_count      INTEGER NOT NULL DEFAULT 0,
  discord_thread_id   TEXT,

  created_at          TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at          TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX IF NOT EXISTS idx_submissions_cycle ON submissions (cycle_month, status);
CREATE INDEX IF NOT EXISTS idx_submissions_member ON submissions (member_id);
CREATE INDEX IF NOT EXISTS idx_submissions_slug ON submissions (slug);
CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions (status, created_at);

CREATE TABLE IF NOT EXISTS submission_images (
  image_id            INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id       INTEGER NOT NULL,
  r2_key              TEXT NOT NULL,
  public_url          TEXT NOT NULL,
  width               INTEGER,
  height              INTEGER,
  mime_type           TEXT,
  size_bytes          INTEGER,
  caption             TEXT,
  sort_order          INTEGER NOT NULL DEFAULT 0,
  uploaded_at         TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  FOREIGN KEY (submission_id) REFERENCES submissions(submission_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_submission_images_sub ON submission_images (submission_id, sort_order);

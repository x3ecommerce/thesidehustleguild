-- ============================================================================
-- The Side Hustle Guild Finance Ledger
-- Cloudflare D1 schema, v1.0
-- All tables append-only or strictly controlled. No silent updates.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- members — the master roster. Updated on signup/churn/upgrade.
-- ----------------------------------------------------------------------------
CREATE TABLE members (
  member_id           INTEGER PRIMARY KEY AUTOINCREMENT,
  whop_id             TEXT NOT NULL UNIQUE,
  discord_id          TEXT UNIQUE,
  email_hash          TEXT NOT NULL,                        -- SHA-256 with server-side pepper
  signup_date         TEXT NOT NULL,                        -- ISO 8601
  tier                TEXT NOT NULL CHECK (tier IN ('rookie','builder','operator','founders_circle')),
  status              TEXT NOT NULL CHECK (status IN ('active','churned','refunded','banned')),
  affiliate_id        INTEGER,                              -- referrer affiliate, NULL if direct
  is_affiliate        INTEGER NOT NULL DEFAULT 0,           -- 1 if the member is also an affiliate
  current_rate_bps    INTEGER,                              -- basis points: 3000=30%, 3500=35%, etc. NULL for non-affiliates
  current_active_refs INTEGER NOT NULL DEFAULT 0,
  payment_method      TEXT,                                 -- 'stripe_connect' or 'wise'
  stripe_connect_id   TEXT,
  wise_recipient_id   TEXT,
  country_code        TEXT NOT NULL,                        -- ISO 3166-1 alpha-2
  state_code          TEXT,                                 -- US states only
  is_restricted_state INTEGER NOT NULL DEFAULT 0,           -- per Builders Marketplace Rules section 2
  founder_locked_rate INTEGER NOT NULL DEFAULT 0,           -- 1 if Founder $9 lifetime-locked
  created_at          TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at          TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
CREATE INDEX idx_members_whop_id ON members(whop_id);
CREATE INDEX idx_members_discord_id ON members(discord_id);
CREATE INDEX idx_members_affiliate_id ON members(affiliate_id);
CREATE INDEX idx_members_status ON members(status);

-- ----------------------------------------------------------------------------
-- transactions — APPEND-ONLY. Hash-chained for tamper evidence.
-- Every dollar in or out has a row here.
-- ----------------------------------------------------------------------------
CREATE TABLE transactions (
  txn_id              TEXT PRIMARY KEY,                     -- format: txn_YYYYMMDD_HHMMSS_<4hex>
  member_id           INTEGER,                              -- nullable: not all transactions tie to members (e.g. vendor)
  type                TEXT NOT NULL CHECK (type IN (
                          'subscription','sponsor','refund','chargeback','payout',
                          'commission','milestone_bonus','council_profit_share',
                          'lucky_sponsor_bonus','contest_prize','vendor_invoice',
                          'contractor_payment','marketplace_volume','adjustment'
                      )),
  amount_cents        INTEGER NOT NULL,                     -- can be negative (refunds, chargebacks)
  currency            TEXT NOT NULL DEFAULT 'USD',
  occurred_at         TEXT NOT NULL,                        -- when the event happened in the source system
  source              TEXT NOT NULL CHECK (source IN ('stripe','whop','wise','manual','adjustment')),
  source_id           TEXT,                                 -- the ID in the source system
  supporting_doc_url  TEXT,
  metadata            TEXT,                                 -- JSON; subscription_id, billing_period, affiliate_id, etc.
  hash                TEXT NOT NULL,                        -- SHA-256 of (txn_id|member_id|type|amount_cents|occurred_at|prev_hash)
  prev_hash           TEXT NOT NULL,                        -- chain link to previous row's hash (or '0'×64 for genesis)
  supersedes_txn_id   TEXT,                                 -- if this entry corrects an earlier one
  policy_version_id   INTEGER,                              -- which policy version applied at the time
  created_at          TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  created_by_agent    TEXT NOT NULL,
  FOREIGN KEY (member_id) REFERENCES members(member_id),
  FOREIGN KEY (policy_version_id) REFERENCES policy_versions(version_id)
);
CREATE INDEX idx_transactions_member_id ON transactions(member_id);
CREATE INDEX idx_transactions_occurred_at ON transactions(occurred_at);
CREATE INDEX idx_transactions_type ON transactions(type);
CREATE INDEX idx_transactions_source_id ON transactions(source_id);
CREATE UNIQUE INDEX uniq_transactions_source_source_id ON transactions(source, source_id) WHERE source_id IS NOT NULL;

-- Tamper evidence trigger: prevent UPDATE and DELETE on transactions.
CREATE TRIGGER no_update_transactions BEFORE UPDATE ON transactions
BEGIN
  SELECT RAISE(ABORT, 'transactions are append-only — write a superseding row');
END;
CREATE TRIGGER no_delete_transactions BEFORE DELETE ON transactions
BEGIN
  SELECT RAISE(ABORT, 'transactions are append-only — deletion forbidden');
END;

-- ----------------------------------------------------------------------------
-- commissions — accrued affiliate commission per qualifying member charge.
-- ----------------------------------------------------------------------------
CREATE TABLE commissions (
  commission_id       INTEGER PRIMARY KEY AUTOINCREMENT,
  affiliate_id        INTEGER NOT NULL,
  referred_member_id  INTEGER NOT NULL,
  base_charge_id      TEXT NOT NULL,                        -- the txn_id of the underlying subscription charge
  commission_cents    INTEGER NOT NULL,                     -- can be negative (reversal)
  rate_bps            INTEGER NOT NULL,                     -- basis points applied
  accrued_at          TEXT NOT NULL,
  paid_at             TEXT,                                 -- NULL until paid
  payout_id           TEXT,                                 -- the payouts row that included this commission
  status              TEXT NOT NULL CHECK (status IN (
                          'pending_chargeback_window','accrued','paid','reversed_due_to_refund',
                          'reversed_due_to_chargeback','rolled_forward','blocked_form_missing'
                      )),
  reversal_of_commission_id INTEGER,                        -- if this row reverses an earlier one
  policy_version_id   INTEGER NOT NULL,
  created_at          TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  FOREIGN KEY (affiliate_id) REFERENCES members(member_id),
  FOREIGN KEY (referred_member_id) REFERENCES members(member_id),
  FOREIGN KEY (base_charge_id) REFERENCES transactions(txn_id),
  FOREIGN KEY (payout_id) REFERENCES payouts(payout_id),
  FOREIGN KEY (policy_version_id) REFERENCES policy_versions(version_id)
);
CREATE INDEX idx_commissions_affiliate_id ON commissions(affiliate_id);
CREATE INDEX idx_commissions_status ON commissions(status);
CREATE INDEX idx_commissions_accrued_at ON commissions(accrued_at);

-- ----------------------------------------------------------------------------
-- milestone_events — vesting schedule for the 5/25/50/100 milestone bonuses.
-- ----------------------------------------------------------------------------
CREATE TABLE milestone_events (
  milestone_event_id  INTEGER PRIMARY KEY AUTOINCREMENT,
  affiliate_id        INTEGER NOT NULL,
  milestone           INTEGER NOT NULL CHECK (milestone IN (5,25,50,100)),
  reached_at          TEXT NOT NULL,
  total_bonus_cents   INTEGER NOT NULL,                     -- 5000/30000/100000/300000
  vesting_schedule    TEXT NOT NULL,                        -- JSON: array of {due_at, amount_cents}
  installments_paid   INTEGER NOT NULL DEFAULT 0,
  installments_total  INTEGER NOT NULL,                     -- 1/6/5/6 per affiliate doc
  status              TEXT NOT NULL CHECK (status IN ('active','paused_below_threshold','completed','revoked')),
  cohort_snapshot_url TEXT,                                 -- Box link to the cohort list at qualification
  created_at          TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  FOREIGN KEY (affiliate_id) REFERENCES members(member_id)
);
CREATE INDEX idx_milestone_events_affiliate_id ON milestone_events(affiliate_id);
CREATE INDEX idx_milestone_events_status ON milestone_events(status);

-- ----------------------------------------------------------------------------
-- payouts — every dollar going out, with full evidence.
-- ----------------------------------------------------------------------------
CREATE TABLE payouts (
  payout_id           TEXT PRIMARY KEY,                     -- format: pay_YYYYMMDD_<4hex>
  recipient_member_id INTEGER,                              -- nullable: vendor payouts have no member
  recipient_external  TEXT,                                 -- vendor/contractor name when no member
  amount_cents        INTEGER NOT NULL,
  currency            TEXT NOT NULL DEFAULT 'USD',
  type                TEXT NOT NULL CHECK (type IN (
                          'affiliate_commission','milestone_bonus','council_profit_share',
                          'lucky_sponsor_bonus','contest_prize','vendor_invoice',
                          'contractor_payment','refund','adjustment'
                      )),
  reason              TEXT NOT NULL,
  supporting_evidence_url TEXT NOT NULL,
  approved_by         TEXT,                                 -- F1_CFO, FOUNDER_JOSHUA, F3_PAYOUTS (only for routine <$100)
  approved_at         TEXT,
  status              TEXT NOT NULL CHECK (status IN (
                          'queued','blocked_form_missing','pending_chargeback_window',
                          'pending_approval','approved','executing','executed',
                          'failed','rolled_forward','paused_cohort_below_threshold','reversed'
                      )),
  executed_at         TEXT,
  executed_via        TEXT,                                 -- 'stripe_connect','wise','paypal','ach','manual'
  stripe_transfer_id  TEXT,
  wise_transfer_id    TEXT,
  metadata            TEXT,                                 -- JSON
  policy_version_id   INTEGER,
  created_at          TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  FOREIGN KEY (recipient_member_id) REFERENCES members(member_id),
  FOREIGN KEY (policy_version_id) REFERENCES policy_versions(version_id)
);
CREATE INDEX idx_payouts_recipient_member_id ON payouts(recipient_member_id);
CREATE INDEX idx_payouts_status ON payouts(status);
CREATE INDEX idx_payouts_executed_at ON payouts(executed_at);

-- Once a payout is 'executed', its core fields are locked.
CREATE TRIGGER no_modify_executed_payouts BEFORE UPDATE ON payouts
WHEN OLD.status = 'executed' AND (
  NEW.amount_cents != OLD.amount_cents
  OR NEW.recipient_member_id != OLD.recipient_member_id
  OR NEW.executed_at != OLD.executed_at
  OR NEW.stripe_transfer_id != OLD.stripe_transfer_id
)
BEGIN
  SELECT RAISE(ABORT, 'executed payouts are immutable — write an offsetting payout');
END;

-- ----------------------------------------------------------------------------
-- approvals — every approval decision, by whom, with reason.
-- ----------------------------------------------------------------------------
CREATE TABLE approvals (
  approval_id         INTEGER PRIMARY KEY AUTOINCREMENT,
  approver_id         TEXT NOT NULL,                        -- F1_CFO, FOUNDER_JOSHUA, F3_PAYOUTS
  action_type         TEXT NOT NULL CHECK (action_type IN (
                          'payout','refund','chargeback_response','contract','tax_filing',
                          'policy_change','vendor_onboarding','member_ban','adjustment'
                      )),
  target_id           TEXT NOT NULL,                        -- the payout_id, refund_id, etc.
  decision            TEXT NOT NULL CHECK (decision IN ('approved','denied','withdrawn')),
  reason              TEXT NOT NULL,
  evidence_url        TEXT,
  approved_at         TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  founder_dm_screenshot_url TEXT                            -- when approver_id=FOUNDER_*, evidence of the DM
);
CREATE INDEX idx_approvals_target_id ON approvals(target_id);
CREATE INDEX idx_approvals_approver_id ON approvals(approver_id);
CREATE INDEX idx_approvals_approved_at ON approvals(approved_at);

CREATE TRIGGER no_modify_approvals BEFORE UPDATE ON approvals
BEGIN
  SELECT RAISE(ABORT, 'approvals are append-only — withdrawal is a new row');
END;

-- ----------------------------------------------------------------------------
-- w9_forms — W-9 / W-8BEN custody and expiry tracking.
-- ----------------------------------------------------------------------------
CREATE TABLE w9_forms (
  w9_form_id          INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id           INTEGER NOT NULL,
  form_type           TEXT NOT NULL CHECK (form_type IN ('W9','W8BEN','W8BENE')),
  tally_submission_id TEXT NOT NULL,
  box_archive_url     TEXT NOT NULL,                        -- primary
  r2_backup_url       TEXT,                                 -- redundant
  collected_at        TEXT NOT NULL,
  expires_at          TEXT NOT NULL,                        -- collected_at + 3 years (W-8BEN) or per IRS guidance
  superseded_by_id    INTEGER,                              -- if a new form replaces this one
  status              TEXT NOT NULL CHECK (status IN ('active','expired','superseded')),
  FOREIGN KEY (member_id) REFERENCES members(member_id),
  FOREIGN KEY (superseded_by_id) REFERENCES w9_forms(w9_form_id)
);
CREATE INDEX idx_w9_forms_member_id ON w9_forms(member_id);
CREATE INDEX idx_w9_forms_expires_at ON w9_forms(expires_at);

-- ----------------------------------------------------------------------------
-- contracts — sponsor agreements, contractor agreements, vendor MSAs.
-- ----------------------------------------------------------------------------
CREATE TABLE contracts (
  contract_id         INTEGER PRIMARY KEY AUTOINCREMENT,
  counterparty        TEXT NOT NULL,
  counterparty_ein    TEXT,                                 -- for vendors / sponsors
  type                TEXT NOT NULL CHECK (type IN (
                          'sponsor_local','sponsor_theme','sponsor_title','sponsor_capstone',
                          'contractor_w9','contractor_w8ben','vendor_msa','nda','license','other'
                      )),
  amount_cents        INTEGER,                              -- contract value, NULL if recurring/variable
  signed_at           TEXT NOT NULL,
  effective_at        TEXT NOT NULL,
  expires_at          TEXT,
  box_url             TEXT NOT NULL,
  r2_backup_url       TEXT,
  terms_version       TEXT,
  amendment_of_id     INTEGER,                              -- if this is an amendment
  status              TEXT NOT NULL CHECK (status IN ('active','expired','terminated','amended')),
  founder_signed      INTEGER NOT NULL DEFAULT 0,
  counterparty_signed INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (amendment_of_id) REFERENCES contracts(contract_id)
);
CREATE INDEX idx_contracts_counterparty ON contracts(counterparty);
CREATE INDEX idx_contracts_type ON contracts(type);
CREATE INDEX idx_contracts_status ON contracts(status);

-- ----------------------------------------------------------------------------
-- tos_acceptance — every member's TOS acceptance event.
-- ----------------------------------------------------------------------------
CREATE TABLE tos_acceptance (
  tos_acceptance_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id           INTEGER NOT NULL,
  terms_version       TEXT NOT NULL,                        -- e.g. 'tos-v3.1'
  policy_version_id   INTEGER NOT NULL,
  accepted_at         TEXT NOT NULL,
  ip_address          TEXT NOT NULL,
  user_agent          TEXT NOT NULL,
  signature_method    TEXT NOT NULL CHECK (signature_method IN ('checkbox','clickwrap','tally','docusign')),
  FOREIGN KEY (member_id) REFERENCES members(member_id),
  FOREIGN KEY (policy_version_id) REFERENCES policy_versions(version_id)
);
CREATE INDEX idx_tos_acceptance_member_id ON tos_acceptance(member_id);
CREATE INDEX idx_tos_acceptance_terms_version ON tos_acceptance(terms_version);

-- ----------------------------------------------------------------------------
-- policy_versions — every version of every rule. Source of truth for "what was
-- the rate / the term / the rule on date X."
-- ----------------------------------------------------------------------------
CREATE TABLE policy_versions (
  version_id          INTEGER PRIMARY KEY AUTOINCREMENT,
  policy_type         TEXT NOT NULL CHECK (policy_type IN (
                          'affiliate_rates','affiliate_milestones','affiliate_anti_gaming',
                          'tos','privacy','contest_rules','prize_chart','council_bylaws',
                          'sponsor_pricing','tribe_council_profit_share','refund_policy'
                      )),
  version_label       TEXT NOT NULL,                        -- e.g. 'v2.0', 'v2.0.1'
  effective_at        TEXT NOT NULL,
  superseded_at       TEXT,                                 -- when the next version takes effect
  github_commit_sha   TEXT NOT NULL,
  archived_pdf_url    TEXT NOT NULL,
  diff_summary        TEXT,                                 -- human-readable change log
  signed_by           TEXT NOT NULL,                        -- always FOUNDER_JOSHUA for material changes
  signed_at           TEXT NOT NULL,
  UNIQUE (policy_type, version_label)
);
CREATE INDEX idx_policy_versions_policy_type ON policy_versions(policy_type);
CREATE INDEX idx_policy_versions_effective_at ON policy_versions(effective_at);

CREATE TRIGGER no_overlap_policy_versions BEFORE INSERT ON policy_versions
WHEN EXISTS (
  SELECT 1 FROM policy_versions
  WHERE policy_type = NEW.policy_type
    AND superseded_at IS NULL
    AND effective_at < NEW.effective_at
)
BEGIN
  -- This is enforced at app level; trigger is illustrative.
  -- App must SET superseded_at on the prior active row when inserting a new one.
  SELECT 1;
END;

-- ----------------------------------------------------------------------------
-- discord_role_events — every grant/revoke of a financial role.
-- ----------------------------------------------------------------------------
CREATE TABLE discord_role_events (
  role_event_id       INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id           INTEGER NOT NULL,
  role_name           TEXT NOT NULL,                        -- 'verified_affiliate','tribe_builder','tribe_council','guild_masthead','past_champion','hustle_of_the_month'
  action              TEXT NOT NULL CHECK (action IN ('granted','revoked','restored')),
  reason              TEXT NOT NULL,
  active_refs_at_event INTEGER,                             -- snapshot
  granted_by_agent    TEXT NOT NULL,
  occurred_at         TEXT NOT NULL,
  FOREIGN KEY (member_id) REFERENCES members(member_id)
);
CREATE INDEX idx_discord_role_events_member_id ON discord_role_events(member_id);
CREATE INDEX idx_discord_role_events_role_name ON discord_role_events(role_name);

-- ----------------------------------------------------------------------------
-- reconciliation_runs — every reconciliation pass, clean or drift.
-- ----------------------------------------------------------------------------
CREATE TABLE reconciliation_runs (
  run_id              TEXT PRIMARY KEY,                     -- format: recon_YYYYMMDD_HHMMSS
  ran_at              TEXT NOT NULL,
  period_start        TEXT NOT NULL,
  period_end          TEXT NOT NULL,
  stripe_total_cents  INTEGER NOT NULL,
  whop_total_cents    INTEGER NOT NULL,
  d1_total_cents      INTEGER NOT NULL,
  drift_cents         INTEGER NOT NULL,
  drift_pct           REAL NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('clean','drift_detected','hash_chain_break','failed')),
  alerts_fired        TEXT,                                 -- JSON array of alert details
  resolution_notes    TEXT,                                 -- founder writes this when drift is resolved
  resolved_at         TEXT,
  resolved_by         TEXT
);
CREATE INDEX idx_reconciliation_runs_ran_at ON reconciliation_runs(ran_at);
CREATE INDEX idx_reconciliation_runs_status ON reconciliation_runs(status);

-- ----------------------------------------------------------------------------
-- audit_log — every action by every agent. Append-only with hash chain.
-- ----------------------------------------------------------------------------
CREATE TABLE audit_log (
  entry_id            INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id            TEXT NOT NULL,                        -- F1_CFO, F2_REVENUE, etc., or FOUNDER_JOSHUA
  action              TEXT NOT NULL,
  target_table        TEXT,
  target_id           TEXT,
  before_state_hash   TEXT,
  after_state_hash    TEXT,
  metadata            TEXT,                                 -- JSON
  occurred_at         TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  entry_hash          TEXT NOT NULL,                        -- chain
  prev_entry_hash     TEXT NOT NULL
);
CREATE INDEX idx_audit_log_agent_id ON audit_log(agent_id);
CREATE INDEX idx_audit_log_occurred_at ON audit_log(occurred_at);
CREATE INDEX idx_audit_log_target_id ON audit_log(target_id);

CREATE TRIGGER no_update_audit_log BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER no_delete_audit_log BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

-- ----------------------------------------------------------------------------
-- month_close — locks each closed month.
-- ----------------------------------------------------------------------------
CREATE TABLE month_close (
  close_id            INTEGER PRIMARY KEY AUTOINCREMENT,
  closed_month        TEXT NOT NULL UNIQUE,                 -- 'YYYY-MM'
  closed_at           TEXT NOT NULL,
  txn_count           INTEGER NOT NULL,
  total_revenue_cents INTEGER NOT NULL,
  total_expense_cents INTEGER NOT NULL,
  close_hash          TEXT NOT NULL,                        -- SHA-256 of all transactions in the month
  closed_by_agent     TEXT NOT NULL,
  unlocked_at         TEXT,                                 -- if reopened (rare)
  unlocked_by         TEXT,
  unlock_reason       TEXT
);

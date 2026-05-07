-- MoneyMind web app schema. Idempotent — safe to run on every boot.

CREATE TABLE IF NOT EXISTS invite_codes (
  id              SERIAL PRIMARY KEY,
  code            TEXT NOT NULL UNIQUE,
  used_by_user_id INTEGER,
  used_at         TIMESTAMPTZ,
  revoked_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- For databases created before revoked_at existed.
ALTER TABLE invite_codes ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS users (
  id               SERIAL PRIMARY KEY,
  email            TEXT NOT NULL UNIQUE,
  password_hash    TEXT NOT NULL,
  invite_code_used TEXT NOT NULL REFERENCES invite_codes(code),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'invite_codes_used_by_user_id_fkey'
  ) THEN
    ALTER TABLE invite_codes
      ADD CONSTRAINT invite_codes_used_by_user_id_fkey
      FOREIGN KEY (used_by_user_id) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END$$;

-- Session table for connect-pg-simple. Matches its required schema exactly.
CREATE TABLE IF NOT EXISTS "session" (
  "sid"    VARCHAR NOT NULL COLLATE "default",
  "sess"   JSON    NOT NULL,
  "expire" TIMESTAMP(6) NOT NULL
) WITH (OIDS=FALSE);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'session_pkey'
  ) THEN
    ALTER TABLE "session" ADD CONSTRAINT "session_pkey"
      PRIMARY KEY ("sid") NOT DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");

-- Plaid Item: one per (user, financial institution) connection.
-- The encrypted access token is the only durable secret in this table.
CREATE TABLE IF NOT EXISTS plaid_items (
  id                     SERIAL PRIMARY KEY,
  user_id                INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  institution_name       TEXT,
  institution_id         TEXT,
  access_token_encrypted TEXT NOT NULL,
  item_id                TEXT NOT NULL UNIQUE,
  cursor                 TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_plaid_items_user_id ON plaid_items(user_id);

CREATE TABLE IF NOT EXISTS accounts (
  id                SERIAL PRIMARY KEY,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plaid_item_id     INTEGER NOT NULL REFERENCES plaid_items(id) ON DELETE CASCADE,
  plaid_account_id  TEXT NOT NULL,
  name              TEXT,
  official_name     TEXT,
  type              TEXT,
  subtype           TEXT,
  mask              TEXT,
  current_balance   NUMERIC(14,2),
  available_balance NUMERIC(14,2),
  iso_currency_code TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT accounts_user_account_unique UNIQUE (user_id, plaid_account_id)
);
CREATE INDEX IF NOT EXISTS idx_accounts_user_id ON accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_accounts_plaid_item_id ON accounts(plaid_item_id);

-- Transactions. The composite FK (user_id, plaid_account_id) into accounts
-- guarantees at the schema level that a transaction can never be attached
-- to an account belonging to a different user — even if application code
-- has a bug.
CREATE TABLE IF NOT EXISTS transactions (
  id                   SERIAL PRIMARY KEY,
  user_id              INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plaid_item_id        INTEGER NOT NULL REFERENCES plaid_items(id) ON DELETE CASCADE,
  plaid_account_id     TEXT NOT NULL,
  plaid_transaction_id TEXT NOT NULL,
  name                 TEXT,
  merchant_name        TEXT,
  amount               NUMERIC(14,2),
  iso_currency_code    TEXT,
  date                 DATE,
  authorized_date      DATE,
  category             TEXT[],
  category_id          TEXT,
  payment_channel      TEXT,
  pending              BOOLEAN,
  location             JSONB,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT transactions_user_txn_unique UNIQUE (user_id, plaid_transaction_id),
  CONSTRAINT transactions_account_fk
    FOREIGN KEY (user_id, plaid_account_id)
    REFERENCES accounts(user_id, plaid_account_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_transactions_user_date ON transactions(user_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_plaid_item_id ON transactions(plaid_item_id);

-- MoneyMind categories. 5 defaults seeded per user on registration.
-- The composite UNIQUE(user_id, id) lets `transactions.category_id` use
-- a (user_id, category_id) FK that guarantees a transaction can never
-- reference another user's category at the schema level.
CREATE TABLE IF NOT EXISTS categories (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  display_order INTEGER NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT categories_user_name_unique UNIQUE (user_id, name),
  CONSTRAINT categories_user_id_unique   UNIQUE (user_id, id)
);
CREATE INDEX IF NOT EXISTS idx_categories_user_id ON categories(user_id);

-- Transaction → category resolution.
-- The legacy `category_id` column was Plaid's text id (e.g. "12500000").
-- Rename it to `plaid_category_id` so we can re-use `category_id` for the
-- INTEGER FK to MoneyMind categories.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name='transactions'
       AND column_name='category_id'
       AND data_type='text'
  ) THEN
    ALTER TABLE transactions RENAME COLUMN category_id TO plaid_category_id;
  END IF;
END$$;

ALTER TABLE transactions ADD COLUMN IF NOT EXISTS category_id INTEGER;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS plaid_category_id TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS category_source TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS plaid_category_primary  TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS plaid_category_detailed TEXT;
-- Reserved column for future merchant-rules feature. Not yet wired up.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS merchant_rule_applied_id INTEGER;

-- CHECK on category_source enum (idempotent — drop+add).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transactions_category_source_check') THEN
    ALTER TABLE transactions
      ADD CONSTRAINT transactions_category_source_check
      CHECK (category_source IS NULL OR category_source IN ('plaid_mapped', 'user_override'));
  END IF;
END$$;

-- Composite FK: transactions.(user_id, category_id) → categories.(user_id, id).
-- Schema-level guarantee that a transaction cannot reference a category
-- belonging to a different user, even if buggy app code tries to.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transactions_category_user_fk') THEN
    ALTER TABLE transactions
      ADD CONSTRAINT transactions_category_user_fk
      FOREIGN KEY (user_id, category_id)
      REFERENCES categories(user_id, id) ON DELETE SET NULL;
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS idx_transactions_category_id ON transactions(category_id);

-- accounts already has UNIQUE(user_id, plaid_account_id). Add UNIQUE(user_id, id)
-- so other tables can FK on the composite (user_id, account_id) — same
-- multi-tenant pattern as transactions → categories.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'accounts_user_id_id_key') THEN
    ALTER TABLE accounts ADD CONSTRAINT accounts_user_id_id_key UNIQUE (user_id, id);
  END IF;
END$$;

-- ── Budget limits (one per user/category, money in INTEGER cents) ──────
CREATE TABLE IF NOT EXISTS budget_limits (
  id                  SERIAL PRIMARY KEY,
  user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category_id         INTEGER NOT NULL,
  monthly_limit_cents INTEGER NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT budget_limits_positive_check    CHECK (monthly_limit_cents > 0),
  CONSTRAINT budget_limits_user_cat_unique   UNIQUE (user_id, category_id),
  CONSTRAINT budget_limits_category_user_fk
    FOREIGN KEY (user_id, category_id) REFERENCES categories(user_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_budget_limits_user_id ON budget_limits(user_id);

-- ── Low-balance thresholds (one per user/account, INTEGER cents) ──────
CREATE TABLE IF NOT EXISTS low_balance_thresholds (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id      INTEGER NOT NULL,
  threshold_cents INTEGER NOT NULL,
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT low_balance_nonneg_check       CHECK (threshold_cents >= 0),
  CONSTRAINT low_balance_user_account_unique UNIQUE (user_id, account_id),
  CONSTRAINT low_balance_account_user_fk
    FOREIGN KEY (user_id, account_id) REFERENCES accounts(user_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_low_balance_user_id ON low_balance_thresholds(user_id);

-- ── Recurring charges (subscription audit) ─────────────────────────────
-- One canonical row per (user, merchant_key). is_user_dismissed is set
-- when the user marks "not recurring", and detection sync then leaves
-- this row strictly alone — schema doesn't enforce that, the persistence
-- layer does. UNIQUE(user_id, id) lets recurring_charge_actions FK
-- composite, mirroring the per-user-isolation pattern used everywhere.
CREATE TABLE IF NOT EXISTS recurring_charges (
  id                    SERIAL PRIMARY KEY,
  user_id               INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  merchant_key          TEXT    NOT NULL,
  display_name          TEXT    NOT NULL,
  category_id           INTEGER,
  cadence               TEXT    NOT NULL,
  median_amount_cents   INTEGER NOT NULL,
  last_amount_cents     INTEGER NOT NULL,
  last_charged_date     DATE,
  next_expected_date    DATE,
  occurrence_count      INTEGER NOT NULL,
  confidence_score      INTEGER NOT NULL,
  status                TEXT    NOT NULL,
  price_change_detected BOOLEAN NOT NULL DEFAULT FALSE,
  is_user_dismissed     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT recurring_charges_cadence_check
    CHECK (cadence IN ('weekly','biweekly','monthly','quarterly','annual')),
  CONSTRAINT recurring_charges_status_check
    CHECK (status IN ('active','ended','user_dismissed')),
  CONSTRAINT recurring_charges_user_merchant_unique UNIQUE (user_id, merchant_key),
  CONSTRAINT recurring_charges_user_id_unique       UNIQUE (user_id, id),
  CONSTRAINT recurring_charges_category_user_fk
    FOREIGN KEY (user_id, category_id) REFERENCES categories(user_id, id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_recurring_charges_user_id ON recurring_charges(user_id);

CREATE TABLE IF NOT EXISTS recurring_charge_actions (
  id                  SERIAL PRIMARY KEY,
  user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recurring_charge_id INTEGER NOT NULL,
  action              TEXT    NOT NULL,
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT recurring_charge_actions_action_check
    CHECK (action IN ('not_recurring','cancelled','reminder_set')),
  CONSTRAINT recurring_charge_actions_user_charge_fk
    FOREIGN KEY (user_id, recurring_charge_id)
    REFERENCES recurring_charges(user_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_recurring_charge_actions_user_id ON recurring_charge_actions(user_id);
CREATE INDEX IF NOT EXISTS idx_recurring_charge_actions_charge_id ON recurring_charge_actions(recurring_charge_id);

-- ── Net-worth additions: account classification overrides ─────────────
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS is_asset_override     BOOLEAN;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS excluded_from_net_worth BOOLEAN NOT NULL DEFAULT FALSE;

-- ── balance_snapshots — one row per (user, account, day) ──────────────
-- Composite FK on (user_id, account_id) — the same multi-tenant safety
-- pattern used elsewhere. Latest write wins for same-day re-syncs.
CREATE TABLE IF NOT EXISTS balance_snapshots (
  id                       SERIAL PRIMARY KEY,
  user_id                  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id               INTEGER NOT NULL,
  snapshot_date            DATE    NOT NULL,
  balance_cents            INTEGER,
  available_balance_cents  INTEGER,
  iso_currency_code        TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT balance_snapshots_user_acct_date_unique
    UNIQUE (user_id, account_id, snapshot_date),
  CONSTRAINT balance_snapshots_account_user_fk
    FOREIGN KEY (user_id, account_id) REFERENCES accounts(user_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_balance_snapshots_user_id ON balance_snapshots(user_id);
CREATE INDEX IF NOT EXISTS idx_balance_snapshots_user_date ON balance_snapshots(user_id, snapshot_date DESC);

-- ── user_settings — one row per user ──────────────────────────────────
CREATE TABLE IF NOT EXISTS user_settings (
  id                      SERIAL PRIMARY KEY,
  user_id                 INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  savings_rate_target_pct INTEGER NOT NULL DEFAULT 20,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT user_settings_user_unique UNIQUE (user_id),
  CONSTRAINT user_settings_target_pct_check CHECK (savings_rate_target_pct BETWEEN 0 AND 100)
);
CREATE INDEX IF NOT EXISTS idx_user_settings_user_id ON user_settings(user_id);

-- Track when the user last opened /findings, for the "X new since last visit" badge.
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS last_findings_view_at TIMESTAMPTZ;

-- ── findings — synthesized signals shown in the Findings Feed ─────────
-- UNIQUE NULLS NOT DISTINCT (Postgres 15+) makes the constraint treat
-- NULL related_entity_* and NULL occurred_at fields as equal — so a
-- finding like "savings_rate_dropped this month" with no entity id can
-- still be deduplicated by re-runs.
CREATE TABLE IF NOT EXISTS findings (
  id                    SERIAL PRIMARY KEY,
  user_id               INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  finding_type          TEXT    NOT NULL,
  tier                  TEXT    NOT NULL,
  title                 TEXT    NOT NULL,
  body                  TEXT    NOT NULL,
  related_entity_type   TEXT,
  related_entity_id     INTEGER,
  deep_link_path        TEXT,
  money_at_stake_cents  INTEGER,
  occurred_at           TIMESTAMPTZ NOT NULL,
  is_dismissed          BOOLEAN NOT NULL DEFAULT FALSE,
  dismissed_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT findings_tier_check
    CHECK (tier IN ('critical', 'important', 'tip', 'positive')),
  CONSTRAINT findings_unique_event
    UNIQUE NULLS NOT DISTINCT (user_id, finding_type, related_entity_type, related_entity_id, occurred_at)
);
CREATE INDEX IF NOT EXISTS idx_findings_primary
  ON findings(user_id, is_dismissed, tier, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_findings_user_id ON findings(user_id);

-- ── Email verification + password reset (Phase 4A) ────────────────────
-- Tokens are stored as SHA-256 hashes only — the plaintext token leaves
-- the server exactly once (in the email URL) and is never logged.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at         TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verification_attempts INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT    NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip_address  INET
);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user_id ON password_reset_tokens(user_id);
-- Active-token lookups during rate-limit checks query (user, expires, used)
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user_active
  ON password_reset_tokens(user_id, expires_at) WHERE used_at IS NULL;

CREATE TABLE IF NOT EXISTS email_verification_tokens (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT    NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_email_verification_tokens_user_id ON email_verification_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_email_verification_tokens_user_active
  ON email_verification_tokens(user_id, expires_at) WHERE used_at IS NULL;

-- ── Login rate limiting + security alerts (Phase 4B) ──────────────────
-- failed_login_attempts: one row per failed POST /login. NO password
-- column ever — we never store what was attempted, only that an attempt
-- failed. Two indexes: per-IP for the 15-min throttle, per-email for the
-- 1-hour account-wide alert signal.
--
-- Counts both wrong-password AND non-existent-email attempts (the route
-- always inserts on failure regardless of which case it was — preserves
-- the timing-safe semantics already in place via DUMMY_HASH).
CREATE TABLE IF NOT EXISTS failed_login_attempts (
  id              SERIAL PRIMARY KEY,
  ip_address      INET NOT NULL,
  email_attempted TEXT NOT NULL,
  attempted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_failed_login_attempts_ip_time
  ON failed_login_attempts(ip_address, attempted_at DESC);
CREATE INDEX IF NOT EXISTS idx_failed_login_attempts_email_time
  ON failed_login_attempts(email_attempted, attempted_at DESC);

-- security_alerts_sent: rate-limits the security-alert email to at most
-- one per (user, alert_type) per hour. Insert-then-check: route reads
-- "any sent in the last hour for this user+type?" before sending.
CREATE TABLE IF NOT EXISTS security_alerts_sent (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  alert_type TEXT    NOT NULL,
  sent_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT security_alerts_sent_alert_type_check
    CHECK (alert_type IN ('failed_login_burst'))
);
CREATE INDEX IF NOT EXISTS idx_security_alerts_sent_user_type_time
  ON security_alerts_sent(user_id, alert_type, sent_at DESC);

-- Persists the user's last "Remember me" choice, so the login form can
-- pre-check the box on their next visit. Stored as a non-sensitive
-- mm_remember_pref cookie too, but the column is the source of truth.
ALTER TABLE users ADD COLUMN IF NOT EXISTS remember_me_default BOOLEAN NOT NULL DEFAULT FALSE;

-- Privacy policy agreement timestamp. Set at signup time when the user
-- ticks the agreement checkbox in the registration form. Nullable so
-- existing users (created before the policy was published) don't get
-- forcibly back-stamped — they'll be prompted to re-agree if/when we
-- decide to gate features behind it.
ALTER TABLE users ADD COLUMN IF NOT EXISTS privacy_policy_agreed_at TIMESTAMPTZ;

-- ── Account deletion (soft-delete with 30-day window) ────────────────
-- is_deleted flips to TRUE the moment the user confirms account deletion.
-- Login + forgot-password treat is_deleted=TRUE as "account does not
-- exist" (generic anti-enumeration response). After 30 days the
-- scheduled hard-delete script removes the row, FK CASCADE wipes
-- every user-scoped table (transactions, accounts, findings, etc.).
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- deletion_log: persists past hard-delete so we keep an auditable record
-- that an account once existed and was deleted. Survives the cascade
-- because there's no FK to users(id) here.
--
-- TODO (GDPR-readiness): if/when MoneyMind adds EU users, consider
-- storing email_hash (sha256 hex) instead of plaintext email here, so
-- right-to-erasure requests can be honored without losing the audit
-- record entirely. For US/beta scope we keep plaintext per spec.
CREATE TABLE IF NOT EXISTS deletion_log (
  id          SERIAL PRIMARY KEY,
  email       TEXT,
  deleted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reason      TEXT
);
CREATE INDEX IF NOT EXISTS idx_deletion_log_deleted_at ON deletion_log(deleted_at DESC);
CREATE INDEX IF NOT EXISTS idx_deletion_log_email      ON deletion_log(email);

-- Optimizes the hard-delete cron's WHERE clause: pull soft-deleted
-- users whose 30-day window has elapsed.
CREATE INDEX IF NOT EXISTS idx_users_soft_deleted ON users(deleted_at)
  WHERE is_deleted = TRUE;

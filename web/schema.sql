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

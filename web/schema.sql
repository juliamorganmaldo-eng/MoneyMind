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

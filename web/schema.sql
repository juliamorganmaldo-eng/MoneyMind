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

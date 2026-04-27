CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name          TEXT,
  phone         TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS connected_accounts (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
  institution  TEXT NOT NULL,
  access_token TEXT NOT NULL,
  item_id      TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS findings (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,
  title       TEXT NOT NULL,
  description TEXT,
  data_json   JSONB,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS action_drafts (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
  type          TEXT NOT NULL,
  merchant      TEXT NOT NULL,
  content       TEXT,
  status        TEXT DEFAULT 'draft',
  metadata_json JSONB,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS goals (
  id               SERIAL PRIMARY KEY,
  user_id          INTEGER REFERENCES users(id) ON DELETE CASCADE,
  goal_type        TEXT NOT NULL CHECK (goal_type IN ('retirement','house_deposit','emergency_fund','education','other')),
  name             TEXT,
  target_amount    NUMERIC NOT NULL,
  current_progress NUMERIC NOT NULL DEFAULT 0,
  target_date      DATE NOT NULL,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_goals_user ON goals(user_id);

CREATE TABLE IF NOT EXISTS savings_ledger (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER REFERENCES users(id) ON DELETE CASCADE,
  action_id       INTEGER REFERENCES action_drafts(id) ON DELETE SET NULL,
  merchant        TEXT NOT NULL,
  finding_type    TEXT NOT NULL,
  savings_type    TEXT NOT NULL CHECK (savings_type IN ('one_time','recurring_monthly')),
  amount          NUMERIC NOT NULL,
  outcome_note    TEXT,
  confirmed_date  DATE NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_savings_user ON savings_ledger(user_id);

CREATE TABLE IF NOT EXISTS session (
  sid    TEXT PRIMARY KEY,
  sess   JSONB NOT NULL,
  expire TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_expire ON session(expire);

const { DatabaseSync: Database } = require('node:sqlite');
const path = require('path');

const db = new Database(path.join(__dirname, 'moneymind.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS transactions (
    id          TEXT PRIMARY KEY,
    account     TEXT NOT NULL,
    date        TEXT NOT NULL,
    merchant    TEXT,
    amount      REAL NOT NULL,
    category    TEXT,
    raw_json    TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_transactions_account  ON transactions(account);
  CREATE INDEX IF NOT EXISTS idx_transactions_merchant ON transactions(merchant);
  CREATE INDEX IF NOT EXISTS idx_transactions_date     ON transactions(date);

  CREATE TABLE IF NOT EXISTS findings (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    type        TEXT NOT NULL,
    title       TEXT NOT NULL,
    description TEXT,
    data_json   TEXT,
    created_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_findings_type ON findings(type);

  CREATE TABLE IF NOT EXISTS savings_ledger (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id        INTEGER NOT NULL,
    merchant       TEXT NOT NULL,
    finding_type   TEXT NOT NULL,
    savings_type   TEXT NOT NULL CHECK (savings_type IN ('one_time', 'recurring_monthly')),
    amount         REAL NOT NULL,
    confirmed_date TEXT NOT NULL,
    note           TEXT,
    created_at     TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_savings_user ON savings_ledger(user_id);
  CREATE INDEX IF NOT EXISTS idx_savings_type ON savings_ledger(savings_type);
`);

module.exports = db;

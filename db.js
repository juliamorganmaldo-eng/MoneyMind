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
`);

module.exports = db;

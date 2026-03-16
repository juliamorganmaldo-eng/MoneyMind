const { DatabaseSync: Database } = require('node:sqlite');
const path = require('path');

const dbPath = path.join(__dirname, 'moneymind-web.db');
const db = new Database(dbPath);

// Enable WAL mode for better concurrency
db.exec('PRAGMA journal_mode=WAL');

// Create tables (SQLite syntax matching the PostgreSQL schema)
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name          TEXT,
    phone         TEXT,
    created_at    TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS connected_accounts (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
    institution  TEXT NOT NULL,
    access_token TEXT NOT NULL,
    item_id      TEXT,
    created_at   TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS findings (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
    type        TEXT NOT NULL,
    title       TEXT NOT NULL,
    description TEXT,
    data_json   TEXT,
    created_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS action_drafts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
    type          TEXT NOT NULL,
    merchant      TEXT NOT NULL,
    content       TEXT,
    status        TEXT DEFAULT 'draft',
    metadata_json TEXT,
    created_at    TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS session (
    sid    TEXT PRIMARY KEY,
    sess   TEXT NOT NULL,
    expire TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_session_expire ON session(expire);
`);

// pg-compatible query wrapper: accepts (sql, params) and returns { rows, rowCount }
const pool = {
  query(sql, params = []) {
    // Convert PostgreSQL-style $1, $2 placeholders to SQLite ?
    let idx = 0;
    const sqliteSQL = sql.replace(/\$\d+/g, () => '?');

    const trimmed = sqliteSQL.trimStart().toUpperCase();

    if (trimmed.startsWith('SELECT') || trimmed.startsWith('WITH')) {
      const stmt = db.prepare(sqliteSQL);
      const rows = stmt.all(...params);
      return Promise.resolve({ rows, rowCount: rows.length });
    }

    if (trimmed.startsWith('INSERT') && sqliteSQL.toUpperCase().includes('RETURNING')) {
      // Handle INSERT ... RETURNING by splitting at RETURNING
      const retIdx = sqliteSQL.toUpperCase().lastIndexOf('RETURNING');
      const insertSQL = sqliteSQL.slice(0, retIdx).trim();
      const retCols = sqliteSQL.slice(retIdx + 9).trim(); // columns after RETURNING

      const stmt = db.prepare(insertSQL);
      const info = stmt.run(...params);
      const lastId = info.lastInsertRowid;

      // Fetch the inserted row
      const table = extractTable(insertSQL);
      const row = db.prepare(`SELECT ${retCols} FROM ${table} WHERE rowid = ?`).get(lastId);
      return Promise.resolve({ rows: row ? [row] : [], rowCount: 1 });
    }

    if (trimmed.startsWith('UPDATE') && sqliteSQL.toUpperCase().includes('RETURNING')) {
      const retIdx = sqliteSQL.toUpperCase().lastIndexOf('RETURNING');
      const updateSQL = sqliteSQL.slice(0, retIdx).trim();
      const retCols = sqliteSQL.slice(retIdx + 9).trim();

      const stmt = db.prepare(updateSQL);
      const info = stmt.run(...params);

      const table = extractTable(updateSQL);
      // Use the WHERE clause from the original to fetch the updated row
      const whereIdx = updateSQL.toUpperCase().indexOf('WHERE');
      if (whereIdx !== -1) {
        const whereClause = updateSQL.slice(whereIdx);
        // Re-use only the WHERE params (after SET params)
        const setParamCount = (updateSQL.slice(0, whereIdx).match(/\?/g) || []).length;
        const whereParams = params.slice(setParamCount);
        const row = db.prepare(`SELECT ${retCols} FROM ${table} ${whereClause}`).get(...whereParams);
        return Promise.resolve({ rows: row ? [row] : [], rowCount: info.changes });
      }
      return Promise.resolve({ rows: [], rowCount: info.changes });
    }

    if (trimmed.startsWith('DELETE') && sqliteSQL.toUpperCase().includes('RETURNING')) {
      const retIdx = sqliteSQL.toUpperCase().lastIndexOf('RETURNING');
      const deleteSQL = sqliteSQL.slice(0, retIdx).trim();
      const stmt = db.prepare(deleteSQL);
      const info = stmt.run(...params);
      return Promise.resolve({ rows: [], rowCount: info.changes });
    }

    // Plain INSERT, UPDATE, DELETE without RETURNING
    const stmt = db.prepare(sqliteSQL);
    const info = stmt.run(...params);
    return Promise.resolve({ rows: [], rowCount: info.changes });
  },
};

function extractTable(sql) {
  // Extract table name from INSERT INTO table or UPDATE table or DELETE FROM table
  const insertMatch = sql.match(/INSERT\s+INTO\s+(\w+)/i);
  if (insertMatch) return insertMatch[1];
  const updateMatch = sql.match(/UPDATE\s+(\w+)/i);
  if (updateMatch) return updateMatch[1];
  const deleteMatch = sql.match(/DELETE\s+FROM\s+(\w+)/i);
  if (deleteMatch) return deleteMatch[1];
  return 'unknown';
}

module.exports = { pool };

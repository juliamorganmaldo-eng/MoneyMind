const { DatabaseSync: Database } = require('node:sqlite');
const path = require('path');

module.exports = function (session) {
  const Store = session.Store;

  class SqliteStore extends Store {
    constructor(options = {}) {
      super(options);
      this.db = new Database(path.join(__dirname, 'moneymind-web.db'));
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS session (
          sid TEXT PRIMARY KEY,
          sess TEXT NOT NULL,
          expire TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_session_expire ON session(expire);
      `);

      // Prune expired sessions every 15 minutes
      this._prune = setInterval(() => {
        try {
          this.db.prepare("DELETE FROM session WHERE expire < datetime('now')").run();
        } catch (_) {}
      }, 15 * 60 * 1000);
      if (this._prune.unref) this._prune.unref();
    }

    get(sid, callback) {
      try {
        const row = this.db.prepare('SELECT sess FROM session WHERE sid = ? AND expire > datetime(\'now\')').get(sid);
        if (!row) return callback(null, null);
        callback(null, JSON.parse(row.sess));
      } catch (err) {
        callback(err);
      }
    }

    set(sid, sess, callback) {
      try {
        const maxAge = sess.cookie && sess.cookie.maxAge ? sess.cookie.maxAge : 86400000;
        const expireMs = Date.now() + maxAge;
        const expire = new Date(expireMs).toISOString();
        const sessStr = JSON.stringify(sess);
        this.db.prepare(
          'INSERT OR REPLACE INTO session (sid, sess, expire) VALUES (?, ?, ?)'
        ).run(sid, sessStr, expire);
        callback(null);
      } catch (err) {
        callback(err);
      }
    }

    destroy(sid, callback) {
      try {
        this.db.prepare('DELETE FROM session WHERE sid = ?').run(sid);
        if (callback) callback(null);
      } catch (err) {
        if (callback) callback(err);
      }
    }

    touch(sid, sess, callback) {
      try {
        const maxAge = sess.cookie && sess.cookie.maxAge ? sess.cookie.maxAge : 86400000;
        const expire = new Date(Date.now() + maxAge).toISOString();
        this.db.prepare('UPDATE session SET expire = ? WHERE sid = ?').run(expire, sid);
        if (callback) callback(null);
      } catch (err) {
        if (callback) callback(err);
      }
    }
  }

  return SqliteStore;
};

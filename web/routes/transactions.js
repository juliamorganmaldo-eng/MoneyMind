const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { syncTransactionsForUser } = require('../lib/transactions-sync');

const router = express.Router();

router.use(express.json({ limit: '32kb' }));
router.use(requireAuth);

function clampInt(v, def, min, max) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

// Returns { startInclusive, endExclusive } as YYYY-MM-DD strings, or null
// if the input is not a valid YYYY-MM. We deliberately reject anything
// that isn't strictly two fields of digits — never trust format we
// haven't validated, even though the values reach SQL via parameters.
function parseMonth(v) {
  if (typeof v !== 'string') return null;
  const m = /^(\d{4})-(\d{2})$/.exec(v);
  if (!m) return null;
  const year = Number.parseInt(m[1], 10);
  const month = Number.parseInt(m[2], 10);
  if (year < 2000 || year > 2100 || month < 1 || month > 12) return null;
  const start = `${m[1]}-${m[2]}-01`;
  const ny = month === 12 ? year + 1 : year;
  const nm = month === 12 ? 1 : month + 1;
  const end = `${ny}-${String(nm).padStart(2, '0')}-01`;
  return { start, end };
}

router.post('/api/transactions/sync', async (req, res) => {
  try {
    const totals = await syncTransactionsForUser(req.session.userId);
    // Counts only — no transaction payload here. The browser fetches data
    // through GET /api/transactions, which is the curated, scoped query.
    res.json({
      added_count: totals.added_count,
      modified_count: totals.modified_count,
      removed_count: totals.removed_count,
    });
  } catch (err) {
    console.error('[txn-sync] failed:', err.message);
    res.status(502).json({ error: 'Transaction sync failed.' });
  }
});

router.get('/api/transactions', async (req, res) => {
  const userId = req.session.userId;
  const perPage = clampInt(req.query.per_page, 50, 1, 200);
  const page = clampInt(req.query.page, 1, 1, 10000);
  const month = parseMonth(req.query.month); // null if absent or malformed
  const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
  const accountId = typeof req.query.account_id === 'string' ? req.query.account_id.trim() : '';

  // Build WHERE incrementally. user_id is ALWAYS the first filter, before
  // anything from req.query. Even if the client sends an account_id that
  // belongs to a different user, the user_id filter forces the row count
  // to zero — the wrong-user account simply won't match anything.
  const where = ['user_id = $1'];
  const params = [userId];

  if (month) {
    where.push(`date >= $${params.length + 1} AND date < $${params.length + 2}`);
    params.push(month.start, month.end);
  }
  if (search) {
    // ILIKE is case-insensitive partial match. We escape the user input
    // to make %/_ literal — they would otherwise act as wildcards.
    const escaped = search.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    where.push(`(name ILIKE $${params.length + 1} OR merchant_name ILIKE $${params.length + 1})`);
    params.push('%' + escaped + '%');
  }
  if (accountId) {
    where.push(`plaid_account_id = $${params.length + 1}`);
    params.push(accountId);
  }
  const whereSql = where.join(' AND ');

  try {
    // Count for pagination metadata (uses the same WHERE).
    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*)::int AS total FROM transactions WHERE ${whereSql}`,
      params
    );
    const total = countRows[0].total;

    const offset = (page - 1) * perPage;
    const { rows } = await pool.query(
      `SELECT id, plaid_account_id, name, merchant_name, amount,
              iso_currency_code, date, pending, category
         FROM transactions
        WHERE ${whereSql}
        ORDER BY date DESC, id DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, perPage, offset]
    );

    res.json({
      transactions: rows,
      total_count: total,
      page,
      per_page: perPage,
    });
  } catch (err) {
    console.error('[txn-list] failed:', err.message);
    res.status(500).json({ error: 'Could not load transactions.' });
  }
});

module.exports = router;

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
  // (Columns are prefixed with `t.` so the same WHERE works for both the
  // count query and the LEFT JOIN list query below.)
  const where = ['t.user_id = $1'];
  const params = [userId];

  if (month) {
    where.push(`t.date >= $${params.length + 1} AND t.date < $${params.length + 2}`);
    params.push(month.start, month.end);
  }
  if (search) {
    // ILIKE is case-insensitive partial match. We escape the user input
    // to make %/_ literal — they would otherwise act as wildcards.
    const escaped = search.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    where.push(`(t.name ILIKE $${params.length + 1} OR t.merchant_name ILIKE $${params.length + 1})`);
    params.push('%' + escaped + '%');
  }
  if (accountId) {
    where.push(`t.plaid_account_id = $${params.length + 1}`);
    params.push(accountId);
  }
  const whereSql = where.join(' AND ');

  try {
    // Count for pagination metadata (uses the same WHERE).
    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*)::int AS total FROM transactions t WHERE ${whereSql}`,
      params
    );
    const total = countRows[0].total;

    const offset = (page - 1) * perPage;
    // The LEFT JOIN to categories also enforces (user_id) — defense in depth.
    // The composite FK already guarantees this, but the redundant filter
    // means a future schema drift can't quietly leak names.
    const { rows } = await pool.query(
      `SELECT t.id, t.plaid_account_id, t.name, t.merchant_name, t.amount,
              t.iso_currency_code, t.date, t.pending, t.category,
              t.category_id, t.category_source,
              t.plaid_category_primary, t.plaid_category_detailed,
              c.name AS category_name
         FROM transactions t
         LEFT JOIN categories c
           ON c.id = t.category_id AND c.user_id = t.user_id
        WHERE ${whereSql}
        ORDER BY t.date DESC, t.id DESC
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

// Reassign a transaction to a different MoneyMind category. Optionally
// applies the same change to ALL transactions from the same merchant.
//
// Defenses:
//   1. The category must belong to the session user (otherwise 404).
//   2. The transaction must belong to the session user (otherwise 404).
//   3. Even apply_to_all_from_merchant updates by merchant_name are scoped
//      WHERE user_id = $session — never touches another user's rows.
//   4. The schema's composite FK (user_id, category_id) → categories
//      makes a cross-user assignment fail at the DB layer too.
router.patch('/api/transactions/:id/category', async (req, res) => {
  const userId = req.session.userId;
  const txnId = Number.parseInt(req.params.id, 10);
  const categoryId = Number.parseInt(req.body && req.body.category_id, 10);
  const applyToAll = !!(req.body && req.body.apply_to_all_from_merchant);

  if (!Number.isFinite(txnId) || !Number.isFinite(categoryId)) {
    return res.status(400).json({ error: 'invalid id' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Category ownership
    const { rows: cat } = await client.query(
      'SELECT id FROM categories WHERE id = $1 AND user_id = $2',
      [categoryId, userId]
    );
    if (cat.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Category not found.' });
    }

    // 2. Transaction ownership (and grab merchant_name for apply_to_all)
    const { rows: txn } = await client.query(
      'SELECT id, merchant_name FROM transactions WHERE id = $1 AND user_id = $2',
      [txnId, userId]
    );
    if (txn.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Transaction not found.' });
    }

    // 3. Apply
    let updatedCount;
    if (applyToAll && txn[0].merchant_name) {
      const r = await client.query(
        `UPDATE transactions
            SET category_id = $1,
                category_source = 'user_override',
                updated_at = NOW()
          WHERE user_id = $2 AND merchant_name = $3`,
        [categoryId, userId, txn[0].merchant_name]
      );
      updatedCount = r.rowCount;
    } else {
      const r = await client.query(
        `UPDATE transactions
            SET category_id = $1,
                category_source = 'user_override',
                updated_at = NOW()
          WHERE id = $2 AND user_id = $3`,
        [categoryId, txnId, userId]
      );
      updatedCount = r.rowCount;
    }

    await client.query('COMMIT');
    res.json({ ok: true, updated_count: updatedCount });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[txn-category] failed:', err.message);
    res.status(500).json({ error: 'Update failed.' });
  } finally {
    client.release();
  }
});

module.exports = router;

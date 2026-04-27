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
  const limit = clampInt(req.query.limit, 50, 1, 200);
  const offset = clampInt(req.query.offset, 0, 0, 100000);

  try {
    // CRITICAL: every read of `transactions` filters by user_id.
    // The selected columns are the curated display set — we don't ship the
    // raw Plaid payload (no `location`, no `category_id`, no `plaid_item_id`).
    const { rows } = await pool.query(
      `SELECT id,
              plaid_account_id,
              name,
              merchant_name,
              amount,
              iso_currency_code,
              date,
              pending,
              category
         FROM transactions
        WHERE user_id = $1
        ORDER BY date DESC, id DESC
        LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    );

    res.json({ transactions: rows, limit, offset });
  } catch (err) {
    console.error('[txn-list] failed:', err.message);
    res.status(500).json({ error: 'Could not load transactions.' });
  }
});

module.exports = router;

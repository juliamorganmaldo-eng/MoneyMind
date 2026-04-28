const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(express.json({ limit: '32kb' }));
router.use(requireAuth);

// "Money is integer cents." We never accept floats from the client.
// Number.isInteger rejects floats, NaN, +Infinity, strings, null,
// objects — everything except a finite integer. That is exactly what
// we want at this boundary.
function asPositiveIntCents(v) {
  return Number.isInteger(v) && v > 0 ? v : null;
}
function asNonNegIntCentsOrNull(v) {
  if (v === null || v === undefined) return 'null';
  return Number.isInteger(v) && v >= 0 ? v : 'invalid';
}

function statusFor(spendCents, limitCents) {
  if (limitCents == null) return null;
  const pct = (spendCents / limitCents) * 100;
  if (pct < 80)   return 'ok';
  if (pct <= 100) return 'warning';
  return 'over';
}

router.get('/api/budget-limits', async (req, res) => {
  const userId = req.session.userId;
  try {
    // For each of the user's 5 categories: optional limit + current-month
    // spend (sum of POSITIVE amounts only — outflows). Multiplying NUMERIC
    // by 100 keeps full precision; ROUND + cast to int yields exact cents.
    const { rows } = await pool.query(
      `SELECT c.id   AS category_id,
              c.name AS category_name,
              c.display_order,
              bl.monthly_limit_cents,
              COALESCE(ROUND((SUM(CASE WHEN t.amount > 0 THEN t.amount ELSE 0 END)) * 100), 0)::int
                AS current_spend_cents,
              COUNT(t.id) FILTER (WHERE t.amount > 0)::int AS transaction_count
         FROM categories c
         LEFT JOIN budget_limits bl
           ON bl.user_id = c.user_id AND bl.category_id = c.id
         LEFT JOIN transactions t
           ON t.user_id = c.user_id AND t.category_id = c.id
          AND t.date >= date_trunc('month', CURRENT_DATE)
          AND t.date <  (date_trunc('month', CURRENT_DATE) + INTERVAL '1 month')
        WHERE c.user_id = $1
        GROUP BY c.id, c.name, c.display_order, bl.monthly_limit_cents
        ORDER BY c.display_order`,
      [userId]
    );

    const out = rows.map((r) => {
      const limit = r.monthly_limit_cents;
      const spend = r.current_spend_cents;
      const pct = (limit && limit > 0) ? Math.round((spend / limit) * 1000) / 10 : null;
      return {
        category_id: r.category_id,
        category_name: r.category_name,
        monthly_limit_cents: limit,
        current_spend_cents: spend,
        transaction_count: r.transaction_count,
        pct_used: pct,
        status: statusFor(spend, limit),
      };
    });
    res.json({ budget_limits: out });
  } catch (err) {
    console.error('[budgets] list failed:', err.message);
    res.status(500).json({ error: 'Could not load budget limits.' });
  }
});

router.put('/api/budget-limits/:category_id', async (req, res) => {
  const userId = req.session.userId;
  const categoryId = Number.parseInt(req.params.category_id, 10);
  if (!Number.isFinite(categoryId)) {
    return res.status(400).json({ error: 'invalid category_id' });
  }

  // Body validation — strictly integer cents. 300.5, '300', null, NaN are
  // all rejected. 0 (or undefined) is allowed and means "delete the limit".
  const raw = (req.body || {}).monthly_limit_cents;
  let limit;
  if (raw === undefined || raw === null) {
    limit = 0; // treat as "delete"
  } else if (Number.isInteger(raw) && raw >= 0) {
    limit = raw;
  } else {
    return res.status(400).json({ error: 'monthly_limit_cents must be a non-negative integer (cents).' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Ownership check on the category
    const { rows: cat } = await client.query(
      'SELECT id FROM categories WHERE id = $1 AND user_id = $2',
      [categoryId, userId]
    );
    if (cat.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Category not found.' });
    }

    if (limit === 0) {
      await client.query(
        'DELETE FROM budget_limits WHERE user_id = $1 AND category_id = $2',
        [userId, categoryId]
      );
      await client.query('COMMIT');
      return res.json({ ok: true, deleted: true });
    }

    // Upsert. Composite FK guarantees a cross-user write is rejected at
    // the DB layer too; the ownership check above is the polite error.
    await client.query(
      `INSERT INTO budget_limits (user_id, category_id, monthly_limit_cents)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, category_id) DO UPDATE
         SET monthly_limit_cents = EXCLUDED.monthly_limit_cents,
             updated_at = NOW()`,
      [userId, categoryId, limit]
    );
    await client.query('COMMIT');
    res.json({ ok: true, monthly_limit_cents: limit });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[budgets] upsert failed:', err.message);
    res.status(500).json({ error: 'Could not save limit.' });
  } finally {
    client.release();
  }
});

router.get('/api/budget-limits/:category_id/transactions', async (req, res) => {
  const userId = req.session.userId;
  const categoryId = Number.parseInt(req.params.category_id, 10);
  if (!Number.isFinite(categoryId)) {
    return res.status(400).json({ error: 'invalid category_id' });
  }

  try {
    // Ownership check first — 404 if the category isn't yours, so we don't
    // leak existence by returning an empty list vs. a 200 with rows.
    const { rows: cat } = await pool.query(
      'SELECT id, name FROM categories WHERE id = $1 AND user_id = $2',
      [categoryId, userId]
    );
    if (cat.length === 0) return res.status(404).json({ error: 'Category not found.' });

    const { rows } = await pool.query(
      `SELECT id, plaid_account_id, name, merchant_name,
              amount, iso_currency_code, date, pending
         FROM transactions
        WHERE user_id = $1
          AND category_id = $2
          AND amount > 0
          AND date >= date_trunc('month', CURRENT_DATE)
          AND date <  (date_trunc('month', CURRENT_DATE) + INTERVAL '1 month')
        ORDER BY date DESC, id DESC`,
      [userId, categoryId]
    );
    res.json({ category: cat[0], transactions: rows });
  } catch (err) {
    console.error('[budgets] drill-down failed:', err.message);
    res.status(500).json({ error: 'Could not load drill-down.' });
  }
});

module.exports = router;

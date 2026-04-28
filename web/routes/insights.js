const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { classifyFlow } = require('../lib/transaction-flow');
const { computeSavingsRate } = require('../lib/savings-rate');

const router = express.Router();
router.use(express.json({ limit: '32kb' }));
router.use(requireAuth);

function clampMonths(v, def = 6) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(1, Math.min(24, n));
}

// "YYYY-MM" key for a Date or string.
function monthKey(d) {
  const dt = d instanceof Date ? d : new Date(d);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}`;
}

// First day of month N months before today (UTC).
function monthsBackStart(months) {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - (months - 1));
  return d.toISOString().slice(0, 10);
}

router.get('/api/spending/by-month', async (req, res) => {
  const userId = req.session.userId;
  const months = clampMonths(req.query.months, 6);
  try {
    const start = monthsBackStart(months);
    const { rows } = await pool.query(
      `SELECT t.id, t.amount, t.date, t.plaid_category_primary,
              t.category_id, c.name AS category_name
         FROM transactions t
         LEFT JOIN categories c ON c.id = t.category_id AND c.user_id = t.user_id
        WHERE t.user_id = $1
          AND t.date >= $2`,
      [userId, start]
    );

    // Aggregate per month.
    const buckets = new Map(); // monthKey -> { spending_cents, income_cents, by_category: Map(catId -> {...}) }
    for (const t of rows) {
      const flow = classifyFlow(t);
      if (flow !== 'spending' && flow !== 'income') continue;
      const m = monthKey(t.date);
      if (!buckets.has(m)) buckets.set(m, { spending_cents: 0, income_cents: 0, byCat: new Map() });
      const b = buckets.get(m);
      const cents = Math.round(Math.abs(Number(t.amount)) * 100);
      if (flow === 'spending') {
        b.spending_cents += cents;
        const ckey = t.category_id == null ? 0 : t.category_id;
        const cname = t.category_name || 'Uncategorized';
        if (!b.byCat.has(ckey)) b.byCat.set(ckey, { category_id: t.category_id, category_name: cname, spending_cents: 0 });
        b.byCat.get(ckey).spending_cents += cents;
      } else {
        b.income_cents += cents;
      }
    }

    // Walk every month in the range so the response covers gaps too.
    const out = [];
    const today = new Date();
    for (let i = months - 1; i >= 0; i--) {
      const dt = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - i, 1));
      const key = monthKey(dt);
      const b = buckets.get(key) || { spending_cents: 0, income_cents: 0, byCat: new Map() };
      out.push({
        month: key,
        spending_cents: b.spending_cents,
        income_cents: b.income_cents,
        by_category: [...b.byCat.values()].sort((a, b2) => b2.spending_cents - a.spending_cents),
      });
    }
    res.json({ months: out });
  } catch (err) {
    console.error('[insights:by-month] failed:', err.message);
    res.status(500).json({ error: 'Could not load monthly spending.' });
  }
});

router.get('/api/savings-rate', async (req, res) => {
  const userId = req.session.userId;
  const months = clampMonths(req.query.months, 6);
  try {
    const start = monthsBackStart(months);
    const { rows } = await pool.query(
      `SELECT t.amount, t.date, t.plaid_category_primary
         FROM transactions t
        WHERE t.user_id = $1 AND t.date >= $2`,
      [userId, start]
    );

    const buckets = new Map();
    for (const t of rows) {
      const flow = classifyFlow(t);
      if (flow !== 'spending' && flow !== 'income') continue;
      const m = monthKey(t.date);
      if (!buckets.has(m)) buckets.set(m, { income_cents: 0, spending_cents: 0 });
      const b = buckets.get(m);
      const cents = Math.round(Math.abs(Number(t.amount)) * 100);
      if (flow === 'spending') b.spending_cents += cents;
      else b.income_cents += cents;
    }

    const out = [];
    const today = new Date();
    for (let i = months - 1; i >= 0; i--) {
      const dt = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - i, 1));
      const key = monthKey(dt);
      const b = buckets.get(key) || { income_cents: 0, spending_cents: 0 };
      // Delegates the no-income / insufficient-income / ok decision to
      // lib/savings-rate.js so the rule lives in one place and is unit-tested.
      const sr = computeSavingsRate(b.income_cents, b.spending_cents);
      out.push({
        month: key,
        income_cents: b.income_cents,
        spending_cents: b.spending_cents,
        savings_cents: sr.savings_cents,
        savings_rate_pct: sr.savings_rate_pct,
        status: sr.status,
      });
    }
    res.json({ months: out });
  } catch (err) {
    console.error('[insights:savings-rate] failed:', err.message);
    res.status(500).json({ error: 'Could not load savings rate.' });
  }
});

module.exports = router;

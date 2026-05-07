const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { render404 } = require('../lib/render-error');
const { countAccountsForUser } = require('../lib/onboarding');

const router = express.Router();

// Resource-not-found copy for detail pages. Phrase deliberately doesn't
// say "doesn't exist" alone — that would let an attacker enumerate IDs
// to discover whether other users have a row at that ID. By saying
// "no longer exists or isn't yours" we cover both cases identically.
const NOT_FOUND_BUDGET = {
  heading: "We can't find that budget category",
  body: "This budget category isn't yours, or it no longer exists.",
};
const NOT_FOUND_SUBSCRIPTION = {
  heading: "We can't find that subscription",
  body: "This subscription no longer exists, or it isn't yours.",
};

router.get('/dashboard', requireAuth, async (req, res, next) => {
  try {
    const userId = req.session.userId;

    const { rows } = await pool.query(
      'SELECT email, email_verified_at FROM users WHERE id = $1',
      [userId]
    );
    const user = rows[0];
    if (!user) {
      // Session points to a user row that no longer exists (e.g. wiped during
      // dev). Without clearing the cookie too, the browser keeps sending the
      // old sid; the next /login render sees no userId and shows the form,
      // but on every subsequent request the same orphan-session check would
      // fire again until the cookie expires.
      return req.session.destroy(() => {
        res.clearCookie('moneymind.sid', { path: '/' });
        res.redirect('/login');
      });
    }

    // CRITICAL: every plaid_items / accounts query MUST filter by user_id.
    // The redundant a.user_id check on the join is defense-in-depth — the
    // FK to plaid_items already implies it, but a typo or schema drift
    // elsewhere shouldn't be able to leak another user's accounts.
    const { rows: items } = await pool.query(
      `SELECT pi.id,
              pi.institution_name,
              pi.created_at,
              COUNT(a.id)::int AS account_count
         FROM plaid_items pi
         LEFT JOIN accounts a
           ON a.plaid_item_id = pi.id AND a.user_id = pi.user_id
        WHERE pi.user_id = $1
        GROUP BY pi.id
        ORDER BY pi.created_at DESC`,
      [userId]
    );

    let flash = null;
    if (req.session && req.session.flash) {
      flash = req.session.flash;
      delete req.session.flash;
    }

    res.render('dashboard', {
      email: user.email,
      email_verified: !!user.email_verified_at,
      items,
      flash,
    });
  } catch (err) {
    next(err);
  }
});

// Build a list of {value, label} option pairs for the Month dropdown.
// Goes back at most 12 months from today, but stops at the user's earliest
// transaction's month so we don't show empty months.
function buildMonthOptions(earliestDate) {
  const list = [];
  const now = new Date();
  let earliestMonthIndex = null; // year * 12 + month, comparable
  if (earliestDate) {
    const d = new Date(earliestDate);
    earliestMonthIndex = d.getUTCFullYear() * 12 + d.getUTCMonth();
  }
  for (let i = 0; i < 12; i++) {
    const dt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const idx = dt.getUTCFullYear() * 12 + dt.getUTCMonth();
    if (earliestMonthIndex !== null && idx < earliestMonthIndex) break;
    const yyyy = dt.getUTCFullYear();
    const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const label = dt.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    list.push({ value: `${yyyy}-${mm}`, label });
  }
  return list;
}

router.get('/transactions', requireAuth, async (req, res, next) => {
  try {
    const userId = req.session.userId;

    // Accounts dropdown — user-scoped, with institution name for grouping in UI.
    const { rows: accounts } = await pool.query(
      `SELECT a.plaid_account_id, a.name, a.mask, a.subtype, pi.institution_name
         FROM accounts a
         JOIN plaid_items pi
           ON pi.id = a.plaid_item_id AND pi.user_id = a.user_id
        WHERE a.user_id = $1
        ORDER BY pi.id, a.id`,
      [userId]
    );

    // Earliest transaction date — caps the Month dropdown range.
    const { rows: minRow } = await pool.query(
      `SELECT MIN(date) AS earliest FROM transactions WHERE user_id = $1`,
      [userId]
    );
    const months = buildMonthOptions(minRow[0].earliest);
    const currentMonth = months.length ? months[0].value : null;

    res.render('transactions', {
      accounts,
      months,
      currentMonth,
      account_count: accounts.length,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/categories', requireAuth, (req, res) => {
  // The page itself is just a shell — JS hydrates from /api/categories.
  // Categories are seeded at signup so there's always data to render —
  // no account_count gating needed.
  res.render('categories');
});

router.get('/budgets', requireAuth, async (req, res, next) => {
  try {
    const account_count = await countAccountsForUser(req.session.userId);
    res.render('budgets', { account_count });
  } catch (err) {
    next(err);
  }
});

router.get('/budgets/:category_id', requireAuth, async (req, res, next) => {
  try {
    const userId = req.session.userId;
    const categoryId = Number.parseInt(req.params.category_id, 10);
    if (!Number.isFinite(categoryId)) return render404(req, res, NOT_FOUND_BUDGET);

    // Render the page only if the category belongs to this user — the
    // server-rendered <h1> would otherwise leak existence/name.
    // Cross-user lookup intentionally returns 404 (not 403) so an
    // attacker can't tell another user's category id from a non-existent one.
    const { rows } = await pool.query(
      'SELECT id, name FROM categories WHERE id = $1 AND user_id = $2',
      [categoryId, userId]
    );
    if (rows.length === 0) return render404(req, res, NOT_FOUND_BUDGET);
    res.render('budgets-detail', { category: rows[0] });
  } catch (err) {
    next(err);
  }
});

router.get('/alerts', requireAuth, async (req, res, next) => {
  try {
    const account_count = await countAccountsForUser(req.session.userId);
    res.render('alerts', { account_count });
  } catch (err) {
    next(err);
  }
});

router.get('/subscriptions', requireAuth, async (req, res, next) => {
  try {
    const account_count = await countAccountsForUser(req.session.userId);
    res.render('subscriptions', { account_count });
  } catch (err) {
    next(err);
  }
});

router.get('/net-worth', requireAuth, async (req, res, next) => {
  try {
    const account_count = await countAccountsForUser(req.session.userId);
    res.render('net-worth', { account_count });
  } catch (err) {
    next(err);
  }
});

router.get('/insights', requireAuth, async (req, res, next) => {
  try {
    const account_count = await countAccountsForUser(req.session.userId);
    res.render('insights', { account_count });
  } catch (err) {
    next(err);
  }
});

router.get('/findings', requireAuth, (req, res) => {
  // Findings are server-derived from transactions, so account_count is
  // implicitly 0 → 0 findings. The findings.js empty-state copy already
  // handles "nothing to show".
  res.render('findings');
});

router.get('/settings', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT email FROM users WHERE id = $1 AND is_deleted = FALSE',
      [req.session.userId]
    );
    if (rows.length === 0) {
      // Soft-deleted user holding a stale session. Force them out.
      return req.session.destroy(() => {
        res.clearCookie('moneymind.sid', { path: '/' });
        res.redirect('/login');
      });
    }
    res.render('settings', { email: rows[0].email });
  } catch (err) {
    next(err);
  }
});

router.get('/subscriptions/:id', requireAuth, async (req, res, next) => {
  try {
    const userId = req.session.userId;
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return render404(req, res, NOT_FOUND_SUBSCRIPTION);
    const { rows } = await pool.query(
      'SELECT id, display_name FROM recurring_charges WHERE id = $1 AND user_id = $2',
      [id, userId]
    );
    if (rows.length === 0) return render404(req, res, NOT_FOUND_SUBSCRIPTION);
    res.render('subscription-detail', { subscription: rows[0] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

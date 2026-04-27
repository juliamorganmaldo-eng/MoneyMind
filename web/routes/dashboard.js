const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/dashboard', requireAuth, async (req, res, next) => {
  try {
    const userId = req.session.userId;

    const { rows } = await pool.query(
      'SELECT email FROM users WHERE id = $1',
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

    res.render('dashboard', { email: user.email, items });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

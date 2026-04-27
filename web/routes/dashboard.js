const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/dashboard', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT email FROM users WHERE id = $1',
      [req.session.userId]
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
    res.render('dashboard', { email: user.email });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

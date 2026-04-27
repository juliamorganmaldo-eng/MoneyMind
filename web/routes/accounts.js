const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);

router.get('/api/accounts', async (req, res) => {
  const userId = req.session.userId;
  try {
    // CRITICAL: filter accounts by user_id, AND defensively re-assert
    // pi.user_id = a.user_id in the join — the FK already implies it,
    // but a typo elsewhere shouldn't be able to leak another user's data.
    const { rows } = await pool.query(
      `SELECT a.id,
              a.plaid_account_id,
              a.plaid_item_id,
              a.name,
              a.official_name,
              a.type,
              a.subtype,
              a.mask,
              a.current_balance,
              a.available_balance,
              a.iso_currency_code,
              pi.institution_name
         FROM accounts a
         JOIN plaid_items pi
           ON pi.id = a.plaid_item_id AND pi.user_id = a.user_id
        WHERE a.user_id = $1
        ORDER BY pi.id, a.id`,
      [userId]
    );
    res.json({ accounts: rows });
  } catch (err) {
    console.error('[accounts] failed:', err.message);
    res.status(500).json({ error: 'Could not load accounts.' });
  }
});

module.exports = router;

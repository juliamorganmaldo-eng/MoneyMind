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

router.use(express.json({ limit: '32kb' }));

router.patch('/api/accounts/:id/classification', async (req, res) => {
  const userId = req.session.userId;
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });

  const body = req.body || {};
  // is_asset_override may be true, false, or null. Anything else → 400.
  // (undefined is allowed and means "don't change this field"; we then
  // require excluded_from_net_worth to be present so the request still
  // does something.)
  let setOverride = false, overrideVal = null;
  if (Object.prototype.hasOwnProperty.call(body, 'is_asset_override')) {
    const v = body.is_asset_override;
    if (v !== true && v !== false && v !== null) {
      return res.status(400).json({ error: 'is_asset_override must be true, false, or null.' });
    }
    setOverride = true; overrideVal = v;
  }
  let setExcluded = false, excludedVal = false;
  if (Object.prototype.hasOwnProperty.call(body, 'excluded_from_net_worth')) {
    if (typeof body.excluded_from_net_worth !== 'boolean') {
      return res.status(400).json({ error: 'excluded_from_net_worth must be a boolean.' });
    }
    setExcluded = true; excludedVal = body.excluded_from_net_worth;
  }
  if (!setOverride && !setExcluded) {
    return res.status(400).json({ error: 'no fields to update' });
  }

  // Build dynamic SET; user_id always anchors the WHERE clause.
  const sets = [];
  const params = [];
  if (setOverride) { params.push(overrideVal); sets.push(`is_asset_override = $${params.length}`); }
  if (setExcluded) { params.push(excludedVal); sets.push(`excluded_from_net_worth = $${params.length}`); }
  sets.push('updated_at = NOW()');
  params.push(id, userId);
  const sql = `UPDATE accounts SET ${sets.join(', ')}
                WHERE id = $${params.length - 1} AND user_id = $${params.length}
                RETURNING id, is_asset_override, excluded_from_net_worth`;
  try {
    const { rows } = await pool.query(sql, params);
    if (rows.length === 0) return res.status(404).json({ error: 'Account not found.' });
    res.json({ ok: true, account: rows[0] });
  } catch (err) {
    console.error('[accounts:patch-classification] failed:', err.message);
    res.status(500).json({ error: 'Could not update classification.' });
  }
});

module.exports = router;

const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(express.json({ limit: '32kb' }));
router.use(requireAuth);

router.get('/api/low-balance-thresholds', async (req, res) => {
  const userId = req.session.userId;
  try {
    // Every account, joined with its (optional) threshold. Balance is
    // converted to integer cents the same way as everywhere else.
    const { rows } = await pool.query(
      `SELECT a.id   AS account_id,
              a.name AS account_name,
              a.mask,
              a.type,
              a.subtype,
              ROUND(a.current_balance * 100)::int AS current_balance_cents,
              lbt.threshold_cents,
              COALESCE(lbt.enabled, false) AS enabled
         FROM accounts a
         LEFT JOIN low_balance_thresholds lbt
           ON lbt.user_id = a.user_id AND lbt.account_id = a.id
        WHERE a.user_id = $1
        ORDER BY a.id`,
      [userId]
    );

    const out = rows.map((r) => {
      const triggered = r.threshold_cents != null
        && r.enabled
        && r.current_balance_cents != null
        && r.current_balance_cents < r.threshold_cents;
      return {
        account_id: r.account_id,
        account_name: r.account_name,
        mask: r.mask,
        type: r.type,
        subtype: r.subtype,
        current_balance_cents: r.current_balance_cents,
        threshold_cents: r.threshold_cents,
        enabled: r.enabled,
        triggered,
      };
    });
    res.json({ thresholds: out });
  } catch (err) {
    console.error('[alerts] list failed:', err.message);
    res.status(500).json({ error: 'Could not load thresholds.' });
  }
});

router.put('/api/low-balance-thresholds/:account_id', async (req, res) => {
  const userId = req.session.userId;
  const accountId = Number.parseInt(req.params.account_id, 10);
  if (!Number.isFinite(accountId)) {
    return res.status(400).json({ error: 'invalid account_id' });
  }

  // threshold_cents must be a non-negative integer; enabled must be a bool.
  // We deliberately reject 300.5, '300', NaN, null, etc.
  const body = req.body || {};
  const threshold = body.threshold_cents;
  const enabled = body.enabled;
  if (!Number.isInteger(threshold) || threshold < 0) {
    return res.status(400).json({ error: 'threshold_cents must be a non-negative integer (cents).' });
  }
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled must be a boolean.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Account ownership — 404 on cross-user
    const { rows: acct } = await client.query(
      'SELECT id FROM accounts WHERE id = $1 AND user_id = $2',
      [accountId, userId]
    );
    if (acct.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Account not found.' });
    }

    await client.query(
      `INSERT INTO low_balance_thresholds (user_id, account_id, threshold_cents, enabled)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, account_id) DO UPDATE
         SET threshold_cents = EXCLUDED.threshold_cents,
             enabled         = EXCLUDED.enabled,
             updated_at      = NOW()`,
      [userId, accountId, threshold, enabled]
    );
    await client.query('COMMIT');
    res.json({ ok: true, threshold_cents: threshold, enabled });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[alerts] upsert failed:', err.message);
    res.status(500).json({ error: 'Could not save threshold.' });
  } finally {
    client.release();
  }
});

router.delete('/api/low-balance-thresholds/:account_id', async (req, res) => {
  const userId = req.session.userId;
  const accountId = Number.parseInt(req.params.account_id, 10);
  if (!Number.isFinite(accountId)) {
    return res.status(400).json({ error: 'invalid account_id' });
  }
  try {
    // The user_id filter on the DELETE is the security boundary — even if
    // a cross-user account_id is sent, no rows match and we still return
    // 404 (rather than 200 with deleted=0) so we don't leak existence.
    const { rowCount } = await pool.query(
      'DELETE FROM low_balance_thresholds WHERE user_id = $1 AND account_id = $2',
      [userId, accountId]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Threshold not found.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[alerts] delete failed:', err.message);
    res.status(500).json({ error: 'Could not delete threshold.' });
  }
});

module.exports = router;

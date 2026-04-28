const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(express.json({ limit: '32kb' }));
router.use(requireAuth);

router.get('/api/user-settings', async (req, res) => {
  const userId = req.session.userId;
  try {
    // Defensive upsert — every user should have a row, but legacy users
    // (created before this table existed) may not.
    const { rows } = await pool.query(
      `INSERT INTO user_settings (user_id) VALUES ($1)
       ON CONFLICT (user_id) DO UPDATE SET updated_at = user_settings.updated_at
       RETURNING savings_rate_target_pct`,
      [userId]
    );
    res.json({ settings: { savings_rate_target_pct: rows[0].savings_rate_target_pct } });
  } catch (err) {
    console.error('[user-settings:get] failed:', err.message);
    res.status(500).json({ error: 'Could not load settings.' });
  }
});

router.patch('/api/user-settings', async (req, res) => {
  const userId = req.session.userId;
  const target = req.body && req.body.savings_rate_target_pct;
  if (!Number.isInteger(target) || target < 0 || target > 100) {
    return res.status(400).json({ error: 'savings_rate_target_pct must be an integer 0–100.' });
  }
  try {
    await pool.query(
      `INSERT INTO user_settings (user_id, savings_rate_target_pct, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         savings_rate_target_pct = EXCLUDED.savings_rate_target_pct,
         updated_at              = NOW()`,
      [userId, target]
    );
    res.json({ ok: true, savings_rate_target_pct: target });
  } catch (err) {
    console.error('[user-settings:patch] failed:', err.message);
    res.status(500).json({ error: 'Could not save setting.' });
  }
});

module.exports = router;

const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { runDetectors } = require('../lib/findings/orchestrator');

const router = express.Router();
router.use(express.json({ limit: '32kb' }));
router.use(requireAuth);

const TIER_ORDER = `CASE tier
  WHEN 'critical'  THEN 0
  WHEN 'important' THEN 1
  WHEN 'tip'       THEN 2
  WHEN 'positive'  THEN 3
  ELSE 4
END`;

router.get('/api/findings', async (req, res) => {
  const userId = req.session.userId;
  const includeDismissed = req.query.include_dismissed === 'true';
  try {
    // Bump last_findings_view_at on every list-fetch — that's how we count
    // "X new since last visit" against this timestamp.
    await pool.query(
      `INSERT INTO user_settings (user_id, last_findings_view_at)
         VALUES ($1, NOW())
         ON CONFLICT (user_id) DO UPDATE SET last_findings_view_at = NOW()`,
      [userId]
    );
    const where = includeDismissed
      ? 'user_id = $1'
      : 'user_id = $1 AND is_dismissed = FALSE';
    const { rows } = await pool.query(
      `SELECT id, finding_type, tier, title, body, deep_link_path,
              money_at_stake_cents, occurred_at, is_dismissed
         FROM findings
        WHERE ${where}
        ORDER BY ${TIER_ORDER}, occurred_at DESC`,
      [userId]
    );
    res.json({ findings: rows });
  } catch (err) {
    console.error('[findings:list] failed:', err.message);
    res.status(500).json({ error: 'Could not load findings.' });
  }
});

router.get('/api/findings/dashboard', async (req, res) => {
  const userId = req.session.userId;
  try {
    const { rows } = await pool.query(
      `SELECT id, finding_type, tier, title, body, deep_link_path,
              money_at_stake_cents, occurred_at
         FROM findings
        WHERE user_id = $1 AND is_dismissed = FALSE
        ORDER BY ${TIER_ORDER}, occurred_at DESC
        LIMIT 3`,
      [userId]
    );
    // Count of "new since last visit"
    const { rows: cnt } = await pool.query(
      `SELECT COUNT(*)::int AS n
         FROM findings f
         JOIN user_settings us ON us.user_id = f.user_id
        WHERE f.user_id = $1
          AND f.is_dismissed = FALSE
          AND (us.last_findings_view_at IS NULL OR f.occurred_at > us.last_findings_view_at)`,
      [userId]
    );
    res.json({ findings: rows, new_since_last_visit: cnt[0].n });
  } catch (err) {
    console.error('[findings:dashboard] failed:', err.message);
    res.status(500).json({ error: 'Could not load findings.' });
  }
});

router.post('/api/findings/refresh', async (req, res) => {
  const userId = req.session.userId;
  try {
    const out = await runDetectors(userId);
    res.json(out);
  } catch (err) {
    console.error('[findings:refresh] failed:', err.message);
    res.status(500).json({ error: 'Refresh failed.' });
  }
});

router.post('/api/findings/:id/dismiss', async (req, res) => {
  const userId = req.session.userId;
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
  try {
    // The user_id filter is the security boundary — cross-user → 0 rows → 404.
    const { rows } = await pool.query(
      `UPDATE findings
          SET is_dismissed = TRUE,
              dismissed_at = NOW(),
              updated_at   = NOW()
        WHERE id = $1 AND user_id = $2 AND is_dismissed = FALSE
        RETURNING id`,
      [id, userId]
    );
    if (rows.length === 0) {
      // Either doesn't exist, belongs to another user, or already dismissed.
      // We don't differentiate (no existence leak).
      return res.status(404).json({ error: 'Finding not found.' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[findings:dismiss] failed:', err.message);
    res.status(500).json({ error: 'Could not dismiss.' });
  }
});

module.exports = router;

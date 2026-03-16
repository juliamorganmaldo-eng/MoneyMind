const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { pool } = require('../db');

// GET /dashboard
router.get('/', requireAuth, async (req, res) => {
  const userId = req.session.user.id;

  try {
    const [accountsCount, findingsCount, actionsCount, recentFindings, recentActions] = await Promise.all([
      pool.query('SELECT COUNT(*) as count FROM connected_accounts WHERE user_id = $1', [userId]),
      pool.query('SELECT COUNT(*) as count FROM findings WHERE user_id = $1', [userId]),
      pool.query("SELECT COUNT(*) as count FROM action_drafts WHERE user_id = $1 AND status = 'draft'", [userId]),
      pool.query(
        'SELECT id, type, title, description, created_at FROM findings WHERE user_id = $1 ORDER BY created_at DESC LIMIT 5',
        [userId]
      ),
      pool.query(
        'SELECT id, type, merchant, status, created_at FROM action_drafts WHERE user_id = $1 ORDER BY created_at DESC LIMIT 5',
        [userId]
      ),
    ]);

    const stats = {
      accounts: Number(accountsCount.rows[0].count) || 0,
      findings: Number(findingsCount.rows[0].count) || 0,
      actions: Number(actionsCount.rows[0].count) || 0,
    };

    res.render('dashboard', {
      title: 'Dashboard',
      page: 'dashboard',
      stats,
      recentFindings: recentFindings.rows,
      recentActions: recentActions.rows,
    });
  } catch (err) {
    console.error('Dashboard error:', err);
    res.render('dashboard', {
      title: 'Dashboard',
      page: 'dashboard',
      stats: { accounts: 0, findings: 0, actions: 0 },
      recentFindings: [],
      recentActions: [],
    });
  }
});

module.exports = router;

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { pool } = require('../db');
const { generateMonthlyReport } = require('../lib/monthly-report');

// GET /notifications
router.get('/', requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  const rows = (await pool.query(
    'SELECT id, type, title, body, data_json, read_at, created_at FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50',
    [userId]
  )).rows;

  const notifications = rows.map(n => ({
    ...n,
    data: n.data_json ? JSON.parse(n.data_json) : null,
  }));

  await pool.query('UPDATE notifications SET read_at = datetime(\'now\') WHERE user_id = $1 AND read_at IS NULL', [userId]);

  res.render('notifications', {
    title: 'Notifications',
    page: 'notifications',
    notifications,
  });
});

// POST /notifications/generate-monthly  (manual trigger for testing)
router.post('/generate-monthly', requireAuth, async (req, res) => {
  try {
    const out = await generateMonthlyReport(req.session.user.id);
    res.json({ success: true, month: out.report.month });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

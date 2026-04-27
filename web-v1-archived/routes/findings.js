const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { pool } = require('../db');

// GET /findings
router.get('/', requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  const typeFilter = req.query.type || 'all';

  const validTypes = ['all', 'recurring', 'duplicate_subscription', 'price_change', 'other'];
  const activeType = validTypes.includes(typeFilter) ? typeFilter : 'all';

  try {
    let query;
    let params;

    if (activeType === 'all') {
      query = 'SELECT * FROM findings WHERE user_id = $1 ORDER BY created_at DESC';
      params = [userId];
    } else {
      query = 'SELECT * FROM findings WHERE user_id = $1 AND type = $2 ORDER BY created_at DESC';
      params = [userId, activeType];
    }

    const result = await pool.query(query, params);

    res.render('findings', {
      title: 'Findings Feed',
      page: 'findings',
      findings: result.rows,
      activeType,
    });
  } catch (err) {
    console.error('Findings error:', err);
    res.render('findings', {
      title: 'Findings Feed',
      page: 'findings',
      findings: [],
      activeType,
    });
  }
});

module.exports = router;

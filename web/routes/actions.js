const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { pool } = require('../db');

// GET /actions
router.get('/', requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  const statusFilter = req.query.status || 'all';

  const validStatuses = ['all', 'draft', 'sent', 'resolved'];
  const activeStatus = validStatuses.includes(statusFilter) ? statusFilter : 'all';

  try {
    let query;
    let params;

    if (activeStatus === 'all') {
      query = 'SELECT * FROM action_drafts WHERE user_id = $1 ORDER BY created_at DESC';
      params = [userId];
    } else {
      query = 'SELECT * FROM action_drafts WHERE user_id = $1 AND status = $2 ORDER BY created_at DESC';
      params = [userId, activeStatus];
    }

    const result = await pool.query(query, params);

    res.render('actions', {
      title: 'Action Centre',
      page: 'actions',
      actions: result.rows,
      activeStatus,
    });
  } catch (err) {
    console.error('Actions error:', err);
    res.render('actions', {
      title: 'Action Centre',
      page: 'actions',
      actions: [],
      activeStatus,
    });
  }
});

// PATCH /actions/:id/status
router.patch('/:id/status', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  const validStatuses = ['draft', 'sent', 'resolved'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid status value' });
  }

  try {
    const result = await pool.query(
      'UPDATE action_drafts SET status = $1 WHERE id = $2 AND user_id = $3 RETURNING id, status',
      [status, id, req.session.user.id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Action not found' });
    }

    res.json({ success: true, status: result.rows[0].status });
  } catch (err) {
    console.error('Update action status error:', err);
    res.status(500).json({ error: 'Failed to update status', details: err.message });
  }
});

module.exports = router;

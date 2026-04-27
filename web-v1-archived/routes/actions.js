const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { pool } = require('../db');
const { project, parseOutcome } = require('../lib/wealth-projection');

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
  const { status, outcome } = req.body;
  const userId = req.session.user.id;

  const validStatuses = ['draft', 'sent', 'resolved'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid status value' });
  }

  try {
    const updated = await pool.query(
      'UPDATE action_drafts SET status = $1 WHERE id = $2 AND user_id = $3 RETURNING id, status, type, merchant',
      [status, id, userId]
    );
    if (updated.rowCount === 0) return res.status(404).json({ error: 'Action not found' });

    const response = { success: true, status: updated.rows[0].status };

    if (status === 'resolved' && outcome) {
      const action = updated.rows[0];
      const findingType = outcome.finding_type || action.type || 'other';
      let savings_type, amount;

      if (outcome.savings_type === 'one_time') {
        amount = Number(outcome.amount);
        savings_type = 'one_time';
      } else if (outcome.savings_type === 'recurring_monthly') {
        if (outcome.from_amount != null && outcome.to_amount != null) {
          amount = +(Number(outcome.from_amount) - Number(outcome.to_amount)).toFixed(2);
        } else {
          amount = Number(outcome.amount);
        }
        savings_type = 'recurring_monthly';
      } else {
        const parsed = parseOutcome(outcome.note || '');
        if (parsed && parsed.delta != null) {
          savings_type = 'recurring_monthly';
          amount = parsed.delta;
        } else if (parsed && parsed.refund != null) {
          savings_type = 'one_time';
          amount = parsed.refund;
        }
      }

      if (savings_type && amount > 0 && !isNaN(amount)) {
        const confirmed = outcome.confirmed_date || new Date().toISOString().slice(0, 10);
        const inserted = await pool.query(
          `INSERT INTO savings_ledger
             (user_id, action_id, merchant, finding_type, savings_type, amount, outcome_note, confirmed_date)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING id, merchant, savings_type, amount, confirmed_date`,
          [userId, id, action.merchant, findingType, savings_type, amount, outcome.note || null, confirmed]
        );
        response.savings = inserted.rows[0];
        response.projection = project({ amount, savings_type });
      } else if (outcome.note) {
        response.warning = 'Could not parse a savings amount from the outcome.';
      }
    }

    res.json(response);
  } catch (err) {
    console.error('Update action status error:', err);
    res.status(500).json({ error: 'Failed to update status', details: err.message });
  }
});

module.exports = router;

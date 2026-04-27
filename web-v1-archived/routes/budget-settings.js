const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { pool } = require('../db');
const { getMonthSpending } = require('../lib/categories');

const DEFAULT_CATEGORIES = ['Eating Out', 'Gas', 'Groceries', 'Other', 'Shopping'];

// GET /budget-settings
router.get('/', requireAuth, async (req, res) => {
  try {
    const budgetsResult = await pool.query(
      'SELECT id, category, monthly_limit FROM budgets WHERE user_id = $1 ORDER BY category',
      [req.session.user.id]
    );

    // First visit: seed defaults
    if (budgetsResult.rows.length === 0) {
      for (const cat of DEFAULT_CATEGORIES) {
        await pool.query(
          'INSERT INTO budgets (user_id, category, monthly_limit) VALUES ($1, $2, $3)',
          [req.session.user.id, cat, 0]
        );
      }
      return res.redirect('/budget-settings');
    }

    const now = new Date();
    const spending = getMonthSpending(now.getFullYear(), now.getMonth() + 1).spending;

    const categories = budgetsResult.rows.map(row => ({
      id: row.id,
      name: row.category,
      limit: row.monthly_limit,
      spent: parseFloat((spending[row.category] || 0).toFixed(2)),
    }));

    res.render('budget-settings', {
      title: 'Budget Settings',
      page: 'budget-settings',
      categories,
    });
  } catch (err) {
    console.error('Budget settings error:', err);
    req.session.flash = { error: 'Failed to load budget settings.' };
    res.redirect('/dashboard');
  }
});

// POST /budget-settings — save all limits
router.post('/', requireAuth, async (req, res) => {
  try {
    const ids = Array.isArray(req.body.id) ? req.body.id : (req.body.id ? [req.body.id] : []);
    const limits = Array.isArray(req.body.limit) ? req.body.limit : (req.body.limit ? [req.body.limit] : []);

    for (let i = 0; i < ids.length; i++) {
      const val = parseFloat(limits[i]);
      if (isNaN(val) || val < 0) continue;
      await pool.query(
        'UPDATE budgets SET monthly_limit = $1 WHERE id = $2 AND user_id = $3',
        [val, ids[i], req.session.user.id]
      );
    }

    req.session.flash = { success: 'Budget limits saved.' };
  } catch (err) {
    console.error('Budget settings save error:', err);
    req.session.flash = { error: 'Failed to save budget limits.' };
  }

  res.redirect('/budget-settings');
});

// POST /budget-settings/add — add a new category
router.post('/add', requireAuth, async (req, res) => {
  const category = (req.body.category || '').trim();
  const limit = parseFloat(req.body.monthly_limit) || 0;

  if (!category) {
    req.session.flash = { error: 'Category name is required.' };
    return res.redirect('/budget-settings');
  }

  try {
    // Check for duplicate
    const existing = await pool.query(
      'SELECT id FROM budgets WHERE user_id = $1 AND category = $2',
      [req.session.user.id, category]
    );
    if (existing.rows.length > 0) {
      req.session.flash = { error: `"${category}" already exists.` };
      return res.redirect('/budget-settings');
    }

    await pool.query(
      'INSERT INTO budgets (user_id, category, monthly_limit) VALUES ($1, $2, $3)',
      [req.session.user.id, category, limit]
    );
    req.session.flash = { success: `Added "${category}" category.` };
  } catch (err) {
    console.error('Add category error:', err);
    req.session.flash = { error: 'Failed to add category.' };
  }

  res.redirect('/budget-settings');
});

// DELETE /budget-settings/:id
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM budgets WHERE id = $1 AND user_id = $2',
      [req.params.id, req.session.user.id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Delete category error:', err);
    res.status(500).json({ error: 'Failed to delete category.' });
  }
});

module.exports = router;

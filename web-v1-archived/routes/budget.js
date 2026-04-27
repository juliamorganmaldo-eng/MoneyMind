const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { pool } = require('../db');
const { BUDGET_CATEGORIES, getMonthSpending, getMonthTransactionsByCategory, setTransactionCategory } = require('../lib/categories');

function getCurrentMonthSpending() {
  const now = new Date();
  return getMonthSpending(now.getFullYear(), now.getMonth() + 1).spending;
}

// GET /budget
router.get('/', requireAuth, async (req, res) => {
  try {
    const budgetsResult = await pool.query(
      'SELECT id, category, monthly_limit FROM budgets WHERE user_id = $1 ORDER BY category',
      [req.session.user.id]
    );

    const spending = getCurrentMonthSpending();
    const now2 = new Date();
    const txnsByCategory = getMonthTransactionsByCategory(now2.getFullYear(), now2.getMonth() + 1);

    // Merge any override-created categories into spending
    for (const cat of Object.keys(txnsByCategory)) {
      if (!(cat in spending)) {
        spending[cat] = txnsByCategory[cat].reduce((s, t) => s + t.amount, 0);
      }
    }

    const budgets = budgetsResult.rows.map(b => ({
      ...b,
      spent: parseFloat((spending[b.category] || 0).toFixed(2)),
      pct: b.monthly_limit > 0 ? Math.min(100, ((spending[b.category] || 0) / b.monthly_limit) * 100) : 0,
    }));

    // User's budget category names for the reassign dropdown
    const userCategories = budgetsResult.rows.map(b => b.category).sort();

    // Categories not yet budgeted
    const budgetedCats = new Set(budgets.map(b => b.category));
    const unbudgeted = BUDGET_CATEGORIES.filter(c => !budgetedCats.has(c));

    // Total spending this month
    const totalSpent = Object.values(spending).reduce((s, v) => s + v, 0);
    const totalBudget = budgets.reduce((s, b) => s + b.monthly_limit, 0);

    const now = new Date();
    const monthName = now.toLocaleString('en-US', { month: 'long', year: 'numeric' });

    res.render('budget', {
      title: 'Budget Alerts',
      page: 'budget',
      budgets,
      unbudgeted,
      categories: BUDGET_CATEGORIES,
      spending,
      totalSpent: parseFloat(totalSpent.toFixed(2)),
      totalBudget: parseFloat(totalBudget.toFixed(2)),
      monthName,
      txnsByCategory,
      userCategories,
    });
  } catch (err) {
    console.error('Budget error:', err);
    req.session.flash = { error: 'Failed to load budgets.' };
    res.redirect('/dashboard');
  }
});

// POST /budget — set or update a budget
router.post('/', requireAuth, async (req, res) => {
  const { category, monthly_limit } = req.body;

  if (!category || !BUDGET_CATEGORIES.includes(category)) {
    req.session.flash = { error: 'Invalid category.' };
    return res.redirect('/budget');
  }

  const limit = parseFloat(monthly_limit);
  if (isNaN(limit) || limit <= 0) {
    req.session.flash = { error: 'Budget must be a positive number.' };
    return res.redirect('/budget');
  }

  try {
    // Upsert: insert or update on conflict
    await pool.query(
      `INSERT INTO budgets (user_id, category, monthly_limit) VALUES ($1, $2, $3)
       ON CONFLICT(user_id, category) DO UPDATE SET monthly_limit = $4`,
      [req.session.user.id, category, limit, limit]
    );
    req.session.flash = { success: `Budget for ${category} set to $${limit.toFixed(2)}/month.` };
  } catch (err) {
    console.error('Budget save error:', err);
    req.session.flash = { error: 'Failed to save budget.' };
  }

  res.redirect('/budget');
});

// POST /budget/reassign — move a transaction to a different budget category
router.post('/reassign', requireAuth, async (req, res) => {
  const { transactionId, newCategory } = req.body;
  if (!transactionId || !newCategory) {
    return res.status(400).json({ error: 'Missing transactionId or newCategory.' });
  }

  try {
    setTransactionCategory(transactionId, newCategory);

    // Return updated spending totals
    const now = new Date();
    const spending = getMonthSpending(now.getFullYear(), now.getMonth() + 1).spending;
    const txnsByCategory = getMonthTransactionsByCategory(now.getFullYear(), now.getMonth() + 1);

    // Include override categories in spending
    for (const cat of Object.keys(txnsByCategory)) {
      if (!(cat in spending)) {
        spending[cat] = txnsByCategory[cat].reduce((s, t) => s + t.amount, 0);
      }
    }

    const budgetsResult = await pool.query(
      'SELECT id, category, monthly_limit FROM budgets WHERE user_id = $1',
      [req.session.user.id]
    );

    const budgets = {};
    for (const b of budgetsResult.rows) {
      const spent = parseFloat((spending[b.category] || 0).toFixed(2));
      budgets[b.category] = {
        spent,
        pct: b.monthly_limit > 0 ? Math.min(100, (spent / b.monthly_limit) * 100) : 0,
        monthly_limit: b.monthly_limit,
      };
    }

    res.json({ success: true, budgets, spending });
  } catch (err) {
    console.error('Reassign error:', err);
    res.status(500).json({ error: 'Failed to reassign transaction.' });
  }
});

// DELETE /budget/:id
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM budgets WHERE id = $1 AND user_id = $2',
      [req.params.id, req.session.user.id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Budget delete error:', err);
    res.status(500).json({ error: 'Failed to delete budget.' });
  }
});

module.exports = router;

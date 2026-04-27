const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { BUDGET_CATEGORIES, getMonthSpending, getIncomeFromAllAccounts } = require('../lib/categories');

// Chart colors for each category
const CATEGORY_COLORS = {
  'Groceries':        '#2D6A4F',
  'Eating Out':       '#52B788',
  'Gas':              '#F59E0B',
  'Shopping':         '#3B82F6',
  'Subscriptions':    '#8B5CF6',
  'Auto & Transport': '#EC4899',
  'Travel':           '#06B6D4',
  'Personal Care':    '#F97316',
  'Entertainment':    '#EF4444',
  'Other':            '#6B7280',
};

// GET /spending
router.get('/', requireAuth, async (req, res) => {
  try {
    const now = new Date();
    const curYear = now.getFullYear();
    const curMonth = now.getMonth() + 1;

    // Previous month
    const prevMonth = curMonth === 1 ? 12 : curMonth - 1;
    const prevYear = curMonth === 1 ? curYear - 1 : curYear;

    const current = getMonthSpending(curYear, curMonth);
    const previous = getMonthSpending(prevYear, prevMonth);

    // Also get income from all accounts (including checking) for savings rate
    const incomeFromAll = getIncomeFromAllAccounts(curYear, curMonth);
    const prevIncomeFromAll = getIncomeFromAllAccounts(prevYear, prevMonth);

    // Build category data for charts
    const categories = BUDGET_CATEGORIES.filter(c => current.spending[c] > 0 || previous.spending[c] > 0);
    const chartData = categories.map(cat => ({
      category: cat,
      current: parseFloat((current.spending[cat] || 0).toFixed(2)),
      previous: parseFloat((previous.spending[cat] || 0).toFixed(2)),
      color: CATEGORY_COLORS[cat],
      change: previous.spending[cat] > 0
        ? parseFloat((((current.spending[cat] - previous.spending[cat]) / previous.spending[cat]) * 100).toFixed(1))
        : null,
    }));

    // Sort by current month spending descending
    chartData.sort((a, b) => b.current - a.current);

    const totalCurrent = parseFloat(Object.values(current.spending).reduce((s, v) => s + v, 0).toFixed(2));
    const totalPrevious = parseFloat(Object.values(previous.spending).reduce((s, v) => s + v, 0).toFixed(2));

    // Savings rate: income from all accounts minus credit card spending
    const totalIncome = incomeFromAll || current.totalIncome;
    const savingsRate = totalIncome > 0
      ? parseFloat((((totalIncome - totalCurrent) / totalIncome) * 100).toFixed(1))
      : null;

    const prevTotalIncome = prevIncomeFromAll || previous.totalIncome;
    const prevSavingsRate = prevTotalIncome > 0
      ? parseFloat((((prevTotalIncome - totalPrevious) / prevTotalIncome) * 100).toFixed(1))
      : null;

    const curMonthName = new Date(curYear, curMonth - 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });
    const prevMonthName = new Date(prevYear, prevMonth - 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });

    res.render('spending', {
      title: 'Spending',
      page: 'spending',
      chartData,
      totalCurrent,
      totalPrevious,
      totalIncome: parseFloat((totalIncome || 0).toFixed(2)),
      savingsRate,
      prevSavingsRate,
      curMonthName,
      prevMonthName,
      categoryColors: CATEGORY_COLORS,
    });
  } catch (err) {
    console.error('Spending error:', err);
    req.session.flash = { error: 'Failed to load spending data.' };
    res.redirect('/dashboard');
  }
});

module.exports = router;

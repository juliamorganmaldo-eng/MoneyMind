const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { mainDb, categorizeTransaction } = require('../lib/categories');

// GET /transactions
router.get('/', requireAuth, (req, res) => {
  try {
    // Determine available months from data
    const monthRows = mainDb.prepare(
      "SELECT DISTINCT substr(date, 1, 7) AS ym FROM transactions ORDER BY ym DESC"
    ).all();
    const availableMonths = monthRows.map(r => r.ym);

    // Selected month (default: current or most recent with data)
    const now = new Date();
    const currentYm = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const selectedMonth = req.query.month && availableMonths.includes(req.query.month)
      ? req.query.month
      : (availableMonths.includes(currentYm) ? currentYm : availableMonths[0] || currentYm);

    const search = (req.query.search || '').trim();

    // Fetch transactions for selected month
    const startDate = `${selectedMonth}-01`;
    const endDate = `${selectedMonth}-31`;

    let rows;
    if (search) {
      rows = mainDb.prepare(
        'SELECT account, date, merchant, amount, category FROM transactions WHERE date >= ? AND date <= ? AND merchant LIKE ? ORDER BY date DESC, rowid DESC'
      ).all(startDate, endDate, `%${search}%`);
    } else {
      rows = mainDb.prepare(
        'SELECT account, date, merchant, amount, category FROM transactions WHERE date >= ? AND date <= ? ORDER BY date DESC, rowid DESC'
      ).all(startDate, endDate);
    }

    // Compute summary
    let totalSpent = 0;
    let totalIncome = 0;
    const transactions = rows.map(row => {
      const cat = categorizeTransaction(row.merchant, row.category);
      // Income: negative amounts with payroll/income categories
      if (row.amount < 0) {
        const c = (row.category || '').toLowerCase();
        const m = (row.merchant || '').toLowerCase();
        if (c.includes('payroll') || c.includes('income') || c.includes('direct dep') ||
            m.includes('payroll') || m.includes('direct deposit')) {
          totalIncome += Math.abs(row.amount);
        }
      }
      if (row.amount > 0 && cat) {
        totalSpent += row.amount;
      }
      return {
        account: row.account,
        date: row.date,
        merchant: row.merchant,
        amount: row.amount,
        plaidCategory: row.category,
        displayCategory: cat || formatPlaidCategory(row.category),
      };
    });

    // Format month labels for selector
    const monthOptions = availableMonths.map(ym => {
      const [y, m] = ym.split('-');
      const label = new Date(parseInt(y), parseInt(m) - 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });
      return { value: ym, label };
    });

    const [sy, sm] = selectedMonth.split('-');
    const selectedMonthLabel = new Date(parseInt(sy), parseInt(sm) - 1)
      .toLocaleString('en-US', { month: 'long', year: 'numeric' });

    res.render('transactions', {
      title: 'Transactions',
      page: 'transactions',
      transactions,
      monthOptions,
      selectedMonth,
      selectedMonthLabel,
      search,
      totalSpent: parseFloat(totalSpent.toFixed(2)),
      totalIncome: parseFloat(totalIncome.toFixed(2)),
      txnCount: transactions.length,
    });
  } catch (err) {
    console.error('Transactions error:', err);
    req.session.flash = { error: 'Failed to load transactions.' };
    res.redirect('/dashboard');
  }
});

function formatPlaidCategory(cat) {
  if (!cat) return 'Other';
  // Take last segment: "Food and Drink > Restaurants" -> "Restaurants"
  const parts = cat.split('>');
  return parts[parts.length - 1].trim();
}

module.exports = router;

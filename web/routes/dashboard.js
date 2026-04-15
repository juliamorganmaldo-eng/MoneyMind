const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { pool } = require('../db');
const { BUDGET_CATEGORIES, getMonthSpending, getMonthInvestments, getIncomeFromAllAccounts, mainDb } = require('../lib/categories');
const { Configuration, PlaidApi, PlaidEnvironments } = require('plaid');

function getPlaidClient() {
  return new PlaidApi(new Configuration({
    basePath: PlaidEnvironments[process.env.PLAID_ENV || 'sandbox'],
    baseOptions: {
      headers: {
        'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
        'PLAID-SECRET': process.env.PLAID_SECRET,
      },
    },
  }));
}

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

const LOW_BALANCE_THRESHOLD = 500;

// GET /dashboard
router.get('/', requireAuth, async (req, res) => {
  const userId = req.session.user.id;

  try {
    const [findingsCount, recentFindings, recentActions] = await Promise.all([
      pool.query('SELECT COUNT(*) as count FROM findings WHERE user_id = $1', [userId]),
      pool.query(
        'SELECT id, type, title, description, created_at FROM findings WHERE user_id = $1 ORDER BY created_at DESC LIMIT 5',
        [userId]
      ),
      pool.query(
        'SELECT id, type, merchant, status, created_at FROM action_drafts WHERE user_id = $1 ORDER BY created_at DESC LIMIT 5',
        [userId]
      ),
    ]);

    // Spending breakdown
    const now = new Date();
    const curMonth = now.getMonth() + 1;
    const curYear = now.getFullYear();
    const current = getMonthSpending(curYear, curMonth);
    const incomeFromAll = getIncomeFromAllAccounts(curYear, curMonth);
    const totalSpending = parseFloat(Object.values(current.spending).reduce((s, v) => s + v, 0).toFixed(2));
    const totalIncome = parseFloat((incomeFromAll || current.totalIncome || 0).toFixed(2));

    const investments = getMonthInvestments(curYear, curMonth);

    const spendingChart = BUDGET_CATEGORIES
      .filter(c => current.spending[c] > 0)
      .map(c => ({ category: c, amount: parseFloat(current.spending[c].toFixed(2)), color: CATEGORY_COLORS[c] }))
      .sort((a, b) => b.amount - a.amount);

    // Recent transactions (last 8)
    const recentTxns = mainDb.prepare(
      'SELECT account, date, merchant, amount, category FROM transactions ORDER BY date DESC, rowid DESC LIMIT 8'
    ).all();

    // Plaid balances — for investment section and low balance alerts
    let assets = [];
    let liabilities = [];
    let totalAssets = 0;
    let totalLiabilities = 0;
    let lowBalanceAlerts = [];

    try {
      const connectedAccounts = await pool.query(
        'SELECT access_token, institution FROM connected_accounts WHERE user_id = $1',
        [userId]
      );
      if (connectedAccounts.rows.length > 0) {
        const plaid = getPlaidClient();
        for (const acct of connectedAccounts.rows) {
          try {
            const resp = await plaid.accountsBalanceGet({ access_token: acct.access_token });
            for (const a of resp.data.accounts) {
              const balance = a.balances.current || 0;
              const available = a.balances.available;
              const entry = {
                institution: acct.institution,
                name: a.name || a.official_name || 'Account',
                type: a.type,
                subtype: a.subtype,
                balance: parseFloat(balance.toFixed(2)),
                available: available != null ? parseFloat(available.toFixed(2)) : null,
                mask: a.mask,
              };

              if (a.type === 'credit' || a.type === 'loan') {
                liabilities.push(entry);
                totalLiabilities += balance;
              } else {
                assets.push(entry);
                totalAssets += balance;
              }

              // Low balance check
              if (a.type === 'depository' && (a.subtype === 'checking' || a.subtype === 'savings')) {
                const bal = available ?? balance;
                if (bal < LOW_BALANCE_THRESHOLD) {
                  lowBalanceAlerts.push({
                    institution: acct.institution,
                    name: entry.name,
                    subtype: a.subtype,
                    balance: parseFloat(bal.toFixed(2)),
                    mask: a.mask,
                  });
                }
              }
            }
          } catch (_) {}
        }
      }
    } catch (_) {}

    const netWorth = parseFloat((totalAssets - totalLiabilities).toFixed(2));
    totalAssets = parseFloat(totalAssets.toFixed(2));
    totalLiabilities = parseFloat(totalLiabilities.toFixed(2));

    const monthName = now.toLocaleString('en-US', { month: 'long', year: 'numeric' });

    res.render('dashboard', {
      title: 'Dashboard',
      page: 'dashboard',
      findingsCount: Number(findingsCount.rows[0].count) || 0,
      recentFindings: recentFindings.rows,
      recentActions: recentActions.rows,
      spendingChart,
      totalSpending,
      totalIncome,
      recentTxns,
      assets,
      liabilities,
      totalAssets,
      totalLiabilities,
      netWorth,
      lowBalanceAlerts,
      monthName,
      investments,
    });
  } catch (err) {
    console.error('Dashboard error:', err);
    res.render('dashboard', {
      title: 'Dashboard',
      page: 'dashboard',
      findingsCount: 0,
      recentFindings: [],
      recentActions: [],
      spendingChart: [],
      totalSpending: 0,
      totalIncome: 0,
      recentTxns: [],
      assets: [],
      liabilities: [],
      totalAssets: 0,
      totalLiabilities: 0,
      netWorth: 0,
      lowBalanceAlerts: [],
      monthName: '',
      investments: { transactions: [], total: 0, byPlatform: {} },
    });
  }
});

module.exports = router;

const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const mainDb = new DatabaseSync(path.join(__dirname, '../../moneymind.db'));

const BUDGET_CATEGORIES = [
  'Groceries',
  'Eating Out',
  'Gas',
  'Shopping',
  'Subscriptions',
  'Auto & Transport',
  'Travel',
  'Personal Care',
  'Entertainment',
  'Other',
];

// Wells Fargo checking & savings account IDs — exclude from spending
const WF_CHECKING_ID = 'VEr1LRQv3Xu7zBPqyVzqUdp18Kq90jUaRdZRg';
const WF_SAVINGS_ID  = 'OxPaRZOL6yCJewNdKEedtA90jnoRPgUNwzLwv';

// Returns null for non-spending transactions (transfers, payments, etc.)
function categorizeTransaction(merchant, category) {
  const m = (merchant || '').toLowerCase();
  const c = (category || '').toLowerCase();

  if (c.includes('transfer') || c.includes('payment') || c.includes('deposit') ||
      c.includes('interest') || c.includes('bank fees') || c.includes('tax') ||
      c.includes('financial')) return null;
  if (['zelle', 'venmo', 'overdraft', 'online transfer', 'chase credit crd',
       'wf credit card', 'discover e-payment', 'mobile deposit', 'apple cash',
       'money transfer authorized', 'automatic payment', 'non-wf atm',
       'non-wells fargo atm', 'vanguard', 'robinhood', 'franchise tax',
       'internal revenue'].some(x => m.includes(x))) return null;

  if (['google one', 'claude.ai', 'anthropic', 'netflix', 'spotify', 'hulu',
       'disney', 'hbo', 'youtube premium', 'apple'].some(g => m.includes(g)))
    return 'Subscriptions';

  if (['amazon', 'target', 'cvs'].some(g => m.includes(g)))
    return 'Shopping';

  if (['vons', 'smart & final', 'trader joe', 'walmart', 'whole foods', 'costco', 'calimax'].some(g => m.includes(g))) {
    if (m.includes('costco') && c.includes('gas')) return 'Gas';
    return 'Groceries';
  }

  if (c.includes('gas station') || ['arco', 'chevron', 'shell'].some(g => m.includes(g)))
    return 'Gas';

  if (c.includes('supermarket') || c.includes('groceries') || c.includes('warehouse'))
    return 'Groceries';

  if (c.includes('restaurant') || c.includes('coffee') || c.includes('fast food'))
    return 'Eating Out';
  if (c.includes('food and drink')) return 'Eating Out';

  if (c.includes('shop') || c.includes('department') || c.includes('pharmac'))
    return 'Shopping';

  if (c.includes('automotive') || m.includes('auto repair') || m.includes('car wash'))
    return 'Auto & Transport';

  if (c.includes('travel') || c.includes('lodging') || ['airbnb', 'chase travel'].some(g => m.includes(g)))
    return 'Travel';

  if (c.includes('personal care') || ['threading', 'clip mx'].some(g => m.includes(g)))
    return 'Personal Care';

  if (c.includes('food and beverage store') || c.includes('entertainment'))
    return 'Entertainment';

  return 'Other';
}

function isIncomeTransaction(merchant, category, amount) {
  const m = (merchant || '').toLowerCase();
  const c = (category || '').toLowerCase();
  // Negative amounts in Plaid = money coming in (income, refunds)
  // But we only want actual income, not refunds
  if (amount >= 0) return false;
  if (c.includes('payroll') || c.includes('income') || c.includes('direct dep')) return true;
  if (m.includes('payroll') || m.includes('direct deposit') || m.includes('adp') ||
      m.includes('gusto') || m.includes('employer')) return true;
  return false;
}

function loadOverrides() {
  const rows = mainDb.prepare('SELECT transaction_id, budget_category FROM category_overrides').all();
  const map = {};
  for (const row of rows) map[row.transaction_id] = row.budget_category;
  return map;
}

function resolveCategory(row, overrides) {
  if (overrides[row.id]) return overrides[row.id];
  return categorizeTransaction(row.merchant, row.category);
}

function getMonthSpending(year, month) {
  const startOfMonth = `${year}-${String(month).padStart(2, '0')}-01`;
  const endOfMonth = `${year}-${String(month).padStart(2, '0')}-31`;

  const rows = mainDb.prepare(
    'SELECT id, merchant, amount, category, raw_json FROM transactions WHERE date >= ? AND date <= ?'
  ).all(startOfMonth, endOfMonth);

  const overrides = loadOverrides();
  const spending = {};
  for (const cat of BUDGET_CATEGORIES) spending[cat] = 0;

  let totalIncome = 0;
  let totalSpending = 0;

  for (const row of rows) {
    // Skip Wells Fargo checking & savings — only count credit card spending
    if (row.raw_json) {
      try {
        const raw = JSON.parse(row.raw_json);
        if (raw.account_id === WF_CHECKING_ID || raw.account_id === WF_SAVINGS_ID) continue;
      } catch (_) {}
    }

    // Check for income
    if (isIncomeTransaction(row.merchant, row.category, row.amount)) {
      totalIncome += Math.abs(row.amount);
      continue;
    }

    const cat = resolveCategory(row, overrides);
    if (!cat) continue;
    spending[cat] = (spending[cat] || 0) + row.amount;
    if (row.amount > 0) totalSpending += row.amount;
  }

  // Floor at zero — for both default and any override categories
  for (const key of Object.keys(spending)) {
    if (spending[key] < 0) spending[key] = 0;
  }

  return { spending, totalIncome, totalSpending };
}

function getMonthTransactionsByCategory(year, month) {
  const startOfMonth = `${year}-${String(month).padStart(2, '0')}-01`;
  const endOfMonth = `${year}-${String(month).padStart(2, '0')}-31`;

  const rows = mainDb.prepare(
    'SELECT id, merchant, amount, category, date, raw_json FROM transactions WHERE date >= ? AND date <= ? ORDER BY date DESC'
  ).all(startOfMonth, endOfMonth);

  const overrides = loadOverrides();
  const grouped = {};
  for (const cat of BUDGET_CATEGORIES) grouped[cat] = [];

  for (const row of rows) {
    if (row.raw_json) {
      try {
        const raw = JSON.parse(row.raw_json);
        if (raw.account_id === WF_CHECKING_ID || raw.account_id === WF_SAVINGS_ID) continue;
      } catch (_) {}
    }

    if (isIncomeTransaction(row.merchant, row.category, row.amount)) continue;

    const cat = resolveCategory(row, overrides);
    if (!cat) continue;
    if (row.amount <= 0) continue;

    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push({
      id: row.id,
      merchant: row.merchant || 'Unknown',
      amount: row.amount,
      date: row.date,
    });
  }

  return grouped;
}

function setTransactionCategory(transactionId, budgetCategory) {
  if (!budgetCategory) {
    mainDb.prepare('DELETE FROM category_overrides WHERE transaction_id = ?').run(transactionId);
  } else {
    mainDb.prepare(
      'INSERT INTO category_overrides (transaction_id, budget_category) VALUES (?, ?) ON CONFLICT(transaction_id) DO UPDATE SET budget_category = ?'
    ).run(transactionId, budgetCategory, budgetCategory);
  }
}

const INVESTMENT_MERCHANTS = ['robinhood', 'vanguard'];

function isInvestmentTransaction(merchant) {
  const m = (merchant || '').toLowerCase();
  return INVESTMENT_MERCHANTS.some(g => m.includes(g));
}

function getMonthInvestments(year, month) {
  const startOfMonth = `${year}-${String(month).padStart(2, '0')}-01`;
  const endOfMonth = `${year}-${String(month).padStart(2, '0')}-31`;

  const rows = mainDb.prepare(
    'SELECT id, merchant, amount, date, raw_json FROM transactions WHERE date >= ? AND date <= ? ORDER BY date DESC'
  ).all(startOfMonth, endOfMonth);

  const transactions = [];
  let total = 0;
  const byPlatform = {};

  for (const row of rows) {
    if (!isInvestmentTransaction(row.merchant)) continue;
    if (row.amount <= 0) continue; // only count contributions (outflows)

    transactions.push({
      id: row.id,
      merchant: row.merchant,
      amount: row.amount,
      date: row.date,
    });
    total += row.amount;

    // Group by platform
    const platform = row.merchant;
    byPlatform[platform] = (byPlatform[platform] || 0) + row.amount;
  }

  return { transactions, total: parseFloat(total.toFixed(2)), byPlatform };
}

function getIncomeFromAllAccounts(year, month) {
  const startOfMonth = `${year}-${String(month).padStart(2, '0')}-01`;
  const endOfMonth = `${year}-${String(month).padStart(2, '0')}-31`;

  const rows = mainDb.prepare(
    'SELECT merchant, amount, category FROM transactions WHERE date >= ? AND date <= ?'
  ).all(startOfMonth, endOfMonth);

  let totalIncome = 0;
  for (const row of rows) {
    // Negative amounts = money in. Look for payroll/income patterns.
    if (row.amount < 0) {
      const m = (row.merchant || '').toLowerCase();
      const c = (row.category || '').toLowerCase();
      if (c.includes('payroll') || c.includes('income') || c.includes('direct dep') ||
          m.includes('payroll') || m.includes('direct deposit') || m.includes('adp') ||
          m.includes('gusto') || m.includes('employer')) {
        totalIncome += Math.abs(row.amount);
      }
    }
  }
  return totalIncome;
}

module.exports = {
  BUDGET_CATEGORIES,
  WF_CHECKING_ID,
  WF_SAVINGS_ID,
  categorizeTransaction,
  isIncomeTransaction,
  getMonthSpending,
  getMonthTransactionsByCategory,
  setTransactionCategory,
  getMonthInvestments,
  getIncomeFromAllAccounts,
  mainDb,
};

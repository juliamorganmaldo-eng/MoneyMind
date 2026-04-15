require('dotenv').config({ path: require('path').join(__dirname, '../plaid-integration/.env') });

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { Configuration, PlaidApi, PlaidEnvironments } = require('plaid');
const Anthropic = require('@anthropic-ai/sdk').default;
const fs   = require('fs');
const path = require('path');
const db = require('./db');

// ── Plaid client ──────────────────────────────────────────────────────────────

const plaidClient = new PlaidApi(new Configuration({
  basePath: PlaidEnvironments[process.env.PLAID_ENV || 'sandbox'],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
      'PLAID-SECRET':    process.env.PLAID_SECRET,
    },
  },
}));

const ACCOUNTS = {
  chase:       process.env.PLAID_ACCESS_TOKEN_CHASE,
  wells_fargo: process.env.PLAID_ACCESS_TOKEN_WELLS_FARGO,
};

const anthropic   = new Anthropic(); // reads ANTHROPIC_API_KEY from env
const ACTIONS_DIR = path.join(__dirname, 'actions');
if (!fs.existsSync(ACTIONS_DIR)) fs.mkdirSync(ACTIONS_DIR, { recursive: true });

function sanitizeFilename(name) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalizeMerchant(name) {
  if (!name) return 'unknown';
  return name.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

function detectInterval(gaps) {
  if (gaps.length === 0) return null;
  const median = gaps.slice().sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
  if (median >= 2  && median <= 9)   return 'weekly';
  if (median >= 25 && median <= 35)  return 'monthly';
  if (median >= 80 && median <= 100) return 'quarterly';
  if (median >= 340 && median <= 390) return 'annual';
  return null;
}

// ── Tool implementations ──────────────────────────────────────────────────────

async function syncTransactions({ days_back = 90 } = {}) {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days_back);
  const start = startDate.toISOString().split('T')[0];
  const end   = new Date().toISOString().split('T')[0];

  const upsert = db.prepare(`
    INSERT OR REPLACE INTO transactions (id, account, date, merchant, amount, category, raw_json)
    VALUES (@id, @account, @date, @merchant, @amount, @category, @raw_json)
  `);

  const results = {};

  for (const [account, accessToken] of Object.entries(ACCOUNTS)) {
    if (!accessToken) {
      results[account] = { error: 'No access token configured' };
      continue;
    }
    try {
      const res = await plaidClient.transactionsGet({
        access_token: accessToken,
        start_date: start,
        end_date: end,
      });
      const rows = res.data.transactions.map(t => ({
        id:       t.transaction_id,
        account,
        date:     t.date,
        merchant: t.merchant_name || t.name,
        amount:   t.amount,
        category: (t.category || []).join(' > '),
        raw_json: JSON.stringify(t),
      }));
      db.exec('BEGIN');
      for (const r of rows) upsert.run(r);
      db.exec('COMMIT');
      results[account] = { synced: rows.length, date_range: `${start} → ${end}` };
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch (_) {}
      results[account] = { error: err.response?.data?.error_message || err.message };
    }
  }

  return results;
}

const TRANSFER_KEYWORDS = ['transfer', 'xfer', 'overdraft', 'zelle', 'payment to', 'venmo', 'cash app', 'wire'];
const ONE_TIME_BOOKING_MERCHANTS = ['airbnb', 'vrbo', 'booking.com', 'hotels.com', 'marriott', 'hilton', 'hyatt', 'expedia', 'priceline', 'kayak', 'ihg'];
const TRANSFER_CATEGORY_KEYWORDS = ['transfer', 'payment', 'credit card payment', 'overdraft', 'loan payment'];

function isTransferOrPayment(merchant, category, rawJson) {
  const m = (merchant || '').toLowerCase();
  const c = (category || '').toLowerCase();
  if (c.includes('transfer') || c.includes('bank fees')) return true;
  if (TRANSFER_CATEGORY_KEYWORDS.some(k => c.includes(k))) return true;
  if (TRANSFER_KEYWORDS.some(k => m.includes(k))) return true;
  let raw = {};
  try { raw = rawJson ? JSON.parse(rawJson) : {}; } catch (_) {}
  if (raw.transaction_type === 'special') return true;
  const pfc = raw.personal_finance_category && raw.personal_finance_category.primary;
  if (pfc === 'TRANSFER_IN' || pfc === 'TRANSFER_OUT' || pfc === 'BANK_FEES' || pfc === 'LOAN_PAYMENTS') return true;
  if (TRANSFER_KEYWORDS.some(k => (raw.name || '').toLowerCase().includes(k))) return true;
  return false;
}

function isOneTimeBookingMerchant(merchant) {
  const m = (merchant || '').toLowerCase();
  return ONE_TIME_BOOKING_MERCHANTS.some(k => m.includes(k));
}

function detectRecurringCharges({ min_occurrences = 2, amount_tolerance_pct = 5 } = {}) {
  const rows = db.prepare(`
    SELECT merchant, account, date, amount, category, raw_json
    FROM transactions
    ORDER BY merchant, date
  `).all();

  // Group by normalized merchant, filtering out transfers/payments and one-time booking merchants up front
  const byMerchant = {};
  for (const row of rows) {
    if (isTransferOrPayment(row.merchant, row.category, row.raw_json)) continue;
    if (isOneTimeBookingMerchant(row.merchant)) continue;
    const key = normalizeMerchant(row.merchant);
    if (!byMerchant[key]) byMerchant[key] = [];
    byMerchant[key].push(row);
  }

  const recurring = [];
  for (const [, txns] of Object.entries(byMerchant)) {
    if (txns.length < min_occurrences) continue;

    // Group transactions into amount-bands within tolerance; only keep the largest band
    const sortedByAmt = txns.slice().sort((a, b) => a.amount - b.amount);
    const bands = [];
    for (const t of sortedByAmt) {
      const band = bands.find(b => {
        const min = Math.min(b.avg, t.amount);
        if (min <= 0) return false;
        return Math.abs(t.amount - b.avg) / min * 100 <= amount_tolerance_pct;
      });
      if (band) {
        band.items.push(t);
        band.avg = band.items.reduce((s, x) => s + x.amount, 0) / band.items.length;
      } else {
        bands.push({ avg: t.amount, items: [t] });
      }
    }
    const band = bands.sort((a, b) => b.items.length - a.items.length)[0];
    if (!band || band.items.length < min_occurrences) continue;

    const bandTxns = band.items.slice().sort((a, b) => new Date(a.date) - new Date(b.date));
    const dates = bandTxns.map(t => new Date(t.date).getTime());
    const gaps  = [];
    for (let i = 1; i < dates.length; i++) {
      gaps.push(Math.round((dates[i] - dates[i - 1]) / 86400000));
    }

    const interval = detectInterval(gaps);
    if (!interval) continue;

    const amounts = bandTxns.map(t => t.amount);
    const avgAmt  = amounts.reduce((s, a) => s + a, 0) / amounts.length;
    const minAmt  = Math.min(...amounts);
    const maxAmt  = Math.max(...amounts);
    const variancePct = minAmt > 0 ? ((maxAmt - minAmt) / minAmt) * 100 : 0;
    if (variancePct > amount_tolerance_pct) continue;

    const accounts = [...new Set(bandTxns.map(t => t.account))];

    recurring.push({
      merchant:        bandTxns[0].merchant,
      interval,
      occurrences:     bandTxns.length,
      avg_amount:      parseFloat(avgAmt.toFixed(2)),
      amount_variance_pct: parseFloat(variancePct.toFixed(2)),
      accounts,
      last_charge:     bandTxns[bandTxns.length - 1].date,
    });
  }

  return recurring.sort((a, b) => b.occurrences - a.occurrences);
}

function findDuplicateSubscriptions() {
  const rows = db.prepare(`
    SELECT merchant, account, amount, date
    FROM transactions
    ORDER BY merchant, date DESC
  `).all();

  // Group by normalized merchant, then by account (most recent charge per account)
  const byMerchant = {};
  for (const row of rows) {
    const key = normalizeMerchant(row.merchant);
    if (!byMerchant[key]) byMerchant[key] = {};
    if (!byMerchant[key][row.account]) {
      byMerchant[key][row.account] = { amount: row.amount, date: row.date, merchant: row.merchant };
    }
  }

  const duplicates = [];
  for (const [, accountMap] of Object.entries(byMerchant)) {
    const entries = Object.entries(accountMap); // [[account, {amount, date, merchant}]]
    if (entries.length < 2) continue;

    const amounts = entries.map(([, v]) => v.amount);
    const minAmt  = Math.min(...amounts);
    const maxAmt  = Math.max(...amounts);

    // Flag if amounts are within 20% of each other (same subscription tier)
    if (minAmt > 0 && (maxAmt - minAmt) / minAmt <= 0.20) {
      duplicates.push({
        merchant:    entries[0][1].merchant,
        found_on:    entries.map(([account, v]) => ({ account, amount: v.amount, last_charge: v.date })),
        total_monthly_waste: parseFloat((amounts.slice(1).reduce((s, a) => s + a, 0)).toFixed(2)),
      });
    }
  }

  return duplicates;
}

function detectPriceChanges({ threshold_pct = 10 } = {}) {
  const rows = db.prepare(`
    SELECT merchant, account, date, amount
    FROM transactions
    ORDER BY merchant, date ASC
  `).all();

  const byMerchant = {};
  for (const row of rows) {
    const key = normalizeMerchant(row.merchant);
    if (!byMerchant[key]) byMerchant[key] = [];
    byMerchant[key].push(row);
  }

  const changes = [];
  for (const [, txns] of Object.entries(byMerchant)) {
    if (txns.length < 2) continue;

    for (let i = 1; i < txns.length; i++) {
      const prev = txns[i - 1];
      const curr = txns[i];
      if (prev.amount === 0) continue;

      const pctChange = ((curr.amount - prev.amount) / Math.abs(prev.amount)) * 100;
      if (Math.abs(pctChange) >= threshold_pct) {
        changes.push({
          merchant:    curr.merchant,
          account:     curr.account,
          from_amount: prev.amount,
          to_amount:   curr.amount,
          change_pct:  parseFloat(pctChange.toFixed(1)),
          from_date:   prev.date,
          to_date:     curr.date,
          direction:   pctChange > 0 ? 'increase' : 'decrease',
        });
      }
    }
  }

  return changes.sort((a, b) => Math.abs(b.change_pct) - Math.abs(a.change_pct));
}

function saveFindings({ type, title, description, data }) {
  const stmt = db.prepare(`
    INSERT INTO findings (type, title, description, data_json)
    VALUES (@type, @title, @description, @data_json)
  `);
  const info = stmt.run({
    type,
    title,
    description: description || null,
    data_json:   data ? JSON.stringify(data) : null,
  });
  return { id: info.lastInsertRowid, type, title };
}

async function draftEmail({ merchant, issue_type, current_charge }) {
  const goal = issue_type === 'negotiation'
    ? `negotiate a lower rate on your current $${current_charge}/month charge`
    : `cancel your subscription charged at $${current_charge}/month`;

  const stream = anthropic.messages.stream({
    model: 'claude-opus-4-6',
    max_tokens: 1500,
    thinking: { type: 'adaptive' },
    system: 'You are an expert consumer advocate who writes highly effective, professional emails to companies. Your emails are concise, firm, and get results.',
    messages: [{
      role: 'user',
      content: `Write a professional email to ${merchant} to ${goal}.

Requirements:
- Start with "Subject:" on the first line
- Professional but assertive tone
- Reference competition or alternatives where relevant
- Include a specific, clear ask
- Set a deadline for response (5–7 business days)
- End with a polite but firm closing

Write only the email, ready to send.`,
    }],
  });

  const message = await stream.finalMessage();
  const content = message.content.filter(b => b.type === 'text').map(b => b.text).join('\n');

  const filename = `email_${sanitizeFilename(merchant)}_${Date.now()}.json`;
  const record   = { type: 'email', merchant, issue_type, current_charge, content, status: 'draft', created_at: new Date().toISOString(), filename };
  fs.writeFileSync(path.join(ACTIONS_DIR, filename), JSON.stringify(record, null, 2));
  return { saved_to: `actions/${filename}`, status: 'draft', content };
}

async function draftDisputeLetter({ merchant, charge_dates, amounts }) {
  const chargeList    = charge_dates.map((date, i) => `  - ${date}: $${amounts[i]}`).join('\n');
  const totalAmount   = amounts.reduce((s, a) => s + a, 0).toFixed(2);

  const stream = anthropic.messages.stream({
    model: 'claude-opus-4-6',
    max_tokens: 2000,
    thinking: { type: 'adaptive' },
    system: 'You are a consumer rights expert who writes formal, legally-sound billing dispute letters that cite relevant regulations and are structured to get results.',
    messages: [{
      role: 'user',
      content: `Write a formal billing dispute letter to ${merchant} regarding these charges:
${chargeList}
Total disputed: $${totalAmount}

Requirements:
- Formal letter format with date and address placeholders ([Your Name], [Your Address], [Date])
- Reference the Fair Credit Billing Act (FCBA) where applicable
- Clearly state each disputed charge and the reason for dispute
- Demand written confirmation of receipt within 30 days
- Request full reversal and written explanation
- Note intent to escalate to credit card issuer or CFPB if unresolved
- Professional signature block placeholder

Write only the letter, formatted for print.`,
    }],
  });

  const message = await stream.finalMessage();
  const content = message.content.filter(b => b.type === 'text').map(b => b.text).join('\n');

  const filename = `dispute_${sanitizeFilename(merchant)}_${Date.now()}.json`;
  const record   = { type: 'dispute_letter', merchant, charge_dates, amounts, total_disputed: parseFloat(totalAmount), content, status: 'draft', created_at: new Date().toISOString(), filename };
  fs.writeFileSync(path.join(ACTIONS_DIR, filename), JSON.stringify(record, null, 2));
  return { saved_to: `actions/${filename}`, status: 'draft', total_disputed: parseFloat(totalAmount), content };
}

async function draftPhoneScript({ merchant, goal }) {
  const stream = anthropic.messages.stream({
    model: 'claude-opus-4-6',
    max_tokens: 2500,
    thinking: { type: 'adaptive' },
    system: 'You are an expert negotiator and consumer advocate who creates effective, word-for-word call scripts. Your scripts prepare people for any response and help them achieve their goal.',
    messages: [{
      role: 'user',
      content: `Write a complete, word-for-word phone call script for calling ${merchant} with this goal: ${goal}

Structure the script with these sections:
1. **Before You Call** — what to have ready (account number, dates, amounts, etc.)
2. **Opening** — exact words when the agent picks up
3. **State Your Purpose** — clear, confident statement of why you're calling
4. **Talking Points** — 3–4 key points to make your case
5. **Handling Objections** — word-for-word responses to at least 3 likely pushbacks:
   - "That's not our policy" / "I can't do that"
   - Transfer attempts / stalling tactics
   - Offers of partial solutions that don't meet your goal
6. **Escalation** — exact words to ask for a supervisor if needed
7. **Closing** — how to confirm the outcome and get a confirmation number

Use [BRACKETED TEXT] for fill-in fields. Label responses as "You:" and agent responses as "Agent:".`,
    }],
  });

  const message = await stream.finalMessage();
  const content = message.content.filter(b => b.type === 'text').map(b => b.text).join('\n');

  const filename = `script_${sanitizeFilename(merchant)}_${Date.now()}.json`;
  const record   = { type: 'phone_script', merchant, goal, content, status: 'draft', created_at: new Date().toISOString(), filename };
  fs.writeFileSync(path.join(ACTIONS_DIR, filename), JSON.stringify(record, null, 2));
  return { saved_to: `actions/${filename}`, status: 'draft', content };
}

function getSavedActions() {
  if (!fs.existsSync(ACTIONS_DIR)) return [];
  return fs.readdirSync(ACTIONS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(filename => {
      try {
        const record = JSON.parse(fs.readFileSync(path.join(ACTIONS_DIR, filename), 'utf8'));
        return {
          filename:    record.filename,
          type:        record.type,
          merchant:    record.merchant,
          status:      record.status,
          created_at:  record.created_at,
          preview:     (record.content || '').slice(0, 160).replace(/\n/g, ' ').trim() + '…',
          ...(record.issue_type        && { issue_type:      record.issue_type }),
          ...(record.goal              && { goal:            record.goal }),
          ...(record.total_disputed != null && { total_disputed: record.total_disputed }),
        };
      } catch (_) {
        return { filename, error: 'Could not parse file' };
      }
    })
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
}

const { DatabaseSync } = require('node:sqlite');
const WEB_DB_PATH = path.join(__dirname, 'web', 'moneymind-web.db');
let webDb = null;
function getWebDb() {
  if (!webDb) webDb = new DatabaseSync(WEB_DB_PATH);
  return webDb;
}

const INVESTMENT_MERCHANTS = ['robinhood', 'vanguard'];

function estimateMonthlyInvestmentContribution() {
  const now = new Date();
  let total = 0, buckets = 0;
  for (let k = 1; k <= 3; k++) {
    const d = new Date(now.getFullYear(), now.getMonth() - k, 1);
    const y = d.getFullYear(), m = d.getMonth() + 1;
    const start = `${y}-${String(m).padStart(2, '0')}-01`;
    const end   = `${y}-${String(m).padStart(2, '0')}-31`;
    const rows = db.prepare(
      'SELECT merchant, amount FROM transactions WHERE date >= ? AND date <= ?'
    ).all(start, end);
    let monthTotal = 0;
    for (const r of rows) {
      const merch = (r.merchant || '').toLowerCase();
      if (r.amount > 0 && INVESTMENT_MERCHANTS.some(g => merch.includes(g))) monthTotal += r.amount;
    }
    total += monthTotal;
    buckets++;
  }
  return buckets > 0 ? parseFloat((total / buckets).toFixed(2)) : 0;
}

function requiredMonthlyContribution(target, progress, months, annualReturn) {
  const i = annualReturn / 12;
  const growth = Math.pow(1 + i, months);
  const remaining = target - progress * growth;
  if (remaining <= 0) return 0;
  if (i === 0) return remaining / months;
  return (remaining * i) / (growth - 1);
}

function calculateGoalGap({ user_id }) {
  if (!user_id) throw new Error('user_id is required');
  const wdb = getWebDb();

  const goals = wdb.prepare(
    'SELECT id, goal_type, name, target_amount, current_progress, target_date FROM goals WHERE user_id = ?'
  ).all(user_id);

  const ledger = wdb.prepare(
    'SELECT savings_type, amount FROM savings_ledger WHERE user_id = ?'
  ).all(user_id);

  const ledgerMonthlyPool = ledger
    .filter(r => r.savings_type === 'recurring_monthly')
    .reduce((s, r) => s + Number(r.amount), 0);

  const currentMonthly = estimateMonthlyInvestmentContribution();
  const now = new Date();

  const results = goals.map(g => {
    const target = new Date(g.target_date);
    const months = Math.max(1, (target.getFullYear() - now.getFullYear()) * 12 + (target.getMonth() - now.getMonth()));
    const years  = months / 12;

    const rate = years < 5 ? 0.045 : 0.07;
    const horizon = years < 5 ? 'short_term (HYSA 4.5%)' : 'long_term (7% growth)';

    const required = requiredMonthlyContribution(
      Number(g.target_amount),
      Number(g.current_progress || 0),
      months,
      rate
    );

    const delta = required - currentMonthly; // positive = shortfall, negative = surplus
    const shortfall = delta > 0 ? delta : 0;
    const surplus   = delta < 0 ? -delta : 0;
    const ledger_can_cover = Math.min(shortfall, ledgerMonthlyPool);
    const remaining_gap    = Math.max(0, shortfall - ledger_can_cover);

    let flag = null;
    if (shortfall > 0 && ledger_can_cover >= shortfall) flag = 'ledger_closes_full_gap';
    else if (shortfall > 0 && ledger_can_cover > 0)    flag = 'ledger_closes_partial_gap';

    return {
      goal_id:           g.id,
      goal_type:         g.goal_type,
      name:              g.name,
      target_amount:     Number(g.target_amount),
      current_progress:  Number(g.current_progress || 0),
      target_date:       g.target_date,
      months_remaining:  months,
      horizon,
      assumed_annual_return: rate,
      required_monthly:  parseFloat(required.toFixed(2)),
      current_monthly:   currentMonthly,
      monthly_shortfall: parseFloat(shortfall.toFixed(2)),
      monthly_surplus:   parseFloat(surplus.toFixed(2)),
      ledger_can_cover:  parseFloat(ledger_can_cover.toFixed(2)),
      remaining_gap:     parseFloat(remaining_gap.toFixed(2)),
      flag,
    };
  });

  return {
    user_id,
    current_monthly_contribution: currentMonthly,
    ledger_monthly_pool: parseFloat(ledgerMonthlyPool.toFixed(2)),
    goals: results,
  };
}

const TOTAL_MARKET_FUNDS = {
  vanguard:   { ticker: 'VTI',    name: 'Vanguard Total Stock Market ETF',       expense_ratio: 0.03 },
  vanguard_mf:{ ticker: 'VTSAX',  name: 'Vanguard Total Stock Market Index Fund',expense_ratio: 0.04 },
  fidelity:   { ticker: 'FSKAX',  name: 'Fidelity Total Market Index Fund',      expense_ratio: 0.015 },
  schwab:     { ticker: 'SWTSX',  name: 'Schwab Total Stock Market Index',       expense_ratio: 0.03 },
  ishares:    { ticker: 'ITOT',   name: 'iShares Core S&P Total U.S. Stock ETF', expense_ratio: 0.03 },
};

const BALANCED_FUNDS = {
  vanguard:  { ticker: 'VBIAX', name: 'Vanguard Balanced Index Fund (60/40)',   expense_ratio: 0.07 },
  fidelity:  { ticker: 'FBALX', name: 'Fidelity Balanced Fund',                 expense_ratio: 0.48 },
  ishares:   { ticker: 'AOR',   name: 'iShares Core Growth Allocation (60/40)', expense_ratio: 0.15 },
};

const HYSA_OPTIONS = [
  { name: 'Ally Bank Savings',            apy_est: 4.2, fdic_insured: true },
  { name: 'Marcus by Goldman Sachs',      apy_est: 4.3, fdic_insured: true },
  { name: 'Wealthfront Cash Account',     apy_est: 4.5, fdic_insured: true },
  { name: 'Capital One 360 Performance',  apy_est: 4.1, fdic_insured: true },
];

// Industry-average expense ratio for actively managed equity mutual funds (ICI, most recent)
const ACTIVE_MF_AVG_ER = 0.66;

function vanguardTargetDateFund(retirementYear) {
  const bucket = Math.round(retirementYear / 5) * 5;
  const y2 = String(bucket).slice(-2);
  return { ticker: `VFFVX`.replace('55', y2), name: `Vanguard Target Retirement ${bucket} Fund`, expense_ratio: 0.08, target_year: bucket };
}

function recommendFund({
  account_type,
  time_horizon_years,
  risk_tolerance = 'moderate',
  brokerage = 'vanguard',
  retirement_year,
}) {
  if (!account_type) throw new Error('account_type is required');
  if (time_horizon_years == null) throw new Error('time_horizon_years is required');

  const acct = account_type.toLowerCase().replace(/[^a-z0-9]/g, '');
  const years = Number(time_horizon_years);
  const brok  = (brokerage || 'vanguard').toLowerCase();

  const disclaimer = 'Past performance does not guarantee future results. This is general educational information, not personalized investment advice. Confirm suitability with a fiduciary advisor or your account provider before investing.';

  // Hard rule: short horizon or cash account → HYSA, never equities
  if (years < 5 || acct === 'hysa' || acct === 'highyieldsavings' || acct === 'savings') {
    const top = HYSA_OPTIONS.slice().sort((a, b) => b.apy_est - a.apy_est);
    return {
      account_type,
      time_horizon_years: years,
      horizon_bucket: 'short_term (<5 yrs)',
      recommendation: {
        product_type: 'FDIC-insured high-yield savings account',
        primary: top[0],
        alternates: top.slice(1),
        rationale: 'For horizons under 5 years, principal preservation matters more than return. Equities can draw down 30-40% in any given year, which is unacceptable when the money is needed soon. FDIC insurance protects up to $250k per depositor per bank.',
      },
      comparison_to_active: null,
      disclaimer,
    };
  }

  // Long horizon → total market index
  if (years > 10) {
    const fund = TOTAL_MARKET_FUNDS[brok] || TOTAL_MARKET_FUNDS.vanguard;
    return {
      account_type,
      time_horizon_years: years,
      horizon_bucket: 'long_term (>10 yrs)',
      recommendation: {
        product_type: 'Low-cost total market index fund',
        primary: fund,
        alternates: Object.values(TOTAL_MARKET_FUNDS).filter(f => f.ticker !== fund.ticker),
        rationale: `Over 10+ year horizons, broad U.S. equity index funds have historically outperformed the vast majority of actively managed funds, largely because of fee drag. ${fund.ticker} holds essentially every publicly traded U.S. company at a ${fund.expense_ratio}% expense ratio, vs. the ~${ACTIVE_MF_AVG_ER}% industry average for active equity funds.`,
      },
      comparison_to_active: {
        recommended_expense_ratio: fund.expense_ratio,
        active_fund_average:       ACTIVE_MF_AVG_ER,
        annual_savings_per_10k:    parseFloat(((ACTIVE_MF_AVG_ER - fund.expense_ratio) / 100 * 10000).toFixed(2)),
        note: `On a $10,000 balance, the recommended fund costs roughly $${(fund.expense_ratio/100*10000).toFixed(2)}/yr vs. ~$${(ACTIVE_MF_AVG_ER/100*10000).toFixed(2)}/yr for the average active fund.`,
      },
      disclaimer,
    };
  }

  // 5–10 yr horizon → balanced or target-date
  const useTargetDate = !!retirement_year && acct !== 'taxablebrokerage' && acct !== 'taxable';
  let primary, altList, productType, rationale;
  if (useTargetDate) {
    primary = vanguardTargetDateFund(Number(retirement_year));
    altList = [BALANCED_FUNDS.vanguard, BALANCED_FUNDS.ishares];
    productType = 'Target-date retirement fund';
    rationale = `With a retirement year around ${primary.target_year} and a ${years}-year intermediate horizon, a target-date fund automatically glides from stocks to bonds as the date approaches, so you don't have to rebalance. Expense ratio ${primary.expense_ratio}%.`;
  } else {
    primary = BALANCED_FUNDS[brok] || BALANCED_FUNDS.vanguard;
    altList = Object.values(BALANCED_FUNDS).filter(f => f.ticker !== primary.ticker).concat([vanguardTargetDateFund(new Date().getFullYear() + Math.round(years))]);
    productType = 'Balanced index fund (roughly 60/40 stocks/bonds)';
    rationale = `For a ${years}-year horizon with a ${risk_tolerance} risk tolerance, a 60/40 balanced index fund like ${primary.ticker} smooths drawdowns while still capturing equity growth. Expense ratio ${primary.expense_ratio}%.`;
  }

  return {
    account_type,
    time_horizon_years: years,
    horizon_bucket: 'intermediate (5-10 yrs)',
    recommendation: {
      product_type: productType,
      primary,
      alternates: altList,
      rationale,
    },
    comparison_to_active: {
      recommended_expense_ratio: primary.expense_ratio,
      active_fund_average:       ACTIVE_MF_AVG_ER,
      annual_savings_per_10k:    parseFloat(((ACTIVE_MF_AVG_ER - primary.expense_ratio) / 100 * 10000).toFixed(2)),
      note: `At ${primary.expense_ratio}% vs. the ~${ACTIVE_MF_AVG_ER}% active-fund average, you keep about $${(((ACTIVE_MF_AVG_ER - primary.expense_ratio) / 100) * 10000).toFixed(2)}/yr more per $10,000 invested.`,
    },
    disclaimer,
  };
}

function estimateMonthlySpending() {
  const now = new Date();
  let total = 0, buckets = 0;
  for (let k = 1; k <= 3; k++) {
    const d = new Date(now.getFullYear(), now.getMonth() - k, 1);
    const y = d.getFullYear(), m = d.getMonth() + 1;
    const start = `${y}-${String(m).padStart(2, '0')}-01`;
    const end   = `${y}-${String(m).padStart(2, '0')}-31`;
    const rows = db.prepare('SELECT merchant, amount, category FROM transactions WHERE date >= ? AND date <= ?').all(start, end);
    let monthTotal = 0;
    for (const r of rows) {
      if (r.amount <= 0) continue;
      const c = (r.category || '').toLowerCase();
      const merch = (r.merchant || '').toLowerCase();
      if (c.includes('transfer') || c.includes('payment') || c.includes('deposit')) continue;
      if (INVESTMENT_MERCHANTS.some(g => merch.includes(g))) continue;
      monthTotal += r.amount;
    }
    total += monthTotal; buckets++;
  }
  return buckets > 0 ? total / buckets : 0;
}

function routeSavingsToAccount({
  monthly_amount,
  user_id,
  debts = [],                         // [{name, balance, apr}]
  employer_match = null,              // {unused_monthly_match} or {percent, salary, current_contribution_pct}
  emergency_fund_balance = 0,
  monthly_spending,                   // optional override
  roth_ira_ytd_contributed = 0,
  roth_ira_eligible = true,
  k401_ytd_contributed = 0,
  k401_annual_limit = 24000,          // 2026 est.
  roth_ira_annual_limit = 7000,       // 2026
}) {
  if (!(monthly_amount > 0)) throw new Error('monthly_amount must be > 0');

  const now = new Date();
  const monthsRemainingThisYear = 12 - now.getMonth(); // includes current
  const spending = monthly_spending != null ? Number(monthly_spending) : estimateMonthlySpending();
  const emergencyTarget = spending * 3;

  let remaining = monthly_amount;
  const allocations = [];
  const alloc = (priority, account, amount, reason) => {
    const amt = Math.min(amount, remaining);
    if (amt <= 0) return;
    allocations.push({
      priority,
      account,
      monthly_amount: parseFloat(amt.toFixed(2)),
      reason,
    });
    remaining = parseFloat((remaining - amt).toFixed(2));
  };

  // 1. High-interest debt (>8% APR)
  const highApr = debts.filter(d => Number(d.apr) > 8 && Number(d.balance) > 0)
                       .sort((a, b) => Number(b.apr) - Number(a.apr));
  for (const d of highApr) {
    if (remaining <= 0) break;
    alloc(
      1,
      `Debt payoff — ${d.name}`,
      remaining, // dump into highest-APR debt
      `${d.name} carries ${d.apr}% APR, which is a guaranteed "return" higher than any market assumption. Paying down $${d.balance.toLocaleString()} here first avoids compounding interest charges.`
    );
  }

  // 2. Unused employer 401(k) match
  let unusedMatch = 0;
  if (employer_match) {
    if (employer_match.unused_monthly_match != null) {
      unusedMatch = Number(employer_match.unused_monthly_match);
    } else if (employer_match.percent != null && employer_match.salary != null) {
      const fullMatchMonthly = (Number(employer_match.salary) * (Number(employer_match.percent) / 100)) / 12;
      const currentMatchMonthly = employer_match.current_contribution_pct != null
        ? (Number(employer_match.salary) * (Number(employer_match.current_contribution_pct) / 100)) / 12
        : 0;
      unusedMatch = Math.max(0, fullMatchMonthly - currentMatchMonthly);
    }
  }
  if (remaining > 0 && unusedMatch > 0) {
    alloc(
      2,
      '401(k) — capture employer match',
      unusedMatch,
      `You're leaving about $${unusedMatch.toFixed(0)}/mo of employer match on the table. That's a 100% instant return — no other account beats free money.`
    );
  }

  // 3. Emergency fund to 3 months of spending (HYSA)
  const emergencyGap = Math.max(0, emergencyTarget - emergency_fund_balance);
  if (remaining > 0 && emergencyGap > 0) {
    // Spread over up to 12 months so it's actionable, not a wall
    const monthlyToEmergency = Math.min(remaining, emergencyGap / 12, remaining);
    alloc(
      3,
      'High-yield savings account (emergency fund)',
      Math.min(remaining, Math.max(monthlyToEmergency, Math.min(remaining, emergencyGap))),
      `Your emergency fund of $${emergency_fund_balance.toLocaleString()} is short of the 3-month target ($${emergencyTarget.toLocaleString()} based on ~$${spending.toFixed(0)}/mo spending). Keep this in a HYSA (~4.5% APY) for liquidity.`
    );
  }

  // 4. Roth IRA up to annual limit
  if (remaining > 0 && roth_ira_eligible) {
    const rothRemainingAnnual = Math.max(0, roth_ira_annual_limit - roth_ira_ytd_contributed);
    const rothMonthlyCap = rothRemainingAnnual / monthsRemainingThisYear;
    if (rothMonthlyCap > 0) {
      alloc(
        4,
        'Roth IRA',
        rothMonthlyCap,
        `Roth IRA contributions grow tax-free and come out tax-free in retirement. You have $${rothRemainingAnnual.toFixed(0)} of 2026 headroom left (limit $${roth_ira_annual_limit}); splitting that across the ${monthsRemainingThisYear} remaining months works out to $${rothMonthlyCap.toFixed(0)}/mo.`
      );
    }
  }

  // 5. 401(k) up to annual limit (beyond the match)
  if (remaining > 0) {
    const k401RemainingAnnual = Math.max(0, k401_annual_limit - k401_ytd_contributed);
    const k401MonthlyCap = k401RemainingAnnual / monthsRemainingThisYear;
    if (k401MonthlyCap > 0) {
      alloc(
        5,
        '401(k) — additional pre-tax contributions',
        k401MonthlyCap,
        `After the Roth, add more to your 401(k) for the pre-tax deduction. You have $${k401RemainingAnnual.toFixed(0)} of 2026 headroom ($${k401_annual_limit} limit), which is $${k401MonthlyCap.toFixed(0)}/mo across the rest of the year.`
      );
    }
  }

  // 6. Taxable brokerage
  if (remaining > 0) {
    alloc(
      6,
      'Taxable brokerage',
      remaining,
      `All tax-advantaged buckets for this year are full. Park remaining savings in a taxable brokerage (Vanguard/Robinhood) in broad index funds — fully liquid and still compounding.`
    );
  }

  return {
    monthly_amount,
    user_id: user_id ?? null,
    assumptions: {
      monthly_spending: parseFloat(spending.toFixed(2)),
      emergency_fund_target_3mo: parseFloat(emergencyTarget.toFixed(2)),
      months_remaining_this_year: monthsRemainingThisYear,
      roth_ira_annual_limit,
      k401_annual_limit,
    },
    allocations,
    unallocated_monthly: parseFloat(Math.max(0, remaining).toFixed(2)),
  };
}

function recommendLumpSumDeployment({
  amount,
  user_id,
  debts = [],
  emergency_fund_balance = 0,
  monthly_spending,
  priority_investment_account = 'Roth IRA',
  recommended_fund_ticker,
  source_merchant,
  credit_date,
}) {
  if (!(amount > 0)) throw new Error('amount must be > 0');

  const spending = monthly_spending != null ? Number(monthly_spending) : estimateMonthlySpending();
  const emergencyTarget = spending * 3;
  const emergencyGap = Math.max(0, emergencyTarget - emergency_fund_balance);

  const highApr = debts.filter(d => Number(d.apr) > 8 && Number(d.balance) > 0)
                       .sort((a, b) => Number(b.apr) - Number(a.apr));

  let destination, reason, applied_amount, leftover = 0;

  if (highApr.length > 0) {
    const top = highApr[0];
    applied_amount = Math.min(amount, Number(top.balance));
    leftover       = parseFloat((amount - applied_amount).toFixed(2));
    destination    = `Debt payoff — ${top.name}`;
    reason         = `${top.name} carries ${top.apr}% APR. Paying down $${applied_amount.toFixed(2)} of a $${Number(top.balance).toLocaleString()} balance is a guaranteed ${top.apr}% return — better than any market assumption. This is the first use of any windfall.`;
  } else if (emergencyGap > 0) {
    applied_amount = Math.min(amount, emergencyGap);
    leftover       = parseFloat((amount - applied_amount).toFixed(2));
    destination    = 'High-yield savings account (emergency fund)';
    reason         = `Your emergency fund is $${emergency_fund_balance.toLocaleString()}, short of the 3-month target of $${emergencyTarget.toFixed(0)} (based on ~$${spending.toFixed(0)}/mo spending). Depositing $${applied_amount.toFixed(2)} into a HYSA closes $${applied_amount.toFixed(2)} of that gap while staying fully liquid and FDIC-insured.`;
  } else {
    applied_amount = amount;
    destination    = priority_investment_account;
    reason         = `No high-interest debt and emergency fund fully funded. Deploy the full $${amount.toFixed(2)} into your ${priority_investment_account}${recommended_fund_ticker ? ` (e.g. ${recommended_fund_ticker})` : ''}. A one-time lump sum invested now has decades to compound — the earlier it's in the market, the larger the tail.`;
  }

  const i = 0.07 / 12;
  const fv = (n) => applied_amount * Math.pow(1 + i, n);
  const growth = {
    principal:    parseFloat(applied_amount.toFixed(2)),
    ten_year:     { future_value: parseFloat(fv(120).toFixed(2)), growth: parseFloat((fv(120) - applied_amount).toFixed(2)) },
    twenty_year:  { future_value: parseFloat(fv(240).toFixed(2)), growth: parseFloat((fv(240) - applied_amount).toFixed(2)) },
    assumption:   'Compounded monthly at 7% annualized; real returns will vary.',
  };

  const today = new Date().toISOString().slice(0, 10);
  const creditDate = credit_date || today;
  const isSameDay = creditDate === today;

  const notification = {
    channel:      'in_app',
    surfaced_at:  new Date().toISOString(),
    same_day:     isSameDay,
    title:        `New credit detected${source_merchant ? ` from ${source_merchant}` : ''}: $${amount.toFixed(2)}`,
    body:         `MoneyMind recommends sending $${applied_amount.toFixed(2)} to "${destination}". ${destination.startsWith('Debt') ? '' : `Left untouched at 7%, that grows to about $${growth.ten_year.future_value.toLocaleString()} in 10 years and $${growth.twenty_year.future_value.toLocaleString()} in 20.`}`,
    cta:          { label: `Move to ${destination}`, action: 'deploy_lump_sum' },
  };

  return {
    user_id: user_id ?? null,
    amount,
    credit_date: creditDate,
    source_merchant: source_merchant || null,
    recommendation: {
      destination,
      applied_amount: parseFloat(applied_amount.toFixed(2)),
      leftover_for_next_priority: leftover,
      reason,
    },
    projection_7pct: growth,
    notification,
    checks: {
      high_interest_debt_above_8pct: highApr.length > 0,
      emergency_fund_below_3mo:      emergencyGap > 0,
      emergency_fund_target_3mo:     parseFloat(emergencyTarget.toFixed(2)),
    },
    disclaimer: 'Past performance does not guarantee future results. Projections assume a constant 7% annual return, compounded monthly; actual returns will vary.',
  };
}

function recordSaving({ user_id, merchant, finding_type, savings_type, amount, confirmed_date, note }) {
  if (!['one_time', 'recurring_monthly'].includes(savings_type)) {
    throw new Error(`savings_type must be 'one_time' or 'recurring_monthly'`);
  }
  const info = db.prepare(`
    INSERT INTO savings_ledger (user_id, merchant, finding_type, savings_type, amount, confirmed_date, note)
    VALUES (@user_id, @merchant, @finding_type, @savings_type, @amount, @confirmed_date, @note)
  `).run({
    user_id,
    merchant,
    finding_type,
    savings_type,
    amount,
    confirmed_date,
    note: note || null,
  });
  return { id: info.lastInsertRowid, user_id, merchant, finding_type, savings_type, amount, confirmed_date };
}

function getSavingsSummary({ user_id }) {
  const rows = db.prepare(`
    SELECT id, merchant, finding_type, savings_type, amount, confirmed_date
    FROM savings_ledger
    WHERE user_id = ?
  `).all(user_id);

  let total_one_time = 0;
  let total_monthly_recurring = 0;
  for (const r of rows) {
    if (r.savings_type === 'one_time') total_one_time += r.amount;
    else if (r.savings_type === 'recurring_monthly') total_monthly_recurring += r.amount;
  }
  const projected_annual_recurring = total_monthly_recurring * 12;

  const ranked = rows.map(r => ({
    ...r,
    impact: r.savings_type === 'recurring_monthly' ? r.amount * 12 : r.amount,
  })).sort((a, b) => b.impact - a.impact).slice(0, 5);

  return {
    total_one_time_savings:      parseFloat(total_one_time.toFixed(2)),
    total_monthly_recurring:     parseFloat(total_monthly_recurring.toFixed(2)),
    projected_annual_recurring:  parseFloat(projected_annual_recurring.toFixed(2)),
    top_five_by_impact: ranked.map(r => ({
      id:             r.id,
      merchant:       r.merchant,
      finding_type:   r.finding_type,
      savings_type:   r.savings_type,
      amount:         r.amount,
      confirmed_date: r.confirmed_date,
      annualized_impact: parseFloat(r.impact.toFixed(2)),
    })),
  };
}

// ── MCP server ────────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'moneymind', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'sync_transactions',
      description: 'Fetch and store transactions from Chase and Wells Fargo via Plaid. Defaults to last 90 days.',
      inputSchema: {
        type: 'object',
        properties: {
          days_back: { type: 'number', description: 'How many days back to sync (default: 90)' },
        },
      },
    },
    {
      name: 'detect_recurring_charges',
      description: 'Analyze stored transactions to find recurring charges (weekly, monthly, quarterly, annual).',
      inputSchema: {
        type: 'object',
        properties: {
          min_occurrences: { type: 'number', description: 'Minimum times a charge must appear (default: 2)' },
        },
      },
    },
    {
      name: 'find_duplicate_subscriptions',
      description: 'Find the same subscription or merchant charged across multiple accounts.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'detect_price_changes',
      description: 'Detect merchants where the charge amount has changed over time.',
      inputSchema: {
        type: 'object',
        properties: {
          threshold_pct: { type: 'number', description: 'Minimum % change to flag (default: 10)' },
        },
      },
    },
    {
      name: 'save_findings',
      description: 'Save an analysis finding to the local database.',
      inputSchema: {
        type: 'object',
        required: ['type', 'title'],
        properties: {
          type:        { type: 'string', enum: ['recurring', 'duplicate_subscription', 'price_change', 'other'] },
          title:       { type: 'string', description: 'Short title for the finding' },
          description: { type: 'string', description: 'Detailed description' },
          data:        { type: 'object', description: 'Structured data to store with the finding' },
        },
      },
    },
    {
      name: 'draft_email',
      description: 'Write a professional rate-negotiation or cancellation email for a merchant and save it to the actions/ folder.',
      inputSchema: {
        type: 'object',
        required: ['merchant', 'issue_type', 'current_charge'],
        properties: {
          merchant:       { type: 'string',  description: 'Merchant or company name' },
          issue_type:     { type: 'string',  enum: ['negotiation', 'cancellation'], description: 'Goal of the email' },
          current_charge: { type: 'number',  description: 'Current monthly charge amount in dollars' },
        },
      },
    },
    {
      name: 'draft_dispute_letter',
      description: 'Write a formal billing dispute letter for a merchant and save it to the actions/ folder.',
      inputSchema: {
        type: 'object',
        required: ['merchant', 'charge_dates', 'amounts'],
        properties: {
          merchant:     { type: 'string', description: 'Merchant or company name' },
          charge_dates: { type: 'array',  items: { type: 'string' }, description: 'List of charge dates (YYYY-MM-DD)' },
          amounts:      { type: 'array',  items: { type: 'number' }, description: 'List of disputed amounts in dollars, matching charge_dates' },
        },
      },
    },
    {
      name: 'draft_phone_script',
      description: 'Write a word-for-word call script with talking points and counterarguments, saved to the actions/ folder.',
      inputSchema: {
        type: 'object',
        required: ['merchant', 'goal'],
        properties: {
          merchant: { type: 'string', description: 'Merchant or company name to call' },
          goal:     { type: 'string', description: 'What you want to achieve (e.g. "cancel subscription", "negotiate lower rate")' },
        },
      },
    },
    {
      name: 'recommend_lump_sum_deployment',
      description: 'For a one-time refund/credit, recommend where to deploy it: (1) high-interest debt >8% APR, (2) emergency fund if <3 months spending, (3) otherwise the priority investment account. Returns 10- and 20-year growth at 7% and a same-day notification payload.',
      inputSchema: {
        type: 'object',
        required: ['amount'],
        properties: {
          amount:                       { type: 'number', description: 'Lump sum amount in dollars' },
          user_id:                      { type: 'number', description: 'Optional user_id for context' },
          debts:                        { type: 'array',  items: { type: 'object', properties: { name: { type: 'string' }, balance: { type: 'number' }, apr: { type: 'number' } } } },
          emergency_fund_balance:       { type: 'number', description: 'Current emergency fund balance' },
          monthly_spending:             { type: 'number', description: 'Override monthly spending (default: avg last 3 months)' },
          priority_investment_account:  { type: 'string', description: 'Where to deploy if no debt/emergency need (default: Roth IRA)' },
          recommended_fund_ticker:      { type: 'string', description: 'Optional fund ticker to suggest (e.g. VTI)' },
          source_merchant:              { type: 'string', description: 'Merchant that issued the credit, for notification copy' },
          credit_date:                  { type: 'string', description: 'Date the credit posted (YYYY-MM-DD); defaults to today' },
        },
      },
    },
    {
      name: 'recommend_fund',
      description: 'Recommend a specific fund/product given account type, time horizon, and risk tolerance. >10y → total market index (VTI/VTSAX/FSKAX, ER <0.05%); 5–10y → balanced or target-date fund; <5y → FDIC-insured HYSA only. Includes expense ratio vs. active-fund average and a disclaimer.',
      inputSchema: {
        type: 'object',
        required: ['account_type', 'time_horizon_years'],
        properties: {
          account_type:       { type: 'string', description: 'Roth IRA, 401k, taxable brokerage, HYSA, etc.' },
          time_horizon_years: { type: 'number', description: 'Years until the money is needed' },
          risk_tolerance:     { type: 'string', enum: ['conservative', 'moderate', 'aggressive'], description: 'Default: moderate' },
          brokerage:          { type: 'string', description: 'Preferred brokerage: vanguard, fidelity, schwab, ishares (default vanguard)' },
          retirement_year:    { type: 'number', description: 'For target-date funds — the year of planned retirement' },
        },
      },
    },
    {
      name: 'route_savings_to_account',
      description: 'Recommend where a recovered monthly saving should go, in priority order: high-interest debt → unused 401(k) match → emergency fund (HYSA) → Roth IRA → 401(k) → taxable brokerage. Returns an ordered allocation with plain-English reasoning.',
      inputSchema: {
        type: 'object',
        required: ['monthly_amount'],
        properties: {
          monthly_amount:           { type: 'number', description: 'Recovered monthly saving to route (dollars)' },
          user_id:                  { type: 'number', description: 'Optional user_id for context' },
          debts:                    { type: 'array',  items: { type: 'object', properties: { name: { type: 'string' }, balance: { type: 'number' }, apr: { type: 'number' } } }, description: 'User\'s debts (any APR; only those >8% are prioritized)' },
          employer_match:           { type: 'object', description: '{unused_monthly_match} or {percent, salary, current_contribution_pct}' },
          emergency_fund_balance:   { type: 'number', description: 'Current balance in emergency fund / HYSA' },
          monthly_spending:         { type: 'number', description: 'Override monthly spending estimate (default: avg last 3 months)' },
          roth_ira_ytd_contributed: { type: 'number', description: 'Roth IRA contributed year-to-date' },
          roth_ira_eligible:        { type: 'boolean', description: 'Whether the user is under the Roth income phaseout (default true)' },
          k401_ytd_contributed:     { type: 'number', description: '401(k) contributed year-to-date' },
          k401_annual_limit:        { type: 'number', description: 'Override 401(k) annual limit (default 24000 for 2026)' },
          roth_ira_annual_limit:    { type: 'number', description: 'Override Roth IRA annual limit (default 7000 for 2026)' },
        },
      },
    },
    {
      name: 'calculate_goal_gap',
      description: 'For each of the user\'s goals, compute required monthly contribution (7% long-term / 4.5% short-term HYSA), compare to current monthly investment contribution, and flag goals whose gap can be partially or fully closed by recurring savings from the ledger.',
      inputSchema: {
        type: 'object',
        required: ['user_id'],
        properties: {
          user_id: { type: 'number', description: 'ID of the user (from the web app users table)' },
        },
      },
    },
    {
      name: 'record_saving',
      description: 'Record a confirmed saving (refund or negotiated monthly reduction) in the savings ledger.',
      inputSchema: {
        type: 'object',
        required: ['user_id', 'merchant', 'finding_type', 'savings_type', 'amount', 'confirmed_date'],
        properties: {
          user_id:        { type: 'number', description: 'ID of the user this saving belongs to' },
          merchant:       { type: 'string', description: 'Merchant or company name the saving came from' },
          finding_type:   { type: 'string', description: 'Origin of the saving (e.g. recurring, duplicate_subscription, price_change, dispute)' },
          savings_type:   { type: 'string', enum: ['one_time', 'recurring_monthly'], description: 'One-time refund vs. recurring monthly reduction' },
          amount:         { type: 'number', description: 'Dollar amount (one-time total, or monthly reduction)' },
          confirmed_date: { type: 'string', description: 'Date the saving was confirmed (YYYY-MM-DD)' },
          note:           { type: 'string', description: 'Optional note or context' },
        },
      },
    },
    {
      name: 'get_savings_summary',
      description: 'Summarize savings for a user: total one-time, total monthly recurring, projected annual recurring, and top 5 by impact.',
      inputSchema: {
        type: 'object',
        required: ['user_id'],
        properties: {
          user_id: { type: 'number', description: 'ID of the user' },
        },
      },
    },
    {
      name: 'get_saved_actions',
      description: 'List all drafts saved in the actions/ folder with their type, merchant, status, and a short preview.',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result;

    switch (name) {
      case 'sync_transactions':
        result = await syncTransactions(args);
        break;
      case 'detect_recurring_charges':
        result = detectRecurringCharges(args);
        break;
      case 'find_duplicate_subscriptions':
        result = findDuplicateSubscriptions();
        break;
      case 'detect_price_changes':
        result = detectPriceChanges(args);
        break;
      case 'save_findings':
        result = saveFindings(args);
        break;
      case 'draft_email':
        result = await draftEmail(args);
        break;
      case 'draft_dispute_letter':
        result = await draftDisputeLetter(args);
        break;
      case 'draft_phone_script':
        result = await draftPhoneScript(args);
        break;
      case 'recommend_lump_sum_deployment':
        result = recommendLumpSumDeployment(args);
        break;
      case 'recommend_fund':
        result = recommendFund(args);
        break;
      case 'route_savings_to_account':
        result = routeSavingsToAccount(args);
        break;
      case 'calculate_goal_gap':
        result = calculateGoalGap(args);
        break;
      case 'record_saving':
        result = recordSaving(args);
        break;
      case 'get_savings_summary':
        result = getSavingsSummary(args);
        break;
      case 'get_saved_actions':
        result = getSavedActions();
        break;
      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error: ${err.message}` }],
      isError: true,
    };
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('MoneyMind MCP server running on stdio');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});

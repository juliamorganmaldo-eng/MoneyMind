const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { pool } = require('../db');
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk').default;

const mainDb = new DatabaseSync(path.join(__dirname, '../../moneymind.db'));

function normalizeMerchant(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 30);
}

function detectInterval(gaps) {
  if (gaps.length === 0) return null;
  const avg = gaps.reduce((s, g) => s + g, 0) / gaps.length;
  if (avg >= 1 && avg <= 10) return 'weekly';
  if (avg >= 25 && avg <= 35) return 'monthly';
  if (avg >= 80 && avg <= 100) return 'quarterly';
  if (avg >= 350 && avg <= 380) return 'annual';
  return null;
}

const TRANSFER_NAME_KEYWORDS = ['transfer', 'xfer', 'overdraft', 'zelle', 'payment to', 'online transfer'];
const ONE_TIME_BOOKING_MERCHANTS = ['airbnb', 'vrbo', 'booking.com', 'hotels.com', 'marriott', 'hilton', 'hyatt', 'expedia', 'priceline', 'kayak', 'ihg'];
const AMOUNT_TOLERANCE_PCT = 5;

function hasTransferKeyword(str) {
  const s = (str || '').toLowerCase();
  return TRANSFER_NAME_KEYWORDS.some(k => s.includes(k));
}

function isFilteredTransaction(row) {
  const cat = (row.category || '').toLowerCase();
  if (cat.includes('transfer') || cat.includes('bank fees')) return true;

  let raw = {};
  try { raw = row.raw_json ? JSON.parse(row.raw_json) : {}; } catch (_) {}
  if (raw.transaction_type === 'special') return true;
  const pfc = raw.personal_finance_category && raw.personal_finance_category.primary;
  if (pfc === 'TRANSFER_IN' || pfc === 'TRANSFER_OUT' || pfc === 'BANK_FEES' || pfc === 'LOAN_PAYMENTS') return true;

  if (hasTransferKeyword(row.merchant)) return true;
  if (hasTransferKeyword(raw.name)) return true;

  const m = (row.merchant || '').toLowerCase();
  if (ONE_TIME_BOOKING_MERCHANTS.some(k => m.includes(k))) return true;

  return false;
}

function detectRecurringCharges() {
  const rows = mainDb.prepare(
    'SELECT merchant, account, date, amount, category, raw_json FROM transactions ORDER BY merchant, date'
  ).all();

  const byMerchant = {};
  for (const row of rows) {
    if (isFilteredTransaction(row)) continue;
    if (row.amount <= 0) continue;
    const key = normalizeMerchant(row.merchant);
    if (!byMerchant[key]) byMerchant[key] = [];
    byMerchant[key].push(row);
  }

  const recurring = [];
  for (const [, txns] of Object.entries(byMerchant)) {
    if (txns.length < 2) continue;

    // Cluster by amount (within 5%); keep largest band
    const bands = [];
    for (const t of txns.slice().sort((a, b) => a.amount - b.amount)) {
      const band = bands.find(b => {
        const min = Math.min(b.avg, t.amount);
        return min > 0 && Math.abs(t.amount - b.avg) / min * 100 <= AMOUNT_TOLERANCE_PCT;
      });
      if (band) {
        band.items.push(t);
        band.avg = band.items.reduce((s, x) => s + x.amount, 0) / band.items.length;
      } else {
        bands.push({ avg: t.amount, items: [t] });
      }
    }
    const band = bands.sort((a, b) => b.items.length - a.items.length)[0];
    if (!band || band.items.length < 2) continue;

    const bandTxns = band.items.slice().sort((a, b) => new Date(a.date) - new Date(b.date));
    const amounts  = bandTxns.map(t => t.amount);
    const minAmt   = Math.min(...amounts);
    const maxAmt   = Math.max(...amounts);
    const variance = minAmt > 0 ? ((maxAmt - minAmt) / minAmt) * 100 : Infinity;
    if (variance > AMOUNT_TOLERANCE_PCT) continue;

    const dates = bandTxns.map(t => new Date(t.date).getTime());
    const gaps = [];
    for (let i = 1; i < dates.length; i++) {
      gaps.push(Math.round((dates[i] - dates[i - 1]) / 86400000));
    }
    const interval = detectInterval(gaps);
    if (!interval) continue;

    const avgAmt = amounts.reduce((s, a) => s + a, 0) / amounts.length;
    const accounts = [...new Set(bandTxns.map(t => t.account))];

    recurring.push({
      merchant: bandTxns[0].merchant,
      interval,
      occurrences: bandTxns.length,
      avg_amount: parseFloat(avgAmt.toFixed(2)),
      amount_variance_pct: parseFloat(variance.toFixed(2)),
      accounts,
      last_charge: bandTxns[bandTxns.length - 1].date,
    });
  }

  return recurring.sort((a, b) => b.avg_amount - a.avg_amount);
}

// GET /subscriptions
router.get('/', requireAuth, async (req, res) => {
  try {
    const recurring = detectRecurringCharges();

    // Estimate monthly cost for each
    const withMonthlyCost = recurring.map(r => {
      let monthlyCost = r.avg_amount;
      if (r.interval === 'weekly') monthlyCost = r.avg_amount * 4.33;
      else if (r.interval === 'quarterly') monthlyCost = r.avg_amount / 3;
      else if (r.interval === 'annual') monthlyCost = r.avg_amount / 12;
      return { ...r, monthly_cost: parseFloat(monthlyCost.toFixed(2)) };
    });

    const totalMonthly = withMonthlyCost.reduce((s, r) => s + r.monthly_cost, 0);

    res.render('subscriptions', {
      title: 'Subscription Audit',
      page: 'subscriptions',
      subscriptions: withMonthlyCost,
      totalMonthly: parseFloat(totalMonthly.toFixed(2)),
    });
  } catch (err) {
    console.error('Subscriptions error:', err);
    req.session.flash = { error: 'Failed to load subscription data.' };
    res.redirect('/dashboard');
  }
});

// POST /subscriptions/cancel-email — draft a cancellation email
router.post('/cancel-email', requireAuth, async (req, res) => {
  const { merchant, amount } = req.body;

  if (!merchant) {
    return res.status(400).json({ error: 'Merchant is required.' });
  }

  try {
    const anthropic = new Anthropic();
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5-20241022',
      max_tokens: 1500,
      system: 'You are an expert consumer advocate who writes highly effective, professional emails. Write in a firm but polite professional tone — assertive without being aggressive, courteous without being passive.',
      messages: [{
        role: 'user',
        content: `Write a professional cancellation email to ${merchant} for a recurring charge of $${amount}/month. The account holder is Julia Maldonado. The email should request immediate cancellation and confirmation. Keep it concise and direct.`,
      }],
    });

    const content = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n');

    // Save to web app's action_drafts table
    const result = await pool.query(
      `INSERT INTO action_drafts (user_id, type, merchant, content, status, metadata_json)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [
        req.session.user.id,
        'email',
        merchant,
        content,
        'draft',
        JSON.stringify({ issue_type: 'cancellation', current_charge: amount }),
      ]
    );

    res.json({ success: true, action_id: result.rows[0]?.id });
  } catch (err) {
    console.error('Cancel email draft error:', err);
    res.status(500).json({ error: 'Failed to draft cancellation email.' });
  }
});

module.exports = router;

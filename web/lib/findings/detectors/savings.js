// savings_rate_dropped + savings_rate_hit_target.

const { firstOfCurrentMonth } = require('../util');
const { computeSavingsRate } = require('../../savings-rate');
const { classifyFlow } = require('../../transaction-flow');

const DROP_PP = 10; // 10 percentage points

// inputs: 4 months of { income_cents, spending_cents } in chronological order
// (oldest 3 = baseline, latest = current)
function buildSavingsRateDropped(monthsBuckets, today = firstOfCurrentMonth()) {
  if (monthsBuckets.length < 4) return [];
  const baseline = monthsBuckets.slice(0, 3);
  const current = monthsBuckets[3];
  // Skip if any of the 3 baseline months had insufficient income
  for (const b of baseline) {
    const sr = computeSavingsRate(b.income_cents, b.spending_cents);
    if (sr.status !== 'ok') return [];
  }
  const currSr = computeSavingsRate(current.income_cents, current.spending_cents);
  if (currSr.status !== 'ok') return [];
  const baselineRates = baseline.map(b =>
    computeSavingsRate(b.income_cents, b.spending_cents).savings_rate_pct);
  const baselineAvg = baselineRates.reduce((a, b) => a + b, 0) / baselineRates.length;
  if (currSr.savings_rate_pct >= baselineAvg - DROP_PP) return [];
  const drop = baselineAvg - currSr.savings_rate_pct;
  return [{
    finding_type: 'savings_rate_dropped',
    tier: 'important',
    title: 'Savings rate dropped this month.',
    body: 'Now ' + currSr.savings_rate_pct.toFixed(1) + '% vs ' + baselineAvg.toFixed(1)
        + '% average over prior 3 months (down ' + drop.toFixed(1) + 'pp).',
    related_entity_type: null,
    related_entity_id: null,
    deep_link_path: '/insights',
    money_at_stake_cents: null,
    occurred_at: today,
  }];
}

function buildSavingsRateHitTarget(monthsBuckets, targetPct, today = firstOfCurrentMonth()) {
  if (monthsBuckets.length === 0) return [];
  const current = monthsBuckets[monthsBuckets.length - 1];
  const sr = computeSavingsRate(current.income_cents, current.spending_cents);
  if (sr.status !== 'ok') return [];
  if (sr.savings_rate_pct < targetPct) return [];
  return [{
    finding_type: 'savings_rate_hit_target',
    tier: 'positive',
    title: 'Savings target hit: ' + sr.savings_rate_pct.toFixed(1) + '%.',
    body: 'You\'re at ' + sr.savings_rate_pct.toFixed(1) + '% this month, above your '
        + targetPct + '% target.',
    related_entity_type: null,
    related_entity_id: null,
    deep_link_path: '/insights',
    money_at_stake_cents: null,
    occurred_at: today,
  }];
}

// Pull last 4 months of {income, spending} for this user.
async function fetchMonthlyFlow(userId, client) {
  const { rows } = await client.query(
    `SELECT amount, date, plaid_category_primary
       FROM transactions
      WHERE user_id = $1
        AND date >= date_trunc('month', CURRENT_DATE) - INTERVAL '3 months'`,
    [userId]
  );
  // Bucket per month
  const buckets = new Map();
  for (const t of rows) {
    const d = new Date(t.date);
    const k = d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
    if (!buckets.has(k)) buckets.set(k, { income_cents: 0, spending_cents: 0 });
    const flow = classifyFlow(t);
    const cents = Math.round(Math.abs(Number(t.amount)) * 100);
    if (flow === 'income') buckets.get(k).income_cents += cents;
    else if (flow === 'spending') buckets.get(k).spending_cents += cents;
  }
  // Walk last 4 months in order
  const out = [];
  const today = new Date();
  for (let i = 3; i >= 0; i--) {
    const dt = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - i, 1));
    const k = dt.getUTCFullYear() + '-' + String(dt.getUTCMonth() + 1).padStart(2, '0');
    out.push(buckets.get(k) || { income_cents: 0, spending_cents: 0 });
  }
  return out;
}

async function detectSavingsRateDropped(userId, client) {
  return buildSavingsRateDropped(await fetchMonthlyFlow(userId, client));
}

async function detectSavingsRateHitTarget(userId, client) {
  const buckets = await fetchMonthlyFlow(userId, client);
  const { rows: settings } = await client.query(
    `SELECT savings_rate_target_pct FROM user_settings WHERE user_id = $1`, [userId]
  );
  const target = settings.length > 0 ? settings[0].savings_rate_target_pct : 20;
  return buildSavingsRateHitTarget(buckets, target);
}

module.exports = {
  buildSavingsRateDropped, detectSavingsRateDropped,
  buildSavingsRateHitTarget, detectSavingsRateHitTarget,
};

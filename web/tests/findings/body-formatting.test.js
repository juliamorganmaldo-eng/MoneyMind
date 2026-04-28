// Regression guard: no detector should ever emit a finding body that
// looks like Date.toString() output. A raw Date pasted into a string with
// + concatenation produces "Mon Mar 30 2026 00:00:00 GMT-0700 (Pacific
// Daylight Time)" — leaks weekday, time, and timezone. Bodies must use
// formatDate() (YYYY-MM-DD).
//
// We exercise every build helper with sample data and grep its output.

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://placeholder@localhost/none';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildBudgetExceeded, buildBudgetApproaching } = require('../../lib/findings/detectors/budgets');
const { buildAccountBelowThreshold } = require('../../lib/findings/detectors/account-thresholds');
const {
  buildSubscriptionPriceIncreased,
  buildDuplicateSubscription,
  buildRecurringChargeStopped,
  buildNewRecurringCharge,
} = require('../../lib/findings/detectors/subscriptions');
const { buildUnusuallyLargeTransaction } = require('../../lib/findings/detectors/transactions');
const { buildSpendingCategoryUp, buildSpendingCategoryDown } = require('../../lib/findings/detectors/spending-trends');
const { buildSavingsRateDropped, buildSavingsRateHitTarget } = require('../../lib/findings/detectors/savings');
const { buildNetWorthMilestone } = require('../../lib/findings/detectors/net-worth');

// Patterns that indicate Date.toString() output (or other date-format leakage)
// snuck into a finding body.
const FORBIDDEN_PATTERNS = [
  /\bGMT\b/,
  /\bUTC[+-]\d/,
  /\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/,
  /\bJan\b|\bFeb\b|\bMar\b|\bApr\b|\bMay\b|\bJun\b|\bJul\b|\bAug\b|\bSep\b|\bOct\b|\bNov\b|\bDec\b/,
  /\bPacific Daylight Time\b|\bPacific Standard Time\b|\bEastern\b/i,
];

function assertCleanBody(findings, label) {
  for (const f of findings) {
    for (const pat of FORBIDDEN_PATTERNS) {
      assert.ok(!pat.test(f.body),
        label + ' body matched forbidden pattern ' + pat + ': ' + JSON.stringify(f.body));
    }
  }
}

// Sample data for every detector that surfaces (yields ≥ 1 finding):

test('budget_exceeded — body free of date-format leakage', () => {
  const out = buildBudgetExceeded([{
    category_id: 1, category_name: 'Eating Out', budget_limit_id: 7,
    monthly_limit_cents: 30000, current_spend_cents: 33000,
  }]);
  assertCleanBody(out, 'budget_exceeded');
});

test('budget_approaching — body free of date-format leakage', () => {
  const out = buildBudgetApproaching([{
    category_id: 1, category_name: 'Gas', budget_limit_id: 8,
    monthly_limit_cents: 10000, current_spend_cents: 9000,
  }]);
  assertCleanBody(out, 'budget_approaching');
});

test('account_below_threshold — body free of date-format leakage', () => {
  const out = buildAccountBelowThreshold([{
    account_id: 1, account_name: 'Chase', mask: '0000',
    current_balance_cents: 100, threshold_cents: 50000, enabled: true,
  }]);
  assertCleanBody(out, 'account_below_threshold');
});

test('subscription_price_increased — body free of date-format leakage', () => {
  const out = buildSubscriptionPriceIncreased([{
    id: 4, display_name: 'Netflix', median_amount_cents: 1549, last_amount_cents: 1799,
    price_change_detected: true, updated_at: new Date('2026-04-20'),
  }]);
  assertCleanBody(out, 'subscription_price_increased');
});

test('duplicate_subscription — body free of date-format leakage', () => {
  const map = new Map([
    [10, { id: 10, display_name: 'Netflix', cadence: 'monthly', median_amount_cents: 1549 }],
    [11, { id: 11, display_name: 'Hulu',    cadence: 'monthly', median_amount_cents: 999 }],
  ]);
  const out = buildDuplicateSubscription([{
    left_charge_id: 10, right_charge_id: 11,
    reason: 'known_overlap_pair', monthly_cost_diff_cents: 550,
  }], map);
  assertCleanBody(out, 'duplicate_subscription');
});

test('recurring_charge_stopped — body uses YYYY-MM-DD, no Date.toString leak', () => {
  // Pass a Date — the previous bug was that `new Date(...) + ' string'`
  // produced "Mon Mar 30 2026 00:00:00 GMT-0700".
  const out = buildRecurringChargeStopped([{
    id: 5, display_name: 'OldSub', cadence: 'monthly',
    median_amount_cents: 1000, monthly_equivalent_cents: 1000,
    last_charged_date: new Date('2026-03-30T00:00:00Z'),
    updated_at: new Date('2026-04-25'),
  }]);
  assertCleanBody(out, 'recurring_charge_stopped');
  // Positive assertion: body should contain the YYYY-MM-DD form.
  assert.ok(/2026-03-30/.test(out[0].body), 'body should contain YYYY-MM-DD');
});

test('new_recurring_charge — body free of date-format leakage', () => {
  const out = buildNewRecurringCharge([{
    id: 6, display_name: 'NewSub', cadence: 'monthly',
    median_amount_cents: 999, monthly_equivalent_cents: 999,
    occurrence_count: 3, created_at: new Date('2026-04-25'),
  }]);
  assertCleanBody(out, 'new_recurring_charge');
});

test('unusually_large_transaction — body free of date-format leakage', () => {
  const rows = [];
  for (let i = 0; i < 5; i++) rows.push({
    id: i, date: '2026-04-01', amount: 50, amount_cents: 5000,
    name: 'X', merchant_name: 'Y',
    category_id: 1, category_name: 'Eating Out',
    plaid_category_primary: 'Food and Drink',
  });
  rows.push({
    id: 99, date: '2026-04-20', amount: 500, amount_cents: 50000,
    name: 'X', merchant_name: 'Y',
    category_id: 1, category_name: 'Eating Out',
    plaid_category_primary: 'Food and Drink',
  });
  const r = buildUnusuallyLargeTransaction(rows);
  assertCleanBody(r.toInsert, 'unusually_large_transaction');
});

test('spending_category_up — body free of date-format leakage', () => {
  const out = buildSpendingCategoryUp([{
    category_id: 1, category_name: 'Eating Out',
    current_cents: 17500, last_cents: 12500,
  }]);
  assertCleanBody(out, 'spending_category_up');
});

test('spending_category_down — body free of date-format leakage', () => {
  const out = buildSpendingCategoryDown([{
    category_id: 1, category_name: 'Shopping',
    current_cents: 7500, last_cents: 12500,
  }]);
  assertCleanBody(out, 'spending_category_down');
});

test('savings_rate_dropped — body free of date-format leakage', () => {
  // 4 months: 3 baseline @ 20%, current @ 5% → drop of 15pp → fires
  const m = (rate) => ({ income_cents: 500000, spending_cents: 500000 - Math.round(500000 * rate / 100) });
  const out = buildSavingsRateDropped([m(20), m(20), m(20), m(5)]);
  assertCleanBody(out, 'savings_rate_dropped');
});

test('savings_rate_hit_target — body free of date-format leakage', () => {
  const out = buildSavingsRateHitTarget(
    [{ income_cents: 500000, spending_cents: 400000 }], 20);
  assertCleanBody(out, 'savings_rate_hit_target');
});

test('net_worth_milestone — body free of date-format leakage', () => {
  // Crosses $10K upward — body says "a week ago" (relative, not a date)
  const out = buildNetWorthMilestone(800000, 1100000, new Date('2026-04-28'));
  assertCleanBody(out, 'net_worth_milestone');
});

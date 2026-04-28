process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://placeholder@localhost/none';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildNewRecurringCharge } = require('../../lib/findings/detectors/subscriptions');

test('empty input → empty output', () => {
  assert.deepEqual(buildNewRecurringCharge([]), []);
});

test('row → finding with cadence + amount', () => {
  const out = buildNewRecurringCharge([{
    id: 6, display_name: 'New Sub', cadence: 'monthly',
    median_amount_cents: 999, monthly_equivalent_cents: 999,
    occurrence_count: 3, created_at: new Date('2026-04-25'),
  }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].tier, 'tip');
  assert.equal(out[0].money_at_stake_cents, 999);
});

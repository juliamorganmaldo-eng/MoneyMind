process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://placeholder@localhost/none';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildRecurringChargeStopped } = require('../../lib/findings/detectors/subscriptions');

test('empty input → empty output', () => {
  assert.deepEqual(buildRecurringChargeStopped([]), []);
});

test('row → finding with monthly_equivalent_cents', () => {
  const out = buildRecurringChargeStopped([{
    id: 5, display_name: 'Old Sub', cadence: 'monthly',
    median_amount_cents: 1000, monthly_equivalent_cents: 1000,
    last_charged_date: '2026-03-15', updated_at: new Date('2026-04-25'),
  }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].tier, 'important');
  assert.equal(out[0].money_at_stake_cents, 1000);
  assert.equal(out[0].related_entity_id, 5);
});

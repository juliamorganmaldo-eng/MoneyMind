process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://placeholder@localhost/none';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildDuplicateSubscription } = require('../../lib/findings/detectors/subscriptions');

test('empty pairs → empty output', () => {
  assert.deepEqual(buildDuplicateSubscription([], new Map()), []);
});

test('valid pair → fires with money_at_stake = cheaper monthly cost', () => {
  const map = new Map([
    [10, { id: 10, display_name: 'Netflix', cadence: 'monthly', median_amount_cents: 1549 }],
    [11, { id: 11, display_name: 'Hulu',    cadence: 'monthly', median_amount_cents: 999 }],
  ]);
  const out = buildDuplicateSubscription([{
    left_charge_id: 10, right_charge_id: 11,
    reason: 'known_overlap_pair', monthly_cost_diff_cents: 550,
  }], map);
  assert.equal(out.length, 1);
  assert.equal(out[0].tier, 'important');
  assert.equal(out[0].money_at_stake_cents, 999);
  // Stable id for UNIQUE: lower of the two ids
  assert.equal(out[0].related_entity_id, 10);
});

test('pair with missing chargesById entry → skipped', () => {
  const map = new Map([
    [10, { id: 10, display_name: 'Netflix', cadence: 'monthly', median_amount_cents: 1549 }],
  ]);
  const out = buildDuplicateSubscription([{
    left_charge_id: 10, right_charge_id: 99,
    reason: 'known_overlap_pair', monthly_cost_diff_cents: 0,
  }], map);
  assert.equal(out.length, 0);
});

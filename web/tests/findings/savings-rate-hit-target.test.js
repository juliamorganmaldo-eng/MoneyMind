const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildSavingsRateHitTarget } = require('../../lib/findings/detectors/savings');

test('empty input → empty output', () => {
  assert.deepEqual(buildSavingsRateHitTarget([], 20), []);
});

test('current rate exactly at target → fires', () => {
  // $5,000 income, $4,000 spending → 20% rate, target 20
  const out = buildSavingsRateHitTarget([{ income_cents: 500000, spending_cents: 400000 }], 20);
  assert.equal(out.length, 1);
  assert.equal(out[0].tier, 'positive');
});

test('current rate above target → fires', () => {
  // $5,000 income, $3,000 spending → 40%, target 20
  const out = buildSavingsRateHitTarget([{ income_cents: 500000, spending_cents: 300000 }], 20);
  assert.equal(out.length, 1);
});

test('current rate just below target → does NOT fire', () => {
  // $5,000 income, $4,005 spending → 19.9% (after one-decimal rounding), target 20
  const out = buildSavingsRateHitTarget([{ income_cents: 500000, spending_cents: 400500 }], 20);
  assert.equal(out.length, 0);
});

test('current is insufficient_income → skipped (status != ok)', () => {
  const out = buildSavingsRateHitTarget([{ income_cents: 50000, spending_cents: 1000 }], 20);
  assert.equal(out.length, 0);
});

test('current is no_income → skipped', () => {
  const out = buildSavingsRateHitTarget([{ income_cents: 0, spending_cents: 100 }], 20);
  assert.equal(out.length, 0);
});

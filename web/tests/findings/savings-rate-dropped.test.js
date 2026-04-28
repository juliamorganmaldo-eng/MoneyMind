const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildSavingsRateDropped } = require('../../lib/findings/detectors/savings');

// Helper: a month bucket producing a clean ok savings rate of `rate`%
// at $5000 income (so it passes the $1000 insufficient_income guard).
function monthAtRate(ratePct) {
  const income = 500000; // $5,000 in cents
  const spending = Math.round(income * (1 - ratePct / 100));
  return { income_cents: income, spending_cents: spending };
}

test('empty input → empty output', () => {
  assert.deepEqual(buildSavingsRateDropped([]), []);
});

test('< 4 months → empty (need 3 baseline + current)', () => {
  assert.deepEqual(buildSavingsRateDropped([monthAtRate(20), monthAtRate(20), monthAtRate(20)]), []);
});

test('current is 11pp lower than baseline avg → fires', () => {
  const out = buildSavingsRateDropped([
    monthAtRate(20), monthAtRate(20), monthAtRate(20), monthAtRate(9),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].tier, 'important');
});

test('current is exactly 10pp lower → does NOT fire (must be MORE than 10)', () => {
  const out = buildSavingsRateDropped([
    monthAtRate(20), monthAtRate(20), monthAtRate(20), monthAtRate(10),
  ]);
  assert.equal(out.length, 0);
});

test('baseline includes insufficient_income → skipped (no comparison possible)', () => {
  const out = buildSavingsRateDropped([
    monthAtRate(20),
    { income_cents: 50000, spending_cents: 100000 }, // $500 income → insufficient
    monthAtRate(20),
    monthAtRate(5),
  ]);
  assert.equal(out.length, 0);
});

test('current is insufficient_income → skipped', () => {
  const out = buildSavingsRateDropped([
    monthAtRate(20), monthAtRate(20), monthAtRate(20),
    { income_cents: 50000, spending_cents: 100000 },
  ]);
  assert.equal(out.length, 0);
});

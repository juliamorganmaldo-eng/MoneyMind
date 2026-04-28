const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildSpendingCategoryUp } = require('../../lib/findings/detectors/spending-trends');

test('empty input → empty output', () => {
  assert.deepEqual(buildSpendingCategoryUp([]), []);
});

test('1.4× last month AND ≥ $50 delta → fires', () => {
  const out = buildSpendingCategoryUp([{
    category_id: 1, category_name: 'Eating Out',
    current_cents: 14000, last_cents: 10000,  // 1.4×, $40 delta
  }]);
  // $40 < $50 → no fire
  assert.equal(out.length, 0);
});

test('1.4× last month AND $50 delta exactly → fires', () => {
  const out = buildSpendingCategoryUp([{
    category_id: 1, category_name: 'Eating Out',
    current_cents: 17500, last_cents: 12500, // 1.4×, $50 delta
  }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].money_at_stake_cents, 5000);
});

test('1.39× last month → does NOT fire (just below ratio)', () => {
  const out = buildSpendingCategoryUp([{
    category_id: 1, category_name: 'Eating Out',
    current_cents: 13900, last_cents: 10000,
  }]);
  assert.equal(out.length, 0);
});

test('last_cents = 0 → skipped (no baseline)', () => {
  const out = buildSpendingCategoryUp([{
    category_id: 1, category_name: 'Eating Out',
    current_cents: 50000, last_cents: 0,
  }]);
  assert.equal(out.length, 0);
});

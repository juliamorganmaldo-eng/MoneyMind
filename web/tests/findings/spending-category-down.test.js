const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildSpendingCategoryDown } = require('../../lib/findings/detectors/spending-trends');

test('empty input → empty output', () => {
  assert.deepEqual(buildSpendingCategoryDown([]), []);
});

test('0.6× last month AND $50+ delta → fires', () => {
  const out = buildSpendingCategoryDown([{
    category_id: 1, category_name: 'Shopping',
    current_cents: 6000, last_cents: 10000, // 0.6×, $40 delta — too small
  }]);
  assert.equal(out.length, 0);
});

test('0.6× last month AND exactly $50 delta → fires', () => {
  const out = buildSpendingCategoryDown([{
    category_id: 1, category_name: 'Shopping',
    current_cents: 7500, last_cents: 12500, // 0.6×, $50 delta
  }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].tier, 'tip');
  assert.equal(out[0].money_at_stake_cents, 5000);
});

test('0.61× last month → does NOT fire', () => {
  const out = buildSpendingCategoryDown([{
    category_id: 1, category_name: 'Shopping',
    current_cents: 6100, last_cents: 10000,
  }]);
  assert.equal(out.length, 0);
});

test('last_cents = 0 → skipped', () => {
  const out = buildSpendingCategoryDown([{
    category_id: 1, category_name: 'X', current_cents: 0, last_cents: 0,
  }]);
  assert.equal(out.length, 0);
});

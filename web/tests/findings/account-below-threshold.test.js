const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildAccountBelowThreshold } = require('../../lib/findings/detectors/account-thresholds');

test('empty input → empty output', () => {
  assert.deepEqual(buildAccountBelowThreshold([]), []);
});

test('balance just below threshold → fires', () => {
  const out = buildAccountBelowThreshold([{
    account_id: 1, account_name: 'Chase Checking', mask: '0000',
    current_balance_cents: 49999, threshold_cents: 50000, enabled: true,
  }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].tier, 'critical');
  assert.equal(out[0].money_at_stake_cents, 1);
});

test('balance exactly at threshold → does NOT fire', () => {
  const out = buildAccountBelowThreshold([{
    account_id: 1, account_name: 'X', mask: '0000',
    current_balance_cents: 50000, threshold_cents: 50000, enabled: true,
  }]);
  assert.equal(out.length, 0);
});

test('disabled threshold → does NOT fire even when below', () => {
  const out = buildAccountBelowThreshold([{
    account_id: 1, account_name: 'X', mask: '0000',
    current_balance_cents: 0, threshold_cents: 50000, enabled: false,
  }]);
  assert.equal(out.length, 0);
});

test('null threshold → skipped', () => {
  const out = buildAccountBelowThreshold([{
    account_id: 1, account_name: 'X', mask: '0000',
    current_balance_cents: 0, threshold_cents: null, enabled: true,
  }]);
  assert.equal(out.length, 0);
});

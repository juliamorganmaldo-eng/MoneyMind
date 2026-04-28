const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildBudgetExceeded } = require('../../lib/findings/detectors/budgets');

test('empty input → empty output', () => {
  assert.deepEqual(buildBudgetExceeded([]), []);
});

test('spend exactly equals limit → no finding (must be strictly over)', () => {
  const out = buildBudgetExceeded([{
    category_id: 1, category_name: 'Eating Out', budget_limit_id: 7,
    monthly_limit_cents: 30000, current_spend_cents: 30000,
  }]);
  assert.equal(out.length, 0);
});

test('spend just over limit → fires with correct money_at_stake', () => {
  const out = buildBudgetExceeded([{
    category_id: 1, category_name: 'Eating Out', budget_limit_id: 7,
    monthly_limit_cents: 30000, current_spend_cents: 30001,
  }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].finding_type, 'budget_exceeded');
  assert.equal(out[0].tier, 'critical');
  assert.equal(out[0].money_at_stake_cents, 1);
  assert.equal(out[0].related_entity_type, 'budget_limit');
  assert.equal(out[0].related_entity_id, 7);
});

test('row without limit (null) → skipped', () => {
  const out = buildBudgetExceeded([{
    category_id: 2, category_name: 'Other', budget_limit_id: null,
    monthly_limit_cents: null, current_spend_cents: 99999,
  }]);
  assert.equal(out.length, 0);
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildBudgetApproaching } = require('../../lib/findings/detectors/budgets');

test('empty input → empty output', () => {
  assert.deepEqual(buildBudgetApproaching([]), []);
});

test('exactly 80% → fires (lower boundary inclusive)', () => {
  const out = buildBudgetApproaching([{
    category_id: 1, category_name: 'Gas', budget_limit_id: 8,
    monthly_limit_cents: 10000, current_spend_cents: 8000,
  }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].tier, 'important');
  assert.equal(out[0].money_at_stake_cents, 2000);
});

test('exactly 100% → fires (upper boundary inclusive)', () => {
  const out = buildBudgetApproaching([{
    category_id: 1, category_name: 'Gas', budget_limit_id: 8,
    monthly_limit_cents: 10000, current_spend_cents: 10000,
  }]);
  assert.equal(out.length, 1);
});

test('79% → does NOT fire (just below)', () => {
  const out = buildBudgetApproaching([{
    category_id: 1, category_name: 'Gas', budget_limit_id: 8,
    monthly_limit_cents: 10000, current_spend_cents: 7900,
  }]);
  assert.equal(out.length, 0);
});

test('101% → does NOT fire (already exceeded — handled by exceeded detector)', () => {
  const out = buildBudgetApproaching([{
    category_id: 1, category_name: 'Gas', budget_limit_id: 8,
    monthly_limit_cents: 10000, current_spend_cents: 10100,
  }]);
  assert.equal(out.length, 0);
});

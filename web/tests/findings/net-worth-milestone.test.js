const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildNetWorthMilestone, crossedBoundaries } = require('../../lib/findings/detectors/net-worth');

test('null inputs → empty', () => {
  assert.deepEqual(buildNetWorthMilestone(null, 1000000), []);
  assert.deepEqual(buildNetWorthMilestone(1000000, null), []);
});

test('no boundary crossed → empty', () => {
  // $11K → $12K — no boundary in between (next is $25K)
  assert.deepEqual(buildNetWorthMilestone(1100000, 1200000), []);
});

test('crosses $10K upward → 1 finding', () => {
  // $8K → $11K crosses $10K
  const out = buildNetWorthMilestone(800000, 1100000);
  assert.equal(out.length, 1);
  assert.equal(out[0].tier, 'positive');
  assert.equal(out[0].related_entity_id, 1000000);
});

test('crosses $10K downward → 1 finding (either direction counts)', () => {
  const out = buildNetWorthMilestone(1100000, 800000);
  assert.equal(out.length, 1);
  // The body should reflect the drop
  assert.match(out[0].body, /a week ago/);
});

test('crosses TWO boundaries (10K and 25K) → 2 findings', () => {
  // $8K → $30K crosses both $10K and $25K
  const out = buildNetWorthMilestone(800000, 3000000);
  assert.equal(out.length, 2);
  const ids = out.map(f => f.related_entity_id).sort((a, b) => a - b);
  assert.deepEqual(ids, [1000000, 2500000]);
});

test('crosses negative boundary (-$10K) → 1 finding', () => {
  // $-8K → $-12K crosses -$10K
  const out = buildNetWorthMilestone(-800000, -1200000);
  assert.equal(out.length, 1);
  assert.equal(out[0].related_entity_id, -1000000);
});

test('crossedBoundaries helper: just-touched boundary counts', () => {
  // $9999.99 → $10000 — to=10000 exactly is a crossing (`to >= b`)
  assert.deepEqual(crossedBoundaries(999999, 1000000), [1000000]);
});

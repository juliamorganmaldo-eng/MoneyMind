// duplicate-detection.js requires db at module load — pre-set a placeholder.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://placeholder@localhost/none';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildSubscriptionPriceIncreased } = require('../../lib/findings/detectors/subscriptions');

test('empty input → empty output', () => {
  assert.deepEqual(buildSubscriptionPriceIncreased([]), []);
});

test('price went up → fires with delta', () => {
  const out = buildSubscriptionPriceIncreased([{
    id: 4, display_name: 'Netflix',
    median_amount_cents: 1549, last_amount_cents: 1799,
    price_change_detected: true, updated_at: new Date('2026-04-20'),
  }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].tier, 'critical');
  assert.equal(out[0].money_at_stake_cents, 250);
});

test('price went down → does NOT fire (this detector is increases only)', () => {
  const out = buildSubscriptionPriceIncreased([{
    id: 4, display_name: 'Netflix',
    median_amount_cents: 1799, last_amount_cents: 1549,
    price_change_detected: true, updated_at: new Date('2026-04-20'),
  }]);
  assert.equal(out.length, 0);
});

test('price_change_detected=false → skipped', () => {
  const out = buildSubscriptionPriceIncreased([{
    id: 4, display_name: 'Netflix',
    median_amount_cents: 1549, last_amount_cents: 1799,
    price_change_detected: false, updated_at: new Date('2026-04-20'),
  }]);
  assert.equal(out.length, 0);
});

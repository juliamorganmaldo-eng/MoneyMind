// Pure-function unit tests for the recurring detection algorithm.
// Run from web/:   node --test tests/recurring-detection.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { detectFromTransactions, CONFIDENCE_THRESHOLD } = require('../lib/recurring-detection');

function txn(p) {
  return {
    id: p.id || Math.floor(Math.random() * 1e9),
    name: p.name || p.merchant_name || 'Unknown',
    merchant_name: p.merchant_name || null,
    amount: p.amount,
    date: p.date,
    category_id: p.category_id ?? null,
    plaid_category_primary: p.plaid_category_primary || 'Service',
  };
}

function ymdPlus(start, days) {
  const d = new Date(start + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

test('empty input → empty output', () => {
  assert.deepEqual(detectFromTransactions([]), []);
});

test('single transaction → empty (no cadence possible)', () => {
  const t = [txn({ merchant_name: 'Netflix', amount: 15.49, date: '2026-01-01' })];
  assert.deepEqual(detectFromTransactions(t), []);
});

test('3 monthly Netflix charges $15.49, exact 30-day spacing → confidence ≥ 80, monthly', () => {
  const today = new Date('2026-04-10T00:00:00Z');
  const t = [
    txn({ merchant_name: 'Netflix', amount: 15.49, date: '2026-01-30' }),
    txn({ merchant_name: 'Netflix', amount: 15.49, date: '2026-03-01' }),
    txn({ merchant_name: 'Netflix', amount: 15.49, date: '2026-03-31' }),
  ];
  const out = detectFromTransactions(t, today);
  assert.equal(out.length, 1);
  assert.equal(out[0].cadence, 'monthly');
  assert.ok(out[0].confidence_score >= 80,
    `confidence ${out[0].confidence_score} should be ≥ 80`);
  assert.equal(out[0].price_change_detected, false);
  assert.equal(out[0].median_amount_cents, 1549);
  assert.equal(out[0].occurrence_count, 3);
  assert.equal(out[0].status, 'active');
});

test('3 monthly with last one price-changed → price_change_detected=true', () => {
  const today = new Date('2026-04-10T00:00:00Z');
  const t = [
    txn({ merchant_name: 'Netflix', amount: 15.49, date: '2026-01-30' }),
    txn({ merchant_name: 'Netflix', amount: 15.49, date: '2026-03-01' }),
    txn({ merchant_name: 'Netflix', amount: 17.99, date: '2026-03-31' }),
  ];
  const out = detectFromTransactions(t, today);
  assert.equal(out.length, 1);
  assert.equal(out[0].price_change_detected, true);
  assert.equal(out[0].last_amount_cents, 1799);
});

test('12 weekly $5 transactions exact 7-day spacing → cadence=weekly', () => {
  const today = new Date('2026-04-15T00:00:00Z');
  const t = [];
  for (let i = 0; i < 12; i++) {
    t.push(txn({ merchant_name: 'Coffee Co', amount: 5.00, date: ymdPlus('2026-01-08', i * 7) }));
  }
  const out = detectFromTransactions(t, today);
  assert.equal(out.length, 1);
  assert.equal(out[0].cadence, 'weekly');
  assert.ok(out[0].confidence_score >= CONFIDENCE_THRESHOLD,
    `confidence ${out[0].confidence_score} should be ≥ ${CONFIDENCE_THRESHOLD}`);
  assert.equal(out[0].occurrence_count, 12);
});

test('4 quarterly $100 transactions ~91-day spacing → cadence=quarterly', () => {
  const today = new Date('2026-12-15T00:00:00Z');
  const t = [
    txn({ merchant_name: 'AWS', amount: 100, date: '2025-12-01' }),
    txn({ merchant_name: 'AWS', amount: 100, date: '2026-03-01' }),
    txn({ merchant_name: 'AWS', amount: 100, date: '2026-06-01' }),
    txn({ merchant_name: 'AWS', amount: 100, date: '2026-09-01' }),
  ];
  const out = detectFromTransactions(t, today);
  assert.equal(out.length, 1);
  assert.equal(out[0].cadence, 'quarterly');
});

test('random transactions with no cadence pattern → not detected', () => {
  const today = new Date('2026-04-10T00:00:00Z');
  const t = [
    txn({ merchant_name: 'Random', amount: 10, date: '2026-01-01' }),
    txn({ merchant_name: 'Random', amount: 20, date: '2026-01-03' }),  // gap 2
    txn({ merchant_name: 'Random', amount: 30, date: '2026-02-15' }),  // gap 43
    txn({ merchant_name: 'Random', amount: 40, date: '2026-03-22' }),  // gap 35
  ];
  // gaps: 2, 43, 35 — median 35. None of weekly/biweekly/monthly/quarterly/annual.
  const out = detectFromTransactions(t, today);
  assert.equal(out.length, 0);
});

test('2 transactions same merchant, 35-day gap → not detected (gap outside windows)', () => {
  const today = new Date('2026-04-10T00:00:00Z');
  const t = [
    txn({ merchant_name: 'X', amount: 10, date: '2026-02-01' }),
    txn({ merchant_name: 'X', amount: 10, date: '2026-03-08' }),
  ];
  // 35-day gap is outside monthly (25-34); no cadence match → not surfaced.
  const out = detectFromTransactions(t, today);
  assert.equal(out.length, 0);
});

test('5 monthly charges, then 6 months of nothing → status="ended"', () => {
  const today = new Date('2026-12-01T00:00:00Z');
  const t = [
    txn({ merchant_name: 'OldSub', amount: 9.99, date: '2026-01-15' }),
    txn({ merchant_name: 'OldSub', amount: 9.99, date: '2026-02-14' }),
    txn({ merchant_name: 'OldSub', amount: 9.99, date: '2026-03-16' }),
    txn({ merchant_name: 'OldSub', amount: 9.99, date: '2026-04-15' }),
    txn({ merchant_name: 'OldSub', amount: 9.99, date: '2026-05-15' }),
  ];
  const out = detectFromTransactions(t, today);
  assert.equal(out.length, 1);
  assert.equal(out[0].cadence, 'monthly');
  assert.equal(out[0].status, 'ended');
});

test('Plaid Transfer/Payment transactions are excluded from clustering', () => {
  const today = new Date('2026-04-10T00:00:00Z');
  // 3 monthly "AUTOMATIC PAYMENT" charges that look recurring but are
  // payments, not subscriptions. Should be filtered out before clustering.
  const t = [
    txn({ merchant_name: 'Bank', amount: 2000, date: '2026-01-15', plaid_category_primary: 'Payment' }),
    txn({ merchant_name: 'Bank', amount: 2000, date: '2026-02-14', plaid_category_primary: 'Payment' }),
    txn({ merchant_name: 'Bank', amount: 2000, date: '2026-03-16', plaid_category_primary: 'Payment' }),
  ];
  assert.equal(detectFromTransactions(t, today).length, 0);
});

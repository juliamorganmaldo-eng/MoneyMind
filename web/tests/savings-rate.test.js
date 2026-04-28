// Run from web/:  node --test tests/savings-rate.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeSavingsRate, MIN_INCOME_FOR_SAVINGS_RATE_CENTS } = require('../lib/savings-rate');

test('threshold constant is $1000 in cents', () => {
  assert.equal(MIN_INCOME_FOR_SAVINGS_RATE_CENTS, 100000);
});

test('$0 income → status=no_income, pct=null', () => {
  const r = computeSavingsRate(0, 5000);
  assert.equal(r.status, 'no_income');
  assert.equal(r.savings_rate_pct, null);
  assert.equal(r.savings_cents, -5000);
});

test('negative income (defensive) → status=no_income', () => {
  const r = computeSavingsRate(-100, 50);
  assert.equal(r.status, 'no_income');
  assert.equal(r.savings_rate_pct, null);
});

test('$500 income, $1500 spending → status=insufficient_income, pct=null', () => {
  // 50000 cents = $500, below the $1000 threshold
  const r = computeSavingsRate(50000, 150000);
  assert.equal(r.status, 'insufficient_income');
  assert.equal(r.savings_rate_pct, null);
  assert.equal(r.savings_cents, -100000);
});

test('income exactly at threshold ($1000) → status=ok', () => {
  const r = computeSavingsRate(100000, 50000);
  assert.equal(r.status, 'ok');
  assert.equal(r.savings_rate_pct, 50);
});

test('income just below threshold ($999.99) → status=insufficient_income', () => {
  const r = computeSavingsRate(99999, 50000);
  assert.equal(r.status, 'insufficient_income');
  assert.equal(r.savings_rate_pct, null);
});

test('$5000 income, $4000 spending → status=ok, pct=20', () => {
  const r = computeSavingsRate(500000, 400000);
  assert.equal(r.status, 'ok');
  assert.equal(r.savings_rate_pct, 20);
});

test('$5000 income, $6000 spending → status=ok, pct=-20 (legitimate negative)', () => {
  const r = computeSavingsRate(500000, 600000);
  assert.equal(r.status, 'ok');
  assert.equal(r.savings_rate_pct, -20);
});

test('$5000 income, $0 spending → status=ok, pct=100', () => {
  const r = computeSavingsRate(500000, 0);
  assert.equal(r.status, 'ok');
  assert.equal(r.savings_rate_pct, 100);
});

test('rounding: pct returned to one decimal', () => {
  // 333/1000 = 33.3%
  const r = computeSavingsRate(100000, 66700);
  assert.equal(r.savings_rate_pct, 33.3);
});

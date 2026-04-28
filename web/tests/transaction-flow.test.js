// Run from web/:  node --test tests/transaction-flow.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classifyFlow } = require('../lib/transaction-flow');

test('positive amount + Restaurant → spending', () => {
  assert.equal(classifyFlow({
    amount: 25.00, plaid_category_primary: 'Food and Drink',
  }), 'spending');
});

test('negative amount + Payroll → income', () => {
  assert.equal(classifyFlow({
    amount: -2500, plaid_category_primary: 'Payroll',
  }), 'income');
});

test('Payroll + positive amount STILL income (category beats sign)', () => {
  // Edge case: a payroll reversal might appear as positive but is still
  // tagged Payroll. We trust the category here.
  assert.equal(classifyFlow({
    amount: 100, plaid_category_primary: 'Payroll',
  }), 'income');
});

test('Transfer category → transfer (regardless of sign)', () => {
  assert.equal(classifyFlow({
    amount: 500, plaid_category_primary: 'Transfer',
  }), 'transfer');
  assert.equal(classifyFlow({
    amount: -500, plaid_category_primary: 'Transfer',
  }), 'transfer');
});

test('Payment category → transfer', () => {
  assert.equal(classifyFlow({
    amount: 2000, plaid_category_primary: 'Payment',
  }), 'transfer');
});

test('Refund category → ignore (don\'t double-count as income)', () => {
  assert.equal(classifyFlow({
    amount: -50, plaid_category_primary: 'Refund',
  }), 'ignore');
});

test('zero amount → ignore', () => {
  assert.equal(classifyFlow({ amount: 0, plaid_category_primary: 'Food and Drink' }), 'ignore');
});

test('NaN amount → ignore', () => {
  assert.equal(classifyFlow({ amount: NaN, plaid_category_primary: 'Food and Drink' }), 'ignore');
});

test('negative amount + non-Payroll → income (default sign rule)', () => {
  assert.equal(classifyFlow({
    amount: -100, plaid_category_primary: 'Service',
  }), 'income');
});

test('positive amount + no category → spending', () => {
  assert.equal(classifyFlow({ amount: 10 }), 'spending');
});

test('plaid_category_primary contains "Income" → income', () => {
  assert.equal(classifyFlow({
    amount: 1, plaid_category_primary: 'Interest Income',
  }), 'income');
});

test('null/undefined transaction → ignore', () => {
  assert.equal(classifyFlow(null), 'ignore');
  assert.equal(classifyFlow(undefined), 'ignore');
});

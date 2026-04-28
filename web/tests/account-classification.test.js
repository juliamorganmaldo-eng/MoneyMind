// Run from web/:  node --test tests/account-classification.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classifyAccount } = require('../lib/account-classification');

test('depository → asset', () => {
  assert.equal(classifyAccount({ type: 'depository' }), 'asset');
});

test('investment → asset', () => {
  assert.equal(classifyAccount({ type: 'investment' }), 'asset');
});

test('credit → liability', () => {
  assert.equal(classifyAccount({ type: 'credit' }), 'liability');
});

test('loan → liability', () => {
  assert.equal(classifyAccount({ type: 'loan' }), 'liability');
});

test('brokerage → asset (default for "balance you own")', () => {
  assert.equal(classifyAccount({ type: 'brokerage' }), 'asset');
});

test('unknown type → excluded (no silent miscategorization)', () => {
  assert.equal(classifyAccount({ type: 'mystery' }), 'excluded');
});

test('is_asset_override=true forces asset (overrides credit→liability)', () => {
  assert.equal(classifyAccount({ type: 'credit', is_asset_override: true }), 'asset');
});

test('is_asset_override=false forces liability (overrides depository→asset)', () => {
  assert.equal(classifyAccount({ type: 'depository', is_asset_override: false }), 'liability');
});

test('is_asset_override=null falls through to Plaid default', () => {
  assert.equal(classifyAccount({ type: 'depository', is_asset_override: null }), 'asset');
});

test('excluded_from_net_worth=true beats every other signal', () => {
  assert.equal(classifyAccount({
    type: 'depository',
    is_asset_override: true,
    excluded_from_net_worth: true,
  }), 'excluded');
});

test('case-insensitive type match', () => {
  assert.equal(classifyAccount({ type: 'DEPOSITORY' }), 'asset');
});

test('null/undefined account → excluded', () => {
  assert.equal(classifyAccount(null), 'excluded');
  assert.equal(classifyAccount(undefined), 'excluded');
});

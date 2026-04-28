const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildUnusuallyLargeTransaction, merchantHash } =
  require('../../lib/findings/detectors/transactions');

// Synthetic spending transaction.
function txn(p) {
  return {
    id: p.id,
    date: p.date || '2026-04-20',
    amount: p.amount,                          // for classifyFlow
    amount_cents: Math.round(p.amount * 100),
    name: p.name || 'X',
    merchant_name: p.merchant_name || 'Y',
    category_id: p.category_id || 1,
    category_name: p.category_name || 'Eating Out',
    plaid_category_primary: p.plaid_category_primary || 'Food and Drink',
  };
}

const TODAY = new Date('2026-04-30T00:00:00Z');

test('empty input → empty output', () => {
  const r = buildUnusuallyLargeTransaction([]);
  assert.deepEqual(r.toInsert, []);
  assert.deepEqual(r.toUpdate, []);
});

test('amount just over 4× median AND > $100 → fires', () => {
  const rows = [];
  for (let i = 0; i < 5; i++) rows.push(txn({ id: i, amount: 50, merchant_name: 'A' + i }));
  rows.push(txn({ id: 99, amount: 200.01, merchant_name: 'NewStore' }));
  const r = buildUnusuallyLargeTransaction(rows, { today: TODAY });
  assert.equal(r.toInsert.length, 1);
  assert.equal(r.toInsert[0].money_at_stake_cents, 15001);
});

test('exactly 4× median → does NOT fire', () => {
  const rows = [];
  for (let i = 0; i < 5; i++) rows.push(txn({ id: i, amount: 50, merchant_name: 'A' + i }));
  rows.push(txn({ id: 99, amount: 200, merchant_name: 'NewStore' }));
  const r = buildUnusuallyLargeTransaction(rows, { today: TODAY });
  assert.equal(r.toInsert.length, 0);
});

test('Transfer-tagged income is filtered out via classifyFlow', () => {
  const rows = [];
  for (let i = 0; i < 5; i++) rows.push(txn({ id: i, amount: 50, merchant_name: 'A' + i }));
  rows.push(txn({ id: 99, amount: 5850, merchant_name: 'Gusto', plaid_category_primary: 'Transfer' }));
  const r = buildUnusuallyLargeTransaction(rows, { today: TODAY });
  assert.equal(r.toInsert.length, 0);
});

test('Payment-tagged auto-pay is filtered out via classifyFlow', () => {
  const rows = [];
  for (let i = 0; i < 5; i++) rows.push(txn({ id: i, amount: 50, merchant_name: 'A' + i }));
  rows.push(txn({ id: 99, amount: 2078, merchant_name: 'Bank', plaid_category_primary: 'Payment' }));
  const r = buildUnusuallyLargeTransaction(rows, { today: TODAY });
  assert.equal(r.toInsert.length, 0);
});

// ─── Refinement 1 tests ────────────────────────────────────────────────

test('Refinement 1: merchant with ≥3 prior similar charges → no finding for the new one', () => {
  // Establish a small per-category median with 5 unrelated $10 charges.
  const rows = [];
  for (let i = 1; i <= 5; i++) rows.push(txn({ id: i, amount: 10, merchant_name: 'NoiseCo' + i }));
  // 4 prior Rent Co charges at $1800 in last 6 months (older than candidate).
  rows.push(txn({ id: 101, amount: 1800, merchant_name: 'Rent Co', date: '2025-12-01' }));
  rows.push(txn({ id: 102, amount: 1800, merchant_name: 'Rent Co', date: '2026-01-01' }));
  rows.push(txn({ id: 103, amount: 1800, merchant_name: 'Rent Co', date: '2026-02-01' }));
  rows.push(txn({ id: 104, amount: 1800, merchant_name: 'Rent Co', date: '2026-03-01' }));
  // CANDIDATE: Rent Co April → has 4 prior similar → must be filtered
  rows.push(txn({ id: 999, amount: 1800, merchant_name: 'Rent Co', date: '2026-04-01' }));

  const r = buildUnusuallyLargeTransaction(rows, { today: TODAY });
  // The candidate (id 999) is filtered by Refinement 1.
  // Earlier Rent Co charges (101-103) had < 3 prior, so they'd fire as
  // candidates — but Refinement 2's within-candidates dedup keeps only
  // the latest per merchant, which is id 103 (since 999 was filtered).
  // Either way: the LATEST Rent Co charge (id 999) should NOT be the
  // surfaced finding.
  const insertedRent = r.toInsert.filter(f => f.title.includes('Rent Co'));
  // Rent Co should appear at most once, and never as the April 999 charge.
  assert.ok(insertedRent.length <= 1, 'Rent Co should dedupe to at most 1 finding');
  // Never the latest one — it was filtered by Refinement 1.
  assert.equal(insertedRent.filter(f => f.occurred_at === '2026-04-01').length, 0);
});

test('Refinement 1: novel large charge (merchant never seen) → 1 finding', () => {
  const rows = [];
  for (let i = 1; i <= 5; i++) rows.push(txn({ id: i, amount: 10, merchant_name: 'NoiseCo' + i }));
  rows.push(txn({ id: 99, amount: 200, merchant_name: 'Brand New Store', date: '2026-04-15' }));
  const r = buildUnusuallyLargeTransaction(rows, { today: TODAY });
  assert.equal(r.toInsert.length, 1);
  assert.ok(r.toInsert[0].title.includes('Brand New Store'));
});

// ─── Refinement 2 tests ────────────────────────────────────────────────

test('Refinement 2: same merchant outlier 3 months in a row → 1 finding (occurred_at = most recent)', () => {
  const rows = [];
  for (let i = 1; i <= 5; i++) rows.push(txn({ id: i, amount: 10, merchant_name: 'NoiseCo' + i }));
  // 3 KFC outliers, monthly. Each only has 0/1/2 prior — Refinement 1 doesn't filter.
  rows.push(txn({ id: 11, amount: 200, merchant_name: 'KFC', date: '2026-02-15' }));
  rows.push(txn({ id: 12, amount: 200, merchant_name: 'KFC', date: '2026-03-15' }));
  rows.push(txn({ id: 13, amount: 200, merchant_name: 'KFC', date: '2026-04-15' }));

  const r = buildUnusuallyLargeTransaction(rows, { today: TODAY });
  const kfcs = r.toInsert.filter(f => f.title.includes('KFC'));
  assert.equal(kfcs.length, 1, 'within-candidates dedup → 1 KFC finding');
  assert.equal(kfcs[0].occurred_at, '2026-04-15', 'occurred_at = most recent KFC date');
});

test('Refinement 2: same merchant 100 days apart → 2 findings (90-day window expired)', () => {
  const rows = [];
  for (let i = 1; i <= 5; i++) rows.push(txn({ id: i, amount: 10, merchant_name: 'NoiseCo' + i }));
  // One KFC outlier today
  rows.push(txn({ id: 99, amount: 200, merchant_name: 'KFC', date: '2026-04-30' }));

  // Pre-existing finding for KFC from 100 days before "today".
  // 2026-04-30 - 100 days = 2026-01-20.
  const existingByMerchantHash = new Map([
    [merchantHash('KFC'), { id: 7, occurred_at: '2026-01-20' }],
  ]);

  const r = buildUnusuallyLargeTransaction(rows, {
    today: TODAY, existingByMerchantHash,
  });
  // The existing is OUTSIDE the 90-day window → not a dedupe target →
  // candidate is inserted as a fresh finding.
  assert.equal(r.toInsert.length, 1, 'expired existing → fresh insert');
  assert.equal(r.toUpdate.length, 0, 'no UPDATE since existing is too old');
  assert.equal(r.toInsert[0].related_entity_id, merchantHash('KFC'));
});

test('Refinement 2: same merchant within 90 days → 0 inserts, 1 update with newer date', () => {
  const rows = [];
  for (let i = 1; i <= 5; i++) rows.push(txn({ id: i, amount: 10, merchant_name: 'NoiseCo' + i }));
  rows.push(txn({ id: 99, amount: 200, merchant_name: 'KFC', date: '2026-04-30' }));

  // Existing finding for KFC from 30 days ago (well within window).
  const existingByMerchantHash = new Map([
    [merchantHash('KFC'), { id: 7, occurred_at: '2026-03-30' }],
  ]);

  const r = buildUnusuallyLargeTransaction(rows, {
    today: TODAY, existingByMerchantHash,
  });
  assert.equal(r.toInsert.length, 0);
  assert.equal(r.toUpdate.length, 1);
  assert.equal(r.toUpdate[0].id, 7);
  assert.equal(r.toUpdate[0].new_occurred_at, '2026-04-30');
});

test('different category outliers do not pollute each other', () => {
  const rows = [
    txn({ id: 1, amount: 50, category_id: 1, merchant_name: 'A1' }),
    txn({ id: 2, amount: 50, category_id: 1, merchant_name: 'A2' }),
    txn({ id: 3, amount: 50, category_id: 1, merchant_name: 'A3' }),
    txn({ id: 10, amount: 20, category_id: 2, merchant_name: 'B1' }),
    txn({ id: 11, amount: 20, category_id: 2, merchant_name: 'B2' }),
    txn({ id: 12, amount: 20, category_id: 2, merchant_name: 'B3' }),
    txn({ id: 99,  amount: 250, category_id: 1, merchant_name: 'CatOneNew' }),
    txn({ id: 100, amount: 90,  category_id: 2, merchant_name: 'CatTwoNew' }),
  ];
  const r = buildUnusuallyLargeTransaction(rows, { today: TODAY });
  assert.equal(r.toInsert.length, 1);
  assert.ok(r.toInsert[0].title.includes('CatOneNew'));
});

test('merchantHash is stable across calls', () => {
  assert.equal(merchantHash('Netflix'), merchantHash('Netflix'));
  assert.notEqual(merchantHash('Netflix'), merchantHash('Hulu'));
  assert.equal(typeof merchantHash('X'), 'number');
});

// unusually_large_transaction.
//
// ─── BUG WE CAUGHT (Phase 3E first pass) ───────────────────────────────
// An earlier version queried `WHERE amount > 0` and computed a per-category
// median over EVERY positive-amount transaction. Result: paychecks (which
// Plaid sandbox tags as 'Transfer → Debit' and lands in our 'Other'
// MoneyMind bucket) and credit-card auto-payments (Plaid 'Payment' primary)
// were both counted in the median AND flagged as outliers on every payday.
// Fix: route every transaction through classifyFlow() and only keep
// flow === 'spending'. The median is computed from spending-only too.
//
// ─── REFINEMENT 1: merchant-history check ──────────────────────────────
// A merchant that has charged similar amounts repeatedly is the user's
// pattern, not an anomaly. Without this filter, recurring outliers
// (rent, mortgage, monthly $500 charges) fire repeatedly each month and
// drown out genuine surprises. Skip a candidate if its merchant_name has
// ≥ 3 prior transactions within ±30% of the current amount across the
// last 6 months. This needs a 180-day data pull (vs the original 90)
// so we can see enough history.
//
// ─── REFINEMENT 2: per-merchant dedup at detection time ────────────────
// One finding per merchant per quarter. Repeat outliers update the
// existing finding's occurred_at instead of creating duplicates. We
// switch related_entity_type to 'merchant' (and related_entity_id to a
// stable 32-bit hash of the merchant name) so the existing UNIQUE
// constraint plus an in-detector lookup naturally dedupe across runs.
// ───────────────────────────────────────────────────────────────────────

const { fmtUSD, formatDate } = require('../util');
const { classifyFlow } = require('../../transaction-flow');

const MULTIPLE = 4;
const FLOOR_CENTS = 10000; // $100
const SIMILAR_BAND = 0.30; // ±30% for "similar amount" in Refinement 1
const HISTORY_MIN_PRIOR = 3;
const NINETY_DAYS_MS  = 90  * 24 * 3600 * 1000;
const ONE_EIGHTY_MS   = 180 * 24 * 3600 * 1000;

function median(arr) {
  if (!arr || arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

// Stable string→32-bit-int hash. Same merchant string always hashes to
// the same value within and across processes. Collision risk is low for
// a single user's merchant set; bounded by Postgres INTEGER (-2^31..2^31).
function merchantHash(name) {
  let h = 0;
  const s = String(name || '');
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return h;
}

function asDate(d) {
  if (d instanceof Date) return d;
  return new Date(typeof d === 'string' ? d : String(d));
}

// Mirror recurring-detection's clusterKeyFor. When merchant_name is null
// (common in Plaid sandbox), fall back to the trimmed/lowercased/truncated
// `name`. Prevents same-merchant outliers from looking distinct just
// because Plaid didn't normalize the merchant string.
function merchantKey(t) {
  const m = (t.merchant_name || '').trim();
  if (m) return m;
  return (t.name || '').trim().toLowerCase().slice(0, 30);
}

// Returns: { toInsert: [findings], toUpdate: [{id, new_occurred_at}] }
//
// opts:
//   existingByMerchantHash: Map<int, {id, occurred_at}> — current
//     non-dismissed findings of this type for this user, keyed by hash
//     of their related_entity_id (which IS the merchant hash).
//   today: Date — anchor for the 90-day "still relevant" window. Defaults
//     to new Date(); accepts a Date for deterministic tests.
function buildUnusuallyLargeTransaction(txns, opts) {
  const o = opts || {};
  const existingByMerchantHash = o.existingByMerchantHash || new Map();
  const today = o.today instanceof Date ? o.today : new Date();

  const empty = { toInsert: [], toUpdate: [] };
  if (!Array.isArray(txns) || txns.length === 0) return empty;

  // Filter to spending only. classifyFlow handles Plaid's sign convention
  // and the Transfer/Payment/Income/Refund overrides.
  const spending = txns.filter((t) => classifyFlow(t) === 'spending');
  if (spending.length === 0) return empty;

  // Sub-windows. The input may be 180 days or anything else; we slice.
  const ninetyAgo  = today.getTime() - NINETY_DAYS_MS;
  const oneEightyAgo = today.getTime() - ONE_EIGHTY_MS;
  const last90  = spending.filter((t) => asDate(t.date).getTime() >= ninetyAgo);
  const last180 = spending.filter((t) => asDate(t.date).getTime() >= oneEightyAgo);

  // Per-category median from last 90 days only — keeps the median stable
  // and reflective of "current normal".
  const byCategory = new Map();
  for (const t of last90) {
    const k = t.category_id == null ? 'null' : t.category_id;
    if (!byCategory.has(k)) byCategory.set(k, []);
    byCategory.get(k).push(t.amount_cents);
  }
  const medians = new Map();
  for (const [k, amounts] of byCategory) medians.set(k, median(amounts));

  // Step 1: outlier candidates from last 90 days
  const outliers = [];
  for (const t of last90) {
    const k = t.category_id == null ? 'null' : t.category_id;
    const med = medians.get(k) || 0;
    if (med <= 0) continue;
    if (t.amount_cents <= med * MULTIPLE) continue;
    if (t.amount_cents <= FLOOR_CENTS) continue;

    // Refinement 1: merchant-history check.
    // Skip if this merchant has ≥3 PRIOR (strictly earlier) transactions
    // within ±30% of the current amount across the last 6 months.
    // We use merchantKey() (merchant_name with name-fallback) so sandbox
    // rows whose merchant_name is null but `name` is "Tectra Inc" still
    // cluster correctly.
    const mKey = merchantKey(t);
    if (mKey) {
      const tDate = asDate(t.date).getTime();
      const lower = t.amount_cents * (1 - SIMILAR_BAND);
      const upper = t.amount_cents * (1 + SIMILAR_BAND);
      let priorSimilar = 0;
      for (const o2 of last180) {
        if (o2.id === t.id) continue;
        if (merchantKey(o2) !== mKey) continue;
        if (asDate(o2.date).getTime() >= tDate) continue;
        if (o2.amount_cents < lower || o2.amount_cents > upper) continue;
        priorSimilar += 1;
        if (priorSimilar >= HISTORY_MIN_PRIOR) break;
      }
      if (priorSimilar >= HISTORY_MIN_PRIOR) continue;
    }

    const displayName = t.merchant_name || t.name || 'Unknown';
    const delta = Math.round(t.amount_cents - med);
    outliers.push({
      finding_type: 'unusually_large_transaction',
      tier: 'important',
      title: 'Unusually large ' + (t.category_name || 'transaction') + ': ' + displayName + '.',
      body: fmtUSD(t.amount_cents) + ' is ' + Math.round(t.amount_cents / med)
          + '× your median for this category (' + fmtUSD(med) + ').',
      related_entity_type: 'merchant',
      // Will be overwritten with merchantHash(mKey) below.
      related_entity_id: t.id,
      deep_link_path: '/transactions',
      money_at_stake_cents: delta,
      occurred_at: formatDate(t.date) || t.date,
      _merchant_key: mKey || null,
      _txn_date_ms: asDate(t.date).getTime(),
    });
  }

  // Step 2: within-candidates dedup. One per merchant key; keep the latest.
  // (When mKey is empty we fall back to transaction-id so each fires.)
  const byMerchant = new Map();
  for (const c of outliers) {
    const key = c._merchant_key ? 'm:' + c._merchant_key : 't:' + c.related_entity_id;
    const prev = byMerchant.get(key);
    if (!prev || c._txn_date_ms > prev._txn_date_ms) byMerchant.set(key, c);
  }
  const dedupedCandidates = [...byMerchant.values()];

  // Step 3: against existing findings (Refinement 2's persisted side).
  const result = { toInsert: [], toUpdate: [] };
  for (const c of dedupedCandidates) {
    const mKey = c._merchant_key;
    if (mKey) {
      const hash = merchantHash(mKey);
      const existing = existingByMerchantHash.get(hash);
      if (existing) {
        const exMs = asDate(existing.occurred_at).getTime();
        // Only treat as a dedupe target if the existing finding is within
        // the 90-day window. Older than that → window expired, surface
        // a fresh finding instead.
        if (today.getTime() - exMs <= NINETY_DAYS_MS) {
          if (c._txn_date_ms > exMs) {
            result.toUpdate.push({ id: existing.id, new_occurred_at: c.occurred_at });
          }
          continue;
        }
      }
      const { _merchant_key, _txn_date_ms, ...rest } = c;
      result.toInsert.push({
        ...rest,
        related_entity_type: 'merchant',
        related_entity_id: hash,
      });
    } else {
      const { _merchant_key, _txn_date_ms, ...rest } = c;
      result.toInsert.push({ ...rest, related_entity_type: 'transaction' });
    }
  }
  return result;
}

async function detectUnusuallyLargeTransaction(userId, client) {
  // Pull 180 days so the merchant-history check has enough lookback.
  const { rows: txns } = await client.query(
    `SELECT t.id, t.date,
            t.amount,
            ROUND(t.amount * 100)::int AS amount_cents,
            t.name, t.merchant_name, t.category_id,
            t.plaid_category_primary,
            c.name AS category_name
       FROM transactions t
       LEFT JOIN categories c ON c.id = t.category_id AND c.user_id = t.user_id
      WHERE t.user_id = $1 AND t.amount > 0
        AND t.date >= (CURRENT_DATE - INTERVAL '180 days')`,
    [userId]
  );

  // Pull existing merchant-keyed unusually_large findings for this user.
  // The map's key is the merchant hash (= related_entity_id). We never
  // need to recover the merchant string from the hash — the candidate
  // brings its own.
  const { rows: existing } = await client.query(
    `SELECT id, related_entity_id AS merchant_hash, occurred_at
       FROM findings
      WHERE user_id = $1
        AND finding_type = 'unusually_large_transaction'
        AND related_entity_type = 'merchant'
        AND is_dismissed = FALSE`,
    [userId]
  );
  const existingByMerchantHash = new Map(
    existing.map((e) => [e.merchant_hash, { id: e.id, occurred_at: e.occurred_at }])
  );

  const { toInsert, toUpdate } = buildUnusuallyLargeTransaction(txns, {
    existingByMerchantHash,
    today: new Date(),
  });

  // Apply the in-place updates inside the orchestrator's transaction.
  // user_id filter is the safety boundary even though the SELECT above
  // already scoped — defense in depth.
  for (const u of toUpdate) {
    await client.query(
      `UPDATE findings
          SET occurred_at = $1, updated_at = NOW()
        WHERE id = $2 AND user_id = $3
          AND finding_type = 'unusually_large_transaction'`,
      [u.new_occurred_at, u.id, userId]
    );
  }

  return toInsert;
}

module.exports = {
  buildUnusuallyLargeTransaction,
  detectUnusuallyLargeTransaction,
  merchantHash,
};

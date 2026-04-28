// Recurring-charge detection.
//
// Two entry points:
//   • detectFromTransactions(txns, today) — pure function over an in-memory
//     list. No DB. Used by tests and by the wrapper below.
//   • detectRecurring(userId) — queries the user's last 18 months of
//     positive-amount transactions (excluding Plaid Transfer/Payment/Income
//     primary categories) and runs the pure function. Always user-scoped.
//
// Algorithm:
//   Pass 1: cluster by merchant_key (merchant_name → fallback to lowercased,
//           30-char-truncated `name`).
//   Pass 2: cadence detection — match the median day-gap to one of five
//           templates (weekly/biweekly/monthly/quarterly/annual). Skip
//           clusters that don't fit any template.
//   Pass 3: confidence score = occurrences (0-30) + cadence consistency
//           (0-30) + amount stability (0-25) + recency (0-15). Surface
//           clusters with confidence ≥ 60.
//
// All summary stats (median amount, "previous-5" baseline for price change)
// use the median, not the mean — robust against outliers.
//
// db.js is lazy-imported inside detectRecurring(); the pure function
// detectFromTransactions does NOT pull in the pool (so unit tests don't
// need a live DATABASE_URL).

// ─── Cadence-threshold rationale ──────────────────────────────────────────
// minOccurrences is per-cadence: short cadences need more samples to be
// believable (a "weekly" pattern needs ≥4 weeks of data; a "quarterly" only
// needs the second occurrence to confirm).
//
// Real subscriptions cluster in the $5–$100/month range (streaming,
// software, gym). A 3-month run of high-dollar charges (≥ $100) is more
// likely to be coincidence than recurring (rent, irregular shopping).
// We require an extra month of evidence (≥ 4 occurrences) before surfacing
// high-dollar charges as recurring. This trades some recall for much
// higher precision — in financial software, false positives destroy user
// trust faster than missing one real subscription does.
//
// The amount-aware override is applied only to MONTHLY cadence (see the
// override below CADENCE_TEMPLATES). Quarterly and annual high-dollar
// charges already need fewer matches by their nature; weekly/biweekly
// at >$100/charge would be too unusual to single out specially.
// ──────────────────────────────────────────────────────────────────────────
const CADENCE_TEMPLATES = [
  { name: 'weekly',    minGap:   5, maxGap:   9, targetGap:   7, intervalDays:   7, minOccurrences: 4 },
  { name: 'biweekly',  minGap:  11, maxGap:  17, targetGap:  14, intervalDays:  14, minOccurrences: 3 },
  { name: 'monthly',   minGap:  25, maxGap:  34, targetGap:  30, intervalDays:  30, minOccurrences: 3 },
  { name: 'quarterly', minGap:  83, maxGap:  97, targetGap:  91, intervalDays:  91, minOccurrences: 2 },
  { name: 'annual',    minGap: 351, maxGap: 379, targetGap: 365, intervalDays: 365, minOccurrences: 2 },
];

// Amount-aware monthly override (cents). Median ≥ this → require ≥ 4
// occurrences for monthly-cadence clusters.
const MONTHLY_HIGH_DOLLAR_THRESHOLD_CENTS = 10000; // $100.00
const MONTHLY_HIGH_DOLLAR_MIN_OCCURRENCES = 4;

const CONFIDENCE_THRESHOLD = 70;
const EXCLUDED_PLAID_PRIMARY = new Set(['Transfer', 'Payment', 'Income']);

const MS_PER_DAY = 1000 * 60 * 60 * 24;

function median(arr) {
  if (!arr || arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

function clusterKeyFor(txn) {
  const m = (txn.merchant_name || '').trim();
  if (m) return m;
  return (txn.name || '').trim().toLowerCase().slice(0, 30);
}

function dayGaps(dates) {
  const gaps = [];
  for (let i = 1; i < dates.length; i++) {
    gaps.push((dates[i] - dates[i - 1]) / MS_PER_DAY);
  }
  return gaps;
}

function matchCadence(gaps) {
  if (gaps.length === 0) return null;
  const med = median(gaps);
  for (const t of CADENCE_TEMPLATES) {
    if (med >= t.minGap && med <= t.maxGap) return t;
  }
  return null;
}

function occurrenceScore(count) {
  return Math.min(30, count * 5);
}

function consistencyScore(gaps, target) {
  if (gaps.length === 0) return 0;
  const med = median(gaps);
  // Robust spread metric: median absolute deviation, normalized to target.
  const mad = median(gaps.map((g) => Math.abs(g - med)));
  const norm = Math.max(0, Math.min(1, mad / target));
  return Math.round(30 * (1 - norm));
}

function amountStabilityScore(amountsCents) {
  if (amountsCents.length === 0) return 0;
  const med = median(amountsCents);
  if (med === 0) return 25;
  const mad = median(amountsCents.map((a) => Math.abs(a - med)));
  const norm = Math.max(0, Math.min(1, mad / med));
  return Math.round(25 * (1 - norm));
}

function recencyScore(lastDate, intervalDays, today) {
  const days = (today - lastDate) / MS_PER_DAY;
  if (days < 0) return 15; // future-dated rows are anomalies; treat as on-time
  if (days <= intervalDays) return 15;
  if (days <= intervalDays * 1.5) {
    return Math.round(15 * (1 - (days - intervalDays) / (intervalDays * 0.5)));
  }
  return 0;
}

// Compares the most-recent amount to the median of the previous 5.
// Triggers when the diff is > 5% AND > $1.
function priceChange(amountsCents) {
  if (!amountsCents || amountsCents.length < 2) {
    return { changed: false, prevMedian: amountsCents[0] || 0, last: amountsCents[0] || 0 };
  }
  const last = amountsCents[amountsCents.length - 1];
  const prev = amountsCents.slice(0, -1).slice(-5);
  const prevMedian = median(prev);
  if (prevMedian === 0) return { changed: false, prevMedian, last };
  const diff = Math.abs(last - prevMedian);
  const pct = diff / prevMedian;
  return { changed: pct > 0.05 && diff > 100, prevMedian, last };
}

function toDate(s) {
  // Accepts Date or 'YYYY-MM-DD' string.
  if (s instanceof Date) return s;
  return new Date(s + 'T00:00:00Z');
}

function detectFromTransactions(txns, today = new Date()) {
  if (!Array.isArray(txns) || txns.length === 0) return [];

  // Cluster — skip excluded Plaid primary categories.
  const clusters = new Map();
  for (const tx of txns) {
    if (EXCLUDED_PLAID_PRIMARY.has(tx.plaid_category_primary || '')) continue;
    const amt = Number(tx.amount);
    if (!isFinite(amt) || amt <= 0) continue;
    const key = clusterKeyFor(tx);
    if (!key) continue;
    if (!clusters.has(key)) clusters.set(key, []);
    clusters.get(key).push(tx);
  }

  const detected = [];
  for (const [key, group] of clusters) {
    if (group.length < 2) continue;
    group.sort((a, b) => toDate(a.date) - toDate(b.date));
    const dates = group.map((t) => toDate(t.date));
    const amountsCents = group.map((t) => Math.round(Number(t.amount) * 100));

    const gaps = dayGaps(dates);
    const tmpl = matchCadence(gaps);
    if (!tmpl) continue;

    // Per-cadence minimum-occurrence gate. Short cadences need more samples;
    // see CADENCE_TEMPLATES above for the why.
    if (group.length < tmpl.minOccurrences) continue;

    // Amount-aware override for monthly: high-dollar (≥ $100) needs ≥ 4
    // occurrences. See the rationale comment block above CADENCE_TEMPLATES.
    const medianAmtCents = Math.round(median(amountsCents));
    if (tmpl.name === 'monthly'
        && medianAmtCents >= MONTHLY_HIGH_DOLLAR_THRESHOLD_CENTS
        && group.length < MONTHLY_HIGH_DOLLAR_MIN_OCCURRENCES) {
      continue;
    }

    const conf = occurrenceScore(group.length)
      + consistencyScore(gaps, tmpl.targetGap)
      + amountStabilityScore(amountsCents)
      + recencyScore(dates[dates.length - 1], tmpl.intervalDays, today);
    if (conf < CONFIDENCE_THRESHOLD) continue;

    const lastDate = dates[dates.length - 1];
    const daysSince = (today - lastDate) / MS_PER_DAY;
    const status = daysSince <= tmpl.intervalDays * 1.5 ? 'active' : 'ended';

    const medGap = median(gaps);
    const next = new Date(lastDate.getTime() + Math.round(medGap) * MS_PER_DAY);

    const pc = priceChange(amountsCents);
    const last = group[group.length - 1];
    const displayName = (last.merchant_name || '').trim() || key;

    detected.push({
      merchant_key: key,
      display_name: displayName,
      category_id: last.category_id == null ? null : Number(last.category_id),
      cadence: tmpl.name,
      median_amount_cents: medianAmtCents,
      last_amount_cents: amountsCents[amountsCents.length - 1],
      last_charged_date: lastDate.toISOString().slice(0, 10),
      next_expected_date: next.toISOString().slice(0, 10),
      occurrence_count: group.length,
      confidence_score: conf,
      status,
      price_change_detected: pc.changed,
    });
  }

  return detected;
}

async function detectRecurring(userId) {
  const { pool } = require('../db');
  const { rows } = await pool.query(
    `SELECT id, name, merchant_name, amount, date, category_id, plaid_category_primary
       FROM transactions
      WHERE user_id = $1
        AND date >= (CURRENT_DATE - INTERVAL '18 months')
        AND amount > 0
        AND COALESCE(plaid_category_primary, '') NOT IN ('Transfer', 'Payment', 'Income')
      ORDER BY date ASC`,
    [userId]
  );
  return detectFromTransactions(rows);
}

module.exports = {
  detectRecurring,
  detectFromTransactions,
  // exported for unit tests
  median,
  dayGaps,
  matchCadence,
  occurrenceScore,
  consistencyScore,
  amountStabilityScore,
  recencyScore,
  priceChange,
  clusterKeyFor,
  CONFIDENCE_THRESHOLD,
  CADENCE_TEMPLATES,
};

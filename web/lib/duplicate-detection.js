// Looks for pairs of active recurring charges that may be duplicates.
//
// ── ONE active heuristic: known overlap pairs ────────────────────────────
// Substring match (case-insensitive) on `display_name` against a hardcoded
// list of merchant pairs that commonly indicate duplicate services
// (Spotify ↔ Apple Music, Netflix ↔ Hulu, ChatGPT ↔ Claude, etc.).
//
// ── Disabled: same-category-similar-cost ─────────────────────────────────
// We previously also flagged any two charges in the same MoneyMind category
// whose monthly cost was within ±$5 OR ±30%. That heuristic was disabled
// before friends-and-family launch because it fires on noise: with only 5
// broad categories ("Eating Out", "Other", etc.), any two charges that
// happen to share a category and are similar in cost get paired up — even
// when they're obviously different services. Without a semantic-merchant
// signal (e.g. "both are music services") the same-category proxy is too
// coarse to be useful. The pass-1 loop is gone; if ever re-enabled, see
// the prior commit history for the implementation.
//
// Always user-scoped: the query filters WHERE user_id = $1.

const { pool } = require('../db');

const KNOWN_OVERLAP_PAIRS = [
  ['Spotify', 'Apple Music'],
  ['Spotify', 'Pandora'],
  ['Spotify', 'YouTube Music'],
  ['Apple Music', 'YouTube Music'],
  ['Netflix', 'Hulu'],
  ['Netflix', 'Disney+'],
  ['Netflix', 'HBO Max'],
  ['Netflix', 'Max'],
  ['Disney+', 'Paramount+'],
  ['Hulu', 'HBO Max'],
  ['Hulu', 'Max'],
  ['Hulu', 'Peacock'],
  ['ChatGPT', 'Claude'],
  ['ChatGPT', 'Gemini'],
  ['Claude', 'Gemini'],
  ['Dropbox', 'Google Drive'],
  ['Dropbox', 'OneDrive'],
  ['Google Drive', 'OneDrive'],
  ['Google Drive', 'iCloud'],
  ['Adobe Creative Cloud', 'Canva'],
  ['Adobe', 'Canva'],
  ['Audible', 'Spotify'],
  ['Audible', 'Libby'],
  ['Notion', 'Evernote'],
  ['1Password', 'LastPass'],
];

const CADENCE_PER_MONTH = {
  weekly: 4.33,
  biweekly: 2.17,
  monthly: 1,
  quarterly: 1 / 3,
  annual: 1 / 12,
};

function monthlyEquivalentCents(rec) {
  const k = CADENCE_PER_MONTH[rec.cadence];
  if (!k) return rec.median_amount_cents;
  return Math.round(rec.median_amount_cents * k);
}

function nameContains(haystack, needle) {
  return String(haystack || '').toLowerCase().includes(String(needle || '').toLowerCase());
}

async function detectDuplicates(userId) {
  const { rows } = await pool.query(
    `SELECT id, display_name, category_id, cadence, median_amount_cents
       FROM recurring_charges
      WHERE user_id = $1
        AND status = 'active'
        AND is_user_dismissed = FALSE`,
    [userId]
  );

  const pairs = [];
  const seen = new Set();
  function pairKey(a, b) {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    return `${lo}-${hi}`;
  }

  // Known overlap pairs (substring match on display_name).
  // This is a full cross-product per pair — if a user has multiple rows
  // matching the same brand name, EVERY (left, right) combination is
  // considered. (The previous .find()/.find() version stopped at the first
  // match per side, which would miss valid pairings; now fixed.)
  for (const [n1, n2] of KNOWN_OVERLAP_PAIRS) {
    const lefts = rows.filter((r) => nameContains(r.display_name, n1));
    const rights = rows.filter((r) => nameContains(r.display_name, n2));
    for (const left of lefts) {
      for (const right of rights) {
        if (left.id === right.id) continue;
        const key = pairKey(left.id, right.id);
        if (seen.has(key)) continue;
        seen.add(key);
        pairs.push({
          left_charge_id: left.id,
          right_charge_id: right.id,
          reason: 'known_overlap_pair',
          monthly_cost_diff_cents: Math.abs(monthlyEquivalentCents(left) - monthlyEquivalentCents(right)),
        });
      }
    }
  }

  return pairs;
}

module.exports = { detectDuplicates, monthlyEquivalentCents, CADENCE_PER_MONTH, KNOWN_OVERLAP_PAIRS };

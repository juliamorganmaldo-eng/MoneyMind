// net_worth_milestone — fires when net worth crosses one of the boundaries
// listed below in either direction during the past 7 days.

const { fmtUSD } = require('../util');

const BOUNDARIES_CENTS = [
  -5000000,  // -$50K
  -2500000,  // -$25K
  -1000000,  // -$10K
   1000000,  //  $10K
   2500000,  //  $25K
   5000000,  //  $50K
  10000000,  // $100K
];

// Returns the list of boundaries crossed when going from `from` → `to`.
function crossedBoundaries(from, to) {
  const out = [];
  for (const b of BOUNDARIES_CENTS) {
    if ((from < b && to >= b) || (from > b && to <= b)) out.push(b);
  }
  return out;
}

// inputs: { from_cents, to_cents, today (Date) }
function buildNetWorthMilestone(from_cents, to_cents, today = new Date()) {
  if (from_cents == null || to_cents == null) return [];
  const crossed = crossedBoundaries(from_cents, to_cents);
  const out = [];
  for (const b of crossed) {
    const direction = to_cents >= b ? 'crossed above' : 'dropped below';
    out.push({
      finding_type: 'net_worth_milestone',
      tier: 'positive',
      title: 'Net worth ' + direction + ' ' + fmtUSD(b) + '.',
      body: 'Now at ' + fmtUSD(to_cents) + ' — was ' + fmtUSD(from_cents) + ' a week ago.',
      related_entity_type: 'net_worth_boundary',
      // Use the boundary value as the entity_id so re-runs dedupe per boundary,
      // but DOWNWARD vs UPWARD crossings end up with same id; differentiate
      // via occurred_at = today (will only repeat once per direction per day).
      related_entity_id: b,
      deep_link_path: '/net-worth',
      money_at_stake_cents: null,
      occurred_at: today,
    });
  }
  return out;
}

// Pulls "now" net worth and "7 days ago" net worth from snapshots, then
// runs the pure helper. Only fires when there's enough history.
async function detectNetWorthMilestone(userId, client) {
  // Get accounts + classification info
  const { classifyAccount } = require('../../account-classification');
  const { rows: accts } = await client.query(
    `SELECT id, type, is_asset_override, excluded_from_net_worth
       FROM accounts WHERE user_id = $1`,
    [userId]
  );
  if (accts.length === 0) return [];

  // For a given as-of-date, sum each account's latest balance ≤ that date.
  async function netAsOf(asOfDate) {
    const { rows } = await client.query(
      `SELECT account_id, balance_cents, snapshot_date
         FROM balance_snapshots
        WHERE user_id = $1 AND snapshot_date <= $2
        ORDER BY account_id, snapshot_date DESC`,
      [userId, asOfDate]
    );
    // First row per account is the most recent ≤ as-of-date.
    const seen = new Set();
    let assets = 0, liab = 0;
    for (const r of rows) {
      if (seen.has(r.account_id)) continue;
      seen.add(r.account_id);
      const a = accts.find(x => x.id === r.account_id);
      if (!a) continue;
      const cls = classifyAccount(a);
      if (cls === 'asset') assets += r.balance_cents || 0;
      else if (cls === 'liability') liab += r.balance_cents || 0;
    }
    return seen.size === 0 ? null : assets - liab;
  }

  const today = new Date();
  const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
  const todayStr = today.toISOString().slice(0, 10);
  const weekAgoStr = weekAgo.toISOString().slice(0, 10);

  const [now, before] = await Promise.all([netAsOf(todayStr), netAsOf(weekAgoStr)]);
  if (now == null || before == null) return [];
  return buildNetWorthMilestone(before, now, today);
}

module.exports = { buildNetWorthMilestone, detectNetWorthMilestone, crossedBoundaries };

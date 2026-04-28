// account_below_threshold.

const { firstOfCurrentMonth, fmtUSD } = require('../util');

// rows: [{ account_id, account_name, mask, current_balance_cents, threshold_cents, enabled }, ...]
function buildAccountBelowThreshold(rows, today = firstOfCurrentMonth()) {
  const out = [];
  for (const r of rows) {
    if (!r.enabled) continue;
    if (r.threshold_cents == null || r.current_balance_cents == null) continue;
    if (r.current_balance_cents >= r.threshold_cents) continue;
    const gap = r.threshold_cents - r.current_balance_cents;
    const maskTxt = r.mask ? ' ····' + r.mask : '';
    out.push({
      finding_type: 'account_below_threshold',
      tier: 'critical',
      title: r.account_name + maskTxt + ' below threshold.',
      body: fmtUSD(r.current_balance_cents) + ' current vs '
          + fmtUSD(r.threshold_cents) + ' threshold (' + fmtUSD(gap) + ' under).',
      related_entity_type: 'account',
      related_entity_id: r.account_id,
      deep_link_path: '/alerts',
      money_at_stake_cents: gap,
      occurred_at: today,
    });
  }
  return out;
}

async function detectAccountBelowThreshold(userId, client) {
  const { rows } = await client.query(
    `SELECT a.id   AS account_id,
            a.name AS account_name,
            a.mask,
            ROUND(a.current_balance * 100)::int AS current_balance_cents,
            lbt.threshold_cents,
            lbt.enabled
       FROM accounts a
       JOIN low_balance_thresholds lbt
         ON lbt.user_id = a.user_id AND lbt.account_id = a.id
      WHERE a.user_id = $1`,
    [userId]
  );
  return buildAccountBelowThreshold(rows);
}

module.exports = { buildAccountBelowThreshold, detectAccountBelowThreshold };

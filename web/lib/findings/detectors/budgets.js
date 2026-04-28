// budget_exceeded + budget_approaching.
// Both detectors operate on the same per-(user, category) row of
// {limit, current_month_spend} so we share the SQL.

const { firstOfCurrentMonth, fmtUSD } = require('../util');

// rows: [{ category_id, category_name, monthly_limit_cents, current_spend_cents }, ...]
function buildBudgetExceeded(rows, today = firstOfCurrentMonth()) {
  const out = [];
  for (const r of rows) {
    if (!r.monthly_limit_cents) continue;
    if (r.current_spend_cents <= r.monthly_limit_cents) continue;
    const overCents = r.current_spend_cents - r.monthly_limit_cents;
    const overPct = Math.round((overCents / r.monthly_limit_cents) * 100);
    out.push({
      finding_type: 'budget_exceeded',
      tier: 'critical',
      title: r.category_name + ' budget exceeded.',
      body: fmtUSD(r.current_spend_cents) + ' spent of ' + fmtUSD(r.monthly_limit_cents)
          + ' limit (' + overPct + '% over).',
      related_entity_type: 'budget_limit',
      related_entity_id: r.budget_limit_id,
      deep_link_path: '/budgets',
      money_at_stake_cents: overCents,
      occurred_at: today,
    });
  }
  return out;
}

function buildBudgetApproaching(rows, today = firstOfCurrentMonth()) {
  const out = [];
  for (const r of rows) {
    if (!r.monthly_limit_cents) continue;
    const pct = (r.current_spend_cents / r.monthly_limit_cents) * 100;
    if (pct < 80 || pct > 100) continue;
    const remaining = r.monthly_limit_cents - r.current_spend_cents;
    out.push({
      finding_type: 'budget_approaching',
      tier: 'important',
      title: r.category_name + ' budget at ' + Math.round(pct) + '%.',
      body: fmtUSD(r.current_spend_cents) + ' of ' + fmtUSD(r.monthly_limit_cents)
          + ' spent — ' + fmtUSD(remaining) + ' remaining this month.',
      related_entity_type: 'budget_limit',
      related_entity_id: r.budget_limit_id,
      deep_link_path: '/budgets',
      money_at_stake_cents: remaining,
      occurred_at: today,
    });
  }
  return out;
}

async function fetchBudgetSpend(userId, client) {
  const { rows } = await client.query(
    `SELECT c.id   AS category_id,
            c.name AS category_name,
            bl.id  AS budget_limit_id,
            bl.monthly_limit_cents,
            COALESCE(ROUND((SUM(CASE WHEN t.amount > 0 THEN t.amount ELSE 0 END)) * 100), 0)::int
              AS current_spend_cents
       FROM categories c
       JOIN budget_limits bl ON bl.user_id = c.user_id AND bl.category_id = c.id
       LEFT JOIN transactions t
         ON t.user_id = c.user_id AND t.category_id = c.id
        AND t.date >= date_trunc('month', CURRENT_DATE)
        AND t.date <  (date_trunc('month', CURRENT_DATE) + INTERVAL '1 month')
      WHERE c.user_id = $1
      GROUP BY c.id, c.name, bl.id, bl.monthly_limit_cents`,
    [userId]
  );
  return rows;
}

async function detectBudgetExceeded(userId, client) {
  return buildBudgetExceeded(await fetchBudgetSpend(userId, client));
}
async function detectBudgetApproaching(userId, client) {
  return buildBudgetApproaching(await fetchBudgetSpend(userId, client));
}

module.exports = {
  buildBudgetExceeded, buildBudgetApproaching,
  detectBudgetExceeded, detectBudgetApproaching,
};

// spending_category_up + spending_category_down.

const { firstOfCurrentMonth, fmtUSD } = require('../util');

const UP_RATIO    = 1.4;
const DOWN_RATIO  = 0.6;
const MIN_DELTA_CENTS = 5000; // $50

// inputs:
//   rows: [{ category_id, category_name, current_cents, last_cents }]
function buildSpendingCategoryUp(rows, today = firstOfCurrentMonth()) {
  const out = [];
  for (const r of rows) {
    if (r.last_cents <= 0) continue;
    const ratio = r.current_cents / r.last_cents;
    const delta = r.current_cents - r.last_cents;
    if (ratio < UP_RATIO) continue;
    if (delta < MIN_DELTA_CENTS) continue;
    out.push({
      finding_type: 'spending_category_up',
      tier: 'important',
      title: r.category_name + ' spending up ' + Math.round((ratio - 1) * 100) + '%.',
      body: fmtUSD(r.current_cents) + ' so far this month vs '
          + fmtUSD(r.last_cents) + ' all of last month.',
      related_entity_type: 'category',
      related_entity_id: r.category_id,
      deep_link_path: '/transactions',
      money_at_stake_cents: delta,
      occurred_at: today,
    });
  }
  return out;
}

function buildSpendingCategoryDown(rows, today = firstOfCurrentMonth()) {
  const out = [];
  for (const r of rows) {
    if (r.last_cents <= 0) continue;
    const ratio = r.current_cents / r.last_cents;
    const delta = r.last_cents - r.current_cents;
    if (ratio > DOWN_RATIO) continue;
    if (delta < MIN_DELTA_CENTS) continue;
    out.push({
      finding_type: 'spending_category_down',
      tier: 'tip',
      title: r.category_name + ' spending down ' + Math.round((1 - ratio) * 100) + '%.',
      body: fmtUSD(r.current_cents) + ' so far this month vs '
          + fmtUSD(r.last_cents) + ' all of last month.',
      related_entity_type: 'category',
      related_entity_id: r.category_id,
      deep_link_path: '/transactions',
      money_at_stake_cents: delta,
      occurred_at: today,
    });
  }
  return out;
}

async function fetchMonthVsMonth(userId, client) {
  // Returns one row per category with current-month and last-month spend (cents).
  const { rows } = await client.query(
    `WITH this_month AS (
       SELECT category_id, ROUND(SUM(amount) * 100)::int AS spend
         FROM transactions
        WHERE user_id = $1 AND amount > 0
          AND date >= date_trunc('month', CURRENT_DATE)
          AND date <  (date_trunc('month', CURRENT_DATE) + INTERVAL '1 month')
        GROUP BY category_id
     ),
     last_month AS (
       SELECT category_id, ROUND(SUM(amount) * 100)::int AS spend
         FROM transactions
        WHERE user_id = $1 AND amount > 0
          AND date >= (date_trunc('month', CURRENT_DATE) - INTERVAL '1 month')
          AND date <  date_trunc('month', CURRENT_DATE)
        GROUP BY category_id
     )
     SELECT c.id   AS category_id,
            c.name AS category_name,
            COALESCE(tm.spend, 0) AS current_cents,
            COALESCE(lm.spend, 0) AS last_cents
       FROM categories c
       LEFT JOIN this_month tm ON tm.category_id = c.id
       LEFT JOIN last_month lm ON lm.category_id = c.id
      WHERE c.user_id = $1`,
    [userId]
  );
  return rows;
}

async function detectSpendingCategoryUp(userId, client) {
  return buildSpendingCategoryUp(await fetchMonthVsMonth(userId, client));
}
async function detectSpendingCategoryDown(userId, client) {
  return buildSpendingCategoryDown(await fetchMonthVsMonth(userId, client));
}

module.exports = {
  buildSpendingCategoryUp, detectSpendingCategoryUp,
  buildSpendingCategoryDown, detectSpendingCategoryDown,
};

// Runs every detector for one user, inserts new findings (deduped by the
// UNIQUE constraint), bumps `updated_at` on already-present rows.

const { pool } = require('../../db');

const budgets        = require('./detectors/budgets');
const acctThresholds = require('./detectors/account-thresholds');
const subs           = require('./detectors/subscriptions');
const txns           = require('./detectors/transactions');
const trends         = require('./detectors/spending-trends');
const savings        = require('./detectors/savings');
const networth       = require('./detectors/net-worth');

const DETECTORS = [
  { name: 'budget_exceeded',              fn: budgets.detectBudgetExceeded },
  { name: 'budget_approaching',           fn: budgets.detectBudgetApproaching },
  { name: 'account_below_threshold',      fn: acctThresholds.detectAccountBelowThreshold },
  { name: 'subscription_price_increased', fn: subs.detectSubscriptionPriceIncreased },
  { name: 'duplicate_subscription',       fn: subs.detectDuplicateSubscription },
  { name: 'recurring_charge_stopped',     fn: subs.detectRecurringChargeStopped },
  { name: 'new_recurring_charge',         fn: subs.detectNewRecurringCharge },
  { name: 'unusually_large_transaction',  fn: txns.detectUnusuallyLargeTransaction },
  { name: 'spending_category_up',         fn: trends.detectSpendingCategoryUp },
  { name: 'spending_category_down',       fn: trends.detectSpendingCategoryDown },
  { name: 'savings_rate_dropped',         fn: savings.detectSavingsRateDropped },
  { name: 'savings_rate_hit_target',      fn: savings.detectSavingsRateHitTarget },
  { name: 'net_worth_milestone',          fn: networth.detectNetWorthMilestone },
];

async function runDetectors(userId) {
  const client = await pool.connect();
  let inserted = 0, refreshed = 0;
  try {
    await client.query('BEGIN');

    // Run detectors. Each is wrapped so a single failure doesn't kill the
    // whole orchestrator (we want findings from the others to still land).
    const allFindings = [];
    for (const { name, fn } of DETECTORS) {
      try {
        const found = await fn(userId, client);
        for (const f of found) allFindings.push(f);
      } catch (err) {
        console.error('[findings] detector', name, 'failed:', err.message);
      }
    }

    for (const f of allFindings) {
      const r = await client.query(
        `INSERT INTO findings (
           user_id, finding_type, tier, title, body,
           related_entity_type, related_entity_id, deep_link_path,
           money_at_stake_cents, occurred_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (user_id, finding_type, related_entity_type, related_entity_id, occurred_at)
           DO UPDATE SET updated_at = NOW()
         RETURNING (xmax = 0) AS inserted_new`,
        [
          userId, f.finding_type, f.tier, f.title, f.body,
          f.related_entity_type, f.related_entity_id, f.deep_link_path,
          f.money_at_stake_cents, f.occurred_at,
        ]
      );
      if (r.rows[0].inserted_new) inserted += 1; else refreshed += 1;
    }

    await client.query('COMMIT');
    return { new_findings_count: inserted, refreshed_count: refreshed };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { runDetectors, DETECTORS };

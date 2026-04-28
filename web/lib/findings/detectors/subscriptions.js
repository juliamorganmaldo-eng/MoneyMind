// 4 detectors: subscription_price_increased, duplicate_subscription,
// recurring_charge_stopped, new_recurring_charge.

const { fmtUSD, firstOfCurrentMonth, formatDate } = require('../util');
const { detectDuplicates, monthlyEquivalentCents } = require('../../duplicate-detection');

// rows: recurring_charges with price_change_detected = true and updated_at recent.
// We require last > median for THIS detector — true price increases only.
function buildSubscriptionPriceIncreased(rows) {
  const out = [];
  for (const r of rows) {
    if (!r.price_change_detected) continue;
    if (r.last_amount_cents <= r.median_amount_cents) continue; // skip price drops
    const delta = r.last_amount_cents - r.median_amount_cents;
    out.push({
      finding_type: 'subscription_price_increased',
      tier: 'critical',
      title: r.display_name + ' price increased.',
      body: fmtUSD(r.median_amount_cents) + ' → ' + fmtUSD(r.last_amount_cents)
          + ' (' + fmtUSD(delta) + ' more per charge).',
      related_entity_type: 'recurring_charge',
      related_entity_id: r.id,
      deep_link_path: '/subscriptions/' + r.id,
      money_at_stake_cents: delta,
      occurred_at: r.updated_at,
    });
  }
  return out;
}

async function detectSubscriptionPriceIncreased(userId, client) {
  const { rows } = await client.query(
    `SELECT id, display_name, median_amount_cents, last_amount_cents,
            price_change_detected, updated_at
       FROM recurring_charges
      WHERE user_id = $1
        AND is_user_dismissed = FALSE
        AND price_change_detected = TRUE
        AND updated_at >= (NOW() - INTERVAL '30 days')`,
    [userId]
  );
  return buildSubscriptionPriceIncreased(rows);
}

// pairs: [{ left_charge_id, right_charge_id, reason, monthly_cost_diff_cents }]
// chargesById: Map of recurring_charge.id → row
function buildDuplicateSubscription(pairs, chargesById, today = firstOfCurrentMonth()) {
  const out = [];
  for (const p of pairs) {
    const L = chargesById.get(p.left_charge_id);
    const R = chargesById.get(p.right_charge_id);
    if (!L || !R) continue;
    const lo = Math.min(p.left_charge_id, p.right_charge_id); // stable id for UNIQUE
    const lMo = monthlyEquivalentCents(L);
    const rMo = monthlyEquivalentCents(R);
    const cheaperSave = Math.min(lMo, rMo);
    out.push({
      finding_type: 'duplicate_subscription',
      tier: 'important',
      title: 'Possible duplicate: ' + L.display_name + ' & ' + R.display_name + '.',
      body: 'Cancelling one could save up to ' + fmtUSD(cheaperSave) + '/mo.',
      related_entity_type: 'recurring_charge_pair',
      related_entity_id: lo,
      deep_link_path: '/subscriptions',
      money_at_stake_cents: cheaperSave,
      occurred_at: today,
    });
  }
  return out;
}

async function detectDuplicateSubscription(userId, client) {
  const pairs = await detectDuplicates(userId);
  if (pairs.length === 0) return [];
  const allIds = [...new Set(pairs.flatMap(p => [p.left_charge_id, p.right_charge_id]))];
  const { rows } = await client.query(
    `SELECT id, display_name, cadence, median_amount_cents
       FROM recurring_charges
      WHERE user_id = $1 AND id = ANY($2::int[])`,
    [userId, allIds]
  );
  const map = new Map(rows.map(r => [r.id, r]));
  return buildDuplicateSubscription(pairs, map);
}

// rows: recurring_charges that ended recently AND were sustained-active.
//
// ─── PRECISION TIGHTENED ───────────────────────────────────────────────
// Tighter than 'just an active row that ended' because Phase 3C's
// algorithm correctly demotes false-positive subscriptions to 'ended'
// when the occurrence pattern decays (e.g. a 3-month run of $500 charges
// that turned out to not be a real subscription). Surfacing those as
// "stopped charging" findings is misleading — the user never had a real
// subscription to begin with.
//
// Require sustained recurrence before treating an end as user-relevant:
//   • occurrence_count ≥ 4   (was ≥ 3 in spec — bumped for tighter precision)
//   • active for ≥ 14 days   (proxied as updated_at − created_at ≥ 14 days)
// Both filters live in SQL so the build helper just renders findings.
// ───────────────────────────────────────────────────────────────────────
function buildRecurringChargeStopped(rows) {
  const out = [];
  for (const r of rows) {
    const lastCharged = formatDate(r.last_charged_date) || 'recently';
    out.push({
      finding_type: 'recurring_charge_stopped',
      tier: 'important',
      title: r.display_name + ' stopped charging.',
      body: 'No new charges detected since ' + lastCharged
          + ' — was ' + fmtUSD(r.monthly_equivalent_cents) + '/mo.',
      related_entity_type: 'recurring_charge',
      related_entity_id: r.id,
      deep_link_path: '/subscriptions/' + r.id,
      money_at_stake_cents: r.monthly_equivalent_cents,
      occurred_at: r.updated_at,
    });
  }
  return out;
}

async function detectRecurringChargeStopped(userId, client) {
  const { rows } = await client.query(
    `SELECT id, display_name, cadence, median_amount_cents,
            last_charged_date, updated_at, created_at, occurrence_count
       FROM recurring_charges
      WHERE user_id = $1
        AND is_user_dismissed = FALSE
        AND status = 'ended'
        AND occurrence_count >= 4
        AND updated_at - created_at >= INTERVAL '14 days'
        AND updated_at >= (NOW() - INTERVAL '14 days')`,
    [userId]
  );
  for (const r of rows) r.monthly_equivalent_cents = monthlyEquivalentCents(r);
  return buildRecurringChargeStopped(rows);
}

// rows: recurring_charges newly detected in last 14 days
function buildNewRecurringCharge(rows) {
  const out = [];
  for (const r of rows) {
    out.push({
      finding_type: 'new_recurring_charge',
      tier: 'tip',
      title: 'New recurring charge: ' + r.display_name + '.',
      body: 'We just spotted this as ' + r.cadence + ' (~' + fmtUSD(r.monthly_equivalent_cents) + '/mo).',
      related_entity_type: 'recurring_charge',
      related_entity_id: r.id,
      deep_link_path: '/subscriptions/' + r.id,
      money_at_stake_cents: r.monthly_equivalent_cents,
      occurred_at: r.created_at,
    });
  }
  return out;
}

async function detectNewRecurringCharge(userId, client) {
  const { rows } = await client.query(
    `SELECT id, display_name, cadence, median_amount_cents,
            occurrence_count, created_at
       FROM recurring_charges
      WHERE user_id = $1
        AND is_user_dismissed = FALSE
        AND status = 'active'
        AND occurrence_count <= 4
        AND created_at >= (NOW() - INTERVAL '14 days')`,
    [userId]
  );
  for (const r of rows) r.monthly_equivalent_cents = monthlyEquivalentCents(r);
  return buildNewRecurringCharge(rows);
}

module.exports = {
  buildSubscriptionPriceIncreased, detectSubscriptionPriceIncreased,
  buildDuplicateSubscription,      detectDuplicateSubscription,
  buildRecurringChargeStopped,     detectRecurringChargeStopped,
  buildNewRecurringCharge,         detectNewRecurringCharge,
};

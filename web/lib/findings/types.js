// Single source of truth for finding type → tier mapping.
// Keep in sync with the CHECK constraint on findings.tier.

const TIERS = ['critical', 'important', 'tip', 'positive'];
const TIER_RANK = { critical: 0, important: 1, tip: 2, positive: 3 };

const FINDING_TYPES = {
  budget_exceeded:               'critical',
  account_below_threshold:       'critical',
  subscription_price_increased:  'critical',
  budget_approaching:            'important',
  duplicate_subscription:        'important',
  unusually_large_transaction:   'important',
  spending_category_up:          'important',
  savings_rate_dropped:          'important',
  recurring_charge_stopped:      'important',
  new_recurring_charge:          'tip',
  spending_category_down:        'tip',
  savings_rate_hit_target:       'positive',
  net_worth_milestone:           'positive',
};

function tierFor(findingType) {
  return FINDING_TYPES[findingType] || 'tip';
}

module.exports = { TIERS, TIER_RANK, FINDING_TYPES, tierFor };

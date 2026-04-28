// Hardcoded mapping from Plaid's `category` array (legacy hierarchical
// taxonomy) to the 5 default MoneyMind categories.
//
// Rules are evaluated in order — most specific first. A `plaidPath` is
// matched as a *prefix* of the Plaid array, with '*' acting as a single
// wildcard segment. The first rule that matches wins. The final '*'
// rule is the catch-all.
//
// Examples:
//   ['Food and Drink', 'Groceries']                        → Groceries
//   ['Food and Drink', 'Restaurants', 'Fast Food']         → Eating Out
//   ['Travel', 'Gas Stations']                             → Gas
//   ['Shops', 'Clothing and Accessories']                  → Shopping
//   ['Service', 'Subscription']                            → Other
//
// Plaid's API exposes both the legacy `category` array and the newer
// `personal_finance_category`. The transactions sync today reads the
// legacy `category` field, which is what these rules match.

const DEFAULT_CATEGORY_NAMES = ['Eating Out', 'Gas', 'Groceries', 'Other', 'Shopping'];

const MAPPING_RULES = [
  // ── Groceries (must come before "Food and Drink → *" ) ────────────────
  { plaidPath: ['Food and Drink', 'Groceries'],            target: 'Groceries' },
  { plaidPath: ['Food and Drink', 'Supermarkets'],         target: 'Groceries' },
  { plaidPath: ['Shops', 'Supermarkets and Groceries'],    target: 'Groceries' },
  { plaidPath: ['Shops', 'Food and Beverage Store'],       target: 'Groceries' },

  // ── Gas (must come before "Travel → *" or "Shops → *") ────────────────
  { plaidPath: ['Travel', 'Gas Stations'],                 target: 'Gas' },
  { plaidPath: ['Shops', 'Gas Stations'],                  target: 'Gas' },
  { plaidPath: ['Service', 'Gas Stations'],                target: 'Gas' },

  // ── Eating Out: anything else under Food and Drink ────────────────────
  { plaidPath: ['Food and Drink', '*'],                    target: 'Eating Out' },
  { plaidPath: ['Food and Drink'],                         target: 'Eating Out' },

  // ── Shopping: anything else under Shops ───────────────────────────────
  { plaidPath: ['Shops', '*'],                             target: 'Shopping' },
  { plaidPath: ['Shops'],                                  target: 'Shopping' },

  // ── Catch-all ─────────────────────────────────────────────────────────
  { plaidPath: ['*'],                                      target: 'Other' },
];

function matches(arr, pattern) {
  if (!Array.isArray(arr)) return false;
  if (arr.length < pattern.length) return false;
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === '*') continue;
    if ((arr[i] || '').toLowerCase() !== pattern[i].toLowerCase()) return false;
  }
  return true;
}

// Returns one of the 5 DEFAULT_CATEGORY_NAMES.
function categoryFor(plaidCategoryArr) {
  if (!Array.isArray(plaidCategoryArr) || plaidCategoryArr.length === 0) return 'Other';
  for (const rule of MAPPING_RULES) {
    if (matches(plaidCategoryArr, rule.plaidPath)) return rule.target;
  }
  return 'Other';
}

// Helpers used by sync to populate the new transaction columns.
function plaidPrimary(plaidCategoryArr) {
  return Array.isArray(plaidCategoryArr) && plaidCategoryArr.length > 0
    ? String(plaidCategoryArr[0])
    : null;
}
function plaidDetailed(plaidCategoryArr) {
  return Array.isArray(plaidCategoryArr) && plaidCategoryArr.length > 0
    ? plaidCategoryArr.map(String).join(' → ')
    : null;
}

module.exports = {
  DEFAULT_CATEGORY_NAMES,
  MAPPING_RULES,
  categoryFor,
  plaidPrimary,
  plaidDetailed,
};

// Decides whether an account counts as an asset, a liability, or is
// excluded from net-worth calculations entirely.
//
// Order of precedence (most to least specific):
//   1. excluded_from_net_worth = true      → 'excluded'
//   2. is_asset_override is non-null       → 'asset' if true, else 'liability'
//   3. Plaid type defaults                 → as below
//
// The defaults assume "balance you own = asset" for ambiguous types like
// `other` and `brokerage`. Anything we don't recognize is excluded with
// a warning rather than silently bucketed.

const ASSET_TYPES     = new Set(['depository', 'investment', 'brokerage', 'other']);
const LIABILITY_TYPES = new Set(['credit', 'loan']);

function classifyAccount(account) {
  if (!account || typeof account !== 'object') return 'excluded';

  if (account.excluded_from_net_worth === true) return 'excluded';

  if (account.is_asset_override === true)  return 'asset';
  if (account.is_asset_override === false) return 'liability';

  const t = String(account.type || '').toLowerCase();
  if (ASSET_TYPES.has(t))     return 'asset';
  if (LIABILITY_TYPES.has(t)) return 'liability';

  // Unknown Plaid type — we don't want to silently drop it into either
  // bucket, since that would skew the net-worth calculation.
  return 'excluded';
}

module.exports = { classifyAccount, ASSET_TYPES, LIABILITY_TYPES };

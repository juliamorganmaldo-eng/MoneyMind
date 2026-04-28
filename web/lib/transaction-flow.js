// Decides whether a transaction is income, spending, an internal
// transfer, or should be ignored for cashflow-style calculations.
//
// ─── PLAID SIGN CONVENTION (counterintuitive — read carefully) ──────
// Plaid's `amount` field is POSITIVE for outflows (money leaving the
// account, i.e. a debit) and NEGATIVE for inflows (money arriving,
// i.e. a credit). It's backwards from how most humans read a bank
// statement. We mirror that convention internally so the math lines up
// with Plaid's reports; the UI flips the sign at display time.
//
// Order of precedence (most specific first):
//   1. plaid_category_primary in {Transfer, Payment}     → 'transfer'
//   2. plaid_category_primary === 'Refund'                → 'ignore'
//   3. plaid_category_primary === 'Payroll' OR contains 'Income'
//        → 'income' regardless of amount sign
//   4. amount > 0                                          → 'spending'
//   5. amount < 0                                          → 'income'
//   6. amount === 0 (or NaN/undefined)                     → 'ignore'

const TRANSFER_PRIMARIES = new Set(['Transfer', 'Payment']);

function classifyFlow(txn) {
  if (!txn || typeof txn !== 'object') return 'ignore';

  const primary = String(txn.plaid_category_primary || '');
  if (TRANSFER_PRIMARIES.has(primary)) return 'transfer';
  if (primary === 'Refund')            return 'ignore';
  if (primary === 'Payroll' || /income/i.test(primary)) return 'income';

  const amt = Number(txn.amount);
  if (!isFinite(amt) || amt === 0) return 'ignore';
  return amt > 0 ? 'spending' : 'income';
}

module.exports = { classifyFlow, TRANSFER_PRIMARIES };

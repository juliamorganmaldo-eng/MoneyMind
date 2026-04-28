// Savings-rate computation for a single month, with a graceful-degradation
// guard for months where income is too low for the percentage to be
// meaningful.
//
// ── Why the income guard ────────────────────────────────────────────────
// Savings rate = (income − spending) / income × 100. When income is very
// small but spending is normal, the math produces an absurd number
// (e.g. $500 income, $1,700 spending → −239%) that misleads users far
// more than it informs them.
//
// Common causes of unusually-low monthly income:
//   • The reporting period cuts mid-paycheck (start or end of month
//     before the deposit lands).
//   • A newly-connected account whose history is partial.
//   • Sandbox or production data quirks — e.g. Plaid sandbox tagging
//     payroll deposits as `Transfer → Debit` rather than `Payroll`,
//     which makes the income side disappear from classifyFlow's
//     bucketing entirely.
//
// Rather than display a number that's mathematically correct but
// behaviorally wrong, we surface a status flag so the UI can show
// "Insufficient income data" and skip the data point in the trend chart.
// Legitimate negative rates (income $5k, spending $6k → −20%) still pass
// through with status='ok' — overspending is a real signal worth showing.
const MIN_INCOME_FOR_SAVINGS_RATE_CENTS = 100000; // $1,000

// Returns: { savings_cents, savings_rate_pct, status }
//   status: 'ok'                  — percentage is reliable
//           'no_income'           — income_cents <= 0
//           'insufficient_income' — 0 < income_cents < threshold
function computeSavingsRate(income_cents, spending_cents) {
  const savings = income_cents - spending_cents;

  if (income_cents <= 0) {
    return { savings_cents: savings, savings_rate_pct: null, status: 'no_income' };
  }
  if (income_cents < MIN_INCOME_FOR_SAVINGS_RATE_CENTS) {
    return { savings_cents: savings, savings_rate_pct: null, status: 'insufficient_income' };
  }

  // One decimal place. Negative rates allowed when overspending — that's
  // a real signal, not a degeneracy.
  const pct = Math.round((savings / income_cents) * 1000) / 10;
  return { savings_cents: savings, savings_rate_pct: pct, status: 'ok' };
}

module.exports = { computeSavingsRate, MIN_INCOME_FOR_SAVINGS_RATE_CENTS };

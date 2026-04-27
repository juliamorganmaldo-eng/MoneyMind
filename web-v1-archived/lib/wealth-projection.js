const DEFAULT_ANNUAL_RETURN = 0.07;
const HORIZONS_YEARS = [5, 10, 20];

function project({ amount, savings_type, annual_return = DEFAULT_ANNUAL_RETURN, horizons = HORIZONS_YEARS }) {
  const i = annual_return / 12;
  return horizons.map(years => {
    const n = years * 12;
    let future_value;
    if (savings_type === 'recurring_monthly') {
      future_value = amount * (((Math.pow(1 + i, n) - 1) / i));
    } else {
      future_value = amount * Math.pow(1 + i, n);
    }
    const contributed = savings_type === 'recurring_monthly' ? amount * n : amount;
    return {
      years,
      future_value: Math.round(future_value * 100) / 100,
      contributed:  Math.round(contributed * 100) / 100,
      growth:       Math.round((future_value - contributed) * 100) / 100,
    };
  });
}

function parseOutcome(text) {
  if (!text) return null;
  const nums = (text.match(/\$?\s*([0-9][0-9,]*(?:\.[0-9]+)?)/g) || [])
    .map(s => parseFloat(s.replace(/[$,\s]/g, '')))
    .filter(n => !isNaN(n));
  if (nums.length >= 2) {
    const [from, to] = nums;
    return { from, to, delta: +(from - to).toFixed(2) };
  }
  if (nums.length === 1) return { refund: nums[0] };
  return null;
}

module.exports = { project, parseOutcome, DEFAULT_ANNUAL_RETURN, HORIZONS_YEARS };

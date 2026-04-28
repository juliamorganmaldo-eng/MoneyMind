// Small shared helpers used across detectors.

function firstOfCurrentMonth() {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function fmtUSD(cents) {
  if (cents == null) return '';
  return (Number(cents) / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

// Always render dates as YYYY-MM-DD in finding bodies. Default JS
// Date.toString() produces "Mon Mar 30 2026 00:00:00 GMT-0700" which
// leaks timezone, day-of-week, and time-of-day — none of which we want.
// Accepts a Date, an ISO string, or a YYYY-MM-DD string.
function formatDate(d) {
  if (d == null) return '';
  if (typeof d === 'string') {
    // If it's already YYYY-MM-DD or ISO, slice the date portion.
    return d.slice(0, 10);
  }
  if (d instanceof Date) {
    return d.toISOString().slice(0, 10);
  }
  // Try to coerce; fall back to empty string on garbage.
  const dt = new Date(d);
  return isFinite(dt.getTime()) ? dt.toISOString().slice(0, 10) : '';
}

module.exports = { firstOfCurrentMonth, fmtUSD, formatDate };

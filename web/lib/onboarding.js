// Tiny helper for "is this user onboarded yet?" — used by every page
// that needs to render a "Connect a bank to see X" empty state instead
// of a spinner that flips to nothing.
//
// Returns the integer count of accounts (rows in the `accounts` table)
// scoped to one user. A missing row counts as 0; a returning user with
// 0 accounts (e.g. they removed all their banks) gets the same empty
// state as a brand-new user — both have nothing to show.

const { pool } = require('../db');

async function countAccountsForUser(userId) {
  const { rows } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM accounts WHERE user_id = $1',
    [userId]
  );
  return rows[0].n;
}

module.exports = { countAccountsForUser };

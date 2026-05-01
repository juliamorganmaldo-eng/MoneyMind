// Integration tests for rate-limit helpers — uses the live DB.
// Each test scopes its INSERTs to a unique synthetic IP so concurrent
// runs don't collide and so cleanup is a single DELETE WHERE ip = …
//
// Run from web/:
//   node --test tests/auth/rate-limit.test.js
//
// Requires: DATABASE_URL set (via .env). Reads & writes
// failed_login_attempts only — never touches users or sessions.

require('dotenv').config();

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../../db');
const {
  recordFailedAttempt,
  clearFailedAttemptsForIp,
  countAccountWideFailures,
  IP_WINDOW_MS,
  IP_MAX_FAILURES,
} = require('../../middleware/rate-limit');

// Use unique IPs in the 203.0.113.0/24 range — RFC 5737 documentation
// space, guaranteed never to be a real client IP.
const TEST_IP_PREFIX = '203.0.113.';
let nextIpOctet = 10;
function freshIp() {
  return TEST_IP_PREFIX + (nextIpOctet++);
}
const TEST_EMAIL_PREFIX = 'rl-test-' + Date.now() + '+';
function freshEmail(tag) {
  return TEST_EMAIL_PREFIX + tag + '@example.com';
}

after(async () => {
  // Belt-and-braces cleanup. Each test should leave its rows tidy on its
  // own (since clearFailedAttemptsForIp gets called or the test deletes),
  // but in case of a failed assertion mid-test, scrub the whole prefix.
  await pool.query(
    `DELETE FROM failed_login_attempts
      WHERE host(ip_address) LIKE $1
         OR email_attempted LIKE $2`,
    [TEST_IP_PREFIX + '%', TEST_EMAIL_PREFIX + '%']
  );
  await pool.end();
});

test('recordFailedAttempt inserts a row', async () => {
  const ip = freshIp();
  const email = freshEmail('insert');
  await recordFailedAttempt(ip, email);
  const { rows } = await pool.query(
    'SELECT email_attempted FROM failed_login_attempts WHERE ip_address = $1',
    [ip]
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].email_attempted, email);
});

test('countAccountWideFailures counts attempts within the window', async () => {
  const email = freshEmail('count');
  for (let i = 0; i < 7; i++) {
    await recordFailedAttempt(freshIp(), email);
  }
  const n = await countAccountWideFailures(email, 60 * 60 * 1000);
  assert.equal(n, 7);
});

test('countAccountWideFailures excludes attempts older than the window', async () => {
  const email = freshEmail('window');
  // Insert one row backdated 2 hours ago
  await pool.query(
    `INSERT INTO failed_login_attempts (ip_address, email_attempted, attempted_at)
     VALUES ($1, $2, NOW() - INTERVAL '2 hours')`,
    [freshIp(), email]
  );
  // And one inside the window
  await recordFailedAttempt(freshIp(), email);

  const within1h = await countAccountWideFailures(email, 60 * 60 * 1000);
  const within3h = await countAccountWideFailures(email, 3 * 60 * 60 * 1000);
  assert.equal(within1h, 1, 'old row excluded');
  assert.equal(within3h, 2, 'wider window includes both');
});

test('clearFailedAttemptsForIp deletes ONLY this IP\'s recent rows', async () => {
  const ipA = freshIp();
  const ipB = freshIp();
  await recordFailedAttempt(ipA, freshEmail('clrA1'));
  await recordFailedAttempt(ipA, freshEmail('clrA2'));
  await recordFailedAttempt(ipB, freshEmail('clrB1'));

  await clearFailedAttemptsForIp(ipA);

  const { rows: a } = await pool.query(
    'SELECT 1 FROM failed_login_attempts WHERE ip_address = $1',
    [ipA]
  );
  const { rows: b } = await pool.query(
    'SELECT 1 FROM failed_login_attempts WHERE ip_address = $1',
    [ipB]
  );
  assert.equal(a.length, 0, 'ipA cleared');
  assert.equal(b.length, 1, 'ipB untouched — clear is per-IP');
});

test('clearFailedAttemptsForIp does NOT delete attempts older than 15 minutes', async () => {
  // The DELETE uses `attempted_at > NOW() - INTERVAL '15 minutes'` so a
  // very old failure stays on the books. (In practice it doesn't matter
  // because the per-IP throttle also uses the same 15-min window — but
  // verify that the DELETE is correctly scoped, not unconditional.)
  const ip = freshIp();
  await pool.query(
    `INSERT INTO failed_login_attempts (ip_address, email_attempted, attempted_at)
     VALUES ($1, $2, NOW() - INTERVAL '20 minutes')`,
    [ip, freshEmail('old')]
  );
  await recordFailedAttempt(ip, freshEmail('new'));

  await clearFailedAttemptsForIp(ip);

  const { rows } = await pool.query(
    'SELECT email_attempted FROM failed_login_attempts WHERE ip_address = $1',
    [ip]
  );
  assert.equal(rows.length, 1, 'old row preserved');
  assert.equal(rows[0].email_attempted.includes('+old@'), true);
});

test('IP_MAX_FAILURES + IP_WINDOW_MS constants match the spec (5 in 15 min)', () => {
  // Guards against accidental config drift — these are the contract.
  assert.equal(IP_MAX_FAILURES, 5);
  assert.equal(IP_WINDOW_MS, 15 * 60 * 1000);
});

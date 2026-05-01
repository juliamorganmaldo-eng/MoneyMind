// Integration tests for maybeSendSecurityAlert — uses the live DB but
// stubs sendEmail so no real Resend call goes out.
//
// Run from web/:
//   node --test tests/auth/security-alert.test.js

require('dotenv').config();

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const { pool } = require('../../db');
const { maybeSendSecurityAlert } = require('../../lib/auth/security-alert');
const { ACCOUNT_MAX_FAILURES } = require('../../middleware/rate-limit');

const SUFFIX = '-' + Date.now() + '-sa';
const FAKE_INVITE = 'SATEST' + Date.now().toString(36).toUpperCase();

async function makeUser(tag) {
  const email = `sa-test${SUFFIX}-${tag}@example.com`;
  const hash = await bcrypt.hash('throwaway-password', 4);
  await pool.query(
    `INSERT INTO invite_codes (code) VALUES ($1)
     ON CONFLICT (code) DO NOTHING`,
    [FAKE_INVITE]
  );
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, invite_code_used)
     VALUES ($1, $2, $3) RETURNING id`,
    [email, hash, FAKE_INVITE]
  );
  return { id: rows[0].id, email };
}

async function seedFailures(email, count) {
  for (let i = 0; i < count; i++) {
    await pool.query(
      `INSERT INTO failed_login_attempts (ip_address, email_attempted)
       VALUES ($1, $2)`,
      ['203.0.113.' + (50 + (i % 200)), email]
    );
  }
}

// Stub sender — never calls Resend. Records every send for assertions.
function stubSender() {
  const sent = [];
  return {
    sent,
    fn: async (msg) => { sent.push(msg); return { ok: true, id: 'stub' }; },
  };
}

after(async () => {
  await pool.query(
    `DELETE FROM failed_login_attempts WHERE email_attempted LIKE $1`,
    [`sa-test${SUFFIX}-%`]
  );
  await pool.query(
    `DELETE FROM users WHERE email LIKE $1`,
    [`sa-test${SUFFIX}-%`]
  );
  await pool.query(`DELETE FROM invite_codes WHERE code = $1`, [FAKE_INVITE]);
  await pool.end();
});

test('no alert when failures < threshold', async () => {
  const u = await makeUser('below');
  await seedFailures(u.email, ACCOUNT_MAX_FAILURES - 1);
  const stub = stubSender();
  const r = await maybeSendSecurityAlert(u.email, { sendEmail: stub.fn });
  assert.equal(r.sent, false);
  assert.equal(r.reason, 'below_threshold');
  assert.equal(stub.sent.length, 0);
});

test('no alert when email does not map to a user (anti-enumeration)', async () => {
  // 50 failures against a never-registered email — we still must not send.
  const ghost = `sa-test${SUFFIX}-ghost@example.com`;
  await seedFailures(ghost, 50);
  const stub = stubSender();
  const r = await maybeSendSecurityAlert(ghost, { sendEmail: stub.fn });
  assert.equal(r.sent, false);
  assert.equal(r.reason, 'no_user');
  assert.equal(stub.sent.length, 0);
});

test('sends alert when failures cross threshold', async () => {
  const u = await makeUser('cross');
  await seedFailures(u.email, ACCOUNT_MAX_FAILURES);
  const stub = stubSender();
  const r = await maybeSendSecurityAlert(u.email, { sendEmail: stub.fn });
  assert.equal(r.sent, true);
  assert.equal(r.failedCount, ACCOUNT_MAX_FAILURES);
  assert.equal(stub.sent.length, 1);
  assert.equal(stub.sent[0].to, u.email);
  assert.match(stub.sent[0].subject, /Unusual sign-in/i);

  // The send must have inserted exactly one security_alerts_sent row.
  const { rows: sa } = await pool.query(
    `SELECT alert_type FROM security_alerts_sent WHERE user_id = $1`,
    [u.id]
  );
  assert.equal(sa.length, 1);
  assert.equal(sa[0].alert_type, 'failed_login_burst');
});

test('1-per-hour cap suppresses a second alert within the window', async () => {
  const u = await makeUser('cap');
  await seedFailures(u.email, ACCOUNT_MAX_FAILURES + 5);

  const stub1 = stubSender();
  const r1 = await maybeSendSecurityAlert(u.email, { sendEmail: stub1.fn });
  assert.equal(r1.sent, true);

  const stub2 = stubSender();
  const r2 = await maybeSendSecurityAlert(u.email, { sendEmail: stub2.fn });
  assert.equal(r2.sent, false);
  assert.equal(r2.reason, 'already_sent_recently');
  assert.equal(stub2.sent.length, 0);

  // Only one row in security_alerts_sent for this user.
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM security_alerts_sent WHERE user_id = $1`,
    [u.id]
  );
  assert.equal(rows[0].n, 1);
});

test('cap is per-user — alert for user A does not suppress alert for user B', async () => {
  const a = await makeUser('mtA');
  const b = await makeUser('mtB');
  await seedFailures(a.email, ACCOUNT_MAX_FAILURES);
  await seedFailures(b.email, ACCOUNT_MAX_FAILURES);

  const stub = stubSender();
  const rA = await maybeSendSecurityAlert(a.email, { sendEmail: stub.fn });
  const rB = await maybeSendSecurityAlert(b.email, { sendEmail: stub.fn });
  assert.equal(rA.sent, true);
  assert.equal(rB.sent, true);
  assert.equal(stub.sent.length, 2);
  assert.equal(stub.sent[0].to, a.email);
  assert.equal(stub.sent[1].to, b.email);
});

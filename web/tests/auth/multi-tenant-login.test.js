// Multi-tenant integration tests for Phase 4B login security.
//
// Boots the real Express app on a throwaway port, drives it with HTTP
// requests, asserts behavior across two distinct users + IPs.
// Uses a stub sendEmail (via DI in security-alert.js) — but since the
// app loads sendEmail directly, we instead assert via DB rows
// (security_alerts_sent) rather than email side-effects.
//
// Run from web/:
//   node --test --test-timeout=30000 tests/auth/multi-tenant-login.test.js

require('dotenv').config();

const { test, after, before } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const bcrypt = require('bcrypt');
const { pool } = require('../../db');

const SUFFIX = '-' + Date.now() + '-mt';
const FAKE_INVITE = 'MTTEST' + Date.now().toString(36).toUpperCase();
const PASSWORD = 'real-password-known-only-to-tests';

let server;
let baseUrl;
let userA, userB;

async function makeUser(tag) {
  // The login route normalizes to lowercase before SELECT — store lowercase too.
  const email = `mt-test${SUFFIX}-${tag}@example.com`.toLowerCase();
  const hash = await bcrypt.hash(PASSWORD, 4);
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, invite_code_used)
     VALUES ($1, $2, $3) RETURNING id`,
    [email, hash, FAKE_INVITE]
  );
  return { id: rows[0].id, email };
}

// Replace process.env.RESEND_API_KEY with the placeholder so emails
// no-op (security alerts still record into security_alerts_sent — that
// happens before the send call).
process.env.RESEND_API_KEY = 'PLACEHOLDER';

before(async () => {
  await pool.query(
    `INSERT INTO invite_codes (code) VALUES ($1) ON CONFLICT DO NOTHING`,
    [FAKE_INVITE]
  );
  userA = await makeUser('A');
  userB = await makeUser('B');

  // Boot the app. Loading app.js starts main() which calls listen() —
  // we want our own listener on a random port, so build a fresh app.
  // Easiest: require the routes ourselves. But to test the full
  // pipeline (rate-limit + idle-timeout + cookie config), spin up the
  // actual app as a child-style listener.
  const path = require('node:path');
  const express = require('express');
  const session = require('express-session');
  const PgSession = require('connect-pg-simple')(session);
  const { enforceIdleTimeout } = require('../../middleware/idle-timeout');
  const authRoutes = require('../../routes/auth');

  const app = express();
  app.set('views', path.join(__dirname, '..', '..', 'views'));
  app.set('view engine', 'ejs');
  app.set('trust proxy', true); // honor X-Forwarded-For from our test client
  app.use(express.urlencoded({ extended: false, limit: '32kb' }));
  app.use(
    session({
      name: 'moneymind.sid',
      store: new PgSession({ pool, tableName: 'session', createTableIfMissing: false }),
      secret: process.env.SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: { path: '/', httpOnly: true, sameSite: 'lax', secure: false, maxAge: 12 * 3600 * 1000 },
    })
  );
  app.use(enforceIdleTimeout);
  app.use(authRoutes);
  app.get('/dashboard', (req, res) => {
    if (!req.session?.userId) return res.redirect('/login');
    res.send('dashboard for user ' + req.session.userId);
  });

  await new Promise((resolve) => {
    server = app.listen(0, () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  // Wipe rows we created. Order matters for FKs: alerts → failures → users → invite.
  await pool.query(
    `DELETE FROM security_alerts_sent WHERE user_id IN ($1, $2)`,
    [userA?.id, userB?.id]
  );
  await pool.query(
    `DELETE FROM failed_login_attempts WHERE email_attempted LIKE $1`,
    [`mt-test${SUFFIX}-%`]
  );
  await pool.query(
    `DELETE FROM users WHERE email LIKE $1`,
    [`mt-test${SUFFIX}-%`]
  );
  await pool.query(`DELETE FROM invite_codes WHERE code = $1`, [FAKE_INVITE]);
  await pool.end();
});

// Tiny HTTP helper — same shape as fetch but easier to extract headers
// and not pull in node-fetch. Sets X-Forwarded-For to the requested IP
// so the per-IP throttle keys off our synthetic test IPs.
function postLogin({ email, password, ip = '203.0.113.200', remember = false }) {
  const body = `email=${encodeURIComponent(email)}&password=${encodeURIComponent(password)}` +
               (remember ? '&remember_me=on' : '');
  return new Promise((resolve, reject) => {
    const req = http.request(
      baseUrl + '/login',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'content-length': Buffer.byteLength(body),
          'x-forwarded-for': ip,
          'accept': 'text/html',
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({
          status: res.statusCode,
          headers: res.headers,
          body: data,
        }));
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

test('multi-tenant: failed_login_attempts is global (per-IP), not per-user', async () => {
  const ip = '203.0.113.10';
  // 3 failures against userA, 2 against userB, all from the same IP
  for (let i = 0; i < 3; i++) await postLogin({ email: userA.email, password: 'wrong', ip });
  for (let i = 0; i < 2; i++) await postLogin({ email: userB.email, password: 'wrong', ip });

  // The per-IP throttle should now fire on the next attempt regardless of email
  const r = await postLogin({ email: 'whoever@example.com', password: 'x', ip });
  assert.equal(r.status, 429, 'IP-level throttle is global to the IP, not per-email');
  assert.ok(r.headers['retry-after'], 'Retry-After header present on 429');
});

test('multi-tenant: rate-limit on userA\'s IP does NOT block userB from a different IP', async () => {
  const ipA = '203.0.113.20';
  const ipB = '203.0.113.21';
  for (let i = 0; i < 5; i++) await postLogin({ email: userA.email, password: 'wrong', ip: ipA });

  // ipA is now locked
  const lockedA = await postLogin({ email: userA.email, password: 'wrong', ip: ipA });
  assert.equal(lockedA.status, 429);

  // ipB is fresh
  const freshB = await postLogin({ email: userB.email, password: 'wrong', ip: ipB });
  assert.equal(freshB.status, 401, 'ipB independent of ipA');
});

test('multi-tenant: successful login clears ONLY that IP\'s failures', async () => {
  const ipA = '203.0.113.30';
  const ipB = '203.0.113.31';
  await postLogin({ email: userA.email, password: 'wrong', ip: ipA });
  await postLogin({ email: userA.email, password: 'wrong', ip: ipA });
  await postLogin({ email: userB.email, password: 'wrong', ip: ipB });

  // userA logs in successfully from ipA
  const ok = await postLogin({ email: userA.email, password: PASSWORD, ip: ipA });
  assert.equal(ok.status, 302, 'redirect on success');
  assert.match(ok.headers.location, /dashboard/);

  // ipA's failures are gone; ipB's failure is still there.
  const { rows: a } = await pool.query(
    `SELECT 1 FROM failed_login_attempts WHERE ip_address = $1`, [ipA]
  );
  const { rows: b } = await pool.query(
    `SELECT 1 FROM failed_login_attempts WHERE ip_address = $1`, [ipB]
  );
  assert.equal(a.length, 0, 'ipA cleared');
  assert.equal(b.length, 1, 'ipB untouched');
});

test('multi-tenant: security_alerts_sent FK cascades on user delete', async () => {
  const tempUser = await (async () => {
    const email = `mt-test${SUFFIX}-cascade@example.com`;
    const hash = await bcrypt.hash(PASSWORD, 4);
    const { rows } = await pool.query(
      `INSERT INTO users (email, password_hash, invite_code_used)
       VALUES ($1, $2, $3) RETURNING id`,
      [email, hash, FAKE_INVITE]
    );
    return { id: rows[0].id, email };
  })();
  await pool.query(
    `INSERT INTO security_alerts_sent (user_id, alert_type) VALUES ($1, 'failed_login_burst')`,
    [tempUser.id]
  );
  await pool.query(`DELETE FROM users WHERE id = $1`, [tempUser.id]);
  const { rows } = await pool.query(
    `SELECT 1 FROM security_alerts_sent WHERE user_id = $1`, [tempUser.id]
  );
  assert.equal(rows.length, 0, 'FK cascade should remove orphaned alerts');
});

test('multi-tenant: remember_me_default is per-user', async () => {
  // userA logs in WITH remember_me, userB WITHOUT it
  const ipA = '203.0.113.40';
  const ipB = '203.0.113.41';
  await postLogin({ email: userA.email, password: PASSWORD, ip: ipA, remember: true });
  await postLogin({ email: userB.email, password: PASSWORD, ip: ipB, remember: false });

  const { rows } = await pool.query(
    `SELECT email, remember_me_default FROM users
      WHERE id IN ($1, $2) ORDER BY id`,
    [userA.id, userB.id]
  );
  const a = rows.find((r) => r.email === userA.email);
  const b = rows.find((r) => r.email === userB.email);
  assert.equal(a.remember_me_default, true,  'userA opted in');
  assert.equal(b.remember_me_default, false, 'userB did not');
});

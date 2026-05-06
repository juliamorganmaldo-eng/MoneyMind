// Privacy-policy agreement enforcement on POST /register.
//
// The HTML form has a `privacy_agreed` checkbox that disables the
// submit button until checked, but client-side disabling is just UX —
// the POST handler in routes/auth.js MUST also reject submissions
// where `privacy_agreed` is missing/falsy. This file proves both
// branches (missing → 400 with friendly error, present → 302 + DB
// timestamp set).
//
// Run from web/:
//   node --test --test-timeout=30000 tests/auth/register-agreement.test.js

require('dotenv').config();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const { pool } = require('../../db');

const SUFFIX = '-' + Date.now() + '-pa';
const PASSWORD = 'agreement-test-password-1234';
let server;
let baseUrl;
const createdEmails = [];
const createdInvites = [];

before(async () => {
  const authRoutes              = require('../../routes/auth');
  const { enforceIdleTimeout }  = require('../../middleware/idle-timeout');
  const { render404, render500 } = require('../../lib/render-error');

  const app = express();
  app.set('views', path.join(__dirname, '..', '..', 'views'));
  app.set('view engine', 'ejs');
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
  app.use((req, res) => render404(req, res));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => render500(req, res, err));

  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = 'http://127.0.0.1:' + server.address().port;
      resolve();
    });
  });
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (createdEmails.length) {
    await pool.query(`DELETE FROM users WHERE email = ANY($1::text[])`, [createdEmails]);
  }
  if (createdInvites.length) {
    await pool.query(`DELETE FROM invite_codes WHERE code = ANY($1::text[])`, [createdInvites]);
  }
  await pool.end();
});

function postForm(p, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(baseUrl + p, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': Buffer.byteLength(body),
        'accept': 'text/html',
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function freshInvite(tag) {
  const code = ('PA' + SUFFIX + '-' + tag).toUpperCase();
  await pool.query(`INSERT INTO invite_codes (code) VALUES ($1) ON CONFLICT DO NOTHING`, [code]);
  createdInvites.push(code);
  return code;
}

test('POST /register WITHOUT privacy_agreed → 400 + friendly error in body', async () => {
  const code = await freshInvite('miss');
  const email = `reg-miss${SUFFIX}@example.com`;
  const body =
    `email=${encodeURIComponent(email)}` +
    `&password=${encodeURIComponent(PASSWORD)}` +
    `&inviteCode=${encodeURIComponent(code)}`;
    // intentionally NO privacy_agreed param
  const r = await postForm('/register', body);
  assert.equal(r.status, 400, `expected 400, got ${r.status}`);
  assert.match(r.body, /agree to the privacy policy/i,
    'response body should explain the agreement requirement');
  // No user was created.
  const { rows } = await pool.query('SELECT 1 FROM users WHERE email = $1', [email]);
  assert.equal(rows.length, 0, 'no user row should exist after rejected registration');
});

test('POST /register with privacy_agreed=garbage (truthy-ish) → 400 (only "on" or "1" accept)', async () => {
  // Defense check: someone curl-ing with privacy_agreed=true should NOT
  // bypass the gate. The handler explicitly checks for 'on' or '1'.
  const code = await freshInvite('garb');
  const email = `reg-garb${SUFFIX}@example.com`;
  const body =
    `email=${encodeURIComponent(email)}` +
    `&password=${encodeURIComponent(PASSWORD)}` +
    `&inviteCode=${encodeURIComponent(code)}` +
    `&privacy_agreed=true`;
  const r = await postForm('/register', body);
  assert.equal(r.status, 400);
  assert.match(r.body, /agree to the privacy policy/i);
});

test('POST /register WITH privacy_agreed=on → 302 to /dashboard AND privacy_policy_agreed_at set', async () => {
  const code = await freshInvite('ok');
  const email = `reg-ok${SUFFIX}@example.com`;
  createdEmails.push(email);
  const body =
    `email=${encodeURIComponent(email)}` +
    `&password=${encodeURIComponent(PASSWORD)}` +
    `&inviteCode=${encodeURIComponent(code)}` +
    `&privacy_agreed=on`;
  const r = await postForm('/register', body);
  assert.equal(r.status, 302, `expected 302, got ${r.status}`);
  assert.match(r.headers.location || '', /\/dashboard/);

  const { rows } = await pool.query(
    'SELECT id, privacy_policy_agreed_at FROM users WHERE email = $1',
    [email]
  );
  assert.equal(rows.length, 1, 'exactly one user row created');
  assert.ok(rows[0].privacy_policy_agreed_at,
    'privacy_policy_agreed_at must be a timestamp, not NULL');
  // Sanity: the timestamp should be within the last minute.
  const ageMs = Date.now() - new Date(rows[0].privacy_policy_agreed_at).getTime();
  assert.ok(ageMs >= 0 && ageMs < 60 * 1000,
    `expected agreed_at within the last minute, got ageMs=${ageMs}`);
});

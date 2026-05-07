// /api/auth/forgot-password must treat soft-deleted users as if the
// account never existed: same generic 200 response (anti-enumeration),
// no token issued, no email sent.
//
// The test mocks the Resend client through the email/client module so
// no real email goes out — but more importantly, asserts that no token
// row is created and no send was attempted.
//
// Run from web/:
//   node --test --test-timeout=30000 tests/auth/forgot-password-soft-deleted.test.js

require('dotenv').config();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const bcrypt = require('bcrypt');
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const { pool } = require('../../db');

// Stub the email client BEFORE the password-reset route is required.
const emailClient = require('../../lib/email/client');
const realSend = emailClient.sendEmail;
const sendCalls = [];
emailClient.sendEmail = async function stubSend(args) {
  sendCalls.push(args);
  return { ok: true, id: 'stub' };
};

const SUFFIX = '-' + Date.now() + '-fpsd';
const FAKE_INVITE = 'FPSD-' + Date.now().toString(36).toUpperCase();
const PASSWORD = 'fp-soft-deleted-pwd';

let server;
let baseUrl;
const createdEmails = [];

before(async () => {
  await pool.query(`INSERT INTO invite_codes (code) VALUES ($1) ON CONFLICT DO NOTHING`, [FAKE_INVITE]);

  const passwordResetRoutes     = require('../../routes/password-reset');
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
  app.use(passwordResetRoutes);
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
    // Wipe their tokens first (FK), then users.
    await pool.query(`DELETE FROM password_reset_tokens WHERE user_id IN (SELECT id FROM users WHERE email = ANY($1::text[]))`, [createdEmails]);
    await pool.query(`DELETE FROM users WHERE email = ANY($1::text[])`, [createdEmails]);
  }
  await pool.query(`DELETE FROM invite_codes WHERE code = $1`, [FAKE_INVITE]);
  emailClient.sendEmail = realSend;
  await pool.end();
});

function postForgot(email) {
  const body = `email=${encodeURIComponent(email)}`;
  return new Promise((resolve, reject) => {
    const req = http.request(baseUrl + '/api/auth/forgot-password', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': Buffer.byteLength(body),
        'accept': 'application/json',
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function makeUser(tag, opts = {}) {
  const email = `fpsd${SUFFIX}-${tag}@example.com`.toLowerCase();
  createdEmails.push(email);
  const hash = await bcrypt.hash(PASSWORD, 4);
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, invite_code_used, is_deleted, deleted_at, privacy_policy_agreed_at)
     VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING id`,
    [email, hash, FAKE_INVITE, !!opts.softDeleted, opts.softDeleted ? new Date() : null]
  );
  return { id: rows[0].id, email };
}

test('forgot-password against a SOFT-DELETED user → no token, no email sent (still 200 generic)', async () => {
  const u = await makeUser('deleted', { softDeleted: true });

  // Capture send-call count before
  const beforeCalls = sendCalls.length;
  const r = await postForgot(u.email);
  assert.equal(r.status, 200, 'response is generic 200 either way');

  // No password_reset_tokens row created
  const { rows } = await pool.query(
    'SELECT 1 FROM password_reset_tokens WHERE user_id = $1',
    [u.id]
  );
  assert.equal(rows.length, 0, 'no token row should exist for a soft-deleted user');

  // No send to this email
  const sendsToThisUser = sendCalls.slice(beforeCalls).filter((c) => c.to === u.email);
  assert.equal(sendsToThisUser.length, 0, 'no email should be dispatched');
});

test('forgot-password against an ACTIVE user → token issued, email sent (regression check)', async () => {
  const u = await makeUser('active', { softDeleted: false });
  const beforeCalls = sendCalls.length;
  const r = await postForgot(u.email);
  assert.equal(r.status, 200);

  const { rows } = await pool.query(
    'SELECT 1 FROM password_reset_tokens WHERE user_id = $1',
    [u.id]
  );
  assert.equal(rows.length, 1, 'token should be issued for active user');

  const sendsToThisUser = sendCalls.slice(beforeCalls).filter((c) => c.to === u.email);
  assert.equal(sendsToThisUser.length, 1, 'reset email should be dispatched');
});

test('forgot-password against a never-existed email → also 200 generic, no token, no email', async () => {
  const beforeCalls = sendCalls.length;
  const r = await postForgot(`no-such-user${SUFFIX}@example.com`);
  assert.equal(r.status, 200);
  assert.equal(sendCalls.slice(beforeCalls).length, 0);
});

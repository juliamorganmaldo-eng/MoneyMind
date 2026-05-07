// Account-deletion route end-to-end coverage.
//
// Asserts every branch of POST /account/delete:
//   • wrong password → 401, no DB mutation
//   • wrong DELETE confirmation → 400, no DB mutation
//   • correct password + correct confirmation → soft-delete persisted
//     (is_deleted, deleted_at, deletion_log row, plaid_items wiped),
//     session destroyed, redirect to /account/deleted
//   • Plaid /item/remove failure does NOT block the soft-delete
//
// Plaid is stubbed at the lib/plaid module boundary so no real Plaid
// call goes out. The encrypted-access-token decrypt path is also
// stubbed for the failure-injection test.
//
// Run from web/:
//   node --test --test-timeout=30000 tests/auth/account-delete.test.js

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

// Stub the Plaid SDK BEFORE routes/account.js is required, so the
// itemRemove function captured by the route module is the stub.
const plaidLib = require('../../lib/plaid');
const realItemRemove = plaidLib.itemRemove;
let nextItemRemoveResult = { ok: true };
plaidLib.itemRemove = async function stubItemRemove(_token, _decrypt) {
  return nextItemRemoveResult;
};

const SUFFIX = '-' + Date.now() + '-acdel';
const FAKE_INVITE = 'AC-DEL-' + Date.now().toString(36).toUpperCase();
const PASSWORD = 'account-delete-test-pwd-9876';

let server;
let baseUrl;
const createdEmails = [];

before(async () => {
  await pool.query(`INSERT INTO invite_codes (code) VALUES ($1) ON CONFLICT DO NOTHING`, [FAKE_INVITE]);

  const authRoutes              = require('../../routes/auth');
  const accountDeleteRoutes     = require('../../routes/account');
  const dashboardRoutes         = require('../../routes/dashboard');
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
  app.use(accountDeleteRoutes);
  app.use(dashboardRoutes);
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
    await pool.query(`DELETE FROM deletion_log WHERE email = ANY($1::text[])`, [createdEmails]);
  }
  await pool.query(`DELETE FROM invite_codes WHERE code = $1`, [FAKE_INVITE]);
  plaidLib.itemRemove = realItemRemove;
  await pool.end();
});

async function makeUser(tag, opts = {}) {
  const email = `acdel${SUFFIX}-${tag}@example.com`.toLowerCase();
  createdEmails.push(email);
  const hash = await bcrypt.hash(PASSWORD, 4);
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, invite_code_used, email_verified_at, privacy_policy_agreed_at)
     VALUES ($1, $2, $3, NOW(), NOW())
     RETURNING id`,
    [email, hash, FAKE_INVITE]
  );
  const userId = rows[0].id;
  // Optionally seed a plaid_items row for soft-delete coverage.
  if (opts.withPlaidItem) {
    await pool.query(
      `INSERT INTO plaid_items (user_id, institution_name, access_token_encrypted, item_id)
       VALUES ($1, 'Test Bank', 'fake-encrypted-token-' || $2::text, 'fake-item-' || $2::text)`,
      [userId, userId]
    );
  }
  return { id: userId, email };
}

async function login(email) {
  const body = `email=${encodeURIComponent(email)}&password=${encodeURIComponent(PASSWORD)}`;
  return new Promise((resolve, reject) => {
    const req = http.request(baseUrl + '/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': Buffer.byteLength(body),
      },
    }, (res) => {
      const setCookie = res.headers['set-cookie'] || [];
      const sid = setCookie.map((c) => c.split(';')[0])
                            .filter((c) => c.startsWith('moneymind.sid='))
                            .join('; ');
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, cookie: sid }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function postDelete(cookie, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(baseUrl + '/account/delete', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': Buffer.byteLength(body),
        'accept': 'application/json',
        'cookie': cookie,
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

// ────────────────────────────────────────────────────────────────────

test('wrong password → 401, account NOT marked deleted', async () => {
  const u = await makeUser('wrongpw');
  const { cookie } = await login(u.email);
  const r = await postDelete(cookie, 'confirmation=DELETE&password=not-the-real-password');
  assert.equal(r.status, 401);
  const j = JSON.parse(r.body);
  assert.equal(j.error, 'invalid_password');
  // DB unchanged.
  const { rows } = await pool.query('SELECT is_deleted, deleted_at FROM users WHERE id = $1', [u.id]);
  assert.equal(rows[0].is_deleted, false);
  assert.equal(rows[0].deleted_at, null);
});

test('wrong DELETE confirmation → 400, account NOT marked deleted', async () => {
  const u = await makeUser('wrongconf');
  const { cookie } = await login(u.email);
  const r = await postDelete(cookie, 'confirmation=delete&password=' + encodeURIComponent(PASSWORD));
  assert.equal(r.status, 400);
  const j = JSON.parse(r.body);
  assert.equal(j.error, 'invalid_confirmation');
  const { rows } = await pool.query('SELECT is_deleted FROM users WHERE id = $1', [u.id]);
  assert.equal(rows[0].is_deleted, false);
});

test('successful soft-delete: is_deleted set, deletion_log row created, plaid_items wiped, session destroyed', async () => {
  nextItemRemoveResult = { ok: true };
  const u = await makeUser('happy', { withPlaidItem: true });
  const { cookie } = await login(u.email);
  const beforeItems = await pool.query('SELECT COUNT(*)::int AS n FROM plaid_items WHERE user_id = $1', [u.id]);
  assert.equal(beforeItems.rows[0].n, 1, 'pre-condition: 1 plaid_item exists');

  const r = await postDelete(cookie, 'confirmation=DELETE&password=' + encodeURIComponent(PASSWORD));
  assert.equal(r.status, 302);
  assert.match(r.headers.location || '', /\/account\/deleted/);

  // is_deleted + deleted_at set
  const { rows } = await pool.query(
    'SELECT is_deleted, deleted_at FROM users WHERE id = $1',
    [u.id]
  );
  assert.equal(rows[0].is_deleted, true);
  assert.ok(rows[0].deleted_at, 'deleted_at must be set');

  // deletion_log row inserted
  const { rows: log } = await pool.query(
    'SELECT email, reason FROM deletion_log WHERE email = $1 ORDER BY id DESC LIMIT 1',
    [u.email]
  );
  assert.equal(log.length, 1);
  assert.equal(log[0].email, u.email);
  assert.equal(log[0].reason, 'user_initiated');

  // plaid_items wiped
  const { rows: items } = await pool.query(
    'SELECT 1 FROM plaid_items WHERE user_id = $1',
    [u.id]
  );
  assert.equal(items.length, 0, 'plaid_items must be deleted');

  // Session destroyed: a follow-up request with the SAME cookie must
  // not have a userId. We can't introspect the session directly here,
  // but a request to a protected page should redirect to /login.
  const followup = await new Promise((resolve, reject) => {
    const req2 = http.request(baseUrl + '/dashboard', {
      method: 'GET',
      headers: { cookie, accept: 'text/html' },
    }, (res2) => {
      res2.resume();
      res2.on('end', () => resolve({ status: res2.statusCode, location: res2.headers.location }));
    });
    req2.on('error', reject);
    req2.end();
  });
  assert.equal(followup.status, 302);
  assert.match(followup.location || '', /\/login/);
});

test('Plaid /item/remove failure does NOT block soft-delete', async () => {
  nextItemRemoveResult = { ok: false, error: 'ITEM_NOT_FOUND' };
  const u = await makeUser('plaidfail', { withPlaidItem: true });
  const { cookie } = await login(u.email);

  const r = await postDelete(cookie, 'confirmation=DELETE&password=' + encodeURIComponent(PASSWORD));
  assert.equal(r.status, 302, 'soft-delete must succeed even when Plaid fails');

  // is_deleted set despite Plaid stub returning failure
  const { rows } = await pool.query('SELECT is_deleted FROM users WHERE id = $1', [u.id]);
  assert.equal(rows[0].is_deleted, true);

  // Local plaid_items still wiped (we drop them regardless of Plaid result).
  const { rows: items } = await pool.query('SELECT 1 FROM plaid_items WHERE user_id = $1', [u.id]);
  assert.equal(items.length, 0);
});

test('login as soft-deleted user → generic 401, NOT a "deleted account" message', async () => {
  // Use the user from the happy-path test (already soft-deleted).
  // Try to log them back in. Same generic error as wrong password.
  const targetEmail = createdEmails.find((e) => e.includes('-happy@'));
  assert.ok(targetEmail, 'happy-path test should have created a user');

  const body = `email=${encodeURIComponent(targetEmail)}&password=${encodeURIComponent(PASSWORD)}`;
  const r = await new Promise((resolve, reject) => {
    const req = http.request(baseUrl + '/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': Buffer.byteLength(body),
        'accept': 'text/html',
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
  assert.equal(r.status, 401);
  assert.match(r.body, /Invalid email or password/);
  // Must NOT mention deletion in the response body.
  assert.doesNotMatch(r.body, /deleted|removed|no longer exists/i);
});

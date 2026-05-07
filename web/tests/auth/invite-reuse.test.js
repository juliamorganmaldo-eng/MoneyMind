// Invite-code re-use after hard-delete.
//
// Background: invite_codes.used_by_user_id has ON DELETE SET NULL on
// the user FK. When the hard-delete cron purges a soft-deleted user's
// row, the invite they used has used_by_user_id flipped to NULL. The
// pre-existing registration check ONLY looked at used_by_user_id, so
// the invite would silently become re-usable.
//
// Phase 4 fix: tightened the check to also reject if used_at IS NOT NULL.
// This file proves that invariant: an invite that was used by a now-
// hard-deleted user is rejected on attempted reuse.
//
// Run from web/:
//   node --test --test-timeout=30000 tests/auth/invite-reuse.test.js

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

const SUFFIX = '-' + Date.now() + '-invre';
const PASSWORD = 'invite-reuse-pwd';

let server;
let baseUrl;
const createdInvites = [];
const createdEmails = [];

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

function postRegister(body) {
  return new Promise((resolve, reject) => {
    const req = http.request(baseUrl + '/register', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': Buffer.byteLength(body),
        'accept': 'text/html',
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

test('invite used by a now-hard-deleted user is rejected on reuse', async () => {
  const code = ('INVRE' + SUFFIX).toUpperCase();
  createdInvites.push(code);
  await pool.query(`INSERT INTO invite_codes (code) VALUES ($1)`, [code]);

  // 1) Create user A using this invite.
  const aEmail = `invre-a${SUFFIX}@example.com`;
  createdEmails.push(aEmail);
  const aHash = await bcrypt.hash(PASSWORD, 4);
  const { rows: aRows } = await pool.query(
    `INSERT INTO users (email, password_hash, invite_code_used, privacy_policy_agreed_at)
     VALUES ($1, $2, $3, NOW()) RETURNING id`,
    [aEmail, aHash, code]
  );
  const userAId = aRows[0].id;
  await pool.query(
    `UPDATE invite_codes SET used_by_user_id = $1, used_at = NOW() WHERE code = $2`,
    [userAId, code]
  );

  // Sanity: invite is consumed.
  const before = await pool.query(
    'SELECT used_by_user_id, used_at FROM invite_codes WHERE code = $1',
    [code]
  );
  assert.equal(before.rows[0].used_by_user_id, userAId);
  assert.ok(before.rows[0].used_at);

  // 2) Hard-delete user A. The invite's used_by_user_id flips to NULL
  // via ON DELETE SET NULL, but used_at remains.
  await pool.query('DELETE FROM users WHERE id = $1', [userAId]);

  const after = await pool.query(
    'SELECT used_by_user_id, used_at FROM invite_codes WHERE code = $1',
    [code]
  );
  assert.equal(after.rows[0].used_by_user_id, null,
    'FK SET NULL post-condition: used_by_user_id is null after user delete');
  assert.ok(after.rows[0].used_at,
    'used_at should NOT be cleared by FK SET NULL — that is the canary the registration check uses');

  // 3) Try to register user B using the same invite. Must be rejected.
  const bEmail = `invre-b${SUFFIX}@example.com`;
  const body = [
    `email=${encodeURIComponent(bEmail)}`,
    `password=${encodeURIComponent(PASSWORD + 'BBB')}`,
    `inviteCode=${encodeURIComponent(code)}`,
    'privacy_agreed=on',
  ].join('&');
  const r = await postRegister(body);
  assert.equal(r.status, 400, `expected 400, got ${r.status}`);
  assert.match(r.body, /invite code is invalid or has already been used/i);

  // 4) Confirm user B was NOT created.
  const { rows } = await pool.query('SELECT 1 FROM users WHERE email = $1', [bEmail]);
  assert.equal(rows.length, 0, 'no user B should be created');
});

test('a fresh, never-used invite still works (regression guard)', async () => {
  const code = ('FRESH' + SUFFIX).toUpperCase();
  createdInvites.push(code);
  await pool.query(`INSERT INTO invite_codes (code) VALUES ($1)`, [code]);

  const email = `invre-fresh${SUFFIX}@example.com`;
  createdEmails.push(email);
  const body = [
    `email=${encodeURIComponent(email)}`,
    `password=${encodeURIComponent(PASSWORD + 'FRESH')}`,
    `inviteCode=${encodeURIComponent(code)}`,
    'privacy_agreed=on',
  ].join('&');
  const r = await postRegister(body);
  assert.equal(r.status, 302, 'fresh invite must still allow registration');
  // Confirm user was created and invite was consumed.
  const { rows } = await pool.query(
    'SELECT u.id, ic.used_at FROM users u JOIN invite_codes ic ON ic.code = u.invite_code_used WHERE u.email = $1',
    [email]
  );
  assert.equal(rows.length, 1);
  assert.ok(rows[0].used_at, 'invite should be marked used after registration');
});

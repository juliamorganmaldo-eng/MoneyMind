// Footer-presence smoke check.
//
// Asserts the privacy-policy link rendered by partials/footer.ejs
// appears on at least one public page (/login) and at least one
// authed page (/dashboard). This is a minimal regression guard: if
// someone accidentally drops the include from a layout, this will
// catch it.
//
// Run from web/:
//   node --test --test-timeout=30000 tests/footer.test.js

require('dotenv').config();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const bcrypt = require('bcrypt');
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const { pool } = require('../db');

const SUFFIX = '-' + Date.now() + '-foot';
const FAKE_INVITE = 'FOOT-TEST-' + Date.now().toString(36).toUpperCase();
const PASSWORD = 'footer-test-password';

let server;
let baseUrl;
let testUserId;
let cookie;

before(async () => {
  const authRoutes              = require('../routes/auth');
  const dashboardRoutes         = require('../routes/dashboard');
  const privacyRoutes           = require('../routes/privacy');
  const { enforceIdleTimeout }  = require('../middleware/idle-timeout');
  const { render404, render500 } = require('../lib/render-error');

  const app = express();
  app.set('views', path.join(__dirname, '..', 'views'));
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
  app.use(privacyRoutes);
  app.use(dashboardRoutes);
  app.use((req, res) => render404(req, res));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => render500(req, res, err));

  // Create one verified user so /dashboard renders successfully.
  await pool.query(`INSERT INTO invite_codes (code) VALUES ($1) ON CONFLICT DO NOTHING`, [FAKE_INVITE]);
  const hash = await bcrypt.hash(PASSWORD, 4);
  const email = `footer-test${SUFFIX}@example.com`;
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, invite_code_used, email_verified_at, privacy_policy_agreed_at)
     VALUES ($1, $2, $3, NOW(), NOW()) RETURNING id`,
    [email, hash, FAKE_INVITE]
  );
  testUserId = rows[0].id;
  // Seed categories so the dashboard query path is exercised normally.
  await pool.query(`INSERT INTO user_settings (user_id) VALUES ($1)`, [testUserId]);

  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = 'http://127.0.0.1:' + server.address().port;
      resolve();
    });
  });

  // Login the test user — capture session cookie for the authed test.
  const body = `email=${encodeURIComponent(email)}&password=${encodeURIComponent(PASSWORD)}`;
  const r = await new Promise((resolve, reject) => {
    const req = http.request(baseUrl + '/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': Buffer.byteLength(body),
      },
    }, (res) => {
      const setCookie = res.headers['set-cookie'] || [];
      cookie = setCookie.map((c) => c.split(';')[0])
                       .filter((c) => c.startsWith('moneymind.sid='))
                       .join('; ');
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
  assert.equal(r, 302, 'before-hook login should succeed');
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (testUserId) await pool.query('DELETE FROM users WHERE id = $1', [testUserId]);
  await pool.query(`DELETE FROM invite_codes WHERE code = $1`, [FAKE_INVITE]);
  await pool.end();
});

function get(p, opts = {}) {
  return new Promise((resolve, reject) => {
    const headers = { accept: 'text/html' };
    if (opts.cookie) headers.cookie = opts.cookie;
    const req = http.request(baseUrl + p, { method: 'GET', headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('footer link to /privacy appears on /login (public page)', async () => {
  const r = await get('/login');
  assert.equal(r.status, 200);
  // Look specifically for the footer link, not just any /privacy mention.
  // The footer uses `<a href="/privacy">Privacy Policy</a>` inside .app-footer.
  assert.match(r.body, /class="app-footer"[\s\S]*?href="\/privacy"/);
});

test('footer link to /privacy appears on /dashboard (authed page)', async () => {
  assert.ok(cookie, 'before-hook should have captured a session cookie');
  const r = await get('/dashboard', { cookie });
  assert.equal(r.status, 200, `expected 200, got ${r.status}`);
  assert.match(r.body, /class="app-footer"[\s\S]*?href="\/privacy"/);
});

test('footer link to /privacy appears on /privacy itself (recursion-safe)', async () => {
  // Edge case: the footer is included in privacy.ejs too. Make sure it
  // renders without infinite-loop or include errors.
  const r = await get('/privacy');
  assert.equal(r.status, 200);
  assert.match(r.body, /class="app-footer"[\s\S]*?href="\/privacy"/);
});

// /privacy must be a public, no-auth page that renders the policy.
//
// Asserts:
//   • GET /privacy → 200 (no redirect to /login)
//   • body contains "Privacy Policy"
//   • body contains the contact email "juliamorgan.maldo@gmail.com"
//   • Location header is NOT set to /login (the auth-required routers
//     would redirect us there if /privacy were accidentally gated)
//
// Run from web/:
//   node --test tests/privacy.test.js

require('dotenv').config();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const { pool } = require('../db');

let server;
let baseUrl;

before(async () => {
  // Build a server with the same routing-stack ORDER as production app.js.
  // The order matters: privacy must be reachable BEFORE the auth-required
  // routers that do `router.use(requireAuth)` — otherwise a stray request
  // to an unmatched URL would hit one of those routers first and redirect
  // to /login. Mirroring the production order is the only way this test
  // also catches a future mounting regression.
  const authRoutes              = require('../routes/auth');
  const privacyRoutes           = require('../routes/privacy');
  const passwordResetRoutes     = require('../routes/password-reset');
  const { router: emailVerificationRoutes } = require('../routes/email-verification');
  const dashboardRoutes         = require('../routes/dashboard');
  const transactionRoutes       = require('../routes/transactions');
  const accountRoutes           = require('../routes/accounts');
  const categoryRoutes          = require('../routes/categories');
  const budgetRoutes            = require('../routes/budgets');
  const alertRoutes             = require('../routes/alerts');
  const subscriptionRoutes      = require('../routes/subscriptions');
  const netWorthRoutes          = require('../routes/net-worth');
  const insightsRoutes          = require('../routes/insights');
  const userSettingsRoutes      = require('../routes/user-settings');
  const findingsRoutes          = require('../routes/findings');
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
  app.use(passwordResetRoutes);
  app.use(emailVerificationRoutes);
  app.use(privacyRoutes);
  app.use(dashboardRoutes);
  app.use(transactionRoutes);
  app.use(accountRoutes);
  app.use(categoryRoutes);
  app.use(budgetRoutes);
  app.use(alertRoutes);
  app.use(subscriptionRoutes);
  app.use(netWorthRoutes);
  app.use(insightsRoutes);
  app.use(userSettingsRoutes);
  app.use(findingsRoutes);
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
  await pool.end();
});

function get(p) {
  return new Promise((resolve, reject) => {
    const req = http.request(baseUrl + p, { method: 'GET', headers: { accept: 'text/html' } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('GET /privacy returns 200 and is reachable without auth', async () => {
  const r = await get('/privacy');
  assert.equal(r.status, 200, `expected 200, got ${r.status}`);
  assert.equal(r.headers.location, undefined, 'must not redirect (e.g. to /login)');
});

test('response body contains "Privacy Policy"', async () => {
  const r = await get('/privacy');
  assert.match(r.body, /Privacy Policy/);
});

test('response body contains the contact email', async () => {
  const r = await get('/privacy');
  assert.match(r.body, /juliamorgan\.maldo@gmail\.com/);
});

test('response is HTML, not JSON or plaintext', async () => {
  const r = await get('/privacy');
  assert.match(r.headers['content-type'] || '', /text\/html/);
});

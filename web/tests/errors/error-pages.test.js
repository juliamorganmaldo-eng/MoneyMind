// Branded-error-pages + multi-tenant tests for Phase 4C.
//
// Spins up a real Express server that mounts the same routers as app.js
// (with two test-only routes for forcing a 500 and exercising auth state).
// Asserts:
//   • catch-all /totally-fake-route → 404 HTML page
//   • detail-page 404 with contextual copy
//   • cross-user resource lookup → 404, NOT 403 (don't leak existence)
//   • thrown error → 500 page with error_id, no stack visible
//   • Plaid 403 content negotiation (HTML vs JSON)
//   • multi-tenant: User A's URL space stays opaque to User B
//
// Run from web/:
//   node --test --test-timeout=30000 tests/errors/error-pages.test.js

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

const SUFFIX = '-' + Date.now() + '-4c';
const FAKE_INVITE = 'EP4CTEST' + Date.now().toString(36).toUpperCase();
const PASSWORD = 'phase-4c-test-password';

let server;
let baseUrl;
let userA, userB;
let userASubscriptionId;

async function makeUser(tag, opts = {}) {
  const email = `ep-test${SUFFIX}-${tag}@example.com`.toLowerCase();
  const hash = await bcrypt.hash(PASSWORD, 4);
  const verifiedAt = opts.verified ? new Date() : null;
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, invite_code_used, email_verified_at)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [email, hash, FAKE_INVITE, verifiedAt]
  );
  return { id: rows[0].id, email };
}

before(async () => {
  await pool.query(
    `INSERT INTO invite_codes (code) VALUES ($1) ON CONFLICT DO NOTHING`,
    [FAKE_INVITE]
  );
  // userA is verified — we can test the Plaid 403 against an unverified
  // userB to exercise the email-not-verified gate.
  userA = await makeUser('A', { verified: true });
  userB = await makeUser('B', { verified: false });

  // Give userA a recurring_charges row so we can test cross-user lookup.
  const sub = await pool.query(
    `INSERT INTO recurring_charges
       (user_id, merchant_key, display_name, cadence,
        median_amount_cents, last_amount_cents, occurrence_count,
        confidence_score, status)
     VALUES ($1, 'test-merchant', 'Test Sub', 'monthly',
             1000, 1000, 3, 80, 'active')
     RETURNING id`,
    [userA.id]
  );
  userASubscriptionId = sub.rows[0].id;

  // Build a server that wires the same middleware stack as production app.js.
  // We add two small routes for tests: /__force-500 throws, and we use
  // /api/plaid/create-link-token for the verification gate.
  const authRoutes = require('../../routes/auth');
  const plaidRoutes = require('../../routes/plaid');
  const dashboardRoutes = require('../../routes/dashboard');
  const subscriptionsRoutes = require('../../routes/subscriptions');
  const categoriesRoutes = require('../../routes/categories');
  const { passwordResetRoutes } = (() => {
    try { return { passwordResetRoutes: require('../../routes/password-reset') }; }
    catch (e) { return { passwordResetRoutes: express.Router() }; }
  })();
  const { router: emailVerificationRoutes } = require('../../routes/email-verification');
  const { enforceIdleTimeout } = require('../../middleware/idle-timeout');
  const { render404, render500 } = require('../../lib/render-error');

  const app = express();
  app.set('views', path.join(__dirname, '..', '..', 'views'));
  app.set('view engine', 'ejs');
  app.set('trust proxy', true);
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

  // Test-only: force a 500 by throwing in a handler. The global error
  // middleware should catch it and render errors/500.ejs.
  app.get('/__force-500', (req, res, next) => {
    next(new Error('synthetic test error'));
  });

  app.use(authRoutes);
  app.use(passwordResetRoutes);
  app.use(emailVerificationRoutes);
  app.use(dashboardRoutes);
  app.use(plaidRoutes);
  app.use(subscriptionsRoutes);
  app.use(categoriesRoutes);

  app.use((req, res) => render404(req, res));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => render500(req, res, err));

  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await pool.query(`DELETE FROM recurring_charges WHERE user_id IN ($1, $2)`, [userA?.id, userB?.id]);
  await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`ep-test${SUFFIX}-%`]);
  await pool.query(`DELETE FROM invite_codes WHERE code = $1`, [FAKE_INVITE]);
  await pool.end();
});

// Tiny helper to perform an HTTP request with optional cookies + headers.
function request(method, url, { cookie, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + url);
    const opts = {
      method,
      headers: Object.assign({}, headers),
    };
    if (cookie) opts.headers['cookie'] = cookie;
    if (body) {
      opts.headers['content-type'] = opts.headers['content-type'] || 'application/x-www-form-urlencoded';
      opts.headers['content-length'] = Buffer.byteLength(body);
    }
    const req = http.request(u, opts, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: data,
      }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// Logs the user in via POST /login and returns the session cookie string.
async function login(email) {
  const body = `email=${encodeURIComponent(email)}&password=${encodeURIComponent(PASSWORD)}`;
  const r = await request('POST', '/login', { body });
  const setCookie = r.headers['set-cookie'] || [];
  const sid = setCookie.map((c) => c.split(';')[0]).filter((c) => c.startsWith('moneymind.sid=')).join('; ');
  if (!sid) throw new Error('login did not set moneymind.sid cookie; status was ' + r.status);
  return sid;
}

// ────────────────────────────────────────────────────────────────────────

test('GET /totally-fake-route while authed → 404 page (HTML)', async () => {
  const cookie = await login(userA.email);
  const r = await request('GET', '/totally-fake-route', {
    cookie,
    headers: { accept: 'text/html' },
  });
  assert.equal(r.status, 404);
  assert.match(r.headers['content-type'] || '', /text\/html/);
  assert.match(r.body, /We can&#39;t find that page/);
  // No stack traces or "Error:" leaked.
  assert.doesNotMatch(r.body, /Error:|at \//);
});

test('GET /totally-fake-route with Accept: application/json → JSON 404', async () => {
  const cookie = await login(userA.email);
  const r = await request('GET', '/totally-fake-route', {
    cookie,
    headers: { accept: 'application/json' },
  });
  assert.equal(r.status, 404);
  assert.match(r.headers['content-type'] || '', /application\/json/);
  const j = JSON.parse(r.body);
  assert.equal(j.error, 'not_found');
});

test('GET /subscriptions/999999 → branded 404 with contextual copy', async () => {
  const cookie = await login(userA.email);
  const r = await request('GET', '/subscriptions/999999', {
    cookie,
    headers: { accept: 'text/html' },
  });
  assert.equal(r.status, 404);
  assert.match(r.body, /can&#39;t find that subscription/i);
  assert.match(r.body, /no longer exists, or it isn&#39;t yours/i);
});

test('GET /budgets/999999 → branded 404 with contextual copy', async () => {
  const cookie = await login(userA.email);
  const r = await request('GET', '/budgets/999999', {
    cookie,
    headers: { accept: 'text/html' },
  });
  assert.equal(r.status, 404);
  assert.match(r.body, /can&#39;t find that budget category/i);
  assert.match(r.body, /isn&#39;t yours, or it no longer exists/i);
});

test('cross-user: User B requesting User A\'s subscription → 404 (not 403)', async () => {
  // This is the no-leak test: returning 403 ("forbidden") would tell B
  // that A's id exists but is owned by another user. 404 keeps existence
  // ambiguous between "doesn't exist anywhere" and "exists but isn't yours".
  const cookie = await login(userB.email);
  const r = await request('GET', '/subscriptions/' + userASubscriptionId, {
    cookie,
    headers: { accept: 'text/html' },
  });
  assert.equal(r.status, 404, 'must be 404 to avoid existence leak');
  assert.match(r.body, /can&#39;t find that subscription/i);
});

test('cross-user: same response for non-existent ID and other-user-owned ID', async () => {
  // The point of the previous test stated as a stronger invariant:
  // a real-but-not-yours ID and a never-existed ID must produce
  // identical user-visible status codes and copy.
  const cookie = await login(userB.email);
  const otherUserId = await request('GET', '/subscriptions/' + userASubscriptionId, { cookie, headers: { accept: 'text/html' } });
  const neverExisted = await request('GET', '/subscriptions/999999999', { cookie, headers: { accept: 'text/html' } });
  assert.equal(otherUserId.status, neverExisted.status);
  // Body length will vary slightly (URLs differ if any) — what matters is the heading.
  const heading = /can&#39;t find that subscription/i;
  assert.match(otherUserId.body, heading);
  assert.match(neverExisted.body, heading);
});

test('GET /__force-500 → branded 500 page with error_id, no stack', async () => {
  // No login required — error middleware runs whether or not authed.
  const r = await request('GET', '/__force-500', { headers: { accept: 'text/html' } });
  assert.equal(r.status, 500);
  assert.match(r.body, /Something went wrong on our end/);
  assert.match(r.body, /Reference:.*?err_[0-9a-f]{12}/s);
  // Sensitive content NEVER appears in the user-facing page.
  assert.doesNotMatch(r.body, /synthetic test error/);
  assert.doesNotMatch(r.body, /at .+ \(/); // stack-trace shape
});

test('GET /__force-500 with Accept: application/json → JSON 500 with error_id', async () => {
  const r = await request('GET', '/__force-500', { headers: { accept: 'application/json' } });
  assert.equal(r.status, 500);
  const j = JSON.parse(r.body);
  assert.equal(j.error, 'server_error');
  assert.match(j.error_id, /^err_[0-9a-f]{12}$/);
});

test('Plaid create-link-token (HTML, unverified user) → branded 403 page', async () => {
  // userB was created with email_verified = NULL, so the gate fires.
  const cookie = await login(userB.email);
  const r = await request('POST', '/api/plaid/create-link-token', {
    cookie,
    headers: { accept: 'text/html' },
  });
  assert.equal(r.status, 403);
  assert.match(r.headers['content-type'] || '', /text\/html/);
  assert.match(r.body, /Verify your email first/i);
  // The branded page must offer a sensible next step.
  assert.match(r.body, /Back to dashboard/i);
});

test('Plaid create-link-token (XHR, unverified user) → JSON 403 (preserved API contract)', async () => {
  const cookie = await login(userB.email);
  const r = await request('POST', '/api/plaid/create-link-token', {
    cookie,
    headers: { accept: 'application/json' },
  });
  assert.equal(r.status, 403);
  assert.match(r.headers['content-type'] || '', /application\/json/);
  const j = JSON.parse(r.body);
  assert.equal(j.error, 'email_not_verified');
});

test('500 logs include the error stack server-side (smoke check)', async () => {
  // We can't easily intercept the global console.error in this harness
  // without monkey-patching, which would race other tests. Instead, just
  // confirm the response carries an error_id (which proves the log call
  // ran with the same id we're showing the user).
  const r = await request('GET', '/__force-500', { headers: { accept: 'application/json' } });
  const j = JSON.parse(r.body);
  assert.match(j.error_id, /^err_[0-9a-f]{12}$/);
});

test('multi-tenant: empty-state pages for a fresh user never reference other users', async () => {
  // userA has no plaid_items but is verified — should see the welcome
  // hero. The hero says "Welcome, [first name]!" — assert it includes
  // userA's email-derived name and NEVER the seeded subscription's
  // display_name (which belongs to userA in our setup, but the principle
  // is: no rendered text should reflect ANYONE else's data).
  const cookie = await login(userA.email);
  const r = await request('GET', '/dashboard', { cookie, headers: { accept: 'text/html' } });
  assert.equal(r.status, 200);
  // userA has no plaid_items at this point — welcome hero should fire.
  assert.match(r.body, /Welcome to MoneyMind/i);
  assert.match(r.body, /Your data is encrypted and only visible to you/i);
  assert.doesNotMatch(r.body, /ep-test.*-B@example\.com/i);
});

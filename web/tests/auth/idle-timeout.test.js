// Pure middleware tests for enforceIdleTimeout — no DB required.
// Run from web/:  node --test tests/auth/idle-timeout.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { enforceIdleTimeout, IDLE_TIMEOUT_MS } = require('../../middleware/idle-timeout');

// Tiny request/response builder so we can drive the middleware in pure
// JS without spinning up Express. Mirrors only the surface the
// middleware actually touches.
function makeReq({ path = '/dashboard', method = 'GET', session = null } = {}) {
  return {
    path,
    method,
    session,
    headers: { accept: 'text/html' },
    accepts: (types) => (Array.isArray(types) && types.includes('html') ? 'html' : false),
  };
}

function makeRes() {
  return {
    statusCode: 200,
    redirected: null,
    cleared: null,
    jsonBody: null,
    status(c) { this.statusCode = c; return this; },
    redirect(url) { this.redirected = url; },
    clearCookie(name, opts) { this.cleared = { name, opts }; },
    json(obj) { this.jsonBody = obj; return this; },
  };
}

test('skips static-asset paths (/css, /js, /img, /fonts, /public)', () => {
  for (const p of ['/css/x.css', '/js/dashboard.js', '/img/logo.png', '/fonts/a.woff', '/public/x']) {
    const req = makeReq({ path: p, session: { userId: 1, lastActivityAt: 0 } });
    let nextCalled = false;
    enforceIdleTimeout(req, makeRes(), () => { nextCalled = true; });
    assert.equal(nextCalled, true, `expected next() for ${p}`);
    // lastActivityAt must NOT be bumped — that would let polling assets keep a session alive
    assert.equal(req.session.lastActivityAt, 0, `${p} should not update lastActivityAt`);
  }
});

test('skips OPTIONS requests', () => {
  const req = makeReq({ method: 'OPTIONS', session: { userId: 1, lastActivityAt: 0 } });
  let nextCalled = false;
  enforceIdleTimeout(req, makeRes(), () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(req.session.lastActivityAt, 0);
});

test('passes through when no userId in session (unauthenticated)', () => {
  const req = makeReq({ session: { /* no userId */ } });
  let nextCalled = false;
  enforceIdleTimeout(req, makeRes(), () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

test('updates lastActivityAt on the FIRST authenticated request (no prior value)', () => {
  const req = makeReq({ session: { userId: 1 /* no lastActivityAt */ } });
  enforceIdleTimeout(req, makeRes(), () => {});
  assert.equal(typeof req.session.lastActivityAt, 'number');
  assert.ok(req.session.lastActivityAt > 0);
});

test('refreshes lastActivityAt when ≥ 30s since last touch', () => {
  const oldStamp = Date.now() - 60 * 1000; // 60s ago
  const req = makeReq({ session: { userId: 1, lastActivityAt: oldStamp } });
  enforceIdleTimeout(req, makeRes(), () => {});
  assert.ok(req.session.lastActivityAt > oldStamp, 'should bump');
});

test('does NOT bump lastActivityAt for a sub-30s rapid second request (write-suppression)', () => {
  const recent = Date.now() - 5 * 1000; // 5s ago
  const req = makeReq({ session: { userId: 1, lastActivityAt: recent } });
  enforceIdleTimeout(req, makeRes(), () => {});
  assert.equal(req.session.lastActivityAt, recent, 'should not bump under 30s');
});

test('idle session > 30 min: destroys session, clears cookie, redirects to /login?reason=idle', () => {
  const expired = Date.now() - (IDLE_TIMEOUT_MS + 1000);
  let destroyed = false;
  const req = makeReq({
    session: {
      userId: 1,
      lastActivityAt: expired,
      destroy(cb) { destroyed = true; cb(null); },
    },
  });
  const res = makeRes();
  enforceIdleTimeout(req, res, (err) => assert.ifError(err));
  assert.equal(destroyed, true, 'session.destroy must be called');
  assert.deepEqual(res.cleared, { name: 'moneymind.sid', opts: { path: '/' } });
  assert.equal(res.redirected, '/login?reason=idle');
});

test('idle expiry on an XHR (json) request returns 401 JSON, not a redirect', () => {
  const expired = Date.now() - (IDLE_TIMEOUT_MS + 1000);
  const req = {
    path: '/api/x',
    method: 'GET',
    session: {
      userId: 1,
      lastActivityAt: expired,
      destroy(cb) { cb(null); },
    },
    headers: {},
    accepts: (types) => (Array.isArray(types) && types.includes('json') ? 'json' : false),
  };
  const res = makeRes();
  enforceIdleTimeout(req, res, (err) => assert.ifError(err));
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.jsonBody, { error: 'session_idle' });
  assert.equal(res.redirected, null);
});

test('exactly at the boundary (30 min sharp) is NOT yet expired', () => {
  // strictly greater-than is the threshold — being exactly at 30:00 should pass
  const exactlyAtBoundary = Date.now() - IDLE_TIMEOUT_MS;
  const req = makeReq({ session: { userId: 1, lastActivityAt: exactlyAtBoundary } });
  let nextCalled = false;
  enforceIdleTimeout(req, makeRes(), () => { nextCalled = true; });
  assert.equal(nextCalled, true, 'exact boundary should still be valid');
});

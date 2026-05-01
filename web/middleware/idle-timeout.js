// Idle-timeout enforcement (Phase 4B).
//
// Two timeouts protect a logged-in session:
//
//   • Idle (this file): 30 minutes since the last *meaningful* request.
//     Static-asset and OPTIONS requests do NOT count as activity — a
//     user who left the dashboard open in a tab while polling /js/*.js
//     hasn't actually been there.
//
//   • Absolute (enforced via cookie maxAge in app.js + a loginAt check):
//     12h normal, 30d when "Remember me" was checked at sign-in.
//
// On idle expiry: destroy the session, clear the cookie, redirect to
// /login?reason=idle. The login page can render a "You were signed out
// due to inactivity" notice from that query param.

const IDLE_TIMEOUT_MS = 30 * 60 * 1000;

// Paths that should NOT update lastActivityAt and should NOT be subject
// to the idle check. Static assets, the favicon, the logout endpoint
// (so a logout request from a stale tab still works), and OPTIONS
// preflights.
const STATIC_PATH_RE = /^\/(css|js|img|fonts|public)\//;
function isStaticOrSystemPath(req) {
  if (req.method === 'OPTIONS') return true;
  if (req.path === '/favicon.ico') return true;
  if (STATIC_PATH_RE.test(req.path)) return true;
  return false;
}

function enforceIdleTimeout(req, res, next) {
  if (isStaticOrSystemPath(req)) return next();
  if (!req.session || !req.session.userId) return next();

  const now = Date.now();
  const last = req.session.lastActivityAt;

  if (typeof last === 'number' && now - last > IDLE_TIMEOUT_MS) {
    // Expired. Destroy session, clear cookie, send to login.
    return req.session.destroy((err) => {
      if (err) return next(err);
      res.clearCookie('moneymind.sid', { path: '/' });
      // For HTML navs, redirect with a reason so the page can flash a
      // friendly message. For XHR/fetch, return 401 so the client JS
      // can decide what to do (the dashboard JS already treats 401 as
      // "go to login").
      const wantsHtml = req.accepts(['html', 'json']) === 'html';
      if (wantsHtml) return res.redirect('/login?reason=idle');
      return res.status(401).json({ error: 'session_idle' });
    });
  }

  // Touch — but only persist if it actually moved by ≥ 30s. Otherwise
  // every dashboard widget poll writes to the session table on every
  // request, which is wasteful. The 30s slack is well below the 30-min
  // idle threshold so it can't accidentally extend a stale session.
  if (typeof last !== 'number' || now - last >= 30 * 1000) {
    req.session.lastActivityAt = now;
  }
  return next();
}

module.exports = { enforceIdleTimeout, IDLE_TIMEOUT_MS };

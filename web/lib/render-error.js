// Helpers for rendering branded error pages with content negotiation.
//
// `wantsHtml(req)` decides between HTML and JSON based on the Accept
// header — XHR/fetch defaults to */* or application/json, browser navs
// send text/html, so this gives us "render the EJS for browsers, return
// JSON for API clients" in one place.
//
// Both renderers are SAFE to call from the global error middleware:
//   • They never include error.message or stack in user-visible output.
//   • They tolerate `req.session` being undefined (errors thrown before
//     session() runs still need a usable error page).

const crypto = require('node:crypto');

function wantsHtml(req) {
  // Express's req.accepts returns the FIRST type from our list that the
  // Accept header would match. If the client sends `Accept: */*` (curl,
  // most fetch defaults), the first item wins — so we list 'html' first
  // for browser-shaped requests but the explicit 'json' first wins for
  // explicit JSON clients (which set Accept: application/json).
  if (typeof req.accepts !== 'function') return false;
  return req.accepts(['html', 'json']) === 'html';
}

function isAuthed(req) {
  return !!(req && req.session && req.session.userId);
}

// Generate a short, log-friendly error id. UUIDv4 is fine, but a 12-char
// hex slice is easier to read aloud / paste in an email.
function newErrorId() {
  return 'err_' + crypto.randomBytes(6).toString('hex');
}

function render404(req, res, opts = {}) {
  res.status(404);
  if (wantsHtml(req)) {
    return res.render('errors/404', {
      authed: isAuthed(req),
      heading: opts.heading || null,
      body: opts.body || null,
    });
  }
  return res.json({ error: opts.code || 'not_found' });
}

function render403(req, res, opts = {}) {
  res.status(403);
  if (wantsHtml(req)) {
    return res.render('errors/403', {
      authed: isAuthed(req),
      heading: opts.heading || null,
      body: opts.body || null,
      next_step: opts.next_step || null,
    });
  }
  return res.json({ error: opts.code || 'forbidden' });
}

function render500(req, res, err) {
  const error_id = newErrorId();
  // Server-side log gets the full stack + identifying context. NEVER
  // surface this to the user. Includes user_id when available so a
  // matching support email can be looked up.
  const userId = req && req.session ? req.session.userId : null;
  console.error('[error]', {
    error_id,
    user_id: userId || null,
    method: req && req.method,
    path: req && (req.originalUrl || req.url),
    message: err && err.message,
    stack: err && err.stack,
  });

  res.status(500);
  if (wantsHtml(req)) {
    return res.render('errors/500', {
      authed: isAuthed(req),
      error_id,
    });
  }
  return res.json({ error: 'server_error', error_id });
}

module.exports = { wantsHtml, isAuthed, render404, render403, render500 };

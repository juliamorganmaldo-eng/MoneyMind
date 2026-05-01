// Login rate limiting + failed-attempt accounting (Phase 4B).
//
// Two signals are tracked, both backed by failed_login_attempts:
//
//   • IP throttle (15 min): same ip_address has 5 failed POST /login
//     attempts in the last 15 minutes → 6th attempt gets 429 with a
//     Retry-After header. Catches password-spray from a single source.
//
//   • Account-wide signal (1 hr): same email_attempted has 20 failed
//     attempts in the last hour → security-alert email to that user
//     (not enforced here — enforced in the login route after the
//     bcrypt compare so we know whether the email maps to a user).
//
// We do NOT store the password that was attempted. The table only knows
// "ip X tried email Y at time T and it failed" — never the credential.
// This keeps the table itself non-sensitive.

const { pool } = require('../db');

const IP_WINDOW_MS = 15 * 60 * 1000;
const IP_MAX_FAILURES = 5;
const ACCOUNT_WINDOW_MS = 60 * 60 * 1000;
const ACCOUNT_MAX_FAILURES = 20;

// Express middleware. Mount on POST /login BEFORE the handler.
// Reads req.ip — relies on `app.set('trust proxy', 1)` being set when
// behind a TLS-terminating proxy (already configured in app.js for prod).
async function loginRateLimit(req, res, next) {
  try {
    const ip = req.ip;
    const { rows } = await pool.query(
      `SELECT attempted_at
         FROM failed_login_attempts
        WHERE ip_address = $1
          AND attempted_at > NOW() - INTERVAL '15 minutes'
        ORDER BY attempted_at ASC`,
      [ip]
    );
    if (rows.length < IP_MAX_FAILURES) return next();

    // Retry-After is the seconds until the OLDEST attempt in the window
    // ages out — at that moment the count drops to 4 and the next
    // attempt is allowed through.
    const oldest = new Date(rows[0].attempted_at).getTime();
    const retryAfterMs = Math.max(0, oldest + IP_WINDOW_MS - Date.now());
    const retryAfterSec = Math.max(1, Math.ceil(retryAfterMs / 1000));

    res.set('Retry-After', String(retryAfterSec));
    res.status(429);

    // For HTML form submits, render the login view with an error.
    // For anything else (curl, tests), send plaintext — same status + header.
    const wantsHtml = req.accepts(['html', 'json', 'text']) === 'html';
    if (wantsHtml) {
      return res.render('login', {
        error: `Too many sign-in attempts from this network. Try again in about ${Math.ceil(retryAfterSec / 60)} minute${retryAfterSec >= 120 ? 's' : ''}.`,
        email: typeof req.body?.email === 'string' ? req.body.email : '',
        flash: null,
        rememberPref: false,
      });
    }
    return res.type('text/plain').send(`Too many sign-in attempts. Retry after ${retryAfterSec}s.\n`);
  } catch (err) {
    return next(err);
  }
}

// Insert a failed-attempt row. Called by the login route on every failed
// POST /login (whether the email exists or not — keeps the table
// consistent with the timing-safe DUMMY_HASH compare in the route).
async function recordFailedAttempt(ip, email) {
  await pool.query(
    `INSERT INTO failed_login_attempts (ip_address, email_attempted)
     VALUES ($1, $2)`,
    [ip, email]
  );
}

// Wipe this IP's recent failures. Called on a successful login so the
// 5-in-15-min budget resets — otherwise a user who fat-fingers their
// password 4 times then logs in successfully would still have a
// near-locked account from that IP.
async function clearFailedAttemptsForIp(ip) {
  await pool.query(
    `DELETE FROM failed_login_attempts
      WHERE ip_address = $1
        AND attempted_at > NOW() - INTERVAL '15 minutes'`,
    [ip]
  );
}

// Returns the number of failed attempts against `email` within the last
// `withinMs` milliseconds. Used by the route to decide whether to fire
// a security-alert email.
async function countAccountWideFailures(email, withinMs = ACCOUNT_WINDOW_MS) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n
       FROM failed_login_attempts
      WHERE email_attempted = $1
        AND attempted_at > NOW() - ($2::int || ' milliseconds')::interval`,
    [email, withinMs]
  );
  return rows[0].n;
}

module.exports = {
  loginRateLimit,
  recordFailedAttempt,
  clearFailedAttemptsForIp,
  countAccountWideFailures,
  IP_WINDOW_MS,
  IP_MAX_FAILURES,
  ACCOUNT_WINDOW_MS,
  ACCOUNT_MAX_FAILURES,
};

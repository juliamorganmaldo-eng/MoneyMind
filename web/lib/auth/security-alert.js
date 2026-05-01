// Decides whether to send a "failed_login_burst" security-alert email
// to a user who has been targeted by a flood of failed login attempts.
//
// Three preconditions, all required:
//   1. The email maps to a real user (no alert for non-existent emails —
//      that would let an attacker enumerate registered emails by which
//      ones triggered alerts to a controlled inbox).
//   2. Failed attempts against this email cross the threshold (default
//      ACCOUNT_MAX_FAILURES) within the last hour.
//   3. We haven't already sent THIS user a 'failed_login_burst' alert
//      in the last hour. The 1-per-hour cap is enforced by inserting
//      into security_alerts_sent BEFORE the send — if the send fails,
//      the row still blocks a retry storm; the next legitimate alert
//      will fire once the hour rolls over.

const { pool } = require('../../db');
const {
  countAccountWideFailures,
  ACCOUNT_MAX_FAILURES,
  ACCOUNT_WINDOW_MS,
} = require('../../middleware/rate-limit');
const securityAlertTemplate = require('../email/templates/security-alert');
const { sendEmail } = require('../email/client');

const APP_BASE_URL = (process.env.APP_BASE_URL || 'http://localhost:3001').replace(/\/+$/, '');

async function maybeSendSecurityAlert(email, opts = {}) {
  if (!email) return { sent: false, reason: 'no_email' };

  const { rows: userRows } = await pool.query(
    'SELECT id FROM users WHERE email = $1',
    [email]
  );
  const user = userRows[0];
  if (!user) return { sent: false, reason: 'no_user' };

  const failedCount = await countAccountWideFailures(email, ACCOUNT_WINDOW_MS);
  if (failedCount < ACCOUNT_MAX_FAILURES) {
    return { sent: false, reason: 'below_threshold', failedCount };
  }

  const { rows: recent } = await pool.query(
    `SELECT 1
       FROM security_alerts_sent
      WHERE user_id = $1
        AND alert_type = 'failed_login_burst'
        AND sent_at > NOW() - INTERVAL '1 hour'
      LIMIT 1`,
    [user.id]
  );
  if (recent.length > 0) {
    return { sent: false, reason: 'already_sent_recently', failedCount };
  }

  await pool.query(
    `INSERT INTO security_alerts_sent (user_id, alert_type)
     VALUES ($1, 'failed_login_burst')`,
    [user.id]
  );

  // Allow tests to inject a stub sender so we don't actually call Resend.
  const send = opts.sendEmail || sendEmail;
  const { subject, html, text } = securityAlertTemplate.build({
    user_email: email,
    failed_count: failedCount,
    window_minutes: 60,
    forgot_password_url: `${APP_BASE_URL}/forgot-password`,
  });
  const result = await send({ to: email, subject, html, text });
  return { sent: true, failedCount, sendResult: result };
}

module.exports = { maybeSendSecurityAlert };

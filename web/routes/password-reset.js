// Forgot-password + reset-password endpoints. NO auth required (the user
// can't log in — that's the whole point).
//
// Security posture:
//   • Tokens stored as SHA-256 hashes only — plaintext leaves the server
//     once, in the email URL. The lookup column is the hash.
//   • Generic responses prevent username enumeration. The forgot-password
//     endpoint returns the same body+status whether the email exists or not.
//   • Strict expiry (1 hour) and one-time use (used_at) enforced at SQL.
//   • Rate limit: 3 active unexpired non-used tokens per user → suppress
//     further sends silently (still return generic success).
//   • On successful reset: ALL existing sessions for that user are
//     invalidated (force logout everywhere).
//   • Confirmation email sent on successful reset so the user is alerted
//     if it wasn't them.

const express = require('express');
const bcrypt = require('bcrypt');
const { pool } = require('../db');
const { generate, hash } = require('../lib/auth/tokens');
const { sendEmail } = require('../lib/email/client');
const passwordResetTemplate = require('../lib/email/templates/password-reset');
const passwordChangedTemplate = require('../lib/email/templates/password-changed');

const router = express.Router();
router.use(express.json({ limit: '32kb' }));

const TOKEN_EXPIRY_MINUTES = 60;
const RATE_LIMIT_PER_HOUR = 3;
const BCRYPT_ROUNDS = 12;
const MIN_PASSWORD_LENGTH = 10;
const APP_BASE_URL = (process.env.APP_BASE_URL || 'http://localhost:3001').replace(/\/+$/, '');

function normalizeEmail(v) { return typeof v === 'string' ? v.trim().toLowerCase() : ''; }
function genericForgotResponse(res) {
  return res.status(200).json({
    ok: true,
    message: "If an account exists with that email, we've sent a reset link.",
  });
}

router.post('/api/auth/forgot-password', async (req, res) => {
  const email = normalizeEmail(req.body && req.body.email);
  // Generic response is sent in EVERY path — even on input error or DB
  // failure — so the response shape never leaks anything.
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return genericForgotResponse(res);
  }

  try {
    // is_deleted=FALSE filter: a soft-deleted account must respond
    // identically to a never-existed email — generic response, no
    // token issued, no email sent. Otherwise we'd leak that an account
    // once existed AND signal that resetting won't help (because login
    // also blocks them), which is worse than the password-reset itself.
    const { rows: users } = await pool.query(
      'SELECT id FROM users WHERE email = $1 AND is_deleted = FALSE',
      [email]
    );
    if (users.length === 0) return genericForgotResponse(res);

    const userId = users[0].id;

    // Rate limit: count active unexpired non-used tokens for this user.
    const { rows: active } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM password_reset_tokens
        WHERE user_id = $1 AND used_at IS NULL AND expires_at > NOW()`,
      [userId]
    );
    if (active[0].n >= RATE_LIMIT_PER_HOUR) {
      // Stay generic — don't reveal we hit the rate limit.
      return genericForgotResponse(res);
    }

    const plaintext = generate();
    const tokenHash = hash(plaintext);
    const ip = req.ip || (req.connection && req.connection.remoteAddress) || null;

    await pool.query(
      `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, ip_address)
       VALUES ($1, $2, NOW() + INTERVAL '${TOKEN_EXPIRY_MINUTES} minutes', $3)`,
      [userId, tokenHash, ip]
    );

    const resetUrl = `${APP_BASE_URL}/reset-password?token=${encodeURIComponent(plaintext)}`;
    const tpl = passwordResetTemplate.build({
      user_email: email,
      reset_url: resetUrl,
      expires_in_minutes: TOKEN_EXPIRY_MINUTES,
    });
    // Fire-and-await — but wrap so a Resend failure doesn't change response.
    try {
      await sendEmail({ to: email, subject: tpl.subject, html: tpl.html, text: tpl.text });
    } catch (e) {
      console.error('[forgot-password] email send threw:', e.message);
    }
    return genericForgotResponse(res);
  } catch (err) {
    console.error('[forgot-password] failed:', err.message);
    // Even on DB error, generic response — never leak the failure mode.
    return genericForgotResponse(res);
  }
});

// GET /reset-password?token=… — render the form (or an error page).
router.get('/reset-password', async (req, res) => {
  const tokenPlain = typeof req.query.token === 'string' ? req.query.token : '';
  if (!tokenPlain) return res.render('reset-password-error', { reason: 'missing' });

  try {
    const tokenHash = hash(tokenPlain);
    const { rows } = await pool.query(
      `SELECT id FROM password_reset_tokens
        WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()`,
      [tokenHash]
    );
    if (rows.length === 0) return res.render('reset-password-error', { reason: 'invalid_or_expired' });
    res.render('reset-password', { token: tokenPlain, error: null });
  } catch (err) {
    res.render('reset-password-error', { reason: 'invalid_or_expired' });
  }
});

// POST /api/auth/reset-password — consume token, set new password.
router.post('/api/auth/reset-password', async (req, res) => {
  const tokenPlain = typeof req.body.token === 'string' ? req.body.token : '';
  const newPassword = typeof req.body.new_password === 'string' ? req.body.new_password : '';
  if (!tokenPlain) return res.status(400).json({ error: 'token is required' });
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const tokenHash = hash(tokenPlain);
    // SELECT FOR UPDATE prevents race between two concurrent reset attempts.
    const { rows } = await client.query(
      `SELECT id, user_id FROM password_reset_tokens
        WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()
        FOR UPDATE`,
      [tokenHash]
    );
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'This reset link is invalid or has expired.' });
    }
    const tokenId = rows[0].id;
    const userId = rows[0].user_id;

    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

    await client.query(
      `UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2`,
      [passwordHash, userId]
    );

    // Mark THIS token used + invalidate every other unused token for this
    // user (one reset invalidates the rest).
    await client.query(
      `UPDATE password_reset_tokens SET used_at = NOW()
        WHERE user_id = $1 AND used_at IS NULL`,
      [userId]
    );

    // Invalidate all of this user's existing sessions. connect-pg-simple
    // stores sessions in `session` with sess JSON containing userId.
    await client.query(
      `DELETE FROM session WHERE sess::jsonb->>'userId' = $1`,
      [String(userId)]
    );

    // Get email for confirmation message
    const { rows: u } = await client.query('SELECT email FROM users WHERE id = $1', [userId]);
    const email = u[0] && u[0].email;

    await client.query('COMMIT');

    // Confirmation email — fire-and-await but tolerate failure.
    if (email) {
      try {
        const tpl = passwordChangedTemplate.build({
          user_email: email,
          when_iso: new Date().toISOString().slice(0, 19) + ' UTC',
        });
        await sendEmail({ to: email, subject: tpl.subject, html: tpl.html, text: tpl.text });
      } catch (e) {
        console.error('[reset-password] confirmation email failed:', e.message);
      }
    }

    res.json({ ok: true, redirect: '/login?reset=ok' });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[reset-password] failed:', err.message);
    res.status(500).json({ error: 'Could not reset password.' });
  } finally {
    client.release();
  }
});

// Page route: show the forgot-password form.
router.get('/forgot-password', (req, res) => {
  res.render('forgot-password');
});

module.exports = router;

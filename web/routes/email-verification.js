// Email-verification endpoints.
//
//   GET  /verify-email?token=…             — public, consumes token, marks user verified
//   POST /api/auth/resend-verification     — auth required, rate-limited 3/hr, sends a fresh token
//
// Tokens follow the same SHA-256 hash discipline as password reset.

const express = require('express');
const { pool } = require('../db');
const { generate, hash } = require('../lib/auth/tokens');
const { sendEmail } = require('../lib/email/client');
const verificationTemplate = require('../lib/email/templates/email-verification');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(express.json({ limit: '32kb' }));

const TOKEN_EXPIRY_HOURS = 24;
const RATE_LIMIT_PER_HOUR = 3;
const APP_BASE_URL = (process.env.APP_BASE_URL || 'http://localhost:3001').replace(/\/+$/, '');

// Helper: create a fresh verification token row + send the email.
// Returns { ok: bool, throttled?: bool, sent?: bool }.
async function issueVerification(userId, email) {
  // Rate limit: count verification tokens issued in the last hour.
  const { rows: recent } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM email_verification_tokens
      WHERE user_id = $1 AND created_at >= (NOW() - INTERVAL '1 hour')`,
    [userId]
  );
  if (recent[0].n >= RATE_LIMIT_PER_HOUR) {
    return { ok: true, throttled: true };
  }

  const plaintext = generate();
  const tokenHash = hash(plaintext);
  await pool.query(
    `INSERT INTO email_verification_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, NOW() + INTERVAL '${TOKEN_EXPIRY_HOURS} hours')`,
    [userId, tokenHash]
  );
  await pool.query(
    `UPDATE users SET email_verification_attempts = email_verification_attempts + 1 WHERE id = $1`,
    [userId]
  );

  const verifyUrl = `${APP_BASE_URL}/verify-email?token=${encodeURIComponent(plaintext)}`;
  const tpl = verificationTemplate.build({
    user_email: email,
    verify_url: verifyUrl,
    expires_in_hours: TOKEN_EXPIRY_HOURS,
  });
  try {
    await sendEmail({ to: email, subject: tpl.subject, html: tpl.html, text: tpl.text });
  } catch (e) {
    console.error('[verification] email send threw:', e.message);
    return { ok: true, sent: false };
  }
  return { ok: true, sent: true };
}

router.get('/verify-email', async (req, res) => {
  const tokenPlain = typeof req.query.token === 'string' ? req.query.token : '';
  if (!tokenPlain) return res.render('verify-email-error', { reason: 'missing' });

  const tokenHash = hash(tokenPlain);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `SELECT id, user_id FROM email_verification_tokens
        WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()
        FOR UPDATE`,
      [tokenHash]
    );
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return res.render('verify-email-error', { reason: 'invalid_or_expired' });
    }

    const tokenId = rows[0].id;
    const userId = rows[0].user_id;
    await client.query(
      `UPDATE users SET email_verified_at = COALESCE(email_verified_at, NOW()) WHERE id = $1`,
      [userId]
    );
    await client.query(
      `UPDATE email_verification_tokens SET used_at = NOW() WHERE id = $1`,
      [tokenId]
    );
    await client.query('COMMIT');

    // Set a flash via session if available; otherwise just redirect.
    if (req.session) req.session.flash = 'Email verified! You can now connect a bank account.';
    res.redirect('/dashboard');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[verify-email] failed:', err.message);
    res.render('verify-email-error', { reason: 'invalid_or_expired' });
  } finally {
    client.release();
  }
});

router.post('/api/auth/resend-verification', requireAuth, async (req, res) => {
  const userId = req.session.userId;
  try {
    const { rows } = await pool.query(
      'SELECT email, email_verified_at FROM users WHERE id = $1', [userId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'User not found.' });
    if (rows[0].email_verified_at) {
      return res.status(409).json({ error: 'Email is already verified.' });
    }
    const out = await issueVerification(userId, rows[0].email);
    if (out.throttled) {
      return res.status(429).json({ error: 'Too many verification requests. Try again later.' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[resend-verification] failed:', err.message);
    res.status(500).json({ error: 'Could not send verification email.' });
  }
});

module.exports = { router, issueVerification };

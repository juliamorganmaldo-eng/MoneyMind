const express = require('express');
const bcrypt = require('bcrypt');
const { pool } = require('../db');
const { redirectIfAuthed } = require('../middleware/auth');
const {
  loginRateLimit,
  recordFailedAttempt,
  clearFailedAttemptsForIp,
} = require('../middleware/rate-limit');
const { maybeSendSecurityAlert } = require('../lib/auth/security-alert');
const { DEFAULT_CATEGORY_NAMES } = require('../lib/category-mapping');

const router = express.Router();

const BCRYPT_ROUNDS = 12;
const MIN_PASSWORD_LENGTH = 10;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// "Remember me" lifetimes — also enforced on the cookie maxAge in app.js.
const SESSION_MAX_AGE_DEFAULT_MS = 12 * 60 * 60 * 1000;        // 12 hours
const SESSION_MAX_AGE_REMEMBER_MS = 30 * 24 * 60 * 60 * 1000;  // 30 days

// Persists the user's last "Remember me" choice across logout. Not
// security-sensitive — just a UX nicety so the box is pre-checked next
// visit. The DB column users.remember_me_default is the source of truth
// once you log in; this cookie is what the LOGIN form reads.
const REMEMBER_PREF_COOKIE = 'mm_remember_pref';
const REMEMBER_PREF_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

// A precomputed hash of a throwaway value. Used so that failed-lookup logins
// spend the same time as real ones, defeating user-enumeration via timing.
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing-equalization', BCRYPT_ROUNDS);

function normalizeEmail(v) {
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}

function normalizeCode(v) {
  return typeof v === 'string' ? v.trim().toUpperCase() : '';
}

// Regenerate the session to prevent fixation, then set userId, login
// timestamps, and remember-me lifetime. The cookie's maxAge is set
// per-session (not globally in app.js) so "Remember me" can stretch a
// single session to 30 days while a normal login stays at 12 hours.
function logInAs(req, userId, { rememberMe }) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) return reject(err);
      req.session.userId = userId;
      req.session.loginAt = Date.now();
      req.session.lastActivityAt = Date.now();
      req.session.rememberMe = !!rememberMe;
      req.session.cookie.maxAge = rememberMe
        ? SESSION_MAX_AGE_REMEMBER_MS
        : SESSION_MAX_AGE_DEFAULT_MS;
      req.session.save((err2) => (err2 ? reject(err2) : resolve()));
    });
  });
}

// Parse the mm_remember_pref cookie out of the raw Cookie header. We
// don't use cookie-parser app-wide (just to read one non-sensitive
// value), so this avoids adding a dependency for a one-line need.
function rememberPrefFromCookie(req) {
  const header = req.headers.cookie || '';
  const m = header.match(new RegExp('(?:^|;\\s*)' + REMEMBER_PREF_COOKIE + '=([^;]*)'));
  return m ? m[1] === '1' : false;
}

router.get('/login', redirectIfAuthed, (req, res) => {
  let flash = null;
  if (req.query.reset === 'ok') flash = 'Password updated. Please sign in with your new password.';
  if (req.query.verified === 'ok') flash = 'Email verified! You can now connect a bank account.';
  if (req.query.reason === 'idle') flash = 'You were signed out due to inactivity. Please sign in again.';
  if (req.query.reason === 'expired') flash = 'Your session has expired. Please sign in again.';
  res.render('login', {
    error: null,
    email: '',
    flash,
    rememberPref: rememberPrefFromCookie(req),
  });
});

router.post('/login', loginRateLimit, redirectIfAuthed, async (req, res, next) => {
  const email = normalizeEmail(req.body.email);
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const rememberMe = req.body.remember_me === 'on' || req.body.remember_me === '1';
  const ip = req.ip;

  const generic = 'Invalid email or password.';
  const render = (error) =>
    res.status(401).render('login', { error, email, flash: null, rememberPref: rememberMe });

  // Persists the box's checked state across the next /login GET.
  res.cookie(REMEMBER_PREF_COOKIE, rememberMe ? '1' : '0', {
    path: '/',
    httpOnly: false, // intentional — purely UX, no auth value
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: REMEMBER_PREF_MAX_AGE_MS,
  });

  try {
    if (!email || !password) {
      // Still record — an empty submission against a real email is part
      // of the "trying to find a user" pattern. Insert with email='' if
      // empty so the per-email count for real emails stays accurate.
      await recordFailedAttempt(ip, email);
      return render(generic);
    }

    const { rows } = await pool.query(
      'SELECT id, password_hash FROM users WHERE email = $1',
      [email]
    );
    const user = rows[0];

    // Always run a bcrypt compare — equal time whether the user exists or not.
    const hash = user ? user.password_hash : DUMMY_HASH;
    const ok = await bcrypt.compare(password, hash);

    if (!user || !ok) {
      await recordFailedAttempt(ip, email);
      // Account-wide signal — fire-and-forget so a Resend hiccup never
      // leaks signal to the attacker via response timing.
      maybeSendSecurityAlert(email).catch((e) =>
        console.error('[security-alert] dispatch failed:', e.message)
      );
      return render(generic);
    }

    // Success — reset the per-IP failure budget and persist remember-me
    // pref to the user row (source of truth across browsers).
    await clearFailedAttemptsForIp(ip);
    await pool.query(
      'UPDATE users SET remember_me_default = $1, updated_at = NOW() WHERE id = $2',
      [rememberMe, user.id]
    );

    await logInAs(req, user.id, { rememberMe });
    return res.redirect('/dashboard');
  } catch (err) {
    return next(err);
  }
});


router.get('/register', redirectIfAuthed, (req, res) => {
  res.render('register', { error: null, email: '', inviteCode: '', privacyAgreed: false });
});

router.post('/register', redirectIfAuthed, async (req, res, next) => {
  const email = normalizeEmail(req.body.email);
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const inviteCode = normalizeCode(req.body.inviteCode);
  // Privacy-policy agreement: the form sends `privacy_agreed=on` only
  // when the box is checked (HTML checkbox semantics). We DO NOT trust
  // the client-side disabled-button — every POST is re-validated here.
  const privacyAgreed = req.body.privacy_agreed === 'on' || req.body.privacy_agreed === '1';

  const render = (error, status = 400) =>
    res.status(status).render('register', { error, email, inviteCode, privacyAgreed });

  try {
    if (!EMAIL_RE.test(email)) return render('Please enter a valid email address.');
    if (password.length < MIN_PASSWORD_LENGTH) {
      return render(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    }
    if (!inviteCode) return render('Invite code is required.');
    if (!privacyAgreed) {
      return render('You must agree to the privacy policy to create an account.');
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Lock the invite row so two concurrent registrations can't share it.
      const { rows: inviteRows } = await client.query(
        'SELECT code, used_by_user_id, revoked_at FROM invite_codes WHERE code = $1 FOR UPDATE',
        [inviteCode]
      );
      const invite = inviteRows[0];
      if (!invite || invite.used_by_user_id || invite.revoked_at) {
        await client.query('ROLLBACK');
        return render('That invite code is invalid or has already been used.');
      }

      const { rows: existing } = await client.query(
        'SELECT 1 FROM users WHERE email = $1',
        [email]
      );
      if (existing.length) {
        await client.query('ROLLBACK');
        return render('An account with that email already exists.');
      }

      const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

      const { rows: inserted } = await client.query(
        `INSERT INTO users (email, password_hash, invite_code_used, privacy_policy_agreed_at)
         VALUES ($1, $2, $3, NOW())
         RETURNING id`,
        [email, passwordHash, inviteCode]
      );
      const userId = inserted[0].id;

      await client.query(
        `UPDATE invite_codes
            SET used_by_user_id = $1, used_at = NOW()
          WHERE code = $2`,
        [userId, inviteCode]
      );

      // Seed the 5 default MoneyMind categories. Same DB transaction as
      // the user insert — if any seed fails, the entire registration
      // (user, invite update, categories) rolls back.
      for (let i = 0; i < DEFAULT_CATEGORY_NAMES.length; i++) {
        await client.query(
          `INSERT INTO categories (user_id, name, display_order)
           VALUES ($1, $2, $3)`,
          [userId, DEFAULT_CATEGORY_NAMES[i], i + 1]
        );
      }

      // Seed user_settings (savings_rate_target_pct defaults to 20).
      await client.query(
        `INSERT INTO user_settings (user_id) VALUES ($1)`,
        [userId]
      );

      await client.query('COMMIT');

      // Fire verification email (non-blocking — registration succeeds even if Resend fails).
      try {
        const { issueVerification } = require('./email-verification');
        await issueVerification(userId, email);
      } catch (e) {
        console.error('[register] verification email failed:', e.message);
      }

      await logInAs(req, userId, { rememberMe: false });
      return res.redirect('/dashboard');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    return next(err);
  }
});

router.post('/logout', (req, res, next) => {
  req.session.destroy((err) => {
    if (err) return next(err);
    // clearCookie's options must mirror the cookie's set-time options or the
    // browser will leave the cookie in place. path is the one that bites in
    // practice; httpOnly/sameSite are not used to scope clearing.
    res.clearCookie('moneymind.sid', { path: '/' });
    res.redirect('/login');
  });
});

module.exports = router;

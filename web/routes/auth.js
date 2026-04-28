const express = require('express');
const bcrypt = require('bcrypt');
const { pool } = require('../db');
const { redirectIfAuthed } = require('../middleware/auth');
const { DEFAULT_CATEGORY_NAMES } = require('../lib/category-mapping');

const router = express.Router();

const BCRYPT_ROUNDS = 12;
const MIN_PASSWORD_LENGTH = 10;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// A precomputed hash of a throwaway value. Used so that failed-lookup logins
// spend the same time as real ones, defeating user-enumeration via timing.
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing-equalization', BCRYPT_ROUNDS);

function normalizeEmail(v) {
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}

function normalizeCode(v) {
  return typeof v === 'string' ? v.trim().toUpperCase() : '';
}

// Regenerate the session to prevent fixation, then set userId and save.
function logInAs(req, userId) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) return reject(err);
      req.session.userId = userId;
      req.session.save((err2) => (err2 ? reject(err2) : resolve()));
    });
  });
}

router.get('/login', redirectIfAuthed, (req, res) => {
  res.render('login', { error: null, email: '' });
});

router.post('/login', redirectIfAuthed, async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body.email);
    const password = typeof req.body.password === 'string' ? req.body.password : '';

    const generic = 'Invalid email or password.';
    const render = (error) => res.status(401).render('login', { error, email });

    if (!email || !password) return render(generic);

    const { rows } = await pool.query(
      'SELECT id, password_hash FROM users WHERE email = $1',
      [email]
    );
    const user = rows[0];

    // Always run a bcrypt compare — equal time whether the user exists or not.
    const hash = user ? user.password_hash : DUMMY_HASH;
    const ok = await bcrypt.compare(password, hash);

    if (!user || !ok) return render(generic);

    await logInAs(req, user.id);
    return res.redirect('/dashboard');
  } catch (err) {
    return next(err);
  }
});

router.get('/register', redirectIfAuthed, (req, res) => {
  res.render('register', { error: null, email: '', inviteCode: '' });
});

router.post('/register', redirectIfAuthed, async (req, res, next) => {
  const email = normalizeEmail(req.body.email);
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const inviteCode = normalizeCode(req.body.inviteCode);

  const render = (error, status = 400) =>
    res.status(status).render('register', { error, email, inviteCode });

  try {
    if (!EMAIL_RE.test(email)) return render('Please enter a valid email address.');
    if (password.length < MIN_PASSWORD_LENGTH) {
      return render(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    }
    if (!inviteCode) return render('Invite code is required.');

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
        `INSERT INTO users (email, password_hash, invite_code_used)
         VALUES ($1, $2, $3)
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

      await client.query('COMMIT');

      await logInAs(req, userId);
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

const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const { pool } = require('../db');
const { consumeInvite } = require('../lib/bootstrap');

const INVITE_ONLY = (process.env.INVITE_ONLY || 'true').toLowerCase() !== 'false';

// GET /auth/login
router.get('/login', (req, res) => {
  if (req.session && req.session.user) {
    return res.redirect('/dashboard');
  }
  res.render('login', { title: 'Sign In' });
});

// POST /auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    req.session.flash = { error: 'Email and password are required.' };
    return res.redirect('/auth/login');
  }

  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email.trim().toLowerCase()]);
    const user = result.rows[0];

    if (!user) {
      req.session.flash = { error: 'Invalid email or password.' };
      return res.redirect('/auth/login');
    }

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      req.session.flash = { error: 'Invalid email or password.' };
      return res.redirect('/auth/login');
    }

    req.session.user = { id: user.id, email: user.email, name: user.name, phone: user.phone, is_admin: !!user.is_admin };
    req.session.flash = { success: `Welcome back, ${user.name || user.email}!` };
    res.redirect('/dashboard');
  } catch (err) {
    console.error('Login error:', err);
    req.session.flash = { error: 'An unexpected error occurred. Please try again.' };
    res.redirect('/auth/login');
  }
});

// GET /auth/register?token=... — invite landing
router.get('/register', (req, res) => {
  if (req.session && req.session.user) return res.redirect('/dashboard');
  res.render('login', { title: 'Sign In', inviteToken: req.query.token || null });
});

// POST /auth/register
router.post('/register', async (req, res) => {
  const { name, email, password, phone, invite_token } = req.body;

  if (!email || !password) {
    req.session.flash = { error: 'Email and password are required.' };
    return res.redirect('/auth/login');
  }

  if (password.length < 8) {
    req.session.flash = { error: 'Password must be at least 8 characters.' };
    return res.redirect('/auth/login');
  }

  if (INVITE_ONLY) {
    if (!invite_token) {
      req.session.flash = { error: 'Registration requires an invite. Ask an admin to send you a link.' };
      return res.redirect('/auth/login');
    }
    const check = await pool.query('SELECT id, email, used_at, expires_at FROM invites WHERE token = $1', [invite_token]);
    const inv = check.rows[0];
    if (!inv) { req.session.flash = { error: 'Invite link is invalid.' }; return res.redirect('/auth/login'); }
    if (inv.used_at) { req.session.flash = { error: 'This invite has already been used.' }; return res.redirect('/auth/login'); }
    if (inv.expires_at && new Date(inv.expires_at) < new Date()) { req.session.flash = { error: 'This invite has expired.' }; return res.redirect('/auth/login'); }
    if (inv.email && inv.email.toLowerCase() !== email.trim().toLowerCase()) {
      req.session.flash = { error: 'This invite is reserved for a different email address.' };
      return res.redirect('/auth/login');
    }
  }

  try {
    const passwordHash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      'INSERT INTO users (email, password_hash, name, phone) VALUES ($1, $2, $3, $4) RETURNING id, email, name, phone',
      [email.trim().toLowerCase(), passwordHash, name ? name.trim() : null, phone ? phone.trim() : null]
    );
    const user = result.rows[0];

    if (INVITE_ONLY && invite_token) {
      await consumeInvite(invite_token, user.id);
    }

    req.session.user = { id: user.id, email: user.email, name: user.name, phone: user.phone };
    req.session.flash = { success: 'Account created! Welcome to MoneyMind.' };
    res.redirect('/dashboard');
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE constraint failed')) {
      req.session.flash = { error: 'An account with that email already exists.' };
    } else {
      console.error('Register error:', err);
      req.session.flash = { error: 'An unexpected error occurred. Please try again.' };
    }
    res.redirect('/auth/login');
  }
});

// GET /auth/logout
router.get('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error('Session destroy error:', err);
    }
    res.redirect('/auth/login');
  });
});

module.exports = router;

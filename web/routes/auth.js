const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const { pool } = require('../db');

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

    req.session.user = { id: user.id, email: user.email, name: user.name, phone: user.phone };
    req.session.flash = { success: `Welcome back, ${user.name || user.email}!` };
    res.redirect('/dashboard');
  } catch (err) {
    console.error('Login error:', err);
    req.session.flash = { error: 'An unexpected error occurred. Please try again.' };
    res.redirect('/auth/login');
  }
});

// POST /auth/register
router.post('/register', async (req, res) => {
  const { name, email, password, phone } = req.body;

  if (!email || !password) {
    req.session.flash = { error: 'Email and password are required.' };
    return res.redirect('/auth/login');
  }

  if (password.length < 8) {
    req.session.flash = { error: 'Password must be at least 8 characters.' };
    return res.redirect('/auth/login');
  }

  try {
    const passwordHash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      'INSERT INTO users (email, password_hash, name, phone) VALUES ($1, $2, $3, $4) RETURNING id, email, name, phone',
      [email.trim().toLowerCase(), passwordHash, name ? name.trim() : null, phone ? phone.trim() : null]
    );
    const user = result.rows[0];

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

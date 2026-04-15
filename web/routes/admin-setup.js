const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const { pool } = require('../db');

async function setupAvailable() {
  const res = await pool.query('SELECT COUNT(*) AS c FROM users WHERE is_admin = 1');
  return Number(res.rows[0].c) === 0;
}

function notFound(res) {
  res.status(404).send(`
    <!DOCTYPE html><html><head><title>404 — MoneyMind</title>
    <style>body{font-family:system-ui;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0;background:#F0F7F2;color:#111827}h1{font-size:4rem;margin:0;color:#2D6A4F}a{color:#2D6A4F;font-weight:600;text-decoration:none}</style>
    </head><body><h1>404</h1><p>Page not found.</p><a href="/">Go home</a></body></html>
  `);
}

// GET /admin-setup
router.get('/', async (req, res) => {
  if (!(await setupAvailable())) return notFound(res);
  res.render('admin-setup', { title: 'Create first admin', error: null });
});

// POST /admin-setup
router.post('/', async (req, res) => {
  if (!(await setupAvailable())) return notFound(res);

  const { email, password, confirm_password, name } = req.body;
  const render = (error) => res.status(400).render('admin-setup', { title: 'Create first admin', error });

  if (!email || !password) return render('Email and password are required.');
  if (password.length < 12) return render('Password must be at least 12 characters for the admin account.');
  if (password !== confirm_password) return render('Passwords do not match.');

  try {
    // Re-check inside the transaction to close the race window.
    if (!(await setupAvailable())) return notFound(res);

    const normalizedEmail = email.trim().toLowerCase();
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [normalizedEmail]);

    const passwordHash = await bcrypt.hash(password, 12);
    let userId;
    if (existing.rows[0]) {
      await pool.query(
        'UPDATE users SET password_hash = $1, is_admin = 1, name = COALESCE(name, $2) WHERE id = $3',
        [passwordHash, name || 'Admin', existing.rows[0].id]
      );
      userId = existing.rows[0].id;
    } else {
      const ins = await pool.query(
        'INSERT INTO users (email, password_hash, name, is_admin) VALUES ($1, $2, $3, 1) RETURNING id',
        [normalizedEmail, passwordHash, name ? name.trim() : 'Admin']
      );
      userId = ins.rows[0].id;
    }

    req.session.user = { id: userId, email: normalizedEmail, name: name || 'Admin', is_admin: true };
    req.session.flash = { success: 'Admin account created. /admin-setup is now disabled.' };
    res.redirect('/admin');
  } catch (err) {
    console.error('admin-setup error:', err);
    render('Failed to create admin. Check server logs.');
  }
});

module.exports = router;

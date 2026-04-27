const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { pool } = require('../db');

async function bootstrap() {
  // 1. Count users; if none, seed the admin.
  const countRes = await pool.query('SELECT COUNT(*) AS c FROM users');
  const userCount = Number(countRes.rows[0].c);

  if (userCount === 0) {
    const email = (process.env.ADMIN_EMAIL || 'admin@moneymind.local').trim().toLowerCase();
    const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(12).toString('base64url');
    const generated = !process.env.ADMIN_PASSWORD;

    const hash = await bcrypt.hash(password, 12);
    const ins = await pool.query(
      'INSERT INTO users (email, password_hash, name, is_admin) VALUES ($1, $2, $3, $4) RETURNING id',
      [email, hash, 'Admin', 1]
    );
    console.log('============================================================');
    console.log('[bootstrap] First run — seeded admin user.');
    console.log(`[bootstrap]   email:    ${email}`);
    if (generated) {
      console.log(`[bootstrap]   password: ${password}   (generated — save it now, it will not be shown again)`);
    } else {
      console.log('[bootstrap]   password: (from ADMIN_PASSWORD env)');
    }
    console.log(`[bootstrap]   user_id:  ${ins.rows[0].id}`);
    console.log('[bootstrap] Sign in, then visit /admin to mint invite links.');
    console.log('============================================================');
  } else {
    // Guarantee at least one admin exists; promote user id 1 if none flagged.
    const adminRes = await pool.query('SELECT COUNT(*) AS c FROM users WHERE is_admin = 1');
    if (Number(adminRes.rows[0].c) === 0) {
      await pool.query('UPDATE users SET is_admin = 1 WHERE id = (SELECT MIN(id) FROM users)');
      console.log('[bootstrap] No admin found — promoted lowest-id user to admin.');
    }
  }
}

function generateInviteToken() {
  return crypto.randomBytes(24).toString('base64url');
}

async function createInvite({ createdBy, email = null, ttlHours = 168 }) {
  const token = generateInviteToken();
  const expires = new Date(Date.now() + ttlHours * 3600 * 1000).toISOString();
  await pool.query(
    'INSERT INTO invites (token, email, created_by, expires_at) VALUES ($1, $2, $3, $4)',
    [token, email, createdBy, expires]
  );
  return { token, expires_at: expires };
}

async function consumeInvite(token, newUserId) {
  if (!token) return { ok: false, reason: 'missing_token' };
  const rows = (await pool.query(
    'SELECT id, email, used_at, expires_at FROM invites WHERE token = $1',
    [token]
  )).rows;
  if (rows.length === 0) return { ok: false, reason: 'invalid' };
  const inv = rows[0];
  if (inv.used_at) return { ok: false, reason: 'already_used' };
  if (inv.expires_at && new Date(inv.expires_at) < new Date()) return { ok: false, reason: 'expired' };

  await pool.query(
    'UPDATE invites SET used_at = datetime(\'now\'), used_by = $1 WHERE id = $2',
    [newUserId, inv.id]
  );
  return { ok: true, invite: inv };
}

module.exports = { bootstrap, createInvite, consumeInvite, generateInviteToken };

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { pool } = require('../db');
const { createInvite } = require('../lib/bootstrap');

function requireAdmin(req, res, next) {
  if (!req.session?.user?.is_admin) {
    req.session.flash = { error: 'Admin access required.' };
    return res.redirect('/dashboard');
  }
  next();
}

// GET /admin — invites dashboard
router.get('/', requireAuth, requireAdmin, async (req, res) => {
  const invites = (await pool.query(
    `SELECT id, token, email, used_at, expires_at, created_at FROM invites ORDER BY created_at DESC LIMIT 50`
  )).rows;
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  res.render('admin', {
    title: 'Admin — Invites',
    page: 'admin',
    invites: invites.map(i => ({
      ...i,
      url:     `${baseUrl}/auth/register?token=${i.token}`,
      status:  i.used_at ? 'used' : (i.expires_at && new Date(i.expires_at) < new Date() ? 'expired' : 'active'),
    })),
  });
});

// POST /admin/invites — create an invite
router.post('/invites', requireAuth, requireAdmin, async (req, res) => {
  const { email, ttl_hours } = req.body;
  const inv = await createInvite({
    createdBy: req.session.user.id,
    email:     email ? email.trim().toLowerCase() : null,
    ttlHours:  Number(ttl_hours) || 168,
  });
  const url = `${req.protocol}://${req.get('host')}/auth/register?token=${inv.token}`;
  res.json({ success: true, token: inv.token, url, expires_at: inv.expires_at });
});

// POST /admin/invites/:id/revoke
router.post('/invites/:id/revoke', requireAuth, requireAdmin, async (req, res) => {
  await pool.query('UPDATE invites SET expires_at = datetime(\'now\') WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

module.exports = router;

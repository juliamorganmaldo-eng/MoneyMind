// Account-deletion routes:
//   • POST /account/delete   — auth required; soft-deletes the user.
//   • GET  /account/deleted  — public; thank-you confirmation page.
//
// Soft-delete contract:
//   1. Verify password via bcrypt.compare. Wrong → 401.
//   2. Verify confirmation field === 'DELETE' (case-sensitive). Wrong → 400.
//   3. DB TX1 (small + fast): UPDATE users SET is_deleted=TRUE,
//      deleted_at=NOW(); INSERT INTO deletion_log(email, deleted_at);
//      SELECT plaid_items rows for cleanup. COMMIT.
//   4. OUTSIDE any TX: call plaid.itemRemove for each access token,
//      best-effort (network call inside TX would hold locks needlessly,
//      and Plaid being down must not block account deletion).
//   5. DB TX2: DELETE FROM plaid_items WHERE user_id=$1, regardless
//      of Plaid's response in step 4 — we don't keep encrypted access
//      tokens locally beyond this point.
//   6. Send confirmation email (best-effort; Resend down ≠ block).
//   7. req.session.destroy + clearCookie + redirect /account/deleted.
//
// After this returns, the user can no longer log in (login filters
// is_deleted=FALSE) and forgot-password also treats them as not-found.
// The hard-delete cron will purge the row + cascade after 30 days.

const express = require('express');
const bcrypt = require('bcrypt');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { itemRemove } = require('../lib/plaid');
const { decrypt } = require('../lib/crypto');
const { sendEmail } = require('../lib/email/client');
const accountDeletedTemplate = require('./../lib/email/templates/account-deleted');

const router = express.Router();
router.use(express.urlencoded({ extended: false, limit: '32kb' }));

router.post('/account/delete', requireAuth, async (req, res, next) => {
  const userId = req.session.userId;
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const confirmation = typeof req.body.confirmation === 'string' ? req.body.confirmation : '';

  // Step 1 — confirmation phrase must be EXACTLY "DELETE" (case-sensitive
  // per spec). Reject before touching the password hash so a user who
  // mistyped doesn't pay bcrypt's CPU cost for nothing.
  if (confirmation !== 'DELETE') {
    return res.status(400).json({
      error: 'invalid_confirmation',
      message: 'Type DELETE to confirm.',
    });
  }

  try {
    // Step 2 — pull the password hash + email; verify via bcrypt.
    // Filter is_deleted=FALSE so a re-entrant request (e.g. user
    // double-clicked Delete in two tabs) doesn't try to re-soft-delete.
    const { rows: userRows } = await pool.query(
      'SELECT id, email, password_hash FROM users WHERE id = $1 AND is_deleted = FALSE',
      [userId]
    );
    const user = userRows[0];
    if (!user) {
      // No user, or already soft-deleted — destroy session and bounce
      // to the deleted page (idempotent UX).
      return req.session.destroy(() => {
        res.clearCookie('moneymind.sid', { path: '/' });
        res.redirect('/account/deleted');
      });
    }

    const passwordOk = await bcrypt.compare(password, user.password_hash);
    if (!passwordOk) {
      return res.status(401).json({
        error: 'invalid_password',
        message: 'Password is incorrect.',
      });
    }

    // Step 3 — TX1: flip is_deleted, log, snapshot plaid_items.
    const client = await pool.connect();
    let plaidItems;
    let deletedAtIso;
    try {
      await client.query('BEGIN');

      const { rows: updated } = await client.query(
        `UPDATE users
            SET is_deleted = TRUE,
                deleted_at = NOW(),
                updated_at = NOW()
          WHERE id = $1 AND is_deleted = FALSE
          RETURNING deleted_at`,
        [user.id]
      );
      if (updated.length === 0) {
        // Lost a race with a concurrent delete request. Treat as success.
        await client.query('ROLLBACK');
        return req.session.destroy(() => {
          res.clearCookie('moneymind.sid', { path: '/' });
          res.redirect('/account/deleted');
        });
      }
      deletedAtIso = new Date(updated[0].deleted_at).toISOString();

      await client.query(
        `INSERT INTO deletion_log (email, deleted_at, reason)
         VALUES ($1, $2, $3)`,
        [user.email, updated[0].deleted_at, 'user_initiated']
      );

      const { rows: items } = await client.query(
        'SELECT id, access_token_encrypted FROM plaid_items WHERE user_id = $1',
        [user.id]
      );
      plaidItems = items;

      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
      throw e; // surface to Express error handler
    } finally {
      client.release();
    }

    // Step 4 — call Plaid /item/remove for each item, OUTSIDE any TX.
    // Best-effort. We log failures but never block.
    for (const item of plaidItems) {
      try {
        const result = await itemRemove(item.access_token_encrypted, decrypt);
        if (!result.ok) {
          console.error('[account-delete] itemRemove failed for plaid_item', item.id, '— error:', result.error);
        }
      } catch (e) {
        console.error('[account-delete] itemRemove threw for plaid_item', item.id, ':', e.message);
      }
    }

    // Step 5 — TX2: drop the local plaid_items rows (and their encrypted
    // access tokens) regardless of how Plaid responded. We don't want
    // to keep encrypted access tokens for an account the user just
    // deleted; even if /item/remove failed at Plaid, our local row
    // becomes orphaned and useless.
    try {
      await pool.query('DELETE FROM plaid_items WHERE user_id = $1', [user.id]);
    } catch (e) {
      console.error('[account-delete] plaid_items DELETE failed:', e.message);
      // Don't bail — user is already soft-deleted; cron will eventually
      // hard-delete the user, which cascades to plaid_items.
    }

    // Step 6 — confirmation email. Best-effort.
    try {
      const tpl = accountDeletedTemplate.build({
        user_email: user.email,
        deleted_at_iso: deletedAtIso,
      });
      await sendEmail({ to: user.email, subject: tpl.subject, html: tpl.html, text: tpl.text });
    } catch (e) {
      console.error('[account-delete] confirmation email failed:', e.message);
    }

    // Step 7 — destroy session, clear cookie, redirect.
    return req.session.destroy((err) => {
      if (err) return next(err);
      res.clearCookie('moneymind.sid', { path: '/' });
      return res.redirect('/account/deleted');
    });
  } catch (err) {
    return next(err);
  }
});

router.get('/account/deleted', (req, res) => {
  res.render('account-deleted', { authed: false });
});

module.exports = router;

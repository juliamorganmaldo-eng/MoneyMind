#!/usr/bin/env node
// Scheduled hard-delete job — finishes what soft-delete started 30 days
// after the user pressed the button.
//
// What it does:
//   1. SELECT users WHERE is_deleted = TRUE AND deleted_at < NOW() - 30 days.
//   2. For each, DELETE FROM users WHERE id = $id. The FK CASCADE on
//      every user-scoped table (transactions, accounts, plaid_items,
//      categories, budget_limits, low_balance_thresholds, recurring_*,
//      balance_snapshots, user_settings, findings, password_reset_tokens,
//      email_verification_tokens, security_alerts_sent) wipes everything
//      that user owned.
//   3. The deletion_log row stays — no FK to users(id) by design.
//   4. invite_codes.used_by_user_id flips back to NULL via ON DELETE
//      SET NULL, BUT the registration handler also checks `used_at` so
//      the invite remains permanently consumed (see routes/auth.js).
//
// Idempotency: running this twice in a row is a no-op the second time.
// Run frequency: daily is fine (intentionally generous — a user who
// changes their mind on day 29 still has a window).
//
// Schedule (Railway / production): see SECURITY.md. Not yet wired up
// — invoke manually as `node scripts/hard-delete-soft-deleted.js` and
// review the output.

'use strict';

require('dotenv').config();
const { pool } = require('../db');

const RETENTION_DAYS = 30;

// Exposed as a function so tests can call it directly without spawning
// a subprocess. Returns { previewed, deleted } with row counts.
async function runOnce({ dryRun = false } = {}) {
  // Step 1 — preview which rows will be affected. Logged as a structured
  // line per user so a follow-up audit can confirm what cron deleted.
  const { rows: targets } = await pool.query(
    `SELECT id, email, deleted_at
       FROM users
      WHERE is_deleted = TRUE
        AND deleted_at < NOW() - ($1::int || ' days')::interval
      ORDER BY deleted_at ASC`,
    [RETENTION_DAYS]
  );

  if (targets.length === 0) {
    return { previewed: 0, deleted: 0, ids: [] };
  }

  for (const u of targets) {
    console.log(`[hard-delete] candidate user_id=${u.id} email=${u.email} deleted_at=${u.deleted_at.toISOString()}`);
  }

  if (dryRun) {
    return { previewed: targets.length, deleted: 0, ids: targets.map((t) => t.id) };
  }

  // Step 2 — delete. We use a single DELETE WHERE id = ANY(...) so
  // it's one round-trip and the FK cascade fires per row. Returning
  // the id list confirms the count to the caller.
  const ids = targets.map((t) => t.id);
  const { rows: deleted } = await pool.query(
    `DELETE FROM users
      WHERE id = ANY($1::int[])
        AND is_deleted = TRUE
        AND deleted_at < NOW() - ($2::int || ' days')::interval
     RETURNING id`,
    [ids, RETENTION_DAYS]
  );

  return { previewed: targets.length, deleted: deleted.length, ids: deleted.map((r) => r.id) };
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const dryRun = args.has('--dry-run');

  console.log(`[hard-delete] starting (retention=${RETENTION_DAYS} days, dryRun=${dryRun})`);
  try {
    const result = await runOnce({ dryRun });
    if (dryRun) {
      console.log(`[hard-delete] dry run — ${result.previewed} candidate(s); no deletions performed.`);
    } else {
      console.log(`[hard-delete] previewed=${result.previewed}, deleted=${result.deleted}`);
      // Surface ID drift between preview and delete (would indicate a
      // race with another runner — shouldn't happen with daily cron).
      if (result.previewed !== result.deleted) {
        console.warn(`[hard-delete] WARNING: count mismatch — concurrent run?`);
      }
    }
  } catch (e) {
    console.error('[hard-delete] FAILED:', e.stack || e.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main();
}

module.exports = { runOnce, RETENTION_DAYS };

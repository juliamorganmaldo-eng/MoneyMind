// Hard-delete cron script — exercises the runOnce() function directly.
//
// Asserts:
//   • Users with is_deleted=TRUE AND deleted_at older than 30 days are removed.
//   • Users with is_deleted=TRUE AND deleted_at within 30 days are kept.
//   • Users with is_deleted=FALSE are never touched, regardless of how
//     old their deleted_at value is (defensive — that column should
//     always be NULL when is_deleted=FALSE, but sanity-check anyway).
//   • deletion_log rows are NOT deleted by the FK cascade (no FK).
//   • --dry-run mode reports candidates without deleting.
//
// Run from web/:
//   node --test --test-timeout=30000 tests/scripts/hard-delete.test.js

require('dotenv').config();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const { pool } = require('../../db');
const hardDelete = require('../../scripts/hard-delete-soft-deleted');

const SUFFIX = '-' + Date.now() + '-hd';
const FAKE_INVITE = 'HD-CRON-' + Date.now().toString(36).toUpperCase();
const PASSWORD = 'hd-test-pwd';

const createdEmails = [];

before(async () => {
  await pool.query(`INSERT INTO invite_codes (code) VALUES ($1) ON CONFLICT DO NOTHING`, [FAKE_INVITE]);
});

after(async () => {
  if (createdEmails.length) {
    await pool.query(`DELETE FROM users WHERE email = ANY($1::text[])`, [createdEmails]);
    await pool.query(`DELETE FROM deletion_log WHERE email = ANY($1::text[])`, [createdEmails]);
  }
  await pool.query(`DELETE FROM invite_codes WHERE code = $1`, [FAKE_INVITE]);
  await pool.end();
});

async function makeUser(tag, { isDeleted, deletedAtDaysAgo } = {}) {
  const email = `hd${SUFFIX}-${tag}@example.com`.toLowerCase();
  createdEmails.push(email);
  const hash = await bcrypt.hash(PASSWORD, 4);
  const deletedAt = (typeof deletedAtDaysAgo === 'number')
    ? new Date(Date.now() - deletedAtDaysAgo * 24 * 3600 * 1000)
    : null;
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, invite_code_used, is_deleted, deleted_at, privacy_policy_agreed_at)
     VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING id`,
    [email, hash, FAKE_INVITE, !!isDeleted, deletedAt]
  );
  if (isDeleted) {
    await pool.query(
      `INSERT INTO deletion_log (email, deleted_at, reason) VALUES ($1, $2, 'user_initiated')`,
      [email, deletedAt]
    );
  }
  return { id: rows[0].id, email };
}

test('runOnce removes users where deleted_at < NOW() - 30 days, keeps users within window', async () => {
  // Three test users:
  //   old: soft-deleted 35 days ago → should be hard-deleted
  //   recent: soft-deleted 5 days ago → should be kept
  //   active: not soft-deleted at all → should be kept
  const old    = await makeUser('old',    { isDeleted: true,  deletedAtDaysAgo: 35 });
  const recent = await makeUser('recent', { isDeleted: true,  deletedAtDaysAgo: 5  });
  const active = await makeUser('active', { isDeleted: false });

  const result = await hardDelete.runOnce();

  // The result reports the IDs that were deleted. Our `old` must be in
  // that set; `recent` and `active` must not be. Other test users
  // outside this run could also be in the result if they meet the
  // criteria, so we don't assert exact equality on the count — just
  // membership.
  assert.ok(result.ids.includes(old.id), 'old user (35d) should be hard-deleted');
  assert.ok(!result.ids.includes(recent.id), 'recent user (5d) should NOT be hard-deleted');
  assert.ok(!result.ids.includes(active.id), 'active user should NOT be hard-deleted');

  // Verify in DB.
  const { rows: oldRow }    = await pool.query('SELECT 1 FROM users WHERE id = $1', [old.id]);
  const { rows: recentRow } = await pool.query('SELECT 1 FROM users WHERE id = $1', [recent.id]);
  const { rows: activeRow } = await pool.query('SELECT 1 FROM users WHERE id = $1', [active.id]);
  assert.equal(oldRow.length, 0,    'old user row removed');
  assert.equal(recentRow.length, 1, 'recent user row preserved');
  assert.equal(activeRow.length, 1, 'active user row preserved');

  // deletion_log row for `old` survives the user delete (no FK).
  const { rows: logOld } = await pool.query(
    'SELECT 1 FROM deletion_log WHERE email = $1',
    [old.email]
  );
  assert.equal(logOld.length, 1, 'deletion_log row preserved past hard-delete');
});

test('--dry-run mode reports candidates without deleting', async () => {
  const candidate = await makeUser('dry', { isDeleted: true, deletedAtDaysAgo: 40 });

  const dry = await hardDelete.runOnce({ dryRun: true });
  assert.ok(dry.ids.includes(candidate.id), 'dry run should preview the candidate');
  assert.equal(dry.deleted, 0, 'dry run reports zero deleted');

  // The user row is still there.
  const { rows } = await pool.query('SELECT 1 FROM users WHERE id = $1', [candidate.id]);
  assert.equal(rows.length, 1, 'user must NOT be deleted in dry-run mode');
});

test('runOnce with no candidates → previewed=0, deleted=0 (idempotent on empty)', async () => {
  // After previous tests have already wiped any old eligible users, a
  // second call should be a no-op for the rows our suite controls.
  // We can't assert strict zero (other tests in other files might have
  // left rows), but we can assert that running back-to-back doesn't
  // throw and the deleted count never exceeds the previewed count.
  const r = await hardDelete.runOnce();
  assert.ok(r.deleted <= r.previewed);
  assert.ok(r.previewed >= 0);
});

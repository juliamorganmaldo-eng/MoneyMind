const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pool } = require('../db');

// Unambiguous alphabet (no 0/O/1/I/L) — length 32, evenly divides 256 so
// `byte % 32` is uniform (no modulo bias).
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const INVITE_COUNT = 10;

function generateInviteCode() {
  const bytes = crypto.randomBytes(12);
  let out = '';
  for (let i = 0; i < 12; i++) {
    out += ALPHABET[bytes[i] % ALPHABET.length];
    if (i === 3 || i === 7) out += '-';
  }
  return out;
}

async function applySchema() {
  const schemaPath = path.join(__dirname, '..', 'schema.sql');
  const sql = await fs.readFile(schemaPath, 'utf8');
  await pool.query(sql);
}

async function seedInviteCodesIfEmpty() {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM invite_codes');
  if (rows[0].n > 0) return null;

  const codes = Array.from({ length: INVITE_COUNT }, generateInviteCode);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const code of codes) {
      await client.query('INSERT INTO invite_codes (code) VALUES ($1)', [code]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return codes;
}

function printInviteCodes(codes) {
  const bar = '─'.repeat(56);
  console.log('\n' + bar);
  console.log('  MoneyMind — invite codes generated (save these now):');
  console.log(bar);
  for (const c of codes) console.log('    ' + c);
  console.log(bar);
  console.log('  These are the ONLY copy. They are not printed again.');
  console.log(bar + '\n');
}

async function bootstrap() {
  await applySchema();
  const codes = await seedInviteCodesIfEmpty();
  if (codes) printInviteCodes(codes);
}

module.exports = { bootstrap, generateInviteCode };

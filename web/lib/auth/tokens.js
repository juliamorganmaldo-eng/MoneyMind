// Token primitives for password reset + email verification.
//
// Lifecycle:
//   1. generate() returns a 32-byte random base64url plaintext token.
//      The plaintext is sent ONLY in the outgoing email URL — the
//      server never logs it and never stores it.
//   2. hash(plaintext) returns SHA-256 of the plaintext (hex). This is
//      what gets persisted to the *_tokens.token_hash column.
//   3. On callback (URL click), the server hashes the URL token and
//      looks it up by hash. Plaintext-vs-hash comparison via constant
//      time is unnecessary because the hash itself is the lookup key.

const crypto = require('node:crypto');

function generate() {
  // 32 bytes → 43 base64url chars (no padding). URL-safe, no escaping.
  return crypto.randomBytes(32).toString('base64url');
}

function hash(plaintext) {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new TypeError('hash() requires a non-empty string');
  }
  return crypto.createHash('sha256').update(plaintext, 'utf8').digest('hex');
}

module.exports = { generate, hash };

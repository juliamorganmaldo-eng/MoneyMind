// Pure-function tests for the token generator + hasher.
// No DB, no env vars required.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { generate, hash } = require('../../lib/auth/tokens');

test('generate() produces a 43-char base64url string (32 random bytes)', () => {
  const t = generate();
  assert.equal(typeof t, 'string');
  assert.equal(t.length, 43);
  // base64url alphabet: A-Z a-z 0-9 - _
  assert.match(t, /^[A-Za-z0-9_-]{43}$/);
});

test('generate() is non-deterministic — every call differs', () => {
  const seen = new Set();
  for (let i = 0; i < 100; i++) seen.add(generate());
  assert.equal(seen.size, 100);
});

test('hash() returns a 64-char hex string (SHA-256)', () => {
  const h = hash('hello');
  assert.equal(typeof h, 'string');
  assert.equal(h.length, 64);
  assert.match(h, /^[0-9a-f]{64}$/);
});

test('hash() is deterministic — same input → same hash', () => {
  const h1 = hash('the-same-token');
  const h2 = hash('the-same-token');
  assert.equal(h1, h2);
});

test('hash() throws on empty/non-string input', () => {
  assert.throws(() => hash(''));
  assert.throws(() => hash(null));
  assert.throws(() => hash(123));
});

test('different tokens produce different hashes', () => {
  const t1 = generate();
  const t2 = generate();
  assert.notEqual(hash(t1), hash(t2));
});

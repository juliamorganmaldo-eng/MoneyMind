// Run with:  node --test test/crypto.test.js   (from web/)
//
// Sets a throwaway ENCRYPTION_KEY *before* requiring the module, so the
// test is hermetic and never touches the real .env value.

process.env.ENCRYPTION_KEY = require('node:crypto').randomBytes(32).toString('base64');

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { encrypt, decrypt, assertEncryptionKey } = require('../lib/crypto');

test('round-trip: decrypt(encrypt(x)) === x', () => {
  const original = 'access-sandbox-7f3c1c2a-9d8e-4f0c-9b2a-1234567890ab';
  const enc = encrypt(original);
  assert.notEqual(enc, original, 'ciphertext should differ from plaintext');
  assert.equal(decrypt(enc), original);
});

test('encrypting same plaintext twice yields different ciphertexts (random IV)', () => {
  const a = encrypt('hello');
  const b = encrypt('hello');
  assert.notEqual(a, b);
  assert.equal(decrypt(a), 'hello');
  assert.equal(decrypt(b), 'hello');
});

test('tampered ciphertext is rejected by GCM auth tag', () => {
  const enc = encrypt('sensitive');
  // Flip the last byte of the base64 payload — corrupts the ciphertext.
  const tamperedBuf = Buffer.from(enc, 'base64');
  tamperedBuf[tamperedBuf.length - 1] ^= 0x01;
  const tampered = tamperedBuf.toString('base64');
  assert.throws(() => decrypt(tampered), /unsupported state|unable to authenticate|bad decrypt/i);
});

test('truncated ciphertext is rejected (shorter than iv+tag)', () => {
  assert.throws(() => decrypt('AAAA'), /too short/);
});

test('handles empty string', () => {
  const enc = encrypt('');
  assert.equal(decrypt(enc), '');
});

test('handles long unicode', () => {
  const original = '🔐 ' + 'ünïcödé '.repeat(500);
  assert.equal(decrypt(encrypt(original)), original);
});

test('assertEncryptionKey() succeeds with a valid key', () => {
  assert.doesNotThrow(assertEncryptionKey);
});

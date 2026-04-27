// AES-256-GCM envelope for at-rest secrets (Plaid access tokens).
//
// Ciphertext layout (base64-encoded):
//   [ iv (12 bytes) | auth tag (16 bytes) | ciphertext (variable) ]
//
// IV is random per call. Authenticity is enforced by GCM's tag — any
// tampering causes decrypt() to throw.

const nodeCrypto = require('node:crypto');

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 12;  // 96 bits — GCM standard
const TAG_LENGTH = 16; // 128 bits

let cachedKey = null;

function loadKey() {
  const b64 = process.env.ENCRYPTION_KEY;
  if (!b64) {
    throw new Error('ENCRYPTION_KEY env var is required');
  }
  const buf = Buffer.from(b64, 'base64');
  if (buf.length < KEY_LENGTH) {
    throw new Error(
      `ENCRYPTION_KEY must decode to at least ${KEY_LENGTH} bytes (got ${buf.length}). ` +
      `Generate with:  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
    );
  }
  return buf.subarray(0, KEY_LENGTH);
}

function getKey() {
  if (!cachedKey) cachedKey = loadKey();
  return cachedKey;
}

function encrypt(plaintext) {
  if (typeof plaintext !== 'string') {
    throw new TypeError('encrypt() requires a string');
  }
  const iv = nodeCrypto.randomBytes(IV_LENGTH);
  const cipher = nodeCrypto.createCipheriv(ALGORITHM, getKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

function decrypt(ciphertextB64) {
  if (typeof ciphertextB64 !== 'string') {
    throw new TypeError('decrypt() requires a base64 string');
  }
  const buf = Buffer.from(ciphertextB64, 'base64');
  if (buf.length < IV_LENGTH + TAG_LENGTH) {
    throw new Error('ciphertext too short to contain iv + tag');
  }
  const iv = buf.subarray(0, IV_LENGTH);
  const tag = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ct = buf.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = nodeCrypto.createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

// Force-validate the key at startup so we fail fast, not on first encrypt().
function assertEncryptionKey() {
  getKey();
}

module.exports = { encrypt, decrypt, assertEncryptionKey };

// Resend client wrapper. Provides a single sendEmail({to,subject,html,text})
// entry point used by every templated email in the app.
//
// ── PII discipline ──────────────────────────────────────────────────────
// We never log:
//   • the recipient's email address (use a SHA-256 prefix instead)
//   • the subject (could contain a user's name or one-time code)
//   • the body, html or text (always)
// On error we log: timestamp, redacted-recipient, success/failure flag,
// and the upstream error code/message — nothing more.
//
// ── Placeholder mode ────────────────────────────────────────────────────
// When RESEND_API_KEY is the dev placeholder (or empty), sends become
// no-ops with a one-time warning. This lets local dev work without a key,
// which lines up with the same Plaid pattern in lib/plaid.js.

const crypto = require('node:crypto');
const { Resend } = require('resend');

const API_KEY = process.env.RESEND_API_KEY || '';
const EMAIL_FROM = process.env.EMAIL_FROM || 'onboarding@resend.dev';

function isPlaceholder(key) {
  return /placeholder/i.test(key) || key === 'replace-me' || key === '';
}

const PLACEHOLDER_MODE = isPlaceholder(API_KEY);

if (PLACEHOLDER_MODE) {
  console.warn('[email] RESEND_API_KEY is a placeholder — emails will be no-op + logged.');
}

let resendClient = null;
function getClient() {
  if (PLACEHOLDER_MODE) return null;
  if (!resendClient) resendClient = new Resend(API_KEY);
  return resendClient;
}

// Short, stable redaction so the same recipient always appears as the
// same token in logs (helpful for tracing) without exposing the address.
function redactRecipient(to) {
  return 'rcpt:' + crypto.createHash('sha256').update(String(to)).digest('hex').slice(0, 12);
}

// Returns { ok: bool, id?: string, error?: string }
async function sendEmail({ to, subject, html, text }) {
  if (!to || !subject || !html || !text) {
    throw new TypeError('sendEmail requires to, subject, html, text');
  }
  const redacted = redactRecipient(to);

  if (PLACEHOLDER_MODE) {
    console.log('[email] no-op (placeholder mode):', redacted);
    return { ok: true, id: 'placeholder', placeholder: true };
  }

  try {
    const client = getClient();
    const r = await client.emails.send({
      from: EMAIL_FROM,
      to: [to],
      subject,
      html,
      text,
    });
    if (r.error) {
      console.error('[email] send failed:', redacted, r.error.message || r.error.name || 'unknown');
      return { ok: false, error: r.error.message || 'send failed' };
    }
    console.log('[email] sent:', redacted, 'id=' + (r.data && r.data.id));
    return { ok: true, id: r.data && r.data.id };
  } catch (err) {
    // Resend's SDK occasionally throws (network, etc.). Same redaction rule.
    console.error('[email] send threw:', redacted, err.message || 'unknown');
    return { ok: false, error: err.message || 'send threw' };
  }
}

function emailConfigured() {
  return !PLACEHOLDER_MODE;
}

module.exports = { sendEmail, emailConfigured, redactRecipient };

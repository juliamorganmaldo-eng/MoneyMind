// Plaid client singleton. Sandbox by default; the secret env var is
// resolved per environment so swapping PLAID_ENV picks the right key.

const { Configuration, PlaidApi, PlaidEnvironments } = require('plaid');

const ENV = (process.env.PLAID_ENV || 'sandbox').toLowerCase();
const SECRET_ENV_VAR = {
  sandbox: 'PLAID_SECRET_SANDBOX',
  development: 'PLAID_SECRET_DEVELOPMENT',
  production: 'PLAID_SECRET_PRODUCTION',
}[ENV];

if (!SECRET_ENV_VAR) {
  throw new Error(`Unsupported PLAID_ENV: ${ENV}`);
}
if (!PlaidEnvironments[ENV]) {
  throw new Error(`Plaid SDK does not recognize PLAID_ENV=${ENV}`);
}

const clientId = process.env.PLAID_CLIENT_ID;
const secret = process.env[SECRET_ENV_VAR];

if (!clientId || !secret || /PLACEHOLDER/i.test(clientId) || /PLACEHOLDER/i.test(secret)) {
  // Soft-warn rather than refuse to boot — the rest of the app (login,
  // dashboard chrome) still works, and Link endpoints will return a 503.
  console.warn(
    `[plaid] PLAID_CLIENT_ID and/or ${SECRET_ENV_VAR} are placeholders. ` +
    `Link endpoints will fail until real credentials are provided.`
  );
}

const cfg = new Configuration({
  basePath: PlaidEnvironments[ENV],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': clientId || '',
      'PLAID-SECRET': secret || '',
      'Plaid-Version': '2020-09-14',
    },
  },
});

const plaidClient = new PlaidApi(cfg);

function plaidConfigured() {
  return Boolean(clientId && secret) &&
    !/PLACEHOLDER/i.test(clientId) &&
    !/PLACEHOLDER/i.test(secret);
}

// Calls Plaid's /item/remove for one item. Used during account deletion
// so MoneyMind stops being able to pull transactions from that bank.
//
// • Takes the ENCRYPTED token + the decrypt fn (injected so tests can
//   stub it without spinning up a Plaid mock and without us having to
//   require lib/crypto.js here, which would create a circular concern).
// • The plaintext access_token only lives in the local `accessToken`
//   variable for the duration of the network call, then is set to null.
//   We do not log it, and Plaid's SDK does not return it in errors.
// • Best-effort by design: a network failure or Plaid 4xx returns
//   {ok: false, error: '...'} so the caller can log + continue. Account
//   deletion must NOT be blocked by Plaid being unavailable.
async function itemRemove(encryptedToken, decryptFn) {
  if (!plaidConfigured()) {
    return { ok: false, error: 'plaid_not_configured' };
  }
  let accessToken;
  try {
    accessToken = decryptFn(encryptedToken);
  } catch (e) {
    return { ok: false, error: 'decrypt_failed' };
  }
  try {
    await plaidClient.itemRemove({ access_token: accessToken });
    accessToken = null;
    return { ok: true };
  } catch (err) {
    accessToken = null;
    const data = err && err.response && err.response.data;
    return {
      ok: false,
      error: (data && (data.error_code || data.error_type)) || (err && err.message) || 'unknown',
    };
  }
}

module.exports = { plaidClient, plaidConfigured, itemRemove, PLAID_ENV: ENV };

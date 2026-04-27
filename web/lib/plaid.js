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

module.exports = { plaidClient, plaidConfigured, PLAID_ENV: ENV };

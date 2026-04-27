const express = require('express');
const { CountryCode, Products } = require('plaid');
const { plaidClient, plaidConfigured } = require('../lib/plaid');
const { encrypt } = require('../lib/crypto');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// JSON parser scoped to this router so the EJS form posts elsewhere are unaffected.
router.use(express.json({ limit: '32kb' }));

// Every Plaid endpoint requires an authenticated session. If this is ever
// removed, exchange-public-token would let anonymous callers stash tokens.
router.use(requireAuth);

// Strip Plaid SDK error objects of any field that could carry an access token.
// We only forward error_type / error_code / display_message to logs.
function safePlaidError(err) {
  const out = { msg: err && err.message ? err.message : String(err) };
  const data = err && err.response && err.response.data;
  if (data) {
    if (data.error_code) out.error_code = data.error_code;
    if (data.error_type) out.error_type = data.error_type;
    if (data.display_message) out.display_message = data.display_message;
  }
  return out;
}

function ensureConfigured(res) {
  if (plaidConfigured()) return true;
  res.status(503).json({ error: 'Plaid is not configured on the server.' });
  return false;
}

router.post('/api/plaid/create-link-token', async (req, res) => {
  if (!ensureConfigured(res)) return;
  const userId = req.session.userId;
  try {
    const r = await plaidClient.linkTokenCreate({
      user: { client_user_id: String(userId) },
      client_name: 'MoneyMind',
      products: [Products.Transactions],
      country_codes: [CountryCode.Us],
      language: 'en',
    });
    res.json({ link_token: r.data.link_token, expiration: r.data.expiration });
  } catch (err) {
    console.error('[plaid] create-link-token failed:', safePlaidError(err));
    res.status(502).json({ error: 'Could not create Plaid Link token.' });
  }
});

router.post('/api/plaid/exchange-public-token', async (req, res) => {
  if (!ensureConfigured(res)) return;
  const userId = req.session.userId;

  const publicToken = req.body && req.body.public_token;
  if (typeof publicToken !== 'string' || !publicToken.startsWith('public-')) {
    return res.status(400).json({ error: 'public_token is required.' });
  }

  // Step 1: exchange. Hold accessToken in a local — never log it, never send it.
  let accessToken;
  let itemId;
  try {
    const ex = await plaidClient.itemPublicTokenExchange({ public_token: publicToken });
    accessToken = ex.data.access_token;
    itemId = ex.data.item_id;
  } catch (err) {
    console.error('[plaid] exchange failed:', safePlaidError(err));
    return res.status(502).json({ error: 'Plaid token exchange failed.' });
  }

  // Step 2: enrich (institution + accounts).
  let accountsResp;
  try {
    accountsResp = await plaidClient.accountsGet({ access_token: accessToken });
  } catch (err) {
    console.error('[plaid] accountsGet failed:', safePlaidError(err));
    return res.status(502).json({ error: 'Plaid accountsGet failed.' });
  }

  const item = accountsResp.data.item;
  const institutionId = item && item.institution_id ? item.institution_id : null;
  let institutionName = null;
  if (institutionId) {
    try {
      const inst = await plaidClient.institutionsGetById({
        institution_id: institutionId,
        country_codes: [CountryCode.Us],
      });
      institutionName = inst.data.institution.name;
    } catch (err) {
      // Non-fatal — we'll store the connection without a friendly name.
      console.error('[plaid] institutionsGetById failed:', safePlaidError(err));
    }
  }

  // Step 3: encrypt and persist. Drop the plaintext token immediately after.
  const encrypted = encrypt(accessToken);
  accessToken = null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: itemRows } = await client.query(
      `INSERT INTO plaid_items
         (user_id, institution_name, institution_id, access_token_encrypted, item_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (item_id) DO UPDATE SET
         institution_name       = EXCLUDED.institution_name,
         institution_id         = EXCLUDED.institution_id,
         access_token_encrypted = EXCLUDED.access_token_encrypted,
         updated_at             = NOW()
       RETURNING id, user_id`,
      [userId, institutionName, institutionId, encrypted, itemId]
    );

    // Defense-in-depth: if an item with this item_id already exists for a
    // *different* user, the ON CONFLICT update would have overwritten it.
    // Refuse — the same Plaid Item belongs to exactly one MoneyMind user.
    if (itemRows[0].user_id !== userId) {
      await client.query('ROLLBACK');
      console.error('[plaid] item_id collision across users — refusing.');
      return res.status(409).json({ error: 'This bank connection belongs to another account.' });
    }
    const plaidItemId = itemRows[0].id;

    for (const acct of accountsResp.data.accounts) {
      await client.query(
        `INSERT INTO accounts
           (user_id, plaid_item_id, plaid_account_id, name, official_name,
            type, subtype, mask, current_balance, available_balance, iso_currency_code)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (user_id, plaid_account_id) DO UPDATE SET
           plaid_item_id     = EXCLUDED.plaid_item_id,
           name              = EXCLUDED.name,
           official_name     = EXCLUDED.official_name,
           type              = EXCLUDED.type,
           subtype           = EXCLUDED.subtype,
           mask              = EXCLUDED.mask,
           current_balance   = EXCLUDED.current_balance,
           available_balance = EXCLUDED.available_balance,
           iso_currency_code = EXCLUDED.iso_currency_code,
           updated_at        = NOW()`,
        [
          userId,
          plaidItemId,
          acct.account_id,
          acct.name,
          acct.official_name,
          acct.type,
          acct.subtype,
          acct.mask,
          acct.balances ? acct.balances.current : null,
          acct.balances ? acct.balances.available : null,
          acct.balances ? acct.balances.iso_currency_code : null,
        ]
      );
    }

    await client.query('COMMIT');
    return res.json({
      ok: true,
      institution_name: institutionName || 'Connected institution',
      account_count: accountsResp.data.accounts.length,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[plaid] persistence failed:', err.message);
    return res.status(500).json({ error: 'Could not save the bank connection.' });
  } finally {
    client.release();
  }
});

module.exports = router;

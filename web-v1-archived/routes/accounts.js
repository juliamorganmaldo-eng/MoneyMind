const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { pool } = require('../db');
const { Configuration, PlaidApi, PlaidEnvironments, Products, CountryCode } = require('plaid');

function getPlaidClient() {
  const configuration = new Configuration({
    basePath: PlaidEnvironments[process.env.PLAID_ENV || 'sandbox'],
    baseOptions: {
      headers: {
        'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
        'PLAID-SECRET': process.env.PLAID_SECRET,
      },
    },
  });
  return new PlaidApi(configuration);
}

// GET /accounts
router.get('/', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, institution, item_id, created_at FROM connected_accounts WHERE user_id = $1 ORDER BY created_at DESC',
      [req.session.user.id]
    );
    res.render('connect', { title: 'Connected Accounts', accounts: result.rows, page: 'connect' });
  } catch (err) {
    console.error('Accounts fetch error:', err);
    res.render('connect', { title: 'Connected Accounts', accounts: [], page: 'connect' });
  }
});

// GET /accounts/link-token
router.get('/link-token', requireAuth, async (req, res) => {
  try {
    const plaidClient = getPlaidClient();
    const response = await plaidClient.linkTokenCreate({
      user: { client_user_id: String(req.session.user.id) },
      client_name: 'MoneyMind',
      products: [Products.Transactions],
      country_codes: [CountryCode.Us],
      language: 'en',
    });
    res.json({ link_token: response.data.link_token });
  } catch (err) {
    console.error('Link token error:', err);
    res.status(500).json({ error: 'Failed to create link token', details: err.message });
  }
});

// POST /accounts/exchange
router.post('/exchange', requireAuth, async (req, res) => {
  const { public_token, institution_name } = req.body;

  if (!public_token) {
    return res.status(400).json({ error: 'public_token is required' });
  }

  try {
    const plaidClient = getPlaidClient();
    const exchangeResponse = await plaidClient.itemPublicTokenExchange({ public_token });
    const { access_token, item_id } = exchangeResponse.data;

    await pool.query(
      'INSERT INTO connected_accounts (user_id, institution, access_token, item_id) VALUES ($1, $2, $3, $4)',
      [req.session.user.id, institution_name || 'Unknown Institution', access_token, item_id]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('Exchange error:', err);
    res.status(500).json({ error: 'Failed to exchange token', details: err.message });
  }
});

// DELETE /accounts/:id
router.delete('/:id', requireAuth, async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      'DELETE FROM connected_accounts WHERE id = $1 AND user_id = $2 RETURNING id',
      [id, req.session.user.id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Account not found' });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Delete account error:', err);
    res.status(500).json({ error: 'Failed to disconnect account', details: err.message });
  }
});

module.exports = router;

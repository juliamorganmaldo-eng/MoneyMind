const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { pool } = require('../db');
const { Configuration, PlaidApi, PlaidEnvironments } = require('plaid');

function getPlaidClient() {
  return new PlaidApi(new Configuration({
    basePath: PlaidEnvironments[process.env.PLAID_ENV || 'sandbox'],
    baseOptions: {
      headers: {
        'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
        'PLAID-SECRET': process.env.PLAID_SECRET,
      },
    },
  }));
}

// GET /networth
router.get('/', requireAuth, async (req, res) => {
  try {
    const accountsResult = await pool.query(
      'SELECT id, institution, access_token, item_id FROM connected_accounts WHERE user_id = $1',
      [req.session.user.id]
    );

    const plaid = getPlaidClient();
    const assets = [];
    const liabilities = [];
    let totalAssets = 0;
    let totalLiabilities = 0;

    for (const acct of accountsResult.rows) {
      try {
        const response = await plaid.accountsBalanceGet({ access_token: acct.access_token });
        for (const a of response.data.accounts) {
          const balance = a.balances.current || 0;
          const available = a.balances.available;
          const entry = {
            institution: acct.institution,
            name: a.name || a.official_name || 'Account',
            type: a.type,
            subtype: a.subtype,
            balance,
            available,
            mask: a.mask,
          };

          if (a.type === 'credit' || a.type === 'loan') {
            liabilities.push(entry);
            totalLiabilities += balance;
          } else {
            assets.push(entry);
            totalAssets += balance;
          }
        }
      } catch (err) {
        console.error(`Balance fetch error for ${acct.institution}:`, err.message);
        assets.push({
          institution: acct.institution,
          name: 'Error fetching balances',
          type: 'error',
          subtype: '',
          balance: 0,
          available: null,
          mask: '',
        });
      }
    }

    const netWorth = totalAssets - totalLiabilities;

    res.render('networth', {
      title: 'Net Worth',
      page: 'networth',
      assets,
      liabilities,
      totalAssets: parseFloat(totalAssets.toFixed(2)),
      totalLiabilities: parseFloat(totalLiabilities.toFixed(2)),
      netWorth: parseFloat(netWorth.toFixed(2)),
      hasAccounts: accountsResult.rows.length > 0,
    });
  } catch (err) {
    console.error('Net worth error:', err);
    req.session.flash = { error: 'Failed to load net worth data.' };
    res.redirect('/dashboard');
  }
});

module.exports = router;

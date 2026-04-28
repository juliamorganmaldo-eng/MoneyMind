const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { plaidClient } = require('../lib/plaid');
const { decrypt } = require('../lib/crypto');
const { classifyAccount } = require('../lib/account-classification');

const router = express.Router();
router.use(express.json({ limit: '32kb' }));
router.use(requireAuth);

function safePlaidError(err) {
  const out = { msg: err && err.message ? err.message : String(err) };
  const data = err && err.response && err.response.data;
  if (data) {
    if (data.error_code) out.error_code = data.error_code;
    if (data.error_type) out.error_type = data.error_type;
  }
  return out;
}

router.get('/api/net-worth', async (req, res) => {
  const userId = req.session.userId;
  try {
    const { rows } = await pool.query(
      `SELECT id AS account_id, name, mask, type, subtype,
              current_balance, available_balance,
              is_asset_override, excluded_from_net_worth
         FROM accounts WHERE user_id = $1
         ORDER BY id`,
      [userId]
    );

    const accounts = rows.map((r) => {
      const cls = classifyAccount(r);
      const cents = r.current_balance == null ? 0 : Math.round(Number(r.current_balance) * 100);
      return {
        account_id: r.account_id,
        name: r.name,
        mask: r.mask,
        type: r.type,
        subtype: r.subtype,
        classification: cls,
        is_override: r.is_asset_override !== null,
        excluded_from_net_worth: r.excluded_from_net_worth,
        current_balance_cents: cents,
      };
    });

    let assets = 0, liabilities = 0;
    const breakdownMap = new Map();
    for (const a of accounts) {
      if (a.classification === 'excluded') continue;
      if (a.classification === 'asset') assets += a.current_balance_cents;
      else if (a.classification === 'liability') liabilities += a.current_balance_cents;
      const key = a.type || 'unknown';
      if (!breakdownMap.has(key)) breakdownMap.set(key, { type: key, total_cents: 0, account_count: 0 });
      const e = breakdownMap.get(key);
      // For breakdown, signed contribution to net worth (asset positive, liability negative)
      e.total_cents += a.classification === 'asset' ? a.current_balance_cents
                     : a.classification === 'liability' ? -a.current_balance_cents
                     : 0;
      e.account_count += 1;
    }

    res.json({
      current_total_cents: assets - liabilities,
      assets_total_cents: assets,
      liabilities_total_cents: liabilities,
      breakdown_by_type: [...breakdownMap.values()],
      accounts,
    });
  } catch (err) {
    console.error('[net-worth] failed:', err.message);
    res.status(500).json({ error: 'Could not load net worth.' });
  }
});

router.get('/api/net-worth/history', async (req, res) => {
  const userId = req.session.userId;
  const monthsRaw = Number.parseInt(req.query.months, 10);
  const months = Number.isFinite(monthsRaw) ? Math.max(1, Math.min(60, monthsRaw)) : 12;

  try {
    const { rows: snaps } = await pool.query(
      `SELECT snapshot_date, account_id, balance_cents
         FROM balance_snapshots
        WHERE user_id = $1
          AND snapshot_date >= (CURRENT_DATE - ($2::int * INTERVAL '1 month'))
        ORDER BY snapshot_date ASC, account_id ASC`,
      [userId, months]
    );
    const { rows: accts } = await pool.query(
      `SELECT id, type, is_asset_override, excluded_from_net_worth
         FROM accounts WHERE user_id = $1`,
      [userId]
    );
    const acctMap = new Map(accts.map((a) => [a.id, a]));

    // Distinct dates, ascending
    const dateSet = new Set();
    for (const s of snaps) dateSet.add(s.snapshot_date.toISOString().slice(0, 10));
    const dates = [...dateSet].sort();

    // For each date, sum each account's latest snapshot ≤ that date.
    // Carry-forward semantics: an account contributes its most recent
    // known balance even on days when no new snapshot was taken.
    const out = [];
    for (const d of dates) {
      let assets = 0, liabilities = 0;
      for (const [aid, a] of acctMap) {
        let latest = null;
        for (const s of snaps) {
          if (s.account_id !== aid) continue;
          if (s.snapshot_date.toISOString().slice(0, 10) > d) break;
          latest = s;
        }
        if (!latest) continue;
        const cls = classifyAccount(a);
        if (cls === 'excluded') continue;
        if (cls === 'asset') assets += latest.balance_cents || 0;
        else if (cls === 'liability') liabilities += latest.balance_cents || 0;
      }
      out.push({
        date: d,
        net_worth_cents: assets - liabilities,
        assets_cents: assets,
        liabilities_cents: liabilities,
      });
    }
    res.json({ history: out });
  } catch (err) {
    console.error('[net-worth-history] failed:', err.message);
    res.status(500).json({ error: 'Could not load history.' });
  }
});

router.post('/api/balances/refresh', async (req, res) => {
  const userId = req.session.userId;
  try {
    const { rows: items } = await pool.query(
      `SELECT id, item_id, access_token_encrypted FROM plaid_items WHERE user_id = $1`,
      [userId]
    );
    let refreshed = 0;
    for (const item of items) {
      let accessToken = decrypt(item.access_token_encrypted);
      try {
        const r = await plaidClient.accountsBalanceGet({ access_token: accessToken });
        const accountsData = r.data.accounts || [];
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          for (const a of accountsData) {
            const balCents = a.balances && a.balances.current != null
              ? Math.round(Number(a.balances.current) * 100) : null;
            const availCents = a.balances && a.balances.available != null
              ? Math.round(Number(a.balances.available) * 100) : null;
            // Update accounts.current_balance + write a snapshot for today.
            const { rows: own } = await client.query(
              `UPDATE accounts
                  SET current_balance   = $1,
                      available_balance = $2,
                      updated_at        = NOW()
                WHERE user_id = $3
                  AND plaid_account_id = $4
                RETURNING id`,
              [
                balCents == null ? null : balCents / 100,
                availCents == null ? null : availCents / 100,
                userId,
                a.account_id,
              ]
            );
            if (own.length === 0) continue; // shouldn't happen — defensive
            await client.query(
              `INSERT INTO balance_snapshots (user_id, account_id, snapshot_date,
                 balance_cents, available_balance_cents, iso_currency_code)
               VALUES ($1, $2, CURRENT_DATE, $3, $4, $5)
               ON CONFLICT (user_id, account_id, snapshot_date) DO UPDATE SET
                 balance_cents           = EXCLUDED.balance_cents,
                 available_balance_cents = EXCLUDED.available_balance_cents,
                 iso_currency_code       = EXCLUDED.iso_currency_code`,
              [userId, own[0].id, balCents, availCents, a.balances && a.balances.iso_currency_code]
            );
            refreshed += 1;
          }
          await client.query('COMMIT');
        } catch (e) {
          await client.query('ROLLBACK').catch(() => {});
          throw e;
        } finally {
          client.release();
        }
      } catch (err) {
        console.error('[balances-refresh] item failed:', { item_id: item.item_id, err: safePlaidError(err) });
      } finally {
        accessToken = null;
      }
    }
    res.json({ ok: true, refreshed });
  } catch (err) {
    console.error('[balances-refresh] failed:', err.message);
    res.status(500).json({ error: 'Refresh failed.' });
  }
});

module.exports = router;

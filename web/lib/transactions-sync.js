// Pulls Plaid /transactions/sync deltas for one user's items and persists them.
// Always scoped by user_id; the access token is held only across the live
// Plaid calls and dropped before any other work.

const { decrypt } = require('./crypto');
const { plaidClient } = require('./plaid');
const { pool } = require('../db');
const { categoryFor, plaidPrimary, plaidDetailed } = require('./category-mapping');

const MAX_PAGES_PER_ITEM = 50;        // sandbox & realistic prod fit easily
const NOT_READY_RETRIES = 4;
const NOT_READY_BASE_DELAY_MS = 1500;

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

async function transactionsSyncWithRetry(args) {
  let attempt = 0;
  while (true) {
    try {
      return await plaidClient.transactionsSync(args);
    } catch (err) {
      const code = err && err.response && err.response.data && err.response.data.error_code;
      // PRODUCT_NOT_READY can fire briefly right after exchange while Plaid
      // pulls historical data. Back off a bit and retry.
      if (code === 'PRODUCT_NOT_READY' && attempt < NOT_READY_RETRIES) {
        attempt += 1;
        await new Promise((r) => setTimeout(r, NOT_READY_BASE_DELAY_MS * attempt));
        continue;
      }
      throw err;
    }
  }
}

async function syncOneItem(userId, item) {
  // Decrypt at the point of use; null out the local immediately after the
  // last Plaid call so the GC can reclaim the buffer before DB work runs.
  let accessToken = decrypt(item.access_token_encrypted);

  let cursor = item.cursor || null;
  const added = [];
  const modified = [];
  const removed = [];

  try {
    let hasMore = true;
    let pages = 0;
    while (hasMore && pages < MAX_PAGES_PER_ITEM) {
      const r = await transactionsSyncWithRetry({
        access_token: accessToken,
        cursor: cursor || undefined,
      });
      added.push(...r.data.added);
      modified.push(...r.data.modified);
      removed.push(...r.data.removed);
      cursor = r.data.next_cursor;
      hasMore = r.data.has_more;
      pages += 1;
    }
  } finally {
    accessToken = null;
  }

  // Persist deltas + advance cursor in a single DB transaction so a partial
  // failure can't leave us with rows whose cursor doesn't reflect them.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Build a name→id lookup for THIS user's categories so we can resolve
    // the mapping output to a category_id without a per-row query.
    const { rows: catRows } = await client.query(
      'SELECT id, name FROM categories WHERE user_id = $1', [userId]
    );
    const categoryIdByName = new Map();
    for (const r of catRows) categoryIdByName.set(r.name, r.id);

    function resolveCategory(plaidCategoryArr) {
      const mmName = categoryFor(plaidCategoryArr);
      return categoryIdByName.get(mmName) || null; // null if user has no "Other" yet
    }

    for (const tx of added) {
      await client.query(
        `INSERT INTO transactions (
           user_id, plaid_item_id, plaid_account_id, plaid_transaction_id,
           name, merchant_name, amount, iso_currency_code,
           date, authorized_date, category, plaid_category_id,
           payment_channel, pending, location,
           category_id, category_source,
           plaid_category_primary, plaid_category_detailed
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
         ON CONFLICT (user_id, plaid_transaction_id) DO NOTHING`,
        [
          userId,
          item.id,
          tx.account_id,
          tx.transaction_id,
          tx.name,
          tx.merchant_name,
          tx.amount,
          tx.iso_currency_code,
          tx.date,
          tx.authorized_date,
          tx.category || null,
          tx.category_id,
          tx.payment_channel,
          tx.pending,
          tx.location ? JSON.stringify(tx.location) : null,
          resolveCategory(tx.category),
          'plaid_mapped',
          plaidPrimary(tx.category),
          plaidDetailed(tx.category),
        ]
      );
    }

    // On UPDATE: refresh Plaid metadata always, but PRESERVE category_id
    // when the user has manually overridden it.
    //   - category_source = 'user_override' → leave category_id alone,
    //     just update plaid_category_primary/detailed for display.
    //   - otherwise → also update category_id and (re-)stamp it as
    //     'plaid_mapped'.
    for (const tx of modified) {
      await client.query(
        `UPDATE transactions SET
           plaid_item_id           = $2,
           plaid_account_id        = $3,
           name                    = $4,
           merchant_name           = $5,
           amount                  = $6,
           iso_currency_code       = $7,
           date                    = $8,
           authorized_date         = $9,
           category                = $10,
           plaid_category_id       = $11,
           payment_channel         = $12,
           pending                 = $13,
           location                = $14,
           plaid_category_primary  = $15,
           plaid_category_detailed = $16,
           category_id             = CASE WHEN category_source = 'user_override'
                                          THEN category_id ELSE $17 END,
           category_source         = CASE WHEN category_source = 'user_override'
                                          THEN category_source ELSE 'plaid_mapped' END,
           updated_at              = NOW()
         WHERE user_id = $1 AND plaid_transaction_id = $18`,
        [
          userId,
          item.id,
          tx.account_id,
          tx.name,
          tx.merchant_name,
          tx.amount,
          tx.iso_currency_code,
          tx.date,
          tx.authorized_date,
          tx.category || null,
          tx.category_id,
          tx.payment_channel,
          tx.pending,
          tx.location ? JSON.stringify(tx.location) : null,
          plaidPrimary(tx.category),
          plaidDetailed(tx.category),
          resolveCategory(tx.category),
          tx.transaction_id,
        ]
      );
    }

    if (removed.length > 0) {
      await client.query(
        `DELETE FROM transactions
          WHERE user_id = $1 AND plaid_transaction_id = ANY($2::text[])`,
        [userId, removed.map((r) => r.transaction_id)]
      );
    }

    await client.query(
      `UPDATE plaid_items
          SET cursor = $1, updated_at = NOW()
        WHERE id = $2 AND user_id = $3`,
      [cursor, item.id, userId]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  return { added: added.length, modified: modified.length, removed: removed.length };
}

async function syncTransactionsForUser(userId) {
  const { rows: items } = await pool.query(
    `SELECT id, item_id, cursor, access_token_encrypted
       FROM plaid_items
      WHERE user_id = $1`,
    [userId]
  );

  const totals = { added_count: 0, modified_count: 0, removed_count: 0, items_synced: 0 };
  for (const item of items) {
    try {
      const r = await syncOneItem(userId, item);
      totals.added_count += r.added;
      totals.modified_count += r.modified;
      totals.removed_count += r.removed;
      totals.items_synced += 1;
    } catch (err) {
      // Log a sanitized error for this item but keep going for the others.
      console.error('[txn-sync] item failed', { item_id: item.item_id, err: safePlaidError(err) });
    }
  }

  // Refresh recurring-charge detection. Wrapped so a detection failure
  // never kicks back to the caller as a sync failure — the source-of-
  // truth transactions are already saved.
  try {
    const { detectRecurring } = require('./recurring-detection');
    const { syncDetectionResults } = require('./recurring-persistence');
    const detected = await detectRecurring(userId);
    await syncDetectionResults(userId, detected);
  } catch (err) {
    console.error('[recurring] post-sync detection failed:', err.message);
  }

  // Snapshot today's balances. Uses accounts.current_balance (already
  // updated during the most recent Plaid exchange/refresh). For fresher
  // numbers, the user can hit POST /api/balances/refresh which calls
  // Plaid's accountsBalanceGet directly. Same-day re-syncs overwrite via
  // the UNIQUE(user_id, account_id, snapshot_date) ON CONFLICT path.
  try {
    await pool.query(
      `INSERT INTO balance_snapshots
         (user_id, account_id, snapshot_date,
          balance_cents, available_balance_cents, iso_currency_code)
       SELECT user_id, id, CURRENT_DATE,
              CASE WHEN current_balance   IS NULL THEN NULL ELSE ROUND(current_balance   * 100)::int END,
              CASE WHEN available_balance IS NULL THEN NULL ELSE ROUND(available_balance * 100)::int END,
              iso_currency_code
         FROM accounts
        WHERE user_id = $1
       ON CONFLICT (user_id, account_id, snapshot_date) DO UPDATE SET
         balance_cents           = EXCLUDED.balance_cents,
         available_balance_cents = EXCLUDED.available_balance_cents,
         iso_currency_code       = EXCLUDED.iso_currency_code`,
      [userId]
    );
  } catch (err) {
    console.error('[balance-snapshot] post-sync failed:', err.message);
  }

  return totals;
}

module.exports = { syncTransactionsForUser };

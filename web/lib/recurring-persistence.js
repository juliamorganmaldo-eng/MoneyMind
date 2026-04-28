// Persists detection output for one user. Always user-scoped — every
// statement here filters by user_id, even when the input clearly comes
// from detectRecurring(userId). Belt and braces.
//
// Rules:
//   • Detected merchant_keys present in DB AND not is_user_dismissed →
//     UPSERT (refresh cadence, amounts, status, dates, etc.).
//   • Detected merchant_keys present in DB AND is_user_dismissed →
//     left strictly alone — the user said "don't show me this again".
//   • DB rows whose merchant_key is NOT in the latest detection AND not
//     is_user_dismissed → status flipped to 'ended' so the UI can
//     surface it in the "Ended Subscriptions" collapse.

const { pool } = require('../db');

async function syncDetectionResults(userId, detectedList) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: existing } = await client.query(
      `SELECT id, merchant_key, is_user_dismissed
         FROM recurring_charges
        WHERE user_id = $1`,
      [userId]
    );
    const existingByKey = new Map(existing.map((r) => [r.merchant_key, r]));
    const detectedKeys = new Set(detectedList.map((d) => d.merchant_key));

    let upserts = 0;
    for (const d of detectedList) {
      const prev = existingByKey.get(d.merchant_key);
      if (prev && prev.is_user_dismissed) continue;

      // The WHERE on the conflict path also re-asserts is_user_dismissed=false.
      // If a row toggles to dismissed between SELECT and UPSERT, the WHERE
      // suppresses the UPDATE. (INSERT path is fine — no row exists.)
      await client.query(
        `INSERT INTO recurring_charges (
           user_id, merchant_key, display_name, category_id, cadence,
           median_amount_cents, last_amount_cents,
           last_charged_date, next_expected_date,
           occurrence_count, confidence_score, status, price_change_detected
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (user_id, merchant_key) DO UPDATE SET
           display_name          = EXCLUDED.display_name,
           category_id           = EXCLUDED.category_id,
           cadence               = EXCLUDED.cadence,
           median_amount_cents   = EXCLUDED.median_amount_cents,
           last_amount_cents     = EXCLUDED.last_amount_cents,
           last_charged_date     = EXCLUDED.last_charged_date,
           next_expected_date    = EXCLUDED.next_expected_date,
           occurrence_count      = EXCLUDED.occurrence_count,
           confidence_score      = EXCLUDED.confidence_score,
           status                = EXCLUDED.status,
           price_change_detected = EXCLUDED.price_change_detected,
           updated_at            = NOW()
         WHERE recurring_charges.is_user_dismissed = FALSE`,
        [
          userId, d.merchant_key, d.display_name, d.category_id, d.cadence,
          d.median_amount_cents, d.last_amount_cents,
          d.last_charged_date, d.next_expected_date,
          d.occurrence_count, d.confidence_score, d.status, d.price_change_detected,
        ]
      );
      upserts += 1;
    }

    // Mark stragglers as 'ended'. user_id filter is the safety boundary —
    // even if a future code change leaks a wrong key into detectedKeys,
    // we still only touch THIS user's rows.
    let endedCount = 0;
    for (const e of existing) {
      if (e.is_user_dismissed) continue;
      if (detectedKeys.has(e.merchant_key)) continue;
      const r = await client.query(
        `UPDATE recurring_charges
            SET status = 'ended', updated_at = NOW()
          WHERE user_id = $1
            AND merchant_key = $2
            AND is_user_dismissed = FALSE
            AND status <> 'ended'`,
        [userId, e.merchant_key]
      );
      endedCount += r.rowCount;
    }

    await client.query('COMMIT');
    return { upserts, ended: endedCount };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { syncDetectionResults };

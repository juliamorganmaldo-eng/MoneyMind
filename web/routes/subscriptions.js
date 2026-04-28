const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { detectRecurring, clusterKeyFor } = require('../lib/recurring-detection');
const { syncDetectionResults } = require('../lib/recurring-persistence');
const { detectDuplicates, monthlyEquivalentCents } = require('../lib/duplicate-detection');

const router = express.Router();
router.use(express.json({ limit: '32kb' }));
router.use(requireAuth);

const ALLOWED_ACTIONS = new Set(['not_recurring', 'cancelled', 'reminder_set']);

router.get('/api/subscriptions', async (req, res) => {
  const userId = req.session.userId;
  try {
    // The LEFT JOIN to categories enforces (user_id) — defense in depth.
    const { rows } = await pool.query(
      `SELECT rc.id, rc.merchant_key, rc.display_name, rc.category_id,
              c.name AS category_name,
              rc.cadence,
              rc.median_amount_cents, rc.last_amount_cents,
              rc.last_charged_date, rc.next_expected_date,
              rc.occurrence_count, rc.confidence_score, rc.status,
              rc.price_change_detected, rc.is_user_dismissed,
              rc.updated_at
         FROM recurring_charges rc
         LEFT JOIN categories c
           ON c.id = rc.category_id AND c.user_id = rc.user_id
        WHERE rc.user_id = $1
          AND rc.is_user_dismissed = FALSE
        ORDER BY
          CASE rc.status WHEN 'active' THEN 0 WHEN 'ended' THEN 1 ELSE 2 END,
          rc.median_amount_cents DESC`,
      [userId]
    );

    const enriched = rows.map((r) => ({
      ...r,
      monthly_equivalent_cents: monthlyEquivalentCents(r),
    }));

    let annualTotal = 0;
    for (const r of enriched) {
      if (r.status === 'active') annualTotal += r.monthly_equivalent_cents * 12;
    }

    res.json({
      subscriptions: enriched,
      annual_total_cents: annualTotal,
    });
  } catch (err) {
    console.error('[subs] list failed:', err.message);
    res.status(500).json({ error: 'Could not load subscriptions.' });
  }
});

router.get('/api/subscriptions/duplicates', async (req, res) => {
  const userId = req.session.userId;
  try {
    const pairs = await detectDuplicates(userId);
    res.json({ pairs });
  } catch (err) {
    console.error('[subs] duplicates failed:', err.message);
    res.status(500).json({ error: 'Could not load duplicates.' });
  }
});

router.post('/api/subscriptions/sync', async (req, res) => {
  const userId = req.session.userId;
  try {
    const detected = await detectRecurring(userId);
    const result = await syncDetectionResults(userId, detected);
    res.json({ ok: true, detected_count: detected.length, ...result });
  } catch (err) {
    console.error('[subs] manual sync failed:', err.message);
    res.status(500).json({ error: 'Sync failed.' });
  }
});

router.get('/api/subscriptions/:id', async (req, res) => {
  const userId = req.session.userId;
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });

  try {
    const { rows: rec } = await pool.query(
      `SELECT id, merchant_key, display_name, cadence,
              median_amount_cents, last_amount_cents,
              last_charged_date, next_expected_date,
              occurrence_count, confidence_score, status, price_change_detected
         FROM recurring_charges
        WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );
    if (rec.length === 0) return res.status(404).json({ error: 'Subscription not found.' });
    const sub = rec[0];

    // Drill-down: pull the user's transactions in the past 18 months and
    // filter to those whose computed cluster key matches this row's
    // merchant_key. Same logic as detection, so the displayed transactions
    // exactly match what fed the cluster.
    const { rows: txns } = await pool.query(
      `SELECT id, plaid_account_id, name, merchant_name, amount,
              iso_currency_code, date, pending
         FROM transactions
        WHERE user_id = $1
          AND date >= (CURRENT_DATE - INTERVAL '18 months')
          AND amount > 0
          AND COALESCE(plaid_category_primary, '') NOT IN ('Transfer', 'Payment', 'Income')
        ORDER BY date DESC`,
      [userId]
    );
    const matching = txns.filter((t) => clusterKeyFor(t) === sub.merchant_key);
    res.json({ subscription: sub, transactions: matching });
  } catch (err) {
    console.error('[subs] drill-down failed:', err.message);
    res.status(500).json({ error: 'Could not load drill-down.' });
  }
});

router.post('/api/subscriptions/:id/action', async (req, res) => {
  const userId = req.session.userId;
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });

  const action = req.body && typeof req.body.action === 'string' ? req.body.action : null;
  const notes = req.body && typeof req.body.notes === 'string' ? req.body.notes : null;
  if (!action || !ALLOWED_ACTIONS.has(action)) {
    return res.status(400).json({ error: 'action must be one of: ' + [...ALLOWED_ACTIONS].join(', ') });
  }
  if (notes !== null && notes.length > 1000) {
    return res.status(400).json({ error: 'notes too long' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Ownership — 404 cross-user. Composite FK on the action insert
    // would also reject, but this is the polite error.
    const { rows: ownCheck } = await client.query(
      'SELECT id FROM recurring_charges WHERE id = $1 AND user_id = $2',
      [id, userId]
    );
    if (ownCheck.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Subscription not found.' });
    }

    await client.query(
      `INSERT INTO recurring_charge_actions (user_id, recurring_charge_id, action, notes)
       VALUES ($1, $2, $3, $4)`,
      [userId, id, action, notes]
    );

    if (action === 'not_recurring') {
      await client.query(
        `UPDATE recurring_charges
            SET is_user_dismissed = TRUE,
                status            = 'user_dismissed',
                updated_at        = NOW()
          WHERE id = $1 AND user_id = $2`,
        [id, userId]
      );
    } else if (action === 'cancelled') {
      await client.query(
        `UPDATE recurring_charges
            SET status     = 'ended',
                updated_at = NOW()
          WHERE id = $1 AND user_id = $2`,
        [id, userId]
      );
    }
    // 'reminder_set' just records the action; no row state change.

    await client.query('COMMIT');
    res.json({ ok: true, action });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[subs] action failed:', err.message);
    res.status(500).json({ error: 'Could not record action.' });
  } finally {
    client.release();
  }
});

module.exports = router;

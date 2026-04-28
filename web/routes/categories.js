const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(express.json({ limit: '32kb' }));
router.use(requireAuth);

const NAME_MIN = 1;
const NAME_MAX = 30;

router.get('/api/categories', async (req, res) => {
  const userId = req.session.userId;
  try {
    // Per-category current-month metrics (count + outflow spend).
    // The subqueries scope by user_id AND join through user_id, so even if
    // a category id were ever shared (it can't, by FK) the math stays safe.
    const { rows } = await pool.query(
      `SELECT c.id, c.name, c.display_order,
              COALESCE(m.txn_count, 0)    AS transaction_count,
              COALESCE(m.total_spend, 0)::numeric(14,2) AS current_month_spend
         FROM categories c
         LEFT JOIN (
           SELECT category_id,
                  COUNT(*)::int AS txn_count,
                  SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) AS total_spend
             FROM transactions
            WHERE user_id = $1
              AND date >= date_trunc('month', CURRENT_DATE)
              AND date <  (date_trunc('month', CURRENT_DATE) + INTERVAL '1 month')
            GROUP BY category_id
         ) m ON m.category_id = c.id
        WHERE c.user_id = $1
        ORDER BY c.display_order`,
      [userId]
    );
    res.json({ categories: rows });
  } catch (err) {
    console.error('[categories] list failed:', err.message);
    res.status(500).json({ error: 'Could not load categories.' });
  }
});

router.patch('/api/categories/:id', async (req, res) => {
  const userId = req.session.userId;
  const id = Number.parseInt(req.params.id, 10);
  const name = (req.body && typeof req.body.name === 'string') ? req.body.name.trim() : '';

  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
  if (name.length < NAME_MIN || name.length > NAME_MAX) {
    return res.status(400).json({ error: `Name must be ${NAME_MIN}-${NAME_MAX} characters.` });
  }

  try {
    // Reject duplicates within the same user's category set.
    const { rows: dup } = await pool.query(
      'SELECT id FROM categories WHERE user_id = $1 AND name = $2 AND id <> $3',
      [userId, name, id]
    );
    if (dup.length > 0) {
      return res.status(409).json({ error: 'You already have a category with that name.' });
    }

    // Update is scoped by user_id — a cross-user attempt simply matches 0
    // rows and we return 404 (the canonical "this isn't yours" response,
    // which matches the "doesn't exist" response so we don't leak existence).
    const { rows } = await pool.query(
      `UPDATE categories
          SET name = $1, updated_at = NOW()
        WHERE id = $2 AND user_id = $3
        RETURNING id, name, display_order`,
      [name, id, userId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Category not found.' });
    res.json({ category: rows[0] });
  } catch (err) {
    console.error('[categories] rename failed:', err.message);
    res.status(500).json({ error: 'Could not rename category.' });
  }
});

module.exports = router;

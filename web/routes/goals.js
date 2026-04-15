const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { pool } = require('../db');
const { getMonthInvestments } = require('../lib/categories');

const MAX_GOALS = 5;
const ANNUAL_RETURN = 0.07;

function monthsBetween(fromDate, toDate) {
  const a = new Date(fromDate);
  const b = new Date(toDate);
  const months = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
  return Math.max(1, months);
}

function requiredMonthly(target, progress, months, annualReturn = ANNUAL_RETURN) {
  const i = annualReturn / 12;
  const growth = Math.pow(1 + i, months);
  const futureOfProgress = progress * growth;
  const remaining = target - futureOfProgress;
  if (remaining <= 0) return 0;
  if (i === 0) return remaining / months;
  return (remaining * i) / (growth - 1);
}

function estimateCurrentMonthlyContribution() {
  const now = new Date();
  let total = 0, buckets = 0;
  for (let k = 1; k <= 3; k++) {
    const d = new Date(now.getFullYear(), now.getMonth() - k, 1);
    try {
      const inv = getMonthInvestments(d.getFullYear(), d.getMonth() + 1);
      total += inv.total;
      buckets++;
    } catch (_) {}
  }
  return buckets > 0 ? parseFloat((total / buckets).toFixed(2)) : 0;
}

function availableMonthlySavings(ledgerRows) {
  let total = 0;
  for (const r of ledgerRows) {
    if (r.savings_type === 'recurring_monthly') total += Number(r.amount);
  }
  return parseFloat(total.toFixed(2));
}

function computeGoalMetrics(goal, currentMonthly, monthlySavingsPool) {
  const months = monthsBetween(new Date(), goal.target_date);
  const needed = requiredMonthly(Number(goal.target_amount), Number(goal.current_progress || 0), months);
  const gap = Math.max(0, needed - currentMonthly);
  const savingsCanCover = Math.min(gap, monthlySavingsPool);
  const remainingGap = Math.max(0, gap - savingsCanCover);
  const progressPct = Math.min(100, (Number(goal.current_progress || 0) / Number(goal.target_amount)) * 100);
  return {
    months_remaining: months,
    required_monthly: parseFloat(needed.toFixed(2)),
    current_monthly: currentMonthly,
    gap:             parseFloat(gap.toFixed(2)),
    savings_can_cover: parseFloat(savingsCanCover.toFixed(2)),
    remaining_gap:   parseFloat(remainingGap.toFixed(2)),
    progress_pct:    parseFloat(progressPct.toFixed(1)),
  };
}

// GET /goals
router.get('/', requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  try {
    const goalsResult = await pool.query('SELECT * FROM goals WHERE user_id = $1 ORDER BY created_at ASC', [userId]);
    const ledgerResult = await pool.query('SELECT savings_type, amount FROM savings_ledger WHERE user_id = $1', [userId]);

    const currentMonthly = estimateCurrentMonthlyContribution();
    const monthlySavingsPool = availableMonthlySavings(ledgerResult.rows);

    const goals = goalsResult.rows.map(g => ({
      ...g,
      metrics: computeGoalMetrics(g, currentMonthly, monthlySavingsPool),
    }));

    res.render('goals', {
      title: 'Goals',
      page: 'goals',
      goals,
      maxGoals: MAX_GOALS,
      currentMonthly,
      monthlySavingsPool,
    });
  } catch (err) {
    console.error('Goals error:', err);
    res.render('goals', { title: 'Goals', page: 'goals', goals: [], maxGoals: MAX_GOALS, currentMonthly: 0, monthlySavingsPool: 0 });
  }
});

// POST /goals
router.post('/', requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  const { goal_type, name, target_amount, current_progress, target_date } = req.body;

  const validTypes = ['retirement', 'house_deposit', 'emergency_fund', 'education', 'other'];
  if (!validTypes.includes(goal_type)) return res.status(400).json({ error: 'Invalid goal_type' });
  const target = parseFloat(target_amount);
  const progress = parseFloat(current_progress) || 0;
  if (!(target > 0) || !target_date) return res.status(400).json({ error: 'target_amount and target_date required' });

  try {
    const count = await pool.query('SELECT COUNT(*) AS c FROM goals WHERE user_id = $1', [userId]);
    if (Number(count.rows[0].c) >= MAX_GOALS) {
      return res.status(400).json({ error: `Maximum of ${MAX_GOALS} goals reached` });
    }

    const inserted = await pool.query(
      `INSERT INTO goals (user_id, goal_type, name, target_amount, current_progress, target_date)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, user_id, goal_type, name, target_amount, current_progress, target_date, created_at`,
      [userId, goal_type, name || null, target, progress, target_date]
    );
    const goal = inserted.rows[0];

    const ledgerResult = await pool.query('SELECT savings_type, amount FROM savings_ledger WHERE user_id = $1', [userId]);
    const currentMonthly = estimateCurrentMonthlyContribution();
    const monthlySavingsPool = availableMonthlySavings(ledgerResult.rows);
    const metrics = computeGoalMetrics(goal, currentMonthly, monthlySavingsPool);

    res.json({ success: true, goal, metrics, currentMonthly, monthlySavingsPool });
  } catch (err) {
    console.error('Create goal error:', err);
    res.status(500).json({ error: 'Failed to create goal', details: err.message });
  }
});

// DELETE /goals/:id
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM goals WHERE id = $1 AND user_id = $2', [req.params.id, req.session.user.id]);
    res.json({ success: true, deleted: result.rowCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

const { pool } = require('../db');
const { getMonthInvestments } = require('./categories');
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const mainDb = new DatabaseSync(path.join(__dirname, '../../moneymind.db'));

function prevMonth(now = new Date()) {
  const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return { year: d.getFullYear(), month: d.getMonth() + 1, key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` };
}

function monthKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function fmt(n) {
  const v = Math.round(Number(n) || 0);
  return (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString();
}

async function computeSavingsRecovered(userId, monthKeyStr) {
  const start = `${monthKeyStr}-01`;
  const end   = `${monthKeyStr}-31`;
  const rows = (await pool.query(
    `SELECT savings_type, amount FROM savings_ledger
     WHERE user_id = $1 AND confirmed_date >= $2 AND confirmed_date <= $3`,
    [userId, start, end]
  )).rows;
  let one_time = 0, recurring = 0;
  for (const r of rows) {
    if (r.savings_type === 'one_time') one_time += Number(r.amount);
    else if (r.savings_type === 'recurring_monthly') recurring += Number(r.amount);
  }
  return {
    one_time:  parseFloat(one_time.toFixed(2)),
    recurring: parseFloat(recurring.toFixed(2)),
    total:     parseFloat((one_time + recurring).toFixed(2)),
  };
}

async function computeGoalProgressDelta(userId, monthKeyStr) {
  const goals = (await pool.query(
    'SELECT id, name, goal_type, target_amount, current_progress FROM goals WHERE user_id = $1',
    [userId]
  )).rows;

  const prevReport = (await pool.query(
    'SELECT data_json FROM monthly_reports WHERE user_id = $1 AND month = $2',
    [userId, monthKeyStr]
  )).rows[0];
  const prevGoals = prevReport ? (JSON.parse(prevReport.data_json).goal_snapshot || []) : [];
  const prevById = Object.fromEntries(prevGoals.map(g => [g.id, g]));

  return goals.map(g => {
    const prev = prevById[g.id];
    const prevProgress = prev ? Number(prev.current_progress) : 0;
    const pctNow  = (Number(g.current_progress) / Number(g.target_amount)) * 100;
    const pctPrev = prev ? (prevProgress / Number(g.target_amount)) * 100 : 0;
    return {
      id:              g.id,
      name:            g.name || g.goal_type.replace(/_/g, ' '),
      progress_change: parseFloat((Number(g.current_progress) - prevProgress).toFixed(2)),
      pct_change:      parseFloat((pctNow - pctPrev).toFixed(1)),
      pct_now:         parseFloat(pctNow.toFixed(1)),
    };
  });
}

async function computeNetWorthChange(userId, monthKeyStr, currentSnapshot = null) {
  const prev = (await pool.query(
    'SELECT net_worth FROM net_worth_snapshots WHERE user_id = $1 AND month = $2',
    [userId, monthKeyStr]
  )).rows[0];
  if (!currentSnapshot) return { change: 0, prev_net_worth: prev ? Number(prev.net_worth) : null, current_net_worth: null };
  return {
    current_net_worth: currentSnapshot.net_worth,
    prev_net_worth:    prev ? Number(prev.net_worth) : null,
    change:            prev ? parseFloat((currentSnapshot.net_worth - Number(prev.net_worth)).toFixed(2)) : 0,
  };
}

async function computeTopAction(userId) {
  // Largest unresolved draft/sent action by annualized value from metadata_json.current_charge
  const rows = (await pool.query(
    `SELECT id, type, merchant, status, metadata_json
     FROM action_drafts
     WHERE user_id = $1 AND status IN ('draft','sent')`,
    [userId]
  )).rows;

  let best = null;
  for (const r of rows) {
    let monthly = 0;
    try {
      const meta = r.metadata_json ? JSON.parse(r.metadata_json) : {};
      monthly = Number(meta.current_charge) || 0;
    } catch (_) {}
    const annual = monthly * 12;
    if (!best || annual > best.estimated_annual_value) {
      best = {
        action_id: r.id,
        merchant: r.merchant,
        action_type: r.type,
        status: r.status,
        estimated_monthly_value: parseFloat(monthly.toFixed(2)),
        estimated_annual_value: parseFloat(annual.toFixed(2)),
        headline: `Follow up with ${r.merchant} on your ${r.type.replace(/_/g,' ')}`,
      };
    }
  }
  if (!best) {
    return {
      headline: 'Run a fresh subscription audit',
      detail:   'No open drafts. Have MoneyMind scan for new recurring charges, price increases, and duplicate subscriptions.',
      estimated_annual_value: null,
    };
  }
  best.detail = `If this resolves, the recovered ${fmt(best.estimated_monthly_value)}/mo is ${fmt(best.estimated_annual_value)} over the year.`;
  return best;
}

function renderReportText(report) {
  const s = report.savings_recovered;
  const nw = report.net_worth;
  const goalLines = report.goals.length === 0
    ? '  (no goals set yet)'
    : report.goals.map(g => `  • ${g.name}: ${g.pct_change >= 0 ? '+' : ''}${g.pct_change}% (${g.pct_now}% of target)`).join('\n');
  const nwLine = nw.prev_net_worth == null
    ? 'Net worth: first snapshot recorded this month.'
    : `Net worth: ${fmt(nw.current_net_worth)} (${nw.change >= 0 ? '+' : ''}${fmt(nw.change)} vs. last month)`;
  const act = report.top_action;
  return [
    `Your ${report.month_label} Wealth Report`,
    ``,
    `Savings recovered: ${fmt(s.total)} (one-time ${fmt(s.one_time)}, recurring ${fmt(s.recurring)}/mo)`,
    `Invested / redirected: ${fmt(report.invested)}`,
    ``,
    `Goals progress:`,
    goalLines,
    ``,
    nwLine,
    ``,
    `Biggest move this month: ${act.headline}`,
    act.estimated_annual_value ? `Potential value: ${fmt(act.estimated_annual_value)}/yr. ${act.detail || ''}` : act.detail || '',
  ].join('\n');
}

async function generateMonthlyReport(userId, opts = {}) {
  const now = opts.now || new Date();
  const prev = prevMonth(now);
  const monthBeforePrev = monthKey(new Date(prev.year, prev.month - 2, 1));
  const monthLabel = new Date(prev.year, prev.month - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  const savings = await computeSavingsRecovered(userId, prev.key);

  const inv = getMonthInvestments(prev.year, prev.month);
  const invested = inv.total || 0;

  const goals = await computeGoalProgressDelta(userId, monthBeforePrev);

  const currentSnapshot = opts.currentSnapshot || null;
  if (currentSnapshot) {
    await pool.query(
      `INSERT OR IGNORE INTO net_worth_snapshots (user_id, month, total_assets, total_liabilities, net_worth)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, prev.key, currentSnapshot.total_assets, currentSnapshot.total_liabilities, currentSnapshot.net_worth]
    );
  }
  const netWorth = await computeNetWorthChange(userId, monthBeforePrev, currentSnapshot);

  const topAction = await computeTopAction(userId);

  const goalSnapshot = (await pool.query(
    'SELECT id, current_progress FROM goals WHERE user_id = $1',
    [userId]
  )).rows;

  const report = {
    user_id:          userId,
    month:            prev.key,
    month_label:      monthLabel,
    savings_recovered: savings,
    invested:         parseFloat(invested.toFixed(2)),
    goals,
    goal_snapshot:    goalSnapshot,
    net_worth:        netWorth,
    top_action:       topAction,
  };

  const text = renderReportText(report);

  await pool.query(
    `INSERT OR REPLACE INTO monthly_reports (user_id, month, data_json) VALUES ($1, $2, $3)`,
    [userId, prev.key, JSON.stringify(report)]
  );
  await pool.query(
    `INSERT INTO notifications (user_id, type, title, body, data_json)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, 'monthly_report', `Your ${monthLabel} Wealth Report`, text, JSON.stringify(report)]
  );

  if (opts.email && opts.sendEmail) {
    try {
      await opts.sendEmail({ to: opts.email, subject: `MoneyMind — Your ${monthLabel} Wealth Report`, text });
    } catch (err) {
      console.error('Email delivery failed:', err.message);
    }
  }

  return { report, text };
}

async function runForAllUsers(opts = {}) {
  const users = (await pool.query('SELECT id, email FROM users')).rows;
  const out = [];
  for (const u of users) {
    try {
      const res = await generateMonthlyReport(u.id, { ...opts, email: u.email });
      out.push({ user_id: u.id, ok: true, month: res.report.month });
    } catch (err) {
      console.error(`Monthly report failed for user ${u.id}:`, err.message);
      out.push({ user_id: u.id, ok: false, error: err.message });
    }
  }
  return out;
}

function scheduleMonthlyReports() {
  let lastRunMonth = null;
  const check = async () => {
    const now = new Date();
    const key = monthKey(now);
    if (now.getDate() === 1 && lastRunMonth !== key) {
      lastRunMonth = key;
      console.log(`[monthly-report] running for ${key}...`);
      await runForAllUsers();
    }
  };
  setInterval(check, 60 * 60 * 1000); // hourly
  check();
}

module.exports = { generateMonthlyReport, runForAllUsers, scheduleMonthlyReports, renderReportText };

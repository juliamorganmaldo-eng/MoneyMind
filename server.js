require('dotenv').config({ path: require('path').join(__dirname, '../plaid-integration/.env') });

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { Configuration, PlaidApi, PlaidEnvironments } = require('plaid');
const Anthropic = require('@anthropic-ai/sdk').default;
const fs   = require('fs');
const path = require('path');
const db = require('./db');

// ── Plaid client ──────────────────────────────────────────────────────────────

const plaidClient = new PlaidApi(new Configuration({
  basePath: PlaidEnvironments[process.env.PLAID_ENV || 'sandbox'],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
      'PLAID-SECRET':    process.env.PLAID_SECRET,
    },
  },
}));

const ACCOUNTS = {
  chase:       process.env.PLAID_ACCESS_TOKEN_CHASE,
  wells_fargo: process.env.PLAID_ACCESS_TOKEN_WELLS_FARGO,
  discover:    process.env.PLAID_ACCESS_TOKEN_DISCOVER,
};

const anthropic   = new Anthropic(); // reads ANTHROPIC_API_KEY from env
const ACTIONS_DIR = path.join(__dirname, 'actions');
if (!fs.existsSync(ACTIONS_DIR)) fs.mkdirSync(ACTIONS_DIR, { recursive: true });

function sanitizeFilename(name) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalizeMerchant(name) {
  if (!name) return 'unknown';
  return name.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

function detectInterval(gaps) {
  if (gaps.length === 0) return null;
  const median = gaps.slice().sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
  if (median >= 2  && median <= 9)   return 'weekly';
  if (median >= 25 && median <= 35)  return 'monthly';
  if (median >= 80 && median <= 100) return 'quarterly';
  if (median >= 340 && median <= 390) return 'annual';
  return null;
}

// ── Tool implementations ──────────────────────────────────────────────────────

async function syncTransactions({ days_back = 90 } = {}) {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days_back);
  const start = startDate.toISOString().split('T')[0];
  const end   = new Date().toISOString().split('T')[0];

  const upsert = db.prepare(`
    INSERT OR REPLACE INTO transactions (id, account, date, merchant, amount, category, raw_json)
    VALUES (@id, @account, @date, @merchant, @amount, @category, @raw_json)
  `);

  const results = {};

  for (const [account, accessToken] of Object.entries(ACCOUNTS)) {
    if (!accessToken) {
      results[account] = { error: 'No access token configured' };
      continue;
    }
    try {
      const res = await plaidClient.transactionsGet({
        access_token: accessToken,
        start_date: start,
        end_date: end,
      });
      const rows = res.data.transactions.map(t => ({
        id:       t.transaction_id,
        account,
        date:     t.date,
        merchant: t.merchant_name || t.name,
        amount:   t.amount,
        category: (t.category || []).join(' > '),
        raw_json: JSON.stringify(t),
      }));
      db.exec('BEGIN');
      for (const r of rows) upsert.run(r);
      db.exec('COMMIT');
      results[account] = { synced: rows.length, date_range: `${start} → ${end}` };
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch (_) {}
      results[account] = { error: err.response?.data?.error_message || err.message };
    }
  }

  return results;
}

function detectRecurringCharges({ min_occurrences = 2 } = {}) {
  const rows = db.prepare(`
    SELECT merchant, account, date, amount
    FROM transactions
    ORDER BY merchant, date
  `).all();

  // Group by normalized merchant
  const byMerchant = {};
  for (const row of rows) {
    const key = normalizeMerchant(row.merchant);
    if (!byMerchant[key]) byMerchant[key] = [];
    byMerchant[key].push(row);
  }

  const recurring = [];
  for (const [merchant, txns] of Object.entries(byMerchant)) {
    if (txns.length < min_occurrences) continue;

    const dates = txns.map(t => new Date(t.date).getTime()).sort((a, b) => a - b);
    const gaps  = [];
    for (let i = 1; i < dates.length; i++) {
      gaps.push(Math.round((dates[i] - dates[i - 1]) / 86400000));
    }

    const interval = detectInterval(gaps);
    if (!interval) continue;

    const amounts  = txns.map(t => t.amount);
    const avgAmt   = amounts.reduce((s, a) => s + a, 0) / amounts.length;
    const accounts = [...new Set(txns.map(t => t.account))];

    recurring.push({
      merchant:   txns[0].merchant,
      interval,
      occurrences: txns.length,
      avg_amount:  parseFloat(avgAmt.toFixed(2)),
      accounts,
      last_charge: txns[txns.length - 1].date,
    });
  }

  return recurring.sort((a, b) => b.occurrences - a.occurrences);
}

function findDuplicateSubscriptions() {
  const rows = db.prepare(`
    SELECT merchant, account, amount, date
    FROM transactions
    ORDER BY merchant, date DESC
  `).all();

  // Group by normalized merchant, then by account (most recent charge per account)
  const byMerchant = {};
  for (const row of rows) {
    const key = normalizeMerchant(row.merchant);
    if (!byMerchant[key]) byMerchant[key] = {};
    if (!byMerchant[key][row.account]) {
      byMerchant[key][row.account] = { amount: row.amount, date: row.date, merchant: row.merchant };
    }
  }

  const duplicates = [];
  for (const [, accountMap] of Object.entries(byMerchant)) {
    const entries = Object.entries(accountMap); // [[account, {amount, date, merchant}]]
    if (entries.length < 2) continue;

    const amounts = entries.map(([, v]) => v.amount);
    const minAmt  = Math.min(...amounts);
    const maxAmt  = Math.max(...amounts);

    // Flag if amounts are within 20% of each other (same subscription tier)
    if (minAmt > 0 && (maxAmt - minAmt) / minAmt <= 0.20) {
      duplicates.push({
        merchant:    entries[0][1].merchant,
        found_on:    entries.map(([account, v]) => ({ account, amount: v.amount, last_charge: v.date })),
        total_monthly_waste: parseFloat((amounts.slice(1).reduce((s, a) => s + a, 0)).toFixed(2)),
      });
    }
  }

  return duplicates;
}

function detectPriceChanges({ threshold_pct = 10 } = {}) {
  const rows = db.prepare(`
    SELECT merchant, account, date, amount
    FROM transactions
    ORDER BY merchant, date ASC
  `).all();

  const byMerchant = {};
  for (const row of rows) {
    const key = normalizeMerchant(row.merchant);
    if (!byMerchant[key]) byMerchant[key] = [];
    byMerchant[key].push(row);
  }

  const changes = [];
  for (const [, txns] of Object.entries(byMerchant)) {
    if (txns.length < 2) continue;

    for (let i = 1; i < txns.length; i++) {
      const prev = txns[i - 1];
      const curr = txns[i];
      if (prev.amount === 0) continue;

      const pctChange = ((curr.amount - prev.amount) / Math.abs(prev.amount)) * 100;
      if (Math.abs(pctChange) >= threshold_pct) {
        changes.push({
          merchant:    curr.merchant,
          account:     curr.account,
          from_amount: prev.amount,
          to_amount:   curr.amount,
          change_pct:  parseFloat(pctChange.toFixed(1)),
          from_date:   prev.date,
          to_date:     curr.date,
          direction:   pctChange > 0 ? 'increase' : 'decrease',
        });
      }
    }
  }

  return changes.sort((a, b) => Math.abs(b.change_pct) - Math.abs(a.change_pct));
}

function saveFindings({ type, title, description, data }) {
  const stmt = db.prepare(`
    INSERT INTO findings (type, title, description, data_json)
    VALUES (@type, @title, @description, @data_json)
  `);
  const info = stmt.run({
    type,
    title,
    description: description || null,
    data_json:   data ? JSON.stringify(data) : null,
  });
  return { id: info.lastInsertRowid, type, title };
}

async function draftEmail({ merchant, issue_type, current_charge }) {
  const goal = issue_type === 'negotiation'
    ? `negotiate a lower rate on your current $${current_charge}/month charge`
    : `cancel your subscription charged at $${current_charge}/month`;

  const stream = anthropic.messages.stream({
    model: 'claude-opus-4-6',
    max_tokens: 1500,
    thinking: { type: 'adaptive' },
    system: 'You are an expert consumer advocate who writes highly effective, professional emails to companies. Your emails are concise, firm, and get results.',
    messages: [{
      role: 'user',
      content: `Write a professional email to ${merchant} to ${goal}.

Requirements:
- Start with "Subject:" on the first line
- Professional but assertive tone
- Reference competition or alternatives where relevant
- Include a specific, clear ask
- Set a deadline for response (5–7 business days)
- End with a polite but firm closing

Write only the email, ready to send.`,
    }],
  });

  const message = await stream.finalMessage();
  const content = message.content.filter(b => b.type === 'text').map(b => b.text).join('\n');

  const filename = `email_${sanitizeFilename(merchant)}_${Date.now()}.json`;
  const record   = { type: 'email', merchant, issue_type, current_charge, content, status: 'draft', created_at: new Date().toISOString(), filename };
  fs.writeFileSync(path.join(ACTIONS_DIR, filename), JSON.stringify(record, null, 2));
  return { saved_to: `actions/${filename}`, status: 'draft', content };
}

async function draftDisputeLetter({ merchant, charge_dates, amounts }) {
  const chargeList    = charge_dates.map((date, i) => `  - ${date}: $${amounts[i]}`).join('\n');
  const totalAmount   = amounts.reduce((s, a) => s + a, 0).toFixed(2);

  const stream = anthropic.messages.stream({
    model: 'claude-opus-4-6',
    max_tokens: 2000,
    thinking: { type: 'adaptive' },
    system: 'You are a consumer rights expert who writes formal, legally-sound billing dispute letters that cite relevant regulations and are structured to get results.',
    messages: [{
      role: 'user',
      content: `Write a formal billing dispute letter to ${merchant} regarding these charges:
${chargeList}
Total disputed: $${totalAmount}

Requirements:
- Formal letter format with date and address placeholders ([Your Name], [Your Address], [Date])
- Reference the Fair Credit Billing Act (FCBA) where applicable
- Clearly state each disputed charge and the reason for dispute
- Demand written confirmation of receipt within 30 days
- Request full reversal and written explanation
- Note intent to escalate to credit card issuer or CFPB if unresolved
- Professional signature block placeholder

Write only the letter, formatted for print.`,
    }],
  });

  const message = await stream.finalMessage();
  const content = message.content.filter(b => b.type === 'text').map(b => b.text).join('\n');

  const filename = `dispute_${sanitizeFilename(merchant)}_${Date.now()}.json`;
  const record   = { type: 'dispute_letter', merchant, charge_dates, amounts, total_disputed: parseFloat(totalAmount), content, status: 'draft', created_at: new Date().toISOString(), filename };
  fs.writeFileSync(path.join(ACTIONS_DIR, filename), JSON.stringify(record, null, 2));
  return { saved_to: `actions/${filename}`, status: 'draft', total_disputed: parseFloat(totalAmount), content };
}

async function draftPhoneScript({ merchant, goal }) {
  const stream = anthropic.messages.stream({
    model: 'claude-opus-4-6',
    max_tokens: 2500,
    thinking: { type: 'adaptive' },
    system: 'You are an expert negotiator and consumer advocate who creates effective, word-for-word call scripts. Your scripts prepare people for any response and help them achieve their goal.',
    messages: [{
      role: 'user',
      content: `Write a complete, word-for-word phone call script for calling ${merchant} with this goal: ${goal}

Structure the script with these sections:
1. **Before You Call** — what to have ready (account number, dates, amounts, etc.)
2. **Opening** — exact words when the agent picks up
3. **State Your Purpose** — clear, confident statement of why you're calling
4. **Talking Points** — 3–4 key points to make your case
5. **Handling Objections** — word-for-word responses to at least 3 likely pushbacks:
   - "That's not our policy" / "I can't do that"
   - Transfer attempts / stalling tactics
   - Offers of partial solutions that don't meet your goal
6. **Escalation** — exact words to ask for a supervisor if needed
7. **Closing** — how to confirm the outcome and get a confirmation number

Use [BRACKETED TEXT] for fill-in fields. Label responses as "You:" and agent responses as "Agent:".`,
    }],
  });

  const message = await stream.finalMessage();
  const content = message.content.filter(b => b.type === 'text').map(b => b.text).join('\n');

  const filename = `script_${sanitizeFilename(merchant)}_${Date.now()}.json`;
  const record   = { type: 'phone_script', merchant, goal, content, status: 'draft', created_at: new Date().toISOString(), filename };
  fs.writeFileSync(path.join(ACTIONS_DIR, filename), JSON.stringify(record, null, 2));
  return { saved_to: `actions/${filename}`, status: 'draft', content };
}

function getSavedActions() {
  if (!fs.existsSync(ACTIONS_DIR)) return [];
  return fs.readdirSync(ACTIONS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(filename => {
      try {
        const record = JSON.parse(fs.readFileSync(path.join(ACTIONS_DIR, filename), 'utf8'));
        return {
          filename:    record.filename,
          type:        record.type,
          merchant:    record.merchant,
          status:      record.status,
          created_at:  record.created_at,
          preview:     (record.content || '').slice(0, 160).replace(/\n/g, ' ').trim() + '…',
          ...(record.issue_type        && { issue_type:      record.issue_type }),
          ...(record.goal              && { goal:            record.goal }),
          ...(record.total_disputed != null && { total_disputed: record.total_disputed }),
        };
      } catch (_) {
        return { filename, error: 'Could not parse file' };
      }
    })
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
}

// ── MCP server ────────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'moneymind', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'sync_transactions',
      description: 'Fetch and store transactions from Chase, Wells Fargo, and Discover via Plaid. Defaults to last 90 days.',
      inputSchema: {
        type: 'object',
        properties: {
          days_back: { type: 'number', description: 'How many days back to sync (default: 90)' },
        },
      },
    },
    {
      name: 'detect_recurring_charges',
      description: 'Analyze stored transactions to find recurring charges (weekly, monthly, quarterly, annual).',
      inputSchema: {
        type: 'object',
        properties: {
          min_occurrences: { type: 'number', description: 'Minimum times a charge must appear (default: 2)' },
        },
      },
    },
    {
      name: 'find_duplicate_subscriptions',
      description: 'Find the same subscription or merchant charged across multiple accounts.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'detect_price_changes',
      description: 'Detect merchants where the charge amount has changed over time.',
      inputSchema: {
        type: 'object',
        properties: {
          threshold_pct: { type: 'number', description: 'Minimum % change to flag (default: 10)' },
        },
      },
    },
    {
      name: 'save_findings',
      description: 'Save an analysis finding to the local database.',
      inputSchema: {
        type: 'object',
        required: ['type', 'title'],
        properties: {
          type:        { type: 'string', enum: ['recurring', 'duplicate_subscription', 'price_change', 'other'] },
          title:       { type: 'string', description: 'Short title for the finding' },
          description: { type: 'string', description: 'Detailed description' },
          data:        { type: 'object', description: 'Structured data to store with the finding' },
        },
      },
    },
    {
      name: 'draft_email',
      description: 'Write a professional rate-negotiation or cancellation email for a merchant and save it to the actions/ folder.',
      inputSchema: {
        type: 'object',
        required: ['merchant', 'issue_type', 'current_charge'],
        properties: {
          merchant:       { type: 'string',  description: 'Merchant or company name' },
          issue_type:     { type: 'string',  enum: ['negotiation', 'cancellation'], description: 'Goal of the email' },
          current_charge: { type: 'number',  description: 'Current monthly charge amount in dollars' },
        },
      },
    },
    {
      name: 'draft_dispute_letter',
      description: 'Write a formal billing dispute letter for a merchant and save it to the actions/ folder.',
      inputSchema: {
        type: 'object',
        required: ['merchant', 'charge_dates', 'amounts'],
        properties: {
          merchant:     { type: 'string', description: 'Merchant or company name' },
          charge_dates: { type: 'array',  items: { type: 'string' }, description: 'List of charge dates (YYYY-MM-DD)' },
          amounts:      { type: 'array',  items: { type: 'number' }, description: 'List of disputed amounts in dollars, matching charge_dates' },
        },
      },
    },
    {
      name: 'draft_phone_script',
      description: 'Write a word-for-word call script with talking points and counterarguments, saved to the actions/ folder.',
      inputSchema: {
        type: 'object',
        required: ['merchant', 'goal'],
        properties: {
          merchant: { type: 'string', description: 'Merchant or company name to call' },
          goal:     { type: 'string', description: 'What you want to achieve (e.g. "cancel subscription", "negotiate lower rate")' },
        },
      },
    },
    {
      name: 'get_saved_actions',
      description: 'List all drafts saved in the actions/ folder with their type, merchant, status, and a short preview.',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result;

    switch (name) {
      case 'sync_transactions':
        result = await syncTransactions(args);
        break;
      case 'detect_recurring_charges':
        result = detectRecurringCharges(args);
        break;
      case 'find_duplicate_subscriptions':
        result = findDuplicateSubscriptions();
        break;
      case 'detect_price_changes':
        result = detectPriceChanges(args);
        break;
      case 'save_findings':
        result = saveFindings(args);
        break;
      case 'draft_email':
        result = await draftEmail(args);
        break;
      case 'draft_dispute_letter':
        result = await draftDisputeLetter(args);
        break;
      case 'draft_phone_script':
        result = await draftPhoneScript(args);
        break;
      case 'get_saved_actions':
        result = getSavedActions();
        break;
      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error: ${err.message}` }],
      isError: true,
    };
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('MoneyMind MCP server running on stdio');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});

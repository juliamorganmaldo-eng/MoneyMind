// Dashboard interactivity:
//   • Plaid Link: Connect Bank flow (link token → drop-in → exchange).
//   • /api/accounts:   render grouped institution cards + Net Position.
//   • /api/transactions?per_page=10:  render Recent Transactions.
//   • POST /api/transactions/sync:    Sync button.
//   • Last synced: relative-time formatter on the data-since attribute.

(function () {
  'use strict';

  // ── helpers ───────────────────────────────────────────────────────────
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function formatUSD(n) {
    var v = Number(n);
    if (!isFinite(v)) return '—';
    return v.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  }
  function timeAgo(iso) {
    var ms = Date.now() - Date.parse(iso);
    if (!isFinite(ms) || ms < 0) return '';
    var s = Math.round(ms / 1000);
    if (s < 60)    return 'just now';
    var m = Math.round(s / 60);
    if (m < 60)    return m + ' minute' + (m === 1 ? '' : 's') + ' ago';
    var h = Math.round(m / 60);
    if (h < 24)    return h + ' hour'   + (h === 1 ? '' : 's') + ' ago';
    var d = Math.round(h / 24);
    return d + ' day' + (d === 1 ? '' : 's') + ' ago';
  }
  function titleCase(s) {
    return String(s || '').split(/[\s_-]+/).map(function (w) {
      return w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : '';
    }).join(' ');
  }

  // ── connect bank (Plaid Link) ─────────────────────────────────────────
  var connectBtn = document.getElementById('connect-bank');
  var connectStatus = document.getElementById('connect-status');

  function showConnect(text, kind) {
    connectStatus.textContent = text;
    connectStatus.className = 'alert ' + (kind === 'error' ? 'alert-error' : 'alert-info');
    connectStatus.hidden = false;
  }
  function clearConnect() { connectStatus.hidden = true; connectStatus.textContent = ''; }

  async function startLink() {
    clearConnect();
    connectBtn.disabled = true;
    var linkToken;
    try {
      var r = await fetch('/api/plaid/create-link-token', { method: 'POST', credentials: 'same-origin' });
      if (!r.ok) throw new Error('status ' + r.status);
      linkToken = (await r.json()).link_token;
    } catch (e) {
      connectBtn.disabled = false;
      showConnect('Could not start Plaid Link. Check the server logs.', 'error');
      return;
    }
    var handler = Plaid.create({
      token: linkToken,
      onSuccess: async function (publicToken) {
        showConnect('Connecting…', 'info');
        try {
          var r2 = await fetch('/api/plaid/exchange-public-token', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ public_token: publicToken }),
          });
          if (!r2.ok) {
            var j = await r2.json().catch(function () { return {}; });
            throw new Error(j.error || ('status ' + r2.status));
          }
          window.location.reload();
        } catch (e) {
          connectBtn.disabled = false;
          showConnect('Could not save the bank: ' + e.message, 'error');
        }
      },
      onExit: function (err) {
        connectBtn.disabled = false;
        if (err) showConnect(err.display_message || err.error_message || 'Plaid Link closed.', 'error');
      },
    });
    handler.open();
  }
  if (connectBtn) connectBtn.addEventListener('click', startLink);

  // ── Net Position + grouped accounts (from /api/accounts) ─────────────
  var ASSET_TYPES = { depository: 1, investment: 1 };
  var LIAB_TYPES = { credit: 1, loan: 1 };

  function renderAccountCard(a) {
    var sub = titleCase(a.subtype || a.type || '');
    var mask = a.mask ? '•••• ' + escapeHtml(a.mask) : '';
    var current = formatUSD(a.current_balance);
    var avail = '';
    if (a.available_balance != null && Number(a.available_balance) !== Number(a.current_balance)) {
      avail = '<div class="acct-available">' + formatUSD(a.available_balance) + ' available</div>';
    }
    return '<div class="account-card">'
      + '<div class="acct-row1">'
      +   '<span class="acct-name">' + escapeHtml(a.name || 'Account') + '</span> '
      +   '<span class="acct-mask">' + mask + '</span>'
      + '</div>'
      + '<div class="acct-row2"><span class="acct-type">' + escapeHtml(sub) + '</span>'
      +   '<span class="acct-balance">' + current + '</span></div>'
      + avail
      + '</div>';
  }

  async function loadAccounts() {
    var instList = document.getElementById('institutions-list');
    if (!instList) return;
    try {
      var r = await fetch('/api/accounts', { credentials: 'same-origin' });
      if (!r.ok) throw new Error('status ' + r.status);
      var accounts = (await r.json()).accounts || [];

      // Group by institution (plaid_item_id, since name is repeated).
      var groups = new Map();
      var groupOrder = [];
      for (var i = 0; i < accounts.length; i++) {
        var a = accounts[i];
        var key = a.plaid_item_id;
        if (!groups.has(key)) {
          groups.set(key, { name: a.institution_name || 'Unnamed institution', accts: [] });
          groupOrder.push(key);
        }
        groups.get(key).accts.push(a);
      }

      var html = '';
      for (var j = 0; j < groupOrder.length; j++) {
        var g = groups.get(groupOrder[j]);
        html += '<div class="institution-group">'
          + '<div class="institution-name">' + escapeHtml(g.name) + '</div>'
          + '<div class="account-cards">' + g.accts.map(renderAccountCard).join('') + '</div>'
          + '</div>';
      }
      instList.innerHTML = html || '<p class="empty">No accounts found.</p>';
    } catch (e) {
      instList.innerHTML = '<p class="empty">Could not load accounts.</p>';
    }
  }

  // ── Net worth headline (replaces the old per-account sum) ────────────
  function fmtCents(cents) {
    if (cents == null) return '—';
    return (Number(cents) / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  }

  async function loadNetWorth() {
    var totalEl  = document.getElementById('nw-total');
    var assetsEl = document.getElementById('nw-assets');
    var liabsEl  = document.getElementById('nw-liabs');
    if (!totalEl) return;
    try {
      var r = await fetch('/api/net-worth', { credentials: 'same-origin' });
      if (!r.ok) throw new Error('status ' + r.status);
      var j = await r.json();
      totalEl.textContent = fmtCents(j.current_total_cents);
      totalEl.classList.remove('net-positive', 'net-negative');
      totalEl.classList.add(j.current_total_cents >= 0 ? 'net-positive' : 'net-negative');
      assetsEl.textContent = fmtCents(j.assets_total_cents);
      liabsEl.textContent  = fmtCents(j.liabilities_total_cents);
    } catch (e) {
      totalEl.textContent = '—';
    }
  }

  async function loadMiniChart() {
    var el = document.getElementById('nw-mini-chart');
    if (!el) return;
    try {
      var r = await fetch('/api/net-worth/history?months=12', { credentials: 'same-origin' });
      if (!r.ok) throw new Error('status ' + r.status);
      var rows = (await r.json()).history || [];
      if (rows.length < 2) {
        el.innerHTML = '<div class="chart-meta">Need ≥ 2 daily snapshots for a trend line. Sync more often to build history.</div>';
        return;
      }
      var W = 720, H = 80, P = 6;
      var values = rows.map(function (r) { return Number(r.net_worth_cents || 0); });
      var min = Math.min.apply(null, values);
      var max = Math.max.apply(null, values);
      if (min === max) { min -= 100; max += 100; }
      var n = rows.length;
      var pts = rows.map(function (r, i) {
        var x = P + (i * (W - 2*P) / (n - 1));
        var y = H - P - ((values[i] - min) / (max - min)) * (H - 2*P);
        return x + ',' + y;
      }).join(' ');
      el.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" class="line-svg-mini">'
        + '<polyline fill="none" stroke="#15803D" stroke-width="2" points="' + pts + '"/></svg>';
    } catch (e) {
      el.innerHTML = '';
    }
  }

  // Refresh balances button on dashboard
  var refreshBtn = document.getElementById('refresh-balances-btn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', async function () {
      refreshBtn.disabled = true;
      var prev = refreshBtn.textContent;
      refreshBtn.textContent = 'Refreshing…';
      try {
        var r = await fetch('/api/balances/refresh', { method: 'POST', credentials: 'same-origin' });
        if (!r.ok) throw new Error('status ' + r.status);
        await Promise.all([loadAccounts(), loadNetWorth(), loadMiniChart()]);
      } catch (e) {
        // silently — the balances page has its own error UI
      } finally {
        refreshBtn.disabled = false;
        refreshBtn.textContent = prev;
      }
    });
  }

  // ── Recent Transactions (10) ──────────────────────────────────────────
  function fmtAmount(amt, ccy) {
    var n = Number(amt);
    if (!isFinite(n)) return '';
    var symbol = ccy === 'USD' ? '$' : (ccy ? ccy + ' ' : '');
    var sign = n > 0 ? '−' : (n < 0 ? '+' : '');
    return sign + symbol + Math.abs(n).toFixed(2);
  }
  function txnSign(amt) { return Number(amt) > 0 ? 'out' : 'in'; }

  async function loadRecent() {
    var listEl = document.getElementById('txn-list');
    if (!listEl) return;
    try {
      var r = await fetch('/api/transactions?per_page=10', { credentials: 'same-origin' });
      if (!r.ok) throw new Error('status ' + r.status);
      var rows = (await r.json()).transactions || [];
      if (rows.length === 0) {
        listEl.className = 'empty';
        listEl.innerHTML = 'No transactions yet. Click <strong>↻ Sync transactions</strong> to fetch them.';
        return;
      }
      listEl.className = '';
      listEl.innerHTML = '<ul class="txn-list">' + rows.map(function (t) {
        return '<li class="txn">'
          + '<span class="txn-date">' + escapeHtml(t.date || '') + '</span>'
          + '<span class="txn-name">' + escapeHtml(t.merchant_name || t.name || 'Unknown')
            + (t.pending ? ' <span class="txn-pending">pending</span>' : '')
            + '</span>'
          + '<span class="txn-amount txn-' + txnSign(t.amount) + '">'
            + escapeHtml(fmtAmount(t.amount, t.iso_currency_code))
            + '</span>'
          + '</li>';
      }).join('') + '</ul>';
    } catch (e) {
      listEl.className = 'empty';
      listEl.innerHTML = 'Could not load transactions.';
    }
  }

  // ── Sync button ───────────────────────────────────────────────────────
  var syncBtn = document.getElementById('sync-btn');
  var syncStatus = document.getElementById('sync-status');

  if (syncBtn) {
    syncBtn.addEventListener('click', async function () {
      syncBtn.disabled = true;
      var prevText = syncBtn.textContent;
      syncBtn.textContent = 'Syncing…';
      syncStatus.hidden = false;
      syncStatus.className = 'alert alert-info';
      syncStatus.textContent = 'Syncing…';
      try {
        var r = await fetch('/api/transactions/sync', { method: 'POST', credentials: 'same-origin' });
        if (!r.ok) {
          var j = await r.json().catch(function () { return {}; });
          throw new Error(j.error || ('status ' + r.status));
        }
        var c = await r.json();
        var parts = ['Added ' + c.added_count + ' new transaction' + (c.added_count === 1 ? '' : 's')];
        if (c.modified_count) parts.push('updated ' + c.modified_count);
        if (c.removed_count)  parts.push('removed ' + c.removed_count);
        syncStatus.textContent = parts.join(', ') + '.';
        // Refresh everything — sync may have changed balances, transactions,
        // per-category totals, and net-worth headline.
        await Promise.all([loadAccounts(), loadRecent(), loadSpending(),
                           loadNetWorth(), loadMiniChart()]);
        // Bump the last-synced timestamp.
        var ls = document.getElementById('last-synced');
        if (ls) {
          ls.dataset.since = new Date().toISOString();
          renderLastSynced();
        }
      } catch (e) {
        syncStatus.className = 'alert alert-error';
        syncStatus.textContent = 'Sync failed: ' + e.message;
      } finally {
        syncBtn.disabled = false;
        syncBtn.textContent = prevText;
      }
    });
  }

  // ── Last-synced rendering ─────────────────────────────────────────────
  function renderLastSynced() {
    var el = document.getElementById('last-synced');
    if (!el) return;
    var since = el.dataset.since;
    if (!since || since === 'null' || since === '') { el.textContent = ''; return; }
    el.textContent = 'Last synced ' + timeAgo(since);
  }
  renderLastSynced();
  // Refresh the relative time every 30s so "1 minute ago" doesn't go stale.
  setInterval(renderLastSynced, 30000);

  // ── Spending This Month chart ────────────────────────────────────────
  async function loadSpending() {
    var chart = document.getElementById('spending-chart');
    if (!chart) return;
    try {
      var r = await fetch('/api/categories', { credentials: 'same-origin' });
      if (!r.ok) throw new Error('status ' + r.status);
      var cats = (await r.json()).categories || [];
      var max = 0;
      for (var i = 0; i < cats.length; i++) {
        var s = Number(cats[i].current_month_spend) || 0;
        if (s > max) max = s;
      }
      if (max === 0) {
        chart.className = 'empty';
        chart.innerHTML = 'No spending recorded this month yet.';
        return;
      }
      chart.className = '';
      chart.innerHTML = '<div class="spending-list">' + cats.map(function (c) {
        var spend = Number(c.current_month_spend) || 0;
        var pct = max > 0 ? Math.round((spend / max) * 100) : 0;
        return '<div class="spending-row">'
          + '<span class="spending-name">'
          +   '<span class="cat-color cat-color-' + c.display_order + '" aria-hidden="true"></span>'
          +   escapeHtml(c.name)
          + '</span>'
          + '<span class="spending-bar"><span class="spending-fill cat-fill-' + c.display_order + '" style="width:' + pct + '%"></span></span>'
          + '<span class="spending-amount">' + formatUSD(spend) + '</span>'
          + '</div>';
      }).join('') + '</div>';
    } catch (e) {
      chart.className = 'empty';
      chart.innerHTML = 'Could not load spending breakdown.';
    }
  }

  // ── Alerts panel (top-of-dashboard, hidden when nothing to show) ──────
  function fmtUSDFromCents(cents) {
    if (cents == null) return '';
    return (Number(cents) / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  }

  async function loadAlerts() {
    var panel = document.getElementById('alerts-panel');
    var list = document.getElementById('alerts-panel-list');
    if (!panel || !list) return;
    var items = [];
    // Run both fetches in parallel — independent and small.
    try {
      var three = await Promise.all([
        fetch('/api/budget-limits',          { credentials: 'same-origin' }).then(function (r) { return r.ok ? r.json() : { budget_limits: [] }; }),
        fetch('/api/low-balance-thresholds', { credentials: 'same-origin' }).then(function (r) { return r.ok ? r.json() : { thresholds: [] }; }),
        fetch('/api/subscriptions',          { credentials: 'same-origin' }).then(function (r) { return r.ok ? r.json() : { subscriptions: [] }; }),
      ]);
      var budgets = three[0].budget_limits || [];
      var thresholds = three[1].thresholds || [];
      var subs = three[2].subscriptions || [];

      for (var i = 0; i < budgets.length; i++) {
        var b = budgets[i];
        if (b.status === 'warning' || b.status === 'over') {
          items.push({
            kind: 'budget',
            severity: b.status,
            text: escapeHtml(b.category_name) + ': ' + (b.pct_used != null ? b.pct_used + '%' : '—')
                + ' of ' + fmtUSDFromCents(b.monthly_limit_cents) + ' budget'
                + (b.status === 'over' ? ' (over)' : ''),
            href: '/budgets',
          });
        }
      }
      for (var j = 0; j < thresholds.length; j++) {
        var t = thresholds[j];
        if (t.triggered) {
          items.push({
            kind: 'low-balance',
            severity: 'warning',
            text: escapeHtml(t.account_name) + (t.mask ? ' ····' + escapeHtml(t.mask) : '')
                + ': ' + fmtUSDFromCents(t.current_balance_cents)
                + ' (below ' + fmtUSDFromCents(t.threshold_cents) + ' threshold)',
            href: '/alerts',
          });
        }
      }

      // Price-change alert: count active recurring charges where
      // price_change_detected=true AND the row was updated in the last 30 days.
      var THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
      var nowMs = Date.now();
      var priceChangeCount = 0;
      for (var k = 0; k < subs.length; k++) {
        var s = subs[k];
        if (s.status !== 'active' || !s.price_change_detected) continue;
        if (!s.updated_at) continue;
        if (nowMs - Date.parse(s.updated_at) <= THIRTY_DAYS_MS) priceChangeCount++;
      }
      if (priceChangeCount > 0) {
        items.push({
          kind: 'price-change',
          severity: 'warning',
          text: priceChangeCount + ' price change' + (priceChangeCount === 1 ? '' : 's')
              + ' detected this month',
          href: '/subscriptions',
        });
      }
    } catch (e) {
      // Quiet on error — alerts panel just stays hidden.
      return;
    }

    if (items.length === 0) {
      panel.hidden = true;
      return;
    }
    list.innerHTML = items.map(function (a) {
      return '<li class="alert-item alert-' + a.severity + '">'
        + '<span class="alert-icon">' + (a.severity === 'over' ? '🛑' : '⚠') + '</span> '
        + a.text + ' <a class="alert-link" href="' + a.href + '">view →</a>'
        + '</li>';
    }).join('');
    panel.hidden = false;
  }

  // ── kick off initial loads ────────────────────────────────────────────
  if (document.getElementById('institutions-list')) loadAccounts();
  if (document.getElementById('txn-list')) loadRecent();
  if (document.getElementById('spending-chart')) loadSpending();
  if (document.getElementById('alerts-panel')) loadAlerts();
  if (document.getElementById('nw-total')) loadNetWorth();
  if (document.getElementById('nw-mini-chart')) loadMiniChart();
})();

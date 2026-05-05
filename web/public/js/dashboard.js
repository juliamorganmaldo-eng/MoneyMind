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
  // The page may render either #connect-bank (when items > 0) OR
  // #connect-bank-hero (when items = 0 and verified) — never both at the
  // same time per the dashboard.ejs conditional. startLink() needs to
  // tolerate either being absent: build the trigger list at module load
  // and disable/enable whichever buttons are actually in the DOM.
  var connectBtns = ['connect-bank', 'connect-bank-hero']
    .map(function (id) { return document.getElementById(id); })
    .filter(Boolean);
  var connectStatus = document.getElementById('connect-status');

  function setConnectDisabled(disabled) {
    for (var i = 0; i < connectBtns.length; i++) connectBtns[i].disabled = disabled;
  }
  function showConnect(text, kind) {
    if (!connectStatus) return;
    connectStatus.textContent = text;
    connectStatus.className = 'alert ' + (kind === 'error' ? 'alert-error' : 'alert-info');
    connectStatus.hidden = false;
  }
  function clearConnect() {
    if (!connectStatus) return;
    connectStatus.hidden = true;
    connectStatus.textContent = '';
  }

  async function startLink() {
    clearConnect();
    setConnectDisabled(true);
    var linkToken;
    try {
      var r = await fetch('/api/plaid/create-link-token', { method: 'POST', credentials: 'same-origin' });
      if (r.status === 403) {
        var j403 = await r.json().catch(function () { return {}; });
        if (j403.error === 'email_not_verified') {
          setConnectDisabled(false);
          showConnect('Please verify your email before connecting a bank — check your inbox or click "Resend verification" above.', 'error');
          return;
        }
      }
      if (!r.ok) throw new Error('status ' + r.status);
      linkToken = (await r.json()).link_token;
    } catch (e) {
      setConnectDisabled(false);
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
          setConnectDisabled(false);
          showConnect('Could not save the bank: ' + e.message, 'error');
        }
      },
      onExit: function (err) {
        setConnectDisabled(false);
        if (err) showConnect(err.display_message || err.error_message || 'Plaid Link closed.', 'error');
      },
    });
    handler.open();
  }
  for (var bi = 0; bi < connectBtns.length; bi++) {
    connectBtns[bi].addEventListener('click', startLink);
  }

  // ── Resend verification (top banner for unverified users) ────────────
  var resendVerifyBtn = document.getElementById('resend-verify-btn');
  var resendVerifyMsg = document.getElementById('resend-verify-msg');
  if (resendVerifyBtn) {
    resendVerifyBtn.addEventListener('click', async function () {
      resendVerifyBtn.disabled = true;
      var prev = resendVerifyBtn.textContent;
      resendVerifyBtn.textContent = 'Sending…';
      resendVerifyMsg.hidden = true;
      try {
        var r = await fetch('/api/auth/resend-verification', { method: 'POST', credentials: 'same-origin' });
        var j = await r.json().catch(function () { return {}; });
        resendVerifyMsg.hidden = false;
        if (r.ok) resendVerifyMsg.textContent = 'Sent! Check your inbox.';
        else if (r.status === 429) resendVerifyMsg.textContent = 'Too many requests. Try again later.';
        else resendVerifyMsg.textContent = j.error || 'Could not send. Try again.';
      } catch (e) {
        resendVerifyMsg.hidden = false;
        resendVerifyMsg.textContent = 'Network error. Try again.';
      } finally {
        resendVerifyBtn.disabled = false;
        resendVerifyBtn.textContent = prev;
      }
    });
  }

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
        // per-category totals, net-worth headline, and findings.
        await Promise.all([loadAccounts(), loadRecent(), loadSpending(),
                           loadNetWorth(), loadMiniChart(), loadFindingsPanel()]);
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

  // ── Findings panel (top-of-dashboard, hidden when nothing to show) ────
  // Driven by /api/findings/dashboard which returns the top 3 by tier.
  function fmtUSDFromCents(cents) {
    if (cents == null) return '';
    return (Number(cents) / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  }

  async function loadFindingsPanel() {
    var panel = document.getElementById('findings-panel');
    var list = document.getElementById('findings-panel-list');
    var badge = document.getElementById('findings-new-badge');
    if (!panel || !list) return;
    try {
      var r = await fetch('/api/findings/dashboard', { credentials: 'same-origin' });
      if (!r.ok) throw new Error('status ' + r.status);
      var json = await r.json();
      var rows = json.findings || [];
      if (rows.length === 0) {
        panel.hidden = true; // hide entirely when nothing to show
        return;
      }
      list.innerHTML = rows.map(function (f) {
        return '<div class="f-card f-tier-' + f.tier + '" data-id="' + f.id + '" data-href="' + (f.deep_link_path || '') + '">'
          + '<div class="f-stripe"></div>'
          + '<div class="f-body">'
          +   '<div class="f-title">' + escapeHtml(f.title) + '</div>'
          +   '<div class="f-text">' + escapeHtml(f.body) + '</div>'
          + '</div>'
          + '<button class="f-dismiss" type="button" aria-label="Dismiss">×</button>'
          + '</div>';
      }).join('');
      if (json.new_since_last_visit > 0) {
        badge.hidden = false;
        badge.textContent = json.new_since_last_visit + ' new';
      } else {
        badge.hidden = true;
      }
      panel.hidden = false;
      list.querySelectorAll('.f-card').forEach(function (card) {
        var btn = card.querySelector('.f-dismiss');
        if (btn) btn.addEventListener('click', function (e) {
          e.stopPropagation();
          dismissFinding(card.dataset.id);
        });
        card.addEventListener('click', function () {
          var href = card.dataset.href;
          if (href) window.location.href = href;
        });
      });
    } catch (e) {
      // Quiet on error — panel stays hidden.
    }
  }

  async function dismissFinding(id) {
    try {
      await fetch('/api/findings/' + encodeURIComponent(id) + '/dismiss', {
        method: 'POST', credentials: 'same-origin',
      });
      loadFindingsPanel();
    } catch (e) { /* silent */ }
  }

  // ── kick off initial loads ────────────────────────────────────────────
  if (document.getElementById('institutions-list')) loadAccounts();
  if (document.getElementById('txn-list')) loadRecent();
  if (document.getElementById('spending-chart')) loadSpending();
  if (document.getElementById('findings-panel')) loadFindingsPanel();
  if (document.getElementById('nw-total')) loadNetWorth();
  if (document.getElementById('nw-mini-chart')) loadMiniChart();
})();

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
    var netEl = document.getElementById('net-amount');
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

      // Render
      var html = '';
      for (var j = 0; j < groupOrder.length; j++) {
        var g = groups.get(groupOrder[j]);
        html += '<div class="institution-group">'
          + '<div class="institution-name">' + escapeHtml(g.name) + '</div>'
          + '<div class="account-cards">' + g.accts.map(renderAccountCard).join('') + '</div>'
          + '</div>';
      }
      instList.innerHTML = html || '<p class="empty">No accounts found.</p>';

      // Net position
      var net = 0;
      for (var k = 0; k < accounts.length; k++) {
        var bal = Number(accounts[k].current_balance);
        if (!isFinite(bal)) continue;
        if (ASSET_TYPES[accounts[k].type]) net += bal;
        else if (LIAB_TYPES[accounts[k].type]) net -= bal;
      }
      netEl.textContent = formatUSD(net);
      netEl.classList.remove('net-positive', 'net-negative');
      netEl.classList.add(net >= 0 ? 'net-positive' : 'net-negative');
    } catch (e) {
      instList.innerHTML = '<p class="empty">Could not load accounts.</p>';
      netEl.textContent = '—';
    }
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
        // Refresh both panels — sync may have changed balances and transactions.
        await Promise.all([loadAccounts(), loadRecent()]);
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

  // ── kick off initial loads ────────────────────────────────────────────
  if (document.getElementById('institutions-list')) loadAccounts();
  if (document.getElementById('txn-list')) loadRecent();
})();

// /net-worth — totals, history line chart, accounts table with class edit.
(function () {
  'use strict';

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtUSDFromCents(cents) {
    if (cents == null) return '—';
    return (Number(cents) / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  }

  var totalEl = document.getElementById('nw-total');
  var assetsEl = document.getElementById('nw-assets');
  var liabsEl = document.getElementById('nw-liabs');
  var chartEl = document.getElementById('nw-chart');
  var acctsEl = document.getElementById('nw-accounts');
  var errEl = document.getElementById('nw-error');
  var statusEl = document.getElementById('nw-status');

  function showStatus(msg, kind) {
    statusEl.textContent = msg;
    statusEl.className = 'alert ' + (kind === 'error' ? 'alert-error' : 'alert-info');
    statusEl.hidden = false;
  }
  function clearStatus() { statusEl.hidden = true; statusEl.textContent = ''; }

  async function loadTotals() {
    try {
      var r = await fetch('/api/net-worth', { credentials: 'same-origin' });
      if (!r.ok) throw new Error('status ' + r.status);
      var j = await r.json();
      totalEl.textContent = fmtUSDFromCents(j.current_total_cents);
      totalEl.classList.remove('net-positive', 'net-negative');
      totalEl.classList.add(j.current_total_cents >= 0 ? 'net-positive' : 'net-negative');
      assetsEl.textContent = fmtUSDFromCents(j.assets_total_cents);
      liabsEl.textContent = fmtUSDFromCents(j.liabilities_total_cents);
      renderAccounts(j.accounts || []);
    } catch (e) {
      errEl.hidden = false;
      errEl.textContent = 'Could not load net worth: ' + e.message;
    }
  }

  function renderAccounts(accts) {
    if (accts.length === 0) {
      acctsEl.className = 'empty';
      acctsEl.innerHTML = 'No accounts yet.';
      return;
    }
    acctsEl.className = '';
    acctsEl.innerHTML = '<table class="acct-table"><thead><tr>'
      + '<th>Name</th><th>Type</th><th>Mask</th>'
      + '<th class="num">Balance</th><th>Class</th><th>Action</th></tr></thead>'
      + '<tbody>' + accts.map(function (a) {
        var clsBadge = '<span class="class-badge class-' + a.classification + '">'
          + a.classification.toUpperCase() + '</span>'
          + (a.is_override ? ' <span class="class-override">override</span>' : '');
        return '<tr data-aid="' + a.account_id + '">'
          + '<td>' + escapeHtml(a.name) + '</td>'
          + '<td>' + escapeHtml(a.subtype || a.type || '') + '</td>'
          + '<td class="mask">' + escapeHtml(a.mask || '') + '</td>'
          + '<td class="num">' + fmtUSDFromCents(a.current_balance_cents) + '</td>'
          + '<td>' + clsBadge + '</td>'
          + '<td><select class="class-select" data-aid="' + a.account_id + '">'
          +   '<option value="default" '   + (!a.is_override && !a.excluded_from_net_worth ? 'selected' : '') + '>Plaid default</option>'
          +   '<option value="asset" '     + (a.is_override && a.classification === 'asset' ? 'selected' : '') + '>Force asset</option>'
          +   '<option value="liability" ' + (a.is_override && a.classification === 'liability' ? 'selected' : '') + '>Force liability</option>'
          +   '<option value="excluded" '  + (a.excluded_from_net_worth ? 'selected' : '') + '>Exclude from net worth</option>'
          + '</select></td>'
          + '</tr>';
      }).join('') + '</tbody></table>';

    acctsEl.querySelectorAll('.class-select').forEach(function (sel) {
      sel.addEventListener('change', function () { saveClass(sel.dataset.aid, sel.value); });
    });
  }

  async function saveClass(aid, value) {
    clearStatus();
    var body;
    if (value === 'default')         body = { is_asset_override: null,  excluded_from_net_worth: false };
    else if (value === 'asset')      body = { is_asset_override: true,  excluded_from_net_worth: false };
    else if (value === 'liability')  body = { is_asset_override: false, excluded_from_net_worth: false };
    else if (value === 'excluded')   body = { excluded_from_net_worth: true };
    else return;

    try {
      var r = await fetch('/api/accounts/' + encodeURIComponent(aid) + '/classification', {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        var j = await r.json().catch(function () { return {}; });
        throw new Error(j.error || ('status ' + r.status));
      }
      showStatus('Updated.', 'info');
      loadTotals();
    } catch (e) {
      showStatus('Save failed: ' + e.message, 'error');
    }
  }

  // Tiny SVG line chart for net-worth history.
  async function loadHistory() {
    try {
      var r = await fetch('/api/net-worth/history?months=12', { credentials: 'same-origin' });
      if (!r.ok) throw new Error('status ' + r.status);
      var rows = (await r.json()).history || [];
      drawLineChart(chartEl, rows, 'net_worth_cents');
    } catch (e) {
      chartEl.className = 'empty';
      chartEl.innerHTML = 'Could not load history.';
    }
  }

  function drawLineChart(container, rows, key) {
    if (rows.length === 0) {
      container.className = 'empty';
      container.innerHTML = 'No snapshots yet. Sync transactions or refresh balances to start the history.';
      return;
    }
    container.className = '';
    var W = 720, H = 220, P = 30;
    var values = rows.map(function (r) { return Number(r[key] || 0); });
    var min = Math.min.apply(null, values);
    var max = Math.max.apply(null, values);
    if (min === max) { min -= 100; max += 100; }
    var n = rows.length;
    function x(i) { return P + (n === 1 ? (W - 2*P) / 2 : (i * (W - 2*P) / (n - 1))); }
    function y(v) { return H - P - ((v - min) / (max - min)) * (H - 2*P); }
    var pts = rows.map(function (r, i) { return x(i) + ',' + y(values[i]); }).join(' ');
    var dots = rows.map(function (r, i) {
      return '<circle cx="' + x(i) + '" cy="' + y(values[i]) + '" r="3" data-d="' + r.date + '" data-v="' + values[i] + '"/>';
    }).join('');
    container.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet" class="line-svg">'
      + '<polyline fill="none" stroke="#15803D" stroke-width="2" points="' + pts + '"/>'
      + dots
      + '</svg>'
      + '<div class="chart-meta">'
      +   '<span>min ' + (min/100).toLocaleString('en-US', { style:'currency', currency:'USD' }) + '</span>'
      +   '<span>max ' + (max/100).toLocaleString('en-US', { style:'currency', currency:'USD' }) + '</span>'
      +   '<span>' + n + ' point' + (n === 1 ? '' : 's') + '</span>'
      + '</div>';
    // Hover tooltip — appended to chart container as an absolute element
    var tip = document.createElement('div');
    tip.className = 'chart-tip';
    tip.hidden = true;
    container.appendChild(tip);
    container.querySelectorAll('circle').forEach(function (c) {
      c.addEventListener('mouseenter', function (e) {
        tip.textContent = c.dataset.d + ' · ' + (Number(c.dataset.v)/100).toLocaleString('en-US', { style:'currency', currency:'USD' });
        tip.hidden = false;
        var rect = container.getBoundingClientRect();
        tip.style.left = (e.clientX - rect.left + 8) + 'px';
        tip.style.top  = (e.clientY - rect.top + 8) + 'px';
      });
      c.addEventListener('mouseleave', function () { tip.hidden = true; });
    });
  }

  // Refresh balances button
  var refreshBtn = document.getElementById('refresh-btn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', async function () {
      clearStatus();
      refreshBtn.disabled = true;
      var prev = refreshBtn.textContent;
      refreshBtn.textContent = 'Refreshing…';
      try {
        var r = await fetch('/api/balances/refresh', { method: 'POST', credentials: 'same-origin' });
        if (!r.ok) throw new Error('status ' + r.status);
        var j = await r.json();
        showStatus('Refreshed ' + j.refreshed + ' account balance' + (j.refreshed === 1 ? '' : 's') + '.');
        await Promise.all([loadTotals(), loadHistory()]);
      } catch (e) {
        showStatus('Refresh failed: ' + e.message, 'error');
      } finally {
        refreshBtn.disabled = false;
        refreshBtn.textContent = prev;
      }
    });
  }

  loadTotals();
  loadHistory();
})();

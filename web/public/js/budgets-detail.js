// /budgets/:id — current-month transactions feeding a category's spend.
(function () {
  'use strict';

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtUSD(amt) {
    var n = Number(amt);
    if (!isFinite(n)) return '';
    return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  }

  var cat = window.__moneymind_category;
  var listEl = document.getElementById('bd-list');
  var infoEl = document.getElementById('bd-info');
  var errEl = document.getElementById('bd-error');

  async function load() {
    errEl.hidden = true;
    try {
      var r = await fetch('/api/budget-limits/' + encodeURIComponent(cat.id) + '/transactions',
        { credentials: 'same-origin' });
      if (r.status === 404) throw new Error('Category not found.');
      if (!r.ok) throw new Error('status ' + r.status);
      var rows = (await r.json()).transactions || [];
      var total = rows.reduce(function (a, t) { return a + Number(t.amount); }, 0);
      infoEl.textContent = rows.length + ' transaction' + (rows.length === 1 ? '' : 's') + ' · total ' + fmtUSD(total);

      if (rows.length === 0) {
        listEl.innerHTML = '<p class="empty">No transactions in this category this month yet. '
          + '<a href="/budgets">← Back to all budgets</a></p>';
        return;
      }
      listEl.innerHTML = '<ul class="txn-list">' + rows.map(function (t) {
        var primary = t.merchant_name || t.name || 'Unknown';
        return '<li class="txn">'
          + '<span class="txn-date">' + escapeHtml(t.date || '') + '</span>'
          + '<span class="txn-name">' + escapeHtml(primary)
            + (t.pending ? ' <span class="txn-pending">pending</span>' : '') + '</span>'
          + '<span class="txn-amount txn-out">' + escapeHtml(fmtUSD(t.amount)) + '</span>'
          + '</li>';
      }).join('') + '</ul>';
    } catch (e) {
      listEl.innerHTML = '';
      errEl.textContent = 'Could not load: ' + e.message;
      errEl.hidden = false;
    }
  }

  load();
})();

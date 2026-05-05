// /subscriptions/:id — list the transactions feeding this recurring cluster.
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

  var sub = window.__moneymind_subscription;
  var listEl = document.getElementById('sd-list');
  var infoEl = document.getElementById('sd-info');
  var errEl  = document.getElementById('sd-error');

  async function load() {
    errEl.hidden = true;
    try {
      var r = await fetch('/api/subscriptions/' + encodeURIComponent(sub.id),
        { credentials: 'same-origin' });
      if (r.status === 404) throw new Error('Subscription not found.');
      if (!r.ok) throw new Error('status ' + r.status);
      var j = await r.json();
      var rows = j.transactions || [];
      var total = rows.reduce(function (a, t) { return a + Number(t.amount); }, 0);
      infoEl.textContent = rows.length + ' transaction' + (rows.length === 1 ? '' : 's') + ' · ' + fmtUSD(total) + ' total';

      if (rows.length === 0) {
        // Edge case: the recurring_charges row exists but no transactions
        // in the cluster window match. Usually means the source rows were
        // removed (account disconnect, Plaid removed_count) since detection.
        listEl.innerHTML = '<p class="empty">We can\'t find the transactions for this charge. '
          + 'It may have been removed since detection ran. '
          + '<a href="/subscriptions">← Back to subscriptions</a></p>';
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

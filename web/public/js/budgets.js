// /budgets — list categories with their limit + current spend.
(function () {
  'use strict';

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtUSD(cents) {
    if (cents == null) return '';
    return (Number(cents) / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  }
  function fmtUSDPlain(cents) {
    if (cents == null) return '';
    return (Number(cents) / 100).toFixed(2);
  }

  var listEl = document.getElementById('budgets-list');
  var errEl = document.getElementById('budgets-error');
  function showErr(msg) { errEl.textContent = msg; errEl.hidden = false; }
  function clearErr() { errEl.hidden = true; errEl.textContent = ''; }

  async function load() {
    clearErr();
    try {
      var r = await fetch('/api/budget-limits', { credentials: 'same-origin' });
      if (!r.ok) throw new Error('status ' + r.status);
      var data = (await r.json()).budget_limits || [];
      render(data);
    } catch (e) {
      listEl.innerHTML = '';
      showErr('Could not load budgets: ' + e.message);
    }
  }

  function render(items) {
    if (items.length === 0) {
      listEl.innerHTML = '<p class="empty">No categories yet.</p>';
      return;
    }
    listEl.innerHTML = '<ul class="budget-list">' + items.map(function (b) {
      var pct = b.pct_used == null ? 0 : Math.min(100, b.pct_used);
      var statusClass = b.status ? ('budget-status-' + b.status) : 'budget-status-none';
      var pctLabel = b.pct_used == null
        ? '<span class="budget-no-limit">No limit set</span>'
        : escapeHtml(b.pct_used + '% of ' + fmtUSD(b.monthly_limit_cents));
      var limitInputVal = b.monthly_limit_cents == null ? '' : fmtUSDPlain(b.monthly_limit_cents);
      var drillLink = '<a href="/budgets/' + b.category_id + '" class="budget-drill">'
                    + b.transaction_count + ' transaction' + (b.transaction_count === 1 ? '' : 's') + ' →</a>';
      return '<li class="budget-row" data-cid="' + b.category_id + '">'
        + '<div class="budget-row-top">'
        +   '<span class="budget-name">' + escapeHtml(b.category_name) + '</span>'
        +   '<span class="budget-spend">' + fmtUSD(b.current_spend_cents) + ' spent</span>'
        + '</div>'
        + '<div class="budget-bar"><span class="budget-fill ' + statusClass + '" style="width:' + pct + '%"></span></div>'
        + '<div class="budget-row-bot">'
        +   '<span class="budget-pct">' + pctLabel + '</span>'
        +   '<span class="budget-limit-input">'
        +     'Limit&nbsp;$ <input type="number" min="0" step="1" placeholder="0" value="' + limitInputVal + '" data-cid="' + b.category_id + '" class="budget-limit-field" />'
        +     '<button type="button" class="btn-ghost budget-save" data-cid="' + b.category_id + '">Save</button>'
        +   '</span>'
        +   drillLink
        + '</div>'
        + '</li>';
    }).join('') + '</ul>';

    listEl.querySelectorAll('.budget-save').forEach(function (btn) {
      btn.addEventListener('click', function () { saveLimit(btn.dataset.cid); });
    });
    listEl.querySelectorAll('.budget-limit-field').forEach(function (inp) {
      inp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); saveLimit(inp.dataset.cid); }
      });
    });
  }

  async function saveLimit(cid) {
    clearErr();
    var inp = listEl.querySelector('.budget-limit-field[data-cid="' + cid + '"]');
    var dollarsStr = (inp.value || '').trim();
    var dollars = dollarsStr === '' ? 0 : Number(dollarsStr);
    if (!isFinite(dollars) || dollars < 0) {
      showErr('Limit must be a non-negative number.');
      return;
    }
    // Convert dollars → integer cents. We multiply and round, deliberately
    // never sending a float over the wire.
    var cents = Math.round(dollars * 100);
    try {
      var r = await fetch('/api/budget-limits/' + encodeURIComponent(cid), {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ monthly_limit_cents: cents }),
      });
      if (!r.ok) {
        var j = await r.json().catch(function () { return {}; });
        throw new Error(j.error || ('status ' + r.status));
      }
      load();
    } catch (e) {
      showErr('Save failed: ' + e.message);
    }
  }

  load();
})();

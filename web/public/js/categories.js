// /categories page — list, inline-rename, current-month metrics.
(function () {
  'use strict';

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtUSD(n) {
    var v = Number(n);
    if (!isFinite(v)) return '—';
    return v.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  }

  var listEl = document.getElementById('cat-list');
  var errorEl = document.getElementById('cat-error');

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.hidden = false;
  }
  function clearError() { errorEl.hidden = true; errorEl.textContent = ''; }

  async function load() {
    clearError();
    try {
      var r = await fetch('/api/categories', { credentials: 'same-origin' });
      if (!r.ok) throw new Error('status ' + r.status);
      var cats = (await r.json()).categories || [];
      render(cats);
    } catch (e) {
      listEl.innerHTML = '';
      showError('Could not load categories.');
    }
  }

  function render(cats) {
    if (cats.length === 0) {
      listEl.innerHTML = '<p class="empty">No categories.</p>';
      return;
    }
    listEl.innerHTML = '<ul class="cat-list">' + cats.map(function (c) {
      var spend = Number(c.current_month_spend) || 0;
      var count = Number(c.transaction_count) || 0;
      // When a category has no activity at all this month, show a single
      // "No transactions yet" line instead of "0 transactions, $0.00" —
      // less visual noise for a brand-new user who has 5 zeroed rows.
      var metricsHtml = (count === 0 && spend === 0)
        ? '<span class="cat-empty" colspan="2">No transactions yet</span>'
        : '<span class="cat-count">' + count + ' txn' + (count === 1 ? '' : 's') + '</span>'
          + '<span class="cat-total">' + fmtUSD(spend) + '</span>';
      return '<li class="cat-row" data-id="' + c.id + '">'
        + '<span class="cat-color cat-color-' + c.display_order + '" aria-hidden="true"></span>'
        + '<span class="cat-name" tabindex="0" role="button" aria-label="Rename ' + escapeHtml(c.name) + '">'
        +   escapeHtml(c.name)
        + '</span>'
        + metricsHtml
        + '</li>';
    }).join('') + '</ul>';

    // Wire inline rename
    listEl.querySelectorAll('.cat-row').forEach(function (row) {
      var nameEl = row.querySelector('.cat-name');
      nameEl.addEventListener('click', function () { startEdit(row); });
      nameEl.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); startEdit(row); }
      });
    });
  }

  function startEdit(row) {
    var nameEl = row.querySelector('.cat-name');
    var orig = nameEl.textContent;
    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'cat-edit';
    input.value = orig;
    input.maxLength = 30;
    input.minLength = 1;
    nameEl.replaceWith(input);
    input.focus();
    input.select();

    var saved = false;
    function save() {
      if (saved) return; saved = true;
      var next = input.value.trim();
      if (next === orig || next.length === 0) return cancel(orig);
      submit(row, input, next);
    }
    function cancel(text) {
      var span = document.createElement('span');
      span.className = 'cat-name';
      span.textContent = text;
      span.tabIndex = 0; span.role = 'button';
      input.replaceWith(span);
      span.addEventListener('click', function () { startEdit(row); });
      span.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); startEdit(row); }
      });
    }
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); save(); }
      if (e.key === 'Escape') { saved = true; cancel(orig); }
    });
    input.addEventListener('blur', save);
  }

  async function submit(row, input, name) {
    clearError();
    input.disabled = true;
    try {
      var id = row.dataset.id;
      var r = await fetch('/api/categories/' + encodeURIComponent(id), {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name }),
      });
      if (!r.ok) {
        var j = await r.json().catch(function () { return {}; });
        throw new Error(j.error || ('status ' + r.status));
      }
      // Reload — counts may rearrange visually if we ever sort by name.
      load();
    } catch (e) {
      showError(e.message);
      input.disabled = false;
    }
  }

  load();
})();

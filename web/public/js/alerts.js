// /alerts — list accounts + per-account low-balance threshold settings.
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

  var listEl = document.getElementById('alerts-list');
  var errEl = document.getElementById('alerts-error');
  function showErr(m) { errEl.textContent = m; errEl.hidden = false; }
  function clearErr() { errEl.hidden = true; errEl.textContent = ''; }

  async function load() {
    clearErr();
    try {
      var r = await fetch('/api/low-balance-thresholds', { credentials: 'same-origin' });
      if (!r.ok) throw new Error('status ' + r.status);
      var rows = (await r.json()).thresholds || [];
      render(rows);
    } catch (e) {
      listEl.innerHTML = '';
      showErr('Could not load: ' + e.message);
    }
  }

  function render(rows) {
    if (rows.length === 0) {
      listEl.innerHTML = '<p class="empty">No accounts found.</p>';
      return;
    }
    listEl.innerHTML = '<ul class="alert-list">' + rows.map(function (a) {
      var thrInputVal = a.threshold_cents == null ? '' : fmtUSDPlain(a.threshold_cents);
      var triggeredTag = a.triggered ? '<span class="alert-tag">BELOW THRESHOLD</span>' : '';
      var maskTxt = a.mask ? ' ····' + escapeHtml(a.mask) : '';
      return '<li class="alert-row" data-aid="' + a.account_id + '">'
        + '<div class="alert-row-top">'
        +   '<span class="alert-name">' + escapeHtml(a.account_name) + maskTxt + '</span>'
        +   '<span class="alert-balance">' + fmtUSD(a.current_balance_cents) + ' current</span>'
        +   triggeredTag
        + '</div>'
        + '<div class="alert-row-bot">'
        +   '<span>Threshold&nbsp;$ <input type="number" min="0" step="1" value="' + thrInputVal + '" data-aid="' + a.account_id + '" class="alert-thr-field" /></span>'
        +   '<label class="alert-toggle"><input type="checkbox" ' + (a.enabled ? 'checked' : '') + ' data-aid="' + a.account_id + '" class="alert-en-field" /> Enabled</label>'
        +   '<button type="button" class="btn-ghost alert-save" data-aid="' + a.account_id + '">Save</button>'
        + (a.threshold_cents != null
            ? '<button type="button" class="btn-ghost alert-del" data-aid="' + a.account_id + '">Remove</button>'
            : '')
        + '</div>'
        + '</li>';
    }).join('') + '</ul>';

    listEl.querySelectorAll('.alert-save').forEach(function (b) {
      b.addEventListener('click', function () { saveOne(b.dataset.aid); });
    });
    listEl.querySelectorAll('.alert-del').forEach(function (b) {
      b.addEventListener('click', function () { deleteOne(b.dataset.aid); });
    });
    listEl.querySelectorAll('.alert-thr-field').forEach(function (i) {
      i.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); saveOne(i.dataset.aid); }
      });
    });
  }

  async function saveOne(aid) {
    clearErr();
    var thrInp = listEl.querySelector('.alert-thr-field[data-aid="' + aid + '"]');
    var enInp = listEl.querySelector('.alert-en-field[data-aid="' + aid + '"]');
    var dollars = (thrInp.value || '').trim();
    var n = dollars === '' ? 0 : Number(dollars);
    if (!isFinite(n) || n < 0) { showErr('Threshold must be a non-negative number.'); return; }
    var cents = Math.round(n * 100);
    try {
      var r = await fetch('/api/low-balance-thresholds/' + encodeURIComponent(aid), {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threshold_cents: cents, enabled: !!enInp.checked }),
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

  async function deleteOne(aid) {
    clearErr();
    if (!window.confirm('Remove the threshold for this account?')) return;
    try {
      var r = await fetch('/api/low-balance-thresholds/' + encodeURIComponent(aid), {
        method: 'DELETE', credentials: 'same-origin',
      });
      if (!r.ok && r.status !== 404) {
        var j = await r.json().catch(function () { return {}; });
        throw new Error(j.error || ('status ' + r.status));
      }
      load();
    } catch (e) {
      showErr('Delete failed: ' + e.message);
    }
  }

  load();
})();

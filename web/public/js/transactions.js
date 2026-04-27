// /transactions page: filter, paginate, render. All filtering server-side
// (so search works across pagination); JS only orchestrates fetches.

(function () {
  'use strict';

  var PER_PAGE = 50;

  // ── helpers ───────────────────────────────────────────────────────────
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function formatUSD(amt) {
    var n = Number(amt);
    if (!isFinite(n)) return '';
    // We invert sign for display: Plaid gives outflows as positive.
    return (-n).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  }

  // Build a quick lookup: plaid_account_id → display label.
  var ACCT_LOOKUP = {};
  (window.__moneymind_accounts || []).forEach(function (a) {
    ACCT_LOOKUP[a.id] = (a.name || 'Account') + (a.mask ? ' ····' + a.mask : '');
  });

  // ── state ─────────────────────────────────────────────────────────────
  var state = {
    page: 1,
    month: '',
    account_id: '',
    search: '',
    inFlight: 0,
  };

  // ── DOM ───────────────────────────────────────────────────────────────
  var monthEl = document.getElementById('month-filter');
  var acctEl = document.getElementById('account-filter');
  var searchEl = document.getElementById('search-input');
  var tableEl = document.getElementById('txn-table');
  var infoEl = document.getElementById('txn-info');
  var errorEl = document.getElementById('txn-error');
  var prevBtn = document.getElementById('prev-page');
  var nextBtn = document.getElementById('next-page');
  var pageIndicator = document.getElementById('page-indicator');

  state.month = monthEl ? monthEl.value : '';

  // ── render ────────────────────────────────────────────────────────────
  function renderRows(transactions) {
    if (transactions.length === 0) {
      tableEl.innerHTML = '<p class="empty">No transactions found. Try a different month or clear filters.</p>';
      return;
    }
    var html = '<ul class="txn-list">' + transactions.map(function (t) {
      var n = Number(t.amount);
      var sign = n > 0 ? 'out' : 'in';
      var primary = t.merchant_name || t.name || 'Unknown';
      var secondary = (t.merchant_name && t.name && t.merchant_name !== t.name) ? t.name : '';
      var pendingTag = t.pending ? ' <span class="txn-pending">Pending</span>' : '';
      var acctLabel = ACCT_LOOKUP[t.plaid_account_id] || '—';
      return '<li class="txn txn-row">'
        + '<span class="txn-date">' + escapeHtml(t.date || '') + '</span>'
        + '<span class="txn-name">'
        +   '<span class="txn-primary">' + escapeHtml(primary) + pendingTag + '</span>'
        + (secondary ? '<span class="txn-secondary">' + escapeHtml(secondary) + '</span>' : '')
        + '</span>'
        + '<span class="txn-account">' + escapeHtml(acctLabel) + '</span>'
        + '<span class="txn-amount txn-' + sign + '">' + escapeHtml(formatUSD(n)) + '</span>'
        + '</li>';
    }).join('') + '</ul>';
    tableEl.innerHTML = html;
  }

  function renderPagination(page, perPage, total) {
    if (total === 0) {
      infoEl.textContent = '0 transactions';
      pageIndicator.textContent = '';
      prevBtn.disabled = true;
      nextBtn.disabled = true;
      return;
    }
    var first = (page - 1) * perPage + 1;
    var last = Math.min(page * perPage, total);
    infoEl.textContent = 'Showing ' + first + '–' + last + ' of ' + total;
    var totalPages = Math.max(1, Math.ceil(total / perPage));
    pageIndicator.textContent = 'Page ' + page + ' of ' + totalPages;
    prevBtn.disabled = page <= 1;
    nextBtn.disabled = page >= totalPages;
  }

  // ── fetch ─────────────────────────────────────────────────────────────
  function buildUrl() {
    var p = new URLSearchParams();
    p.set('page', state.page);
    p.set('per_page', PER_PAGE);
    if (state.month) p.set('month', state.month);
    if (state.account_id) p.set('account_id', state.account_id);
    if (state.search) p.set('search', state.search);
    return '/api/transactions?' + p.toString();
  }

  async function load() {
    state.inFlight += 1;
    var token = state.inFlight; // discard stale responses
    errorEl.hidden = true; errorEl.textContent = '';
    tableEl.innerHTML = '<div class="empty"><span class="spinner-inline">…</span> Loading…</div>';
    try {
      var r = await fetch(buildUrl(), { credentials: 'same-origin' });
      if (token !== state.inFlight) return; // a newer request started
      if (!r.ok) {
        var j = await r.json().catch(function () { return {}; });
        throw new Error(j.error || ('status ' + r.status));
      }
      var data = await r.json();
      renderRows(data.transactions || []);
      renderPagination(data.page, data.per_page, data.total_count);
    } catch (e) {
      if (token !== state.inFlight) return;
      tableEl.innerHTML = '';
      infoEl.textContent = '';
      pageIndicator.textContent = '';
      prevBtn.disabled = true;
      nextBtn.disabled = true;
      errorEl.hidden = false;
      errorEl.textContent = 'Could not load transactions: ' + e.message;
    }
  }

  // ── events ────────────────────────────────────────────────────────────
  function resetAndLoad() { state.page = 1; load(); }

  if (monthEl)  monthEl.addEventListener('change', function () { state.month = monthEl.value; resetAndLoad(); });
  if (acctEl)   acctEl.addEventListener('change',  function () { state.account_id = acctEl.value; resetAndLoad(); });

  // Debounce the search input — don't fire a query on every keystroke.
  var searchTimer = null;
  if (searchEl) {
    searchEl.addEventListener('input', function () {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(function () {
        state.search = searchEl.value.trim();
        resetAndLoad();
      }, 250);
    });
  }

  if (prevBtn) prevBtn.addEventListener('click', function () { if (state.page > 1) { state.page -= 1; load(); } });
  if (nextBtn) nextBtn.addEventListener('click', function () { state.page += 1; load(); });

  load();
})();

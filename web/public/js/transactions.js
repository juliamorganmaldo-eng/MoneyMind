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

  // Categories list (loaded once, used to populate the reassign dropdown).
  var CATEGORIES = [];
  fetch('/api/categories', { credentials: 'same-origin' })
    .then(function (r) { return r.ok ? r.json() : { categories: [] }; })
    .then(function (j) { CATEGORIES = j.categories || []; });

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
  // Map MoneyMind category name → display_order (1..5) so we can colorize
  // the badge consistently with the dashboard chart.
  function colorClassForCategory(name) {
    for (var i = 0; i < CATEGORIES.length; i++) {
      if (CATEGORIES[i].name === name) return 'cat-color-' + CATEGORIES[i].display_order;
    }
    return 'cat-color-4'; // default to "Other" hue
  }

  function renderBadge(t) {
    if (!t.category_id) return '<span class="cat-badge cat-badge-none">Uncategorized</span>';
    var cls = colorClassForCategory(t.category_name) + (t.category_source === 'user_override' ? ' cat-override' : '');
    return '<span class="cat-badge ' + cls + '" title="'
      + (t.category_source === 'user_override' ? 'Manually set' : 'Auto-assigned')
      + '">' + escapeHtml(t.category_name || '—') + '</span>';
  }

  function renderRows(transactions) {
    if (transactions.length === 0) {
      // Two distinct cases at the JS layer:
      //   1. User has accounts but no transactions at all → suggest Sync
      //      (this is the brand-new-account case; total_count is 0 AND no
      //       filters are applied)
      //   2. Filters returned no rows → suggest changing/clearing filters
      var hasFilters = !!(state.search || state.account_id);
      var msg = hasFilters
        ? 'No transactions match these filters. Try a different month, clear filters, or change the account.'
        : 'No transactions yet. Try clicking <strong>↻ Sync transactions</strong> on the dashboard, or check back after your bank refreshes.';
      tableEl.innerHTML = '<p class="empty">' + msg + '</p>';
      return;
    }
    var html = '<ul class="txn-list">' + transactions.map(function (t) {
      var n = Number(t.amount);
      var sign = n > 0 ? 'out' : 'in';
      var primary = t.merchant_name || t.name || 'Unknown';
      var secondary = (t.merchant_name && t.name && t.merchant_name !== t.name) ? t.name : '';
      var pendingTag = t.pending ? ' <span class="txn-pending">Pending</span>' : '';
      var acctLabel = ACCT_LOOKUP[t.plaid_account_id] || '—';
      return '<li class="txn-grid" data-id="' + t.id + '" data-merchant="' + escapeHtml(t.merchant_name || '') + '">'
        + '<button class="txn-expand" type="button" aria-label="Expand details">▸</button>'
        + '<span class="txn-date">' + escapeHtml(t.date || '') + '</span>'
        + '<span class="txn-name">'
        +   '<span class="txn-primary">' + escapeHtml(primary) + pendingTag + '</span>'
        + (secondary ? '<span class="txn-secondary">' + escapeHtml(secondary) + '</span>' : '')
        + '</span>'
        + '<span class="txn-cat-cell">'
        +   '<button type="button" class="cat-badge-button" aria-label="Reassign category">'
        +     renderBadge(t)
        +   '</button>'
        + '</span>'
        + '<span class="txn-account">' + escapeHtml(acctLabel) + '</span>'
        + '<span class="txn-amount txn-' + sign + '">' + escapeHtml(formatUSD(n)) + '</span>'
        + '<div class="txn-detail" hidden>'
        +   '<div class="txn-detail-label">Plaid category</div>'
        +   '<div class="txn-detail-value">'
        +     escapeHtml(t.plaid_category_detailed || t.plaid_category_primary || '—')
        +   '</div>'
        + '</div>'
        + '</li>';
    }).join('') + '</ul>';
    tableEl.innerHTML = html;

    // Wire row interactions
    tableEl.querySelectorAll('.txn-grid').forEach(wireRow);
  }

  function wireRow(row) {
    var expandBtn = row.querySelector('.txn-expand');
    var detail = row.querySelector('.txn-detail');
    expandBtn.addEventListener('click', function () {
      var open = !detail.hidden;
      detail.hidden = open;
      expandBtn.textContent = open ? '▸' : '▾';
    });
    var catBtn = row.querySelector('.cat-badge-button');
    catBtn.addEventListener('click', function (e) { openCategoryPicker(row, catBtn, e); });
  }

  function closeAnyPickers() {
    document.querySelectorAll('.cat-picker').forEach(function (p) { p.remove(); });
  }
  document.addEventListener('click', function (e) {
    // Close any open picker if clicking outside one.
    if (!e.target.closest('.cat-picker') && !e.target.closest('.cat-badge-button')) {
      closeAnyPickers();
    }
  });

  function openCategoryPicker(row, anchor, evt) {
    evt.stopPropagation();
    closeAnyPickers();
    var pick = document.createElement('div');
    pick.className = 'cat-picker';
    pick.innerHTML = CATEGORIES.map(function (c) {
      return '<button type="button" class="cat-picker-option" data-id="' + c.id + '">'
        + '<span class="cat-color cat-color-' + c.display_order + '" aria-hidden="true"></span>'
        + escapeHtml(c.name)
        + '</button>';
    }).join('');
    anchor.parentNode.appendChild(pick);
    pick.querySelectorAll('.cat-picker-option').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var newCatId = parseInt(btn.dataset.id, 10);
        var newCatName = btn.textContent.trim();
        closeAnyPickers();
        reassign(row, newCatId, newCatName);
      });
    });
  }

  async function reassign(row, categoryId, categoryName) {
    var txnId = row.dataset.id;
    var merchant = row.dataset.merchant || '';

    // First, the single-transaction update.
    try {
      var r = await fetch('/api/transactions/' + encodeURIComponent(txnId) + '/category', {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category_id: categoryId, apply_to_all_from_merchant: false }),
      });
      if (!r.ok) {
        var j = await r.json().catch(function () { return {}; });
        throw new Error(j.error || ('status ' + r.status));
      }
    } catch (e) {
      errorEl.hidden = false;
      errorEl.textContent = 'Reassign failed: ' + e.message;
      return;
    }

    // If there's a merchant, ask whether to apply across the merchant.
    if (merchant && merchant.length > 0) {
      var apply = window.confirm('Apply "' + categoryName + '" to all transactions from "' + merchant + '"?');
      if (apply) {
        try {
          await fetch('/api/transactions/' + encodeURIComponent(txnId) + '/category', {
            method: 'PATCH',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ category_id: categoryId, apply_to_all_from_merchant: true }),
          });
        } catch (e) {
          errorEl.hidden = false;
          errorEl.textContent = 'Bulk apply failed: ' + e.message;
        }
      }
    }
    // Re-fetch the page to reflect changes (counts/badges).
    load();
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

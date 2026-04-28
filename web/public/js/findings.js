// /findings — list by tier, dismiss, refresh, deep-link.
(function () {
  'use strict';

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function timeAgo(iso) {
    var ms = Date.now() - Date.parse(iso);
    if (!isFinite(ms) || ms < 0) return '';
    var s = Math.round(ms / 1000);
    if (s < 60) return 'just now';
    var m = Math.round(s / 60);
    if (m < 60) return m + 'm ago';
    var h = Math.round(m / 60);
    if (h < 24) return h + 'h ago';
    var d = Math.round(h / 24);
    return d + 'd ago';
  }

  var TIER_LABELS = { critical: 'Critical', important: 'Important', tip: 'Tips', positive: 'Positive' };
  var TIER_ORDER = ['critical', 'important', 'tip', 'positive'];

  var sectionsEl = document.getElementById('f-sections');
  var subtitleEl = document.getElementById('findings-subtitle');
  var statusEl = document.getElementById('f-status');
  var showDismissedBtn = document.getElementById('show-dismissed');

  var state = { includeDismissed: false };

  function showStatus(msg, kind) {
    statusEl.textContent = msg;
    statusEl.className = 'alert ' + (kind === 'error' ? 'alert-error' : 'alert-info');
    statusEl.hidden = false;
  }

  function renderCard(f) {
    var dismissed = f.is_dismissed ? ' f-card-dismissed' : '';
    return '<div class="f-card f-tier-' + f.tier + dismissed + '" data-id="' + f.id + '" data-href="' + (f.deep_link_path || '') + '">'
      + '<div class="f-stripe"></div>'
      + '<div class="f-body">'
      +   '<div class="f-title">' + escapeHtml(f.title) + '</div>'
      +   '<div class="f-text">' + escapeHtml(f.body) + '</div>'
      +   '<div class="f-meta">' + escapeHtml(timeAgo(f.occurred_at)) + '</div>'
      + '</div>'
      + (f.is_dismissed
          ? '<span class="f-dismissed-tag">dismissed</span>'
          : '<button class="f-dismiss" type="button" aria-label="Dismiss">×</button>')
      + '</div>';
  }

  async function load() {
    try {
      var url = '/api/findings' + (state.includeDismissed ? '?include_dismissed=true' : '');
      var r = await fetch(url, { credentials: 'same-origin' });
      if (!r.ok) throw new Error('status ' + r.status);
      var rows = (await r.json()).findings || [];

      if (rows.length === 0) {
        sectionsEl.className = 'empty';
        sectionsEl.innerHTML = state.includeDismissed
          ? 'No findings (including dismissed).'
          : 'No findings right now — we\'ll surface things when something needs your attention.';
        showDismissedBtn.hidden = true;
        subtitleEl.textContent = '';
        return;
      }
      sectionsEl.className = '';

      // Bucket by tier
      var byTier = { critical: [], important: [], tip: [], positive: [] };
      var dismissedCount = 0;
      for (var i = 0; i < rows.length; i++) {
        var f = rows[i];
        if (f.is_dismissed) dismissedCount++;
        if (byTier[f.tier]) byTier[f.tier].push(f);
      }

      var html = '';
      for (var ti = 0; ti < TIER_ORDER.length; ti++) {
        var t = TIER_ORDER[ti];
        var items = byTier[t];
        if (!items || items.length === 0) continue; // hide empty sections
        html += '<section class="f-section f-section-' + t + '">'
          + '<h2 class="f-section-title">' + escapeHtml(TIER_LABELS[t]) + ' (' + items.length + ')</h2>'
          + items.map(renderCard).join('')
          + '</section>';
      }
      sectionsEl.innerHTML = html;

      subtitleEl.textContent = rows.length + ' finding' + (rows.length === 1 ? '' : 's')
        + (state.includeDismissed && dismissedCount > 0 ? ' (' + dismissedCount + ' dismissed)' : '');

      // Show "Show dismissed" toggle only when there are dismissed rows
      // and we're not currently showing them.
      // We don't know dismissed count until include_dismissed=true; show
      // the toggle in either mode and let the user click.
      showDismissedBtn.hidden = false;
      showDismissedBtn.textContent = state.includeDismissed ? 'Hide dismissed' : 'Show dismissed';

      // Wire dismiss + click-to-deep-link
      sectionsEl.querySelectorAll('.f-card').forEach(function (card) {
        var btn = card.querySelector('.f-dismiss');
        if (btn) {
          btn.addEventListener('click', function (e) {
            e.stopPropagation();
            dismiss(card.dataset.id);
          });
        }
        card.addEventListener('click', function () {
          var href = card.dataset.href;
          if (href) window.location.href = href;
        });
      });
    } catch (e) {
      sectionsEl.innerHTML = '';
      showStatus('Could not load findings: ' + e.message, 'error');
    }
  }

  async function dismiss(id) {
    try {
      var r = await fetch('/api/findings/' + encodeURIComponent(id) + '/dismiss', {
        method: 'POST', credentials: 'same-origin',
      });
      if (!r.ok) throw new Error('status ' + r.status);
      load();
    } catch (e) {
      showStatus('Dismiss failed: ' + e.message, 'error');
    }
  }

  document.getElementById('refresh-btn').addEventListener('click', async function () {
    var btn = this;
    btn.disabled = true;
    var prev = btn.textContent;
    btn.textContent = 'Refreshing…';
    try {
      var r = await fetch('/api/findings/refresh', { method: 'POST', credentials: 'same-origin' });
      if (!r.ok) throw new Error('status ' + r.status);
      var j = await r.json();
      showStatus(j.new_findings_count + ' new finding' + (j.new_findings_count === 1 ? '' : 's')
        + ' (and ' + j.refreshed_count + ' refreshed).');
      load();
    } catch (e) {
      showStatus('Refresh failed: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = prev;
    }
  });

  showDismissedBtn.addEventListener('click', function () {
    state.includeDismissed = !state.includeDismissed;
    load();
  });

  load();
})();

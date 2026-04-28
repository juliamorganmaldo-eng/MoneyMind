// /subscriptions — list active + ended + duplicates, action buttons, totals.
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
  function cadenceLabel(c) {
    return { weekly:'Weekly', biweekly:'Biweekly', monthly:'Monthly', quarterly:'Quarterly', annual:'Annual' }[c] || c;
  }

  var activeEl  = document.getElementById('active-list');
  var endedEl   = document.getElementById('ended-list');
  var endedPanel= document.getElementById('ended-panel');
  var dupesEl   = document.getElementById('dupes-list');
  var dupesPanel= document.getElementById('dupes-panel');
  var totalsEl  = document.getElementById('sub-totals');
  var errEl     = document.getElementById('sub-error');
  var statusEl  = document.getElementById('sub-status');

  function showErr(msg) { errEl.textContent = msg; errEl.hidden = false; }
  function clearErr()  { errEl.hidden = true; errEl.textContent = ''; }
  function showStatus(msg) { statusEl.textContent = msg; statusEl.hidden = false; }
  function clearStatus()  { statusEl.hidden = true; statusEl.textContent = ''; }

  // Build a recurring-charge row.
  function rowHtml(s, kind /* 'active' | 'ended' */) {
    var pcTag = s.price_change_detected
      ? '<span class="price-tag">↑ price changed</span>'
      : '';
    var catBadge = s.category_name
      ? '<span class="cat-badge">' + escapeHtml(s.category_name) + '</span>'
      : '<span class="cat-badge cat-badge-none">Uncategorized</span>';
    var nextLine = s.next_expected_date
      ? '<span class="sub-next">next ≈ ' + escapeHtml(s.next_expected_date) + '</span>'
      : '';
    var actions = kind === 'active'
      ? ('<div class="sub-actions">'
         + '<button type="button" class="btn-ghost sub-action" data-action="not_recurring" data-id="' + s.id + '">Not recurring</button>'
         + '<button type="button" class="btn-ghost sub-action" data-action="cancelled"     data-id="' + s.id + '">Cancelled</button>'
         + '<a class="btn-ghost btn-inline" href="/subscriptions/' + s.id + '">View transactions →</a>'
         + '</div>')
      : ('<div class="sub-actions"><a class="btn-ghost btn-inline" href="/subscriptions/' + s.id + '">View transactions →</a></div>');

    return '<li class="sub-row">'
      + '<div class="sub-row-top">'
      +   '<span class="sub-name">' + escapeHtml(s.display_name) + '</span>'
      +   catBadge
      +   '<span class="sub-cadence">' + escapeHtml(cadenceLabel(s.cadence)) + '</span>'
      + '</div>'
      + '<div class="sub-row-mid">'
      +   '<span class="sub-amount">' + fmtUSD(s.last_amount_cents) + ' ' + pcTag + '</span>'
      +   '<span class="sub-monthly">≈ ' + fmtUSD(s.monthly_equivalent_cents) + '/mo</span>'
      +   nextLine
      +   '<span class="sub-conf">conf ' + s.confidence_score + '</span>'
      + '</div>'
      + actions
      + '</li>';
  }

  async function load() {
    clearErr();
    try {
      var [subsResp, dupesResp] = await Promise.all([
        fetch('/api/subscriptions',           { credentials: 'same-origin' }),
        fetch('/api/subscriptions/duplicates', { credentials: 'same-origin' }),
      ]);
      if (!subsResp.ok) throw new Error('subs status ' + subsResp.status);
      if (!dupesResp.ok) throw new Error('dupes status ' + dupesResp.status);
      var subsJ = await subsResp.json();
      var dupesJ = await dupesResp.json();

      var subs = subsJ.subscriptions || [];
      var active = subs.filter(function (s) { return s.status === 'active'; });
      var ended  = subs.filter(function (s) { return s.status === 'ended';  });

      // Totals
      if (active.length === 0) {
        totalsEl.hidden = true;
      } else {
        var monthlyTotal = active.reduce(function (a, s) { return a + (s.monthly_equivalent_cents || 0); }, 0);
        document.getElementById('sub-monthly').textContent = fmtUSD(monthlyTotal);
        document.getElementById('sub-annual').textContent  = fmtUSD(subsJ.annual_total_cents || 0);
        totalsEl.hidden = false;
      }

      // Active list
      activeEl.className = '';
      if (active.length === 0) {
        activeEl.className = 'empty';
        activeEl.innerHTML = 'No recurring charges detected yet. Sync transactions, then re-detect.';
      } else {
        activeEl.innerHTML = '<ul class="sub-list">'
          + active.map(function (s) { return rowHtml(s, 'active'); }).join('')
          + '</ul>';
      }

      // Ended
      if (ended.length === 0) {
        endedPanel.hidden = true;
      } else {
        endedPanel.hidden = false;
        document.getElementById('ended-count').textContent = '(' + ended.length + ')';
        endedEl.innerHTML = '<ul class="sub-list">'
          + ended.map(function (s) { return rowHtml(s, 'ended'); }).join('')
          + '</ul>';
      }

      // Duplicates
      var subById = {};
      for (var i = 0; i < subs.length; i++) subById[subs[i].id] = subs[i];
      var pairs = (dupesJ.pairs || []).filter(function (p) {
        return subById[p.left_charge_id] && subById[p.right_charge_id];
      });
      if (pairs.length === 0) {
        dupesPanel.hidden = true;
      } else {
        dupesPanel.hidden = false;
        dupesEl.innerHTML = '<ul class="dupe-list">' + pairs.map(function (p) {
          var L = subById[p.left_charge_id];
          var R = subById[p.right_charge_id];
          var reason = p.reason === 'known_overlap_pair'
            ? 'Both are commonly redundant'
            : 'Both in same category, similar monthly cost';
          return '<li class="dupe-pair">'
            + '<div class="dupe-side">'
            +   '<div class="sub-name">' + escapeHtml(L.display_name) + '</div>'
            +   '<div class="sub-monthly">' + fmtUSD(L.monthly_equivalent_cents) + '/mo</div>'
            + '</div>'
            + '<div class="dupe-vs">vs</div>'
            + '<div class="dupe-side">'
            +   '<div class="sub-name">' + escapeHtml(R.display_name) + '</div>'
            +   '<div class="sub-monthly">' + fmtUSD(R.monthly_equivalent_cents) + '/mo</div>'
            + '</div>'
            + '<div class="dupe-reason">' + escapeHtml(reason) + '</div>'
            + '</li>';
        }).join('') + '</ul>';
      }

      wireActionButtons();
    } catch (e) {
      activeEl.innerHTML = '';
      showErr('Could not load: ' + e.message);
    }
  }

  function wireActionButtons() {
    document.querySelectorAll('.sub-action').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var action = btn.dataset.action;
        var id = btn.dataset.id;
        var label = action === 'not_recurring' ? 'mark as not recurring' : 'mark as cancelled';
        if (!window.confirm('Are you sure you want to ' + label + '?')) return;
        doAction(id, action);
      });
    });
  }

  async function doAction(id, action) {
    clearErr(); clearStatus();
    try {
      var r = await fetch('/api/subscriptions/' + encodeURIComponent(id) + '/action', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: action }),
      });
      if (!r.ok) {
        var j = await r.json().catch(function () { return {}; });
        throw new Error(j.error || ('status ' + r.status));
      }
      showStatus('Recorded.');
      load();
    } catch (e) {
      showErr('Action failed: ' + e.message);
    }
  }

  // Re-detect button
  var resync = document.getElementById('resync-btn');
  if (resync) {
    resync.addEventListener('click', async function () {
      clearErr(); clearStatus();
      resync.disabled = true;
      var prev = resync.textContent;
      resync.textContent = 'Re-detecting…';
      try {
        var r = await fetch('/api/subscriptions/sync', { method: 'POST', credentials: 'same-origin' });
        if (!r.ok) throw new Error('status ' + r.status);
        var j = await r.json();
        showStatus('Re-detected ' + j.detected_count + ' recurring charge'
          + (j.detected_count === 1 ? '' : 's') + '.');
        load();
      } catch (e) {
        showErr('Re-detect failed: ' + e.message);
      } finally {
        resync.disabled = false;
        resync.textContent = prev;
      }
    });
  }

  // Ended toggle
  var endedToggle = document.getElementById('ended-toggle');
  if (endedToggle) {
    endedToggle.addEventListener('click', function () {
      var isOpen = !endedEl.hidden;
      endedEl.hidden = isOpen;
      endedToggle.firstChild.textContent = isOpen ? '▸ Ended Subscriptions ' : '▾ Ended Subscriptions ';
    });
  }

  load();
})();

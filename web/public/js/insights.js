// /insights — month-over-month bars + savings rate + editable target.
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
  function monthLabel(m) {
    var [y, mm] = m.split('-').map(Number);
    var d = new Date(Date.UTC(y, mm - 1, 1));
    return d.toLocaleString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' });
  }

  var momChart = document.getElementById('mom-chart');
  var momDeltas = document.getElementById('mom-deltas');
  var srCurrent = document.getElementById('sr-current');
  var srChart = document.getElementById('sr-chart');
  var srTarget = document.getElementById('sr-target');
  var srSave = document.getElementById('sr-save');
  var srStatus = document.getElementById('sr-status-msg');

  // ── Month over month ────────────────────────────────────────────────
  async function loadMoM() {
    try {
      var r = await fetch('/api/spending/by-month?months=2', { credentials: 'same-origin' });
      if (!r.ok) throw new Error('status ' + r.status);
      var months = (await r.json()).months || [];
      if (months.length < 2) {
        momChart.className = 'empty';
        momChart.innerHTML = 'Not enough months of data yet.';
        return;
      }
      var prev = months[0], curr = months[1];

      // Union of category names across both months
      var catSet = new Map();
      function add(m) {
        for (var i = 0; i < m.by_category.length; i++) {
          var c = m.by_category[i];
          if (!catSet.has(c.category_name)) catSet.set(c.category_name, { prev: 0, curr: 0 });
        }
      }
      add(prev); add(curr);
      for (var i = 0; i < prev.by_category.length; i++) catSet.get(prev.by_category[i].category_name).prev = prev.by_category[i].spending_cents;
      for (var j = 0; j < curr.by_category.length; j++) catSet.get(curr.by_category[j].category_name).curr = curr.by_category[j].spending_cents;

      var rows = [...catSet.entries()].map(function ([name, v]) { return { name, prev: v.prev, curr: v.curr }; });
      rows.sort(function (a, b) { return Math.max(b.prev, b.curr) - Math.max(a.prev, a.curr); });

      var maxV = 0;
      for (var k = 0; k < rows.length; k++) maxV = Math.max(maxV, rows[k].prev, rows[k].curr);
      if (maxV === 0) {
        momChart.className = 'empty';
        momChart.innerHTML = 'No spending in either month.';
        return;
      }

      momChart.className = '';
      momChart.innerHTML = '<div class="mom-legend">'
        + '<span><span class="mom-swatch mom-prev"></span> ' + escapeHtml(monthLabel(prev.month)) + '</span>'
        + '<span><span class="mom-swatch mom-curr"></span> ' + escapeHtml(monthLabel(curr.month)) + '</span>'
        + '</div>'
        + '<div class="mom-rows">' + rows.map(function (r) {
          var pPct = Math.round((r.prev / maxV) * 100);
          var cPct = Math.round((r.curr / maxV) * 100);
          return '<div class="mom-row">'
            + '<div class="mom-name">' + escapeHtml(r.name) + '</div>'
            + '<div class="mom-bars">'
            +   '<div class="mom-bar mom-prev" style="width:' + pPct + '%"></div>'
            +   '<div class="mom-bar mom-curr" style="width:' + cPct + '%"></div>'
            + '</div>'
            + '<div class="mom-vals">'
            +   '<span>' + fmtUSDFromCents(r.prev) + '</span>'
            +   '<span>' + fmtUSDFromCents(r.curr) + '</span>'
            + '</div>'
            + '</div>';
        }).join('') + '</div>';

      // Deltas table — only ≥ $10 differences
      var deltas = [];
      for (var d = 0; d < rows.length; d++) {
        var diff = rows[d].curr - rows[d].prev;
        if (Math.abs(diff) < 1000) continue;
        deltas.push({ name: rows[d].name, diff });
      }
      deltas.sort(function (a, b) { return Math.abs(b.diff) - Math.abs(a.diff); });
      momDeltas.innerHTML = deltas.length === 0
        ? '<p class="empty">No category changed by more than $10 vs last month.</p>'
        : '<ul class="delta-list">' + deltas.map(function (d) {
            var more = d.diff > 0;
            return '<li class="delta ' + (more ? 'delta-more' : 'delta-less') + '">'
              + (more ? '↑ ' : '↓ ') + fmtUSDFromCents(Math.abs(d.diff))
              + ' ' + (more ? 'more on ' : 'less on ') + escapeHtml(d.name) + ' this month'
              + '</li>';
          }).join('') + '</ul>';
    } catch (e) {
      momChart.className = 'empty';
      momChart.innerHTML = 'Could not load: ' + e.message;
    }
  }

  // ── Savings rate ────────────────────────────────────────────────────
  var settingsCache = { savings_rate_target_pct: 20 };

  async function loadSettings() {
    try {
      var r = await fetch('/api/user-settings', { credentials: 'same-origin' });
      if (!r.ok) throw new Error('status ' + r.status);
      var j = await r.json();
      settingsCache = j.settings;
      srTarget.value = settingsCache.savings_rate_target_pct;
    } catch (e) {
      // non-fatal
    }
  }

  function statusForRate(rate, target) {
    if (rate == null) return { cls: 'sr-na',     msg: '' };
    if (rate >= target)        return { cls: 'sr-on',  msg: 'On target' };
    if (rate >= target - 5)    return { cls: 'sr-near',msg: 'Near target' };
    return { cls: 'sr-off', msg: 'Below target' };
  }

  // Headline message for non-'ok' months. We deliberately avoid showing a
  // percentage here — see web/lib/savings-rate.js for the rationale.
  function nonOkMessage(status) {
    if (status === 'no_income') {
      return 'No income recorded this month yet — your savings rate will display once a paycheck is captured.';
    }
    if (status === 'insufficient_income') {
      return 'Insufficient income data this month — your savings rate will display once a full pay cycle is captured.';
    }
    return '';
  }

  async function loadSavings() {
    try {
      var r = await fetch('/api/savings-rate?months=6', { credentials: 'same-origin' });
      if (!r.ok) throw new Error('status ' + r.status);
      var months = (await r.json()).months || [];
      var current = months.length > 0 ? months[months.length - 1] : null;
      if (!current || current.status !== 'ok') {
        srCurrent.textContent = '—';
        srCurrent.className = 'savings-current sr-na'; // no green/yellow/red — undefined, not "below target"
        srStatus.textContent = current ? nonOkMessage(current.status) : '';
      } else {
        var pct = current.savings_rate_pct;
        var st = statusForRate(pct, settingsCache.savings_rate_target_pct);
        srCurrent.textContent = pct.toFixed(1) + '%';
        srCurrent.className = 'savings-current ' + st.cls;
        srStatus.textContent = st.msg;
      }

      // 6-month line chart — skip non-'ok' months entirely (don't plot
      // null or out-of-range values that would distort the y-axis).
      var plottable = months.filter(function (m) { return m.status === 'ok' && m.savings_rate_pct != null; });
      if (plottable.length === 0) {
        srChart.className = 'empty';
        srChart.innerHTML = 'No savings-rate history yet (no months with reliable income data).';
        return;
      }

      var W = 720, H = 180, P = 30;
      var min = -50, max = 100;
      function x(i) { return P + (plottable.length === 1 ? (W-2*P)/2 : (i*(W-2*P)/(plottable.length-1))); }
      function y(v) { return H - P - ((v - min) / (max - min)) * (H - 2*P); }
      var pts = plottable.map(function (m, i) { return x(i) + ',' + y(m.savings_rate_pct); }).join(' ');
      var dots = plottable.map(function (m, i) {
        return '<circle cx="' + x(i) + '" cy="' + y(m.savings_rate_pct) + '" r="3" data-d="' + monthLabel(m.month) + '" data-v="' + m.savings_rate_pct + '"/>';
      }).join('');
      var targetLine = '<line x1="' + P + '" x2="' + (W-P) + '" y1="' + y(settingsCache.savings_rate_target_pct) + '" y2="' + y(settingsCache.savings_rate_target_pct) + '" stroke="#A0AEC0" stroke-dasharray="4 4" stroke-width="1"/>';
      srChart.className = '';
      srChart.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet" class="line-svg">'
        + targetLine
        + '<polyline fill="none" stroke="#15803D" stroke-width="2" points="' + pts + '"/>'
        + dots
        + '</svg>'
        + '<div class="chart-meta">'
        +   '<span>' + plottable.length + ' of ' + months.length + ' months plotted</span>'
        +   '<span>(others have insufficient income — see month details)</span>'
        + '</div>';
    } catch (e) {
      srChart.className = 'empty';
      srChart.innerHTML = 'Could not load: ' + e.message;
    }
  }

  if (srSave) {
    srSave.addEventListener('click', async function () {
      var v = parseInt(srTarget.value, 10);
      if (!Number.isInteger(v) || v < 0 || v > 100) {
        srStatus.textContent = 'Target must be an integer 0–100.';
        return;
      }
      try {
        var r = await fetch('/api/user-settings', {
          method: 'PATCH',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ savings_rate_target_pct: v }),
        });
        if (!r.ok) {
          var j = await r.json().catch(function () { return {}; });
          throw new Error(j.error || ('status ' + r.status));
        }
        settingsCache.savings_rate_target_pct = v;
        srStatus.textContent = 'Target saved.';
        loadSavings();
      } catch (e) {
        srStatus.textContent = 'Save failed: ' + e.message;
      }
    });
  }

  loadMoM();
  loadSettings().then(loadSavings);
})();

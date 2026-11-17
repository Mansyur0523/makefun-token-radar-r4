// Token Radar r4 dashboard: sort, filter, search and detail view over window.RADAR.
// No network: all data is in ../data.js, written by main.ts from the same board.
(function () {
  'use strict';
  var D = window.RADAR;
  if (!D) { document.body.innerHTML = '<p style="padding:40px">Radar data (data.js) did not load.</p>'; return; }

  function money(n) {
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + Math.round(n);
  }
  function pct(g) { return g === null || g === undefined ? '—' : (g > 0 ? '+' : '') + g.toFixed(1) + '%'; }
  function age(a) {
    if (a === null || a === undefined) return '—';
    if (a < 30) return a + 'd';
    if (a < 365) return Math.round(a / 30) + 'mo';
    return (a / 365).toFixed(1) + 'y';
  }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  var oos = D.oos[0];
  document.getElementById('oosLine').innerHTML =
    '<b>Comps curve tested blind:</b> fit before 2024, tested on 2024+ listings (n=' + oos.test_n +
    ') — typical error <b>&times;' + oos.curve_typical_x + '</b>, <b>' + Math.round(oos.curve_within_2x * 100) +
    '% within 2&times;</b> of the real market cap. Flat 0.25&times; on the same split: &times;' +
    oos.flat_typical_x + ', ' + Math.round(oos.flat_within_2x * 100) + '% within 2&times;. ' +
    'Curve: log(mcap) = ' + D.model.intercept + ' + ' + D.model.slope + ' &times; log(TVL), n=' +
    D.model.n_comps + ', R&sup2;=' + D.model.r2 + '.';
  document.getElementById('asof').textContent = D.as_of;

  var catSel = document.getElementById('cat');
  var cats = {};
  D.rows.forEach(function (r) { cats[r.category || 'Uncategorised'] = true; });
  Object.keys(cats).sort().forEach(function (c) {
    var o = document.createElement('option'); o.textContent = c; catSel.appendChild(o);
  });

  var state = { q: '', cat: '', verdict: '', list: '', sort: 'implied' };

  function filtered() {
    var q = state.q.trim().toLowerCase();
    var out = D.rows.filter(function (r) {
      if (state.cat && (r.category || 'Uncategorised') !== state.cat) return false;
      if (state.verdict && r.verdict !== state.verdict) return false;
      if (state.list === 'watch' && !r.on_watchlist) return false;
      if (state.list === 'early' && r.on_watchlist) return false;
      if (q) {
        var hay = (r.name + ' ' + r.slug + ' ' + (r.category || '') + ' ' + r.chains.join(' ')).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });
    var by = {
      implied: function (a, b) { return b.implied_value_usd - a.implied_value_usd; },
      tvl: function (a, b) { return b.tvl_usd - a.tvl_usd; },
      growth: function (a, b) { return (b.change_7d || -999) - (a.change_7d || -999); },
      age: function (a, b) { return (b.age_days || 0) - (a.age_days || 0); },
      name: function (a, b) { return a.name < b.name ? -1 : 1; },
      ratio: function (a, b) { return b.implied_per_tvl - a.implied_per_tvl; }
    }[state.sort] || function (a, b) { return a.rank - b.rank; };
    return out.sort(by);
  }

  function render() {
    var rows = filtered();
    var tb = document.getElementById('rows');
    tb.innerHTML = rows.map(function (r) {
      return '<tr data-slug="' + esc(r.slug) + '">' +
        '<td class="num">' + r.rank + '</td>' +
        '<td><b>' + esc(r.name) + '</b><span class="sub">' + esc(r.slug) + (r.on_watchlist ? ' · watchlist' : '') + '</span></td>' +
        '<td>' + esc(r.category || '—') + '</td>' +
        '<td>' + esc(r.chains.slice(0, 2).join(', ')) + (r.chains.length > 2 ? ' +' + (r.chains.length - 2) : '') + '</td>' +
        '<td class="num">' + money(r.tvl_usd) + '</td>' +
        '<td class="num">' + pct(r.change_7d) + '</td>' +
        '<td class="num">' + age(r.age_days) + '</td>' +
        '<td class="num"><b>' + money(r.implied_value_usd) + '</b><span class="sub">' + money(r.implied_low_usd) + '–' + money(r.implied_high_usd) + '</span></td>' +
        '<td class="num">' + r.implied_per_tvl.toFixed(2) + '×</td>' +
        '<td><span class="badge ' + r.verdict + '">' + r.verdict + '</span></td></tr>';
    }).join('');
    document.getElementById('count').textContent =
      rows.length + ' of ' + D.rows.length + ' protocols · ' +
      D.verdict_counts.FARM + ' FARM · ' + D.verdict_counts.THIN + ' THIN · ' + D.verdict_counts.WATCH + ' WATCH';
  }

  function showDetail(slug) {
    var r = null;
    D.rows.forEach(function (x) { if (x.slug === slug) r = x; });
    var box = document.getElementById('detail');
    if (!r) { box.hidden = true; box.innerHTML = ''; return; }
    box.hidden = false;
    box.innerHTML =
      '<div class="card">' +
      '<button class="close" id="closeDetail">Close ✕</button>' +
      '<h2>#' + r.rank + ' — ' + esc(r.name) + '</h2>' +
      '<p class="meta">' + esc(r.category || 'Uncategorised') + ' · ' + esc(r.chains.join(', ')) +
      ' · TVL ' + money(r.tvl_usd) + ' · 7-day ' + pct(r.change_7d) + ' · listed ' + (r.listed_at || 'unknown') +
      ' (' + age(r.age_days) + ') · records no token' + (r.on_watchlist ? ' · <b>on the watchlist</b>' : '') + '</p>' +
      '<p class="band">Implied value <b>' + money(r.implied_value_usd) + '</b> — honest band ' +
      money(r.implied_low_usd) + ' to ' + money(r.implied_high_usd) +
      ' (blind time-split typical error ×' + D.model.typical_error_x + '). ' +
      'Verdict: <span class="badge ' + r.verdict + '">' + r.verdict + '</span></p>' +
      '<table><tbody>' +
      '<tr><td>Model</td><td>log(mcap) = ' + D.model.intercept + ' + ' + D.model.slope +
      ' × log(TVL), fit on ' + D.model.n_comps + ' live-token comps (R²=' + D.model.r2 + ')</td></tr>' +
      '<tr><td>Implied / TVL</td><td>' + r.implied_per_tvl.toFixed(3) + '× — the curve, not a flat multiple: the ratio falls as TVL grows</td></tr>' +
      '<tr><td>Growth tilt</td><td>×' + r.growth_multiplier + ' (7-day change ' + pct(r.change_7d) + ', clamped to ±30%, weight 0.15)</td></tr>' +
      '<tr><td>Maturity tilt</td><td>×' + r.maturity_multiplier + ' (age ' + age(r.age_days) + ', 0.92–1.08 over 3 years)</td></tr>' +
      '</tbody></table>' +
      '<h3>Farm plan — six steps, each with its cost and time</h3><ol>' +
      r.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol></div>';
    document.getElementById('closeDetail').onclick = function () {
      box.hidden = true; box.innerHTML = '';
      if (location.hash.indexOf('#detail=') === 0) history.replaceState(null, '', location.pathname);
    };
  }

  document.getElementById('rows').addEventListener('click', function (e) {
    var tr = e.target.closest('tr[data-slug]');
    if (tr) { location.hash = '#detail=' + tr.getAttribute('data-slug'); showDetail(tr.getAttribute('data-slug')); }
  });

  function readHash() {
    var h = location.hash || '';
    var m = h.match(/detail=([^&]+)/);
    if (m) { showDetail(decodeURIComponent(m[1])); return; }
    var q = h.match(/q=([^&]+)/);
    if (q) { state.q = decodeURIComponent(q[1]); document.getElementById('q').value = state.q; }
    var c = h.match(/cat=([^&]+)/);
    if (c) { state.cat = decodeURIComponent(c[1]); catSel.value = state.cat; }
    var v = h.match(/verdict=([^&]+)/);
    if (v) { state.verdict = decodeURIComponent(v[1]); document.getElementById('verdict').value = state.verdict; }
    render();
  }

  document.getElementById('q').addEventListener('input', function (e) { state.q = e.target.value; render(); });
  catSel.addEventListener('change', function (e) { state.cat = e.target.value; render(); });
  document.getElementById('verdict').addEventListener('change', function (e) { state.verdict = e.target.value; render(); });
  document.getElementById('list').addEventListener('change', function (e) { state.list = e.target.value; render(); });
  document.getElementById('sort').addEventListener('change', function (e) { state.sort = e.target.value; render(); });
  document.querySelectorAll('#board thead th[data-k]').forEach(function (th) {
    th.addEventListener('click', function () {
      var map = { rank: 'implied', name: 'name', tvl: 'tvl', growth: 'growth', age: 'age', implied: 'implied', ratio: 'ratio', verdict: 'implied' };
      var k = map[th.getAttribute('data-k')] || 'implied';
      state.sort = k; document.getElementById('sort').value = k; render();
    });
  });

  var liveTb = document.getElementById('liveRows');
  liveTb.innerHTML = D.live.map(function (p) {
    return '<tr><td><b>' + esc(p.name) + '</b><span class="sub">' + esc(p.slug) + '</span></td>' +
      '<td>' + esc(p.category || '—') + '</td>' +
      '<td class="num">' + money(p.tvl_usd) + '</td>' +
      '<td class="num"><b>' + money(p.mcap_usd) + '</b></td>' +
      '<td class="num">' + p.mcap_per_tvl.toFixed(2) + '×</td>' +
      '<td class="num">' + pct(p.change_7d) + '</td></tr>';
  }).join('');

  render();
  readHash();
  window.addEventListener('hashchange', readHash);
})();

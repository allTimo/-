/* Аналитика: шесть графиков, срезы, 29 метрик, топы. Без внешних библиотек — SVG. */
'use strict';

var A_PERIOD = '90';
var A_GRAIN = 'day';
var A_FROM = '';
var A_TO = '';

var NS = 'http://www.w3.org/2000/svg';
function sEl(tag, attrs) {
  var n = document.createElementNS(NS, tag);
  if (attrs) Object.keys(attrs).forEach(function (k) { n.setAttribute(k, attrs[k]); });
  return n;
}
function chartBox(host, h) {
  var svg = sEl('svg', { viewBox: '0 0 900 ' + h, class: 'chart-svg', preserveAspectRatio: 'none' });
  svg.style.height = h + 'px';
  host.appendChild(svg);
  return svg;
}
function emptyNote(host, text) { host.appendChild(el('div', 'muted small', text || 'данных пока нет')); }
function niceNum(v) {
  if (v === null || v === undefined || isNaN(v)) return '—';
  if (Math.abs(v) >= 1e9) return (v / 1e9).toFixed(2) + ' млрд';
  if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(2) + ' млн';
  if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(1) + ' тыс.';
  return String(Math.round(v * 100) / 100);
}
function fmtMetric(m) {
  if (!m || m.value === null || m.value === undefined) return 'данных пока нет';
  if (m.unit === '%') return fmtPct(m.value);
  if (m.unit === '₽') return money(m.value, true);
  if (m.unit === 'с') return (Math.round(m.value * 10) / 10) + ' с';
  return fmtInt(m.value);
}

/* --- графики --- */
function lineArea(host, rows, keys, opts) {
  if (!rows.length) { emptyNote(host); return; }
  var h = 220, w = 900, padL = 8, padB = 22;
  var svg = chartBox(host, h);
  var max = 1;
  keys.forEach(function (k) { rows.forEach(function (r) { max = Math.max(max, r[k]); }); });
  var step = rows.length > 1 ? (w - padL * 2) / (rows.length - 1) : 0;
  function x(i) { return padL + i * step; }
  function y(v) { return h - padB - (v / max) * (h - padB - 10); }
  [0.25, 0.5, 0.75].forEach(function (g) {
    svg.appendChild(sEl('line', { x1: 0, x2: w, y1: h - padB - g * (h - padB - 10), y2: h - padB - g * (h - padB - 10), stroke: 'var(--border-soft)', 'stroke-width': 1 }));
  });
  keys.forEach(function (k, ki) {
    var color = ['#7553ff', '#05df72', '#4fc1ff'][ki % 3];
    var pts = rows.map(function (r, i) { return x(i) + ',' + y(r[k]); }).join(' ');
    if (ki === 0) {
      var area = sEl('polygon', { points: padL + ',' + (h - padB) + ' ' + pts + ' ' + x(rows.length - 1) + ',' + (h - padB), fill: color, opacity: 0.16 });
      svg.appendChild(area);
    }
    svg.appendChild(sEl('polyline', { points: pts, fill: 'none', stroke: color, 'stroke-width': 2 }));
  });
  var l1 = sEl('text', { x: padL, y: h - 6, fill: 'var(--muted-2)', 'font-size': 11 });
  l1.textContent = rows[0].key + '  →  ' + rows[rows.length - 1].key + '   ·   максимум ' + niceNum(max);
  svg.appendChild(l1);
}

function barsCumulative(host, rows) {
  if (!rows.length) { emptyNote(host); return; }
  var h = 240, w = 900, padB = 24;
  var svg = chartBox(host, h);
  var max = 1;
  rows.forEach(function (r) { max = Math.max(max, r.revenue, r.cost, r.margin); });
  var groupW = (w - 20) / rows.length;
  var barW = Math.max(3, (groupW - 6) / 3);
  rows.forEach(function (r, i) {
    var x0 = 10 + i * groupW;
    [['revenue', '#7553ff'], ['cost', '#f14c4c'], ['margin', '#05df72']].forEach(function (k, ki) {
      var v = r[k[0]];
      var bh = Math.max(0, (v / max) * (h - padB - 10));
      svg.appendChild(sEl('rect', { x: x0 + ki * barW, y: h - padB - bh, width: Math.max(2, barW - 2), height: bh, fill: k[1], rx: 2 }));
    });
  });
  var t = sEl('text', { x: 10, y: h - 6, fill: 'var(--muted-2)', 'font-size': 11 });
  t.textContent = rows[0].week + ' → ' + rows[rows.length - 1].week + ' · накопительно · максимум ' + niceNum(max);
  svg.appendChild(t);
}

function donutChart(host, items, total) {
  if (!items.length || total <= 0) { emptyNote(host, 'данных пока нет: нет доходных подписок'); return; }
  var size = 200, r = 80, cx = 100, cy = 100, inner = 52;
  var svg = sEl('svg', { viewBox: '0 0 ' + size + ' ' + size, class: 'chart-svg' });
  svg.style.height = size + 'px';
  var colors = ['#7553ff', '#4fc1ff', '#05df72', '#ffb020', '#f14c4c'];
  var a0 = -Math.PI / 2;
  items.forEach(function (it, i) {
    var a1 = a0 + (it.value / total) * Math.PI * 2;
    var large = (a1 - a0) > Math.PI ? 1 : 0;
    var x1 = cx + r * Math.cos(a0), y1 = cy + r * Math.sin(a0);
    var x2 = cx + r * Math.cos(a1), y2 = cy + r * Math.sin(a1);
    var x3 = cx + inner * Math.cos(a1), y3 = cy + inner * Math.sin(a1);
    var x4 = cx + inner * Math.cos(a0), y4 = cy + inner * Math.sin(a0);
    var d = 'M' + x1 + ',' + y1 + ' A' + r + ',' + r + ' 0 ' + large + ' 1 ' + x2 + ',' + y2 + ' L' + x3 + ',' + y3 + ' A' + inner + ',' + inner + ' 0 ' + large + ' 0 ' + x4 + ',' + y4 + ' Z';
    svg.appendChild(sEl('path', { d: d, fill: colors[i % colors.length], opacity: 0.92 }));
    a0 = a1;
  });
  host.appendChild(svg);
  var ul = el('ul', 'clean');
  items.forEach(function (it, i) {
    var li = el('li');
    var dot = el('span', 'legend-dot');
    dot.style.background = colors[i % colors.length];
    li.appendChild(dot);
    li.appendChild(document.createTextNode(it.name + ' — ' + money(it.value, true) + ' · ' + fmtPct(it.share)));
    ul.appendChild(li);
  });
  host.appendChild(ul);
}

function hBars(host, items, unit) {
  if (!items.length) { emptyNote(host, 'данных пока нет'); return; }
  var max = items.reduce(function (a, x) { return Math.max(a, x.value); }, 0) || 1;
  items.forEach(function (x) {
    var row = el('div', 'hb-row');
    row.appendChild(el('div', 'hb-name', x.name));
    var track = el('div', 'hb-track');
    var fill = el('div', 'hb-fill');
    fill.style.width = Math.max(2, Math.round((x.value / max) * 100)) + '%';
    track.appendChild(fill);
    row.appendChild(track);
    row.appendChild(el('div', 'hb-val', (unit === '₽' ? money(x.value, true) : fmtInt(x.value)) + (x.share !== undefined ? ' · ' + fmtPct(x.share) : '')));
    host.appendChild(row);
  });
}

function funnelView(host, f) {
  if (!f.runs) { emptyNote(host, 'данных пока нет: прогонов ещё не было'); return; }
  var steps = [['Прогоны', f.runs, '#7553ff'], ['Результаты', f.results, '#4fc1ff'], ['Отправлено клиенту', f.sent, '#05df72']];
  var max = Math.max(f.runs, 1);
  steps.forEach(function (s, i) {
    var row = el('div', 'fn-row');
    row.appendChild(el('div', 'fn-name', s[0]));
    var track = el('div', 'fn-track');
    var fill = el('div', 'fn-fill');
    fill.style.width = Math.max(3, Math.round((s[1] / max) * 100)) + '%';
    fill.style.background = s[2];
    track.appendChild(fill);
    row.appendChild(track);
    var conv = i === 0 ? '' : ' · ' + fmtPct(s[1] / max);
    row.appendChild(el('div', 'fn-val', String(s[1]) + conv));
    host.appendChild(row);
  });
  if (f.pending) host.appendChild(el('div', 'hintline', 'Ожидает отправки вручную: ' + f.pending));
}

var DOW = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
function heatView(host, heat) {
  var total = heat.reduce(function (a, r) { return a + r.reduce(function (x, y) { return x + y; }, 0); }, 0);
  if (total === 0) { emptyNote(host, 'данных пока нет: ни одного прогона с датой'); return; }
  var max = Math.max.apply(null, heat.map(function (r) { return Math.max.apply(null, r); }));
  var wrap = el('div', 'heat');
  var head = el('div', 'heat-row');
  head.appendChild(el('div', 'heat-lab'));
  for (var hh = 0; hh < 24; hh++) head.appendChild(el('div', 'heat-hour', hh % 2 === 0 ? String(hh) : ''));
  wrap.appendChild(head);
  heat.forEach(function (row, d) {
    var r = el('div', 'heat-row');
    r.appendChild(el('div', 'heat-lab', DOW[d]));
    row.forEach(function (v) {
      var c = el('div', 'heat-cell', v > 0 ? String(v) : '');
      c.style.background = v === 0 ? 'var(--panel-2)' : 'rgba(117,83,255,' + (0.15 + 0.85 * (v / max)).toFixed(2) + ')';
      c.title = DOW[d] + ', ' + String(row.indexOf(v)) + ':00 — прогонов ' + v;
      r.appendChild(c);
    });
    wrap.appendChild(r);
  });
  host.appendChild(wrap);
  host.appendChild(el('div', 'hintline', 'Всего прогонов на карте: ' + total + ' · темнее = больше. Время московское.'));
}

function sparkline(host, values) {
  if (!values || values.length < 2) return;
  var w = 120, h = 28;
  var svg = sEl('svg', { viewBox: '0 0 ' + w + ' ' + h, class: 'spark' });
  var min = Math.min.apply(null, values), max = Math.max.apply(null, values);
  var span = (max - min) || 1;
  var pts = values.map(function (v, i) {
    return (i * (w - 4) / (values.length - 1) + 2) + ',' + (h - 3 - ((v - min) / span) * (h - 8));
  }).join(' ');
  svg.appendChild(sEl('polyline', { points: pts, fill: 'none', stroke: 'var(--accent)', 'stroke-width': 1.8 }));
  host.appendChild(svg);
}

/* --- выборка периода --- */
function periodRows(a) {
  var days = a.series.day;
  if (A_PERIOD === 'all') return days;
  if (A_PERIOD === 'custom') {
    return days.filter(function (d) { return (!A_FROM || d.key >= A_FROM) && (!A_TO || d.key <= A_TO); });
  }
  var n = parseInt(A_PERIOD, 10);
  return days.slice(-n);
}
function grainRows(a, days) {
  if (A_GRAIN === 'day') return days;
  if (A_GRAIN === 'month') {
    var m = new Map();
    days.forEach(function (d) {
      var k = d.key.slice(0, 7);
      if (!m.has(k)) m.set(k, { key: k, revenue: 0, cost: 0, margin: 0, runs: 0, results: 0, sent: 0 });
      var g = m.get(k);
      g.revenue += d.revenue; g.cost += d.cost; g.margin += d.margin; g.runs += d.runs; g.results += d.results; g.sent += d.sent;
    });
    return Array.from(m.values());
  }
  // неделя
  var w2 = new Map();
  days.forEach(function (d) {
    var dt = new Date(d.key + 'T00:00:00Z');
    var dow = dt.getUTCDay() === 0 ? 7 : dt.getUTCDay();
    dt.setUTCDate(dt.getUTCDate() + 4 - dow);
    var ys = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
    var k = dt.getUTCFullYear() + '-W' + String(Math.ceil(((dt - ys) / 86400000 + 1) / 7)).padStart(2, '0');
    if (!w2.has(k)) w2.set(k, { key: k, revenue: 0, cost: 0, margin: 0, runs: 0, results: 0, sent: 0 });
    var g = w2.get(k);
    g.revenue += d.revenue; g.cost += d.cost; g.margin += d.margin; g.runs += d.runs; g.results += d.results; g.sent += d.sent;
  });
  return Array.from(w2.values()).sort(function (x, y) { return x.key < y.key ? -1 : 1; });
}

VIEWS.analytics = function (view) {
  var a = STATE.analytics2;
  if (!a) { view.appendChild(note('bad', 'Нет данных аналитики. Пересоберите: node marketing-agents/dashboard/collector/collect.mjs')); return; }

  // --- фильтр периода и срезы ---
  var s0 = section('Период и срезы', 'выбранный период применяется ко всем графикам и к блоку «за период»');
  var c0 = card();
  var pf = el('div', 'filters');
  [['7', '7 дней'], ['30', '30 дней'], ['90', '90 дней'], ['all', 'всё время'], ['custom', 'произвольный']].forEach(function (p) {
    var b = el('button', 'btn small' + (A_PERIOD === p[0] ? ' primary' : ''), p[1]);
    b.addEventListener('click', function () { A_PERIOD = p[0]; renderActive(); });
    pf.appendChild(b);
  });
  if (A_PERIOD === 'custom') {
    var f1 = el('input'); f1.type = 'date'; f1.value = A_FROM;
    f1.addEventListener('change', function () { A_FROM = this.value; renderActive(); });
    var f2 = el('input'); f2.type = 'date'; f2.value = A_TO;
    f2.addEventListener('change', function () { A_TO = this.value; renderActive(); });
    pf.appendChild(el('span', 'small muted', 'с'));
    pf.appendChild(f1);
    pf.appendChild(el('span', 'small muted', 'по'));
    pf.appendChild(f2);
  }
  c0.appendChild(pf);
  var rows = periodRows(a);
  var grain = grainRows(a, rows);
  c0.appendChild(el('div', 'small muted', 'Показано: ' + rows.length + ' дней (' + (rows[0] ? rows[0].key : '—') + ' → ' + (rows[rows.length - 1] ? rows[rows.length - 1].key : '—') + ').'));
  s0.appendChild(c0);
  view.appendChild(s0);

  // --- метрики за период ---
  var pRev = rows.reduce(function (x, d) { return x + d.revenue; }, 0);
  var pCost = rows.reduce(function (x, d) { return x + d.cost; }, 0);
  var pMargin = pRev - pCost;
  var pRuns = rows.reduce(function (x, d) { return x + d.runs; }, 0);
  var k = el('div', 'grid kpi');
  k.appendChild(kpi('Доход за период', money(pRev, true), rows.length + ' дней', 'ok'));
  k.appendChild(kpi('Себестоимость за период', money(pCost, true), 'прогонов: ' + pRuns, 'accent'));
  k.appendChild(kpi('Маржа за период', money(pMargin, true), pRev > 0 ? fmtPct(pMargin / pRev) + ' от дохода' : '', pMargin >= 0 ? 'ok' : 'bad'));
  k.appendChild(kpi('Средняя себестоимость', pRuns ? money(pCost / pRuns, true) : null, 'на один прогон', ''));
  view.appendChild(k);

  var all = Object.keys(a.metrics).map(function (key) { return { key: key, m: a.metrics[key] }; });
  var s1 = section('Метрики', 'всего ' + all.length + ' показателей · в плитках со спарклайном — тренд за 14 дней');
  var grid = el('div', 'grid kpi');
  all.forEach(function (x) {
    var v = sEl; // заглушка не нужна
    var tile = el('div', 'kpi');
    tile.appendChild(el('div', 'kpi-label', x.m.label));
    var val = el('div', 'kpi-value', fmtMetric(x.m));
    if (x.m.value === null || x.m.value === undefined) val.classList.add('muted');
    val.title = x.m.hint;
    tile.appendChild(val);
    if (x.m.unit) tile.appendChild(el('div', 'kpi-foot', x.m.unit));
    if (x.key === 'margin' || x.key === 'revenue' || x.key === 'cost') {
      var sp = el('div', 'spark-host');
      sparkline(sp, a.spark);
      tile.appendChild(sp);
    }
    grid.appendChild(tile);
  });
  s1.appendChild(grid);
  view.appendChild(s1);

  // --- 1. динамика ---
  var s2 = section('Динамика во времени', 'доход · себестоимость · маржа');
  var c2 = card();
  var gf = el('div', 'filters');
  [['day', 'день'], ['week', 'неделя'], ['month', 'месяц']].forEach(function (g) {
    var b = el('button', 'btn small' + (A_GRAIN === g[0] ? ' primary' : ''), g[1]);
    b.addEventListener('click', function () { A_GRAIN = g[0]; renderActive(); });
    gf.appendChild(b);
  });
  c2.appendChild(gf);
  var dynHost = el('div');
  c2.appendChild(dynHost);
  if (grain.length < 2) emptyNote(dynHost, 'данных пока нет: для динамики нужно минимум два интервала');
  else lineArea(dynHost, grain, ['revenue', 'cost', 'margin']);
  s2.appendChild(c2);
  view.appendChild(s2);

  // --- 2. столбцы по неделям ---
  var s3 = section('Доход · себестоимость · маржа по неделям', 'накопительно');
  var c3 = card();
  if (!a.bars.length) emptyNote(c3);
  else barsCumulative(c3, a.bars);
  s3.appendChild(c3);
  view.appendChild(s3);

  // --- 3. доли ---
  var s4 = section('Доли', 'по услугам — кольцевая, по клиентам — полосы');
  var g4 = el('div', 'cards');
  var c4a = card('По услугам (доход)');
  donutChart(c4a, a.byService, a.serviceTotal);
  g4.appendChild(c4a);
  var c4b = card('По клиентам (доход)');
  hBars(c4b, a.byClient, '₽');
  g4.appendChild(c4b);
  s4.appendChild(g4);
  view.appendChild(s4);

  // --- 4. воронка + 5. тепловая карта ---
  var s5 = section('Воронка и активность', 'прогоны → результаты → отправлено · день недели × час');
  var g5 = el('div', 'cards');
  var c5 = card('Воронка');
  funnelView(c5, a.funnel);
  g5.appendChild(c5);
  var c6 = card('Тепловая карта прогонов');
  heatView(c6, a.heatmap);
  g5.appendChild(c6);
  s5.appendChild(g5);
  view.appendChild(s5);

  // --- срезы ---
  var s6 = section('Срезы', 'всего ' + a.counts.slices + ' измерений');
  var g6 = el('div', 'cards');
  Object.keys(a.slices).forEach(function (key) {
    var list = a.slices[key];
    var names = { client: 'По клиентам', service: 'По услугам', agent: 'По агентам', source: 'По источникам', channel: 'По каналу доставки', plan: 'По тарифу', project: 'По проектам', status: 'По статусу клиента', runStatus: 'По статусу прогона' };
    var c = card(names[key] || key);
    if (!list.length) { emptyNote(c, 'данных пока нет'); g6.appendChild(c); return; }
    var wrap = el('div', 'table-wrap');
    var t = el('table', 'data');
    var th = el('thead'); var tr = el('tr');
    ['Значение', 'Количество', 'Сумма'].forEach(function (h, i) { add(tr, 'th', i > 0 ? 'num' : null, h); });
    th.appendChild(tr); t.appendChild(th);
    var tb = el('tbody');
    list.slice(0, 8).forEach(function (x) {
      var r = el('tr');
      add(r, 'td', null, x.key);
      add(r, 'td', 'num', String(x.count));
      add(r, 'td', 'num', x.value ? money(x.value, true) : '—');
      tb.appendChild(r);
    });
    t.appendChild(tb); wrap.appendChild(t); c.appendChild(wrap);
    g6.appendChild(c);
  });
  s6.appendChild(g6);
  view.appendChild(s6);

  // --- топы ---
  var s7 = section('Топ-5', 'самое крупное по каждому измерению');
  var g7 = el('div', 'cards');
  [['servicesByMargin', 'Услуги по марже'], ['clientsByRevenue', 'Клиенты по доходу'], ['sourcesByLots', 'Источники по лотам'], ['modelsByCost', 'Модели по расходу']].forEach(function (t) {
    var list = a.tops[t[0]] || [];
    var c = card(t[1]);
    if (!list.length) { emptyNote(c); g7.appendChild(c); return; }
    var wrap = el('div', 'table-wrap');
    var tb2 = el('table', 'data');
    var thead = el('thead'); var tr2 = el('tr');
    ['Название', 'Значение'].forEach(function (h, i) { var thh = add(tr2, 'th', i === 1 ? 'num' : null, h); });
    tr2.appendChild(el('th', null, ''));
    thead.appendChild(tr2); tb2.appendChild(thead);
    var tbody = el('tbody');
    list.forEach(function (x) {
      var r = el('tr');
      add(r, 'td', null, x.name);
      add(r, 'td', 'num', x.unit === '₽' ? money(x.value, true) : fmtInt(x.value) + ' ' + (x.unit || ''));
      add(r, 'td', 'small muted', x.extra || '');
      tbody.appendChild(r);
    });
    tb2.appendChild(tbody); wrap.appendChild(tb2); c.appendChild(wrap);
    g7.appendChild(c);
  });
  s7.appendChild(g7);
  view.appendChild(s7);
};

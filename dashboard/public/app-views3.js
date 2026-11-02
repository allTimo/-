/* Вкладка «Аналитика»: сквозная связка агент -> задачи -> результат -> расход. */
'use strict';

var anFilters = { period: 'all', project: 'all' };

function anDaysFiltered(days, period) {
  if (period === 'all') return days || [];
  var n = period === '7' ? 7 : 30;
  return (days || []).slice(-n);
}

function anSum(days) {
  var acc = { tokens: 0, rub: 0, rubComplete: true, days: days.length };
  days.forEach(function (d) {
    acc.tokens += d.tokens || 0;
    if (d.rub === null || d.rub === undefined) acc.rubComplete = false; else acc.rub += d.rub;
  });
  return acc;
}

function anFilteredAgents(doc, project) {
  if (project === 'all') return doc.agents;
  return doc.agents.filter(function (a) { return (a.projects || []).indexOf(project) >= 0; });
}

VIEWS.analytics = function (view) {
  var doc = STATE.analytics;
  if (!doc) { view.appendChild(note('bad', 'Нет данных аналитики. Пересоберите: node marketing-agents/dashboard/collector/collect.mjs')); return; }

  // --- фильтры ---
  var fSection = section('Сводка за период', 'фильтр по датам и проекту');
  var fCard = card();
  var f = el('div', 'filters');
  var periodWrap = el('div');
  periodWrap.appendChild(el('label', null, 'Период: '));
  var periodRow = el('span', 'chip-row');
  [['7', '7 дней'], ['30', '30 дней'], ['all', 'всё время']].forEach(function (p) {
    var b = el('button', 'btn small' + (anFilters.period === p[0] ? ' primary' : ''), p[1]);
    b.addEventListener('click', function () { anFilters.period = p[0]; renderActive(); });
    periodRow.appendChild(b);
  });
  periodWrap.appendChild(periodRow);
  f.appendChild(periodWrap);

  var projWrap = el('div');
  projWrap.appendChild(el('label', null, 'Проект: '));
  var sel = el('select');
  var optAll = el('option', null, 'все проекты'); optAll.value = 'all'; sel.appendChild(optAll);
  (doc.projects || []).forEach(function (p) {
    var o = el('option', null, p.name); o.value = p.id;
    if (anFilters.project === p.id) o.selected = true;
    sel.appendChild(o);
  });
  sel.addEventListener('change', function () { anFilters.project = this.value; renderActive(); });
  projWrap.appendChild(sel);
  f.appendChild(projWrap);
  fCard.appendChild(f);

  var days = anDaysFiltered(doc.days, anFilters.period);
  var sum = anSum(days);
  var agents = anFilteredAgents(doc, anFilters.project);
  var projTasks = 0;
  if (anFilters.project !== 'all') {
    var p = (doc.projects || []).filter(function (x) { return x.id === anFilters.project; })[0];
    projTasks = p ? p.tasks.total : 0;
  } else {
    projTasks = doc.funnel.tasks;
  }

  var k = el('div', 'kpi');
  function kpiCell(label, value, foot, cls) {
    var c = el('div', 'card kpi ' + (cls || ''));
    c.appendChild(el('div', 'accent-bar'));
    c.appendChild(el('div', 'label', label));
    c.appendChild(el('div', 'value small', value));
    if (foot) c.appendChild(el('div', 'foot', foot));
    return c;
  }
  var kg = el('div', 'grid kpi');
  kg.appendChild(kpiCell('Агентов включено', doc.funnel.agentsEnabled + ' / ' + doc.funnel.agents, 'в выборке: ' + agents.length, 'ok'));
  kg.appendChild(kpiCell('Задач', String(projTasks), 'готово: ' + doc.funnel.tasksDone + ' · в работе: ' + doc.funnel.tasksInProgress, 'warn'));
  kg.appendChild(kpiCell('Лотов собрано', fmtInt(doc.funnel.lots), 'по всем снимкам (недельная детализация)', 'purple'));
  kg.appendChild(kpiCell('Токенов за период', fmtTokens(sum.tokens), 'дней в периоде: ' + sum.days, 'accent'));
  kg.appendChild(kpiCell('Расход за период', money(sum.rub, sum.rubComplete), sum.rubComplete ? 'сумма полная' : 'часть моделей без цены', sum.rubComplete ? 'ok' : 'bad'));
  fCard.appendChild(kg);
  fCard.appendChild(el('div', 'hintline', 'Лоты и задачи считаются по неделям и по реестру, поэтому фильтр по датам применяется к расходу и токенам. Это указано честно, а не спрятано.'));
  fSection.appendChild(fCard);
  view.appendChild(fSection);

  // --- воронка ---
  var s1 = section('Воронка: агент → задачи → результат → расход', 'сколько задач у агента, что сделано и во что это обошлось');
  var c1 = card();
  var wrap = el('div', 'table-wrap');
  var t = el('table', 'data');
  var thead = el('thead'); var tr = el('tr');
  [['Агент'], ['Задач', 'num'], ['В работе', 'num'], ['Готово', 'num'], ['Группы задач'], ['Сессий', 'num'], ['Токенов', 'num'], ['Расход', 'num'], ['Источники'], ['Активность']].forEach(function (h) { add(tr, 'th', h[1] || null, h[0]); });
  thead.appendChild(tr); t.appendChild(thead);
  var tb = el('tbody');
  agents.forEach(function (a) {
    var row = el('tr');
    var td0 = el('td');
    td0.appendChild(el('span', null, a.name));
    td0.appendChild(el('div', 'small muted', a.enabled ? 'включён' : 'выключен'));
    row.appendChild(td0);
    add(row, 'td', 'num', String(a.tasks.total));
    add(row, 'td', 'num', String(a.tasks.inProgress));
    add(row, 'td', 'num', String(a.tasks.done));
    add(row, 'td', 'small muted', Object.keys(a.tasks.byGroup).map(function (g) { return g + ' (' + a.tasks.byGroup[g] + ')'; }).join(', ') || '—');
    add(row, 'td', 'num', String(a.sessions));
    add(row, 'td', 'num', fmtTokens(a.tokens.totalTokens)).title = fmtInt(a.tokens.totalTokens);
    add(row, 'td', 'num', a.tokens.totalTokens === 0 ? '—' : money(a.rub, a.rubComplete));
    add(row, 'td', 'small muted', a.sources.length ? a.sources.join(', ') : 'не привязаны');
    add(row, 'td', null, a.lastActivityAt ? fmtAgo(a.lastActivityAt) : 'не запускался');
    tb.appendChild(row);
  });
  t.appendChild(tb); wrap.appendChild(t); c1.appendChild(wrap);

  // расход по агентам — полосы
  var bars = el('div', 'bars');
  bars.style.marginTop = '12px';
  var maxT = 1;
  agents.forEach(function (a) { if (a.tokens.totalTokens > maxT) maxT = a.tokens.totalTokens; });
  agents.forEach(function (a) {
    bars.appendChild(barRow(a.name, a.tokens.totalTokens, maxT,
      fmtTokens(a.tokens.totalTokens) + ' · ' + (a.tokens.totalTokens === 0 ? 'не запускался' : money(a.rub, a.rubComplete)),
      a.enabled ? 'ok' : 'warn',
      a.tasks.total + ' задач, ' + a.sessions + ' сессий'));
  });
  c1.appendChild(bars);
  s1.appendChild(c1);
  view.appendChild(s1);

  // --- источники ---
  var s2 = section('Связка с источниками', 'сколько лотов дал источник и сколько стоили агенты, которые его используют');
  var c2 = card();
  var wrap2 = el('div', 'table-wrap');
  var t2 = el('table', 'data');
  var th2 = el('thead'); var tr2 = el('tr');
  [['Источник'], ['Статус'], ['Лотов', 'num'], ['Снимков', 'num'], ['Доля', 'num'], ['Агенты'], ['Их расход', 'num'], ['₽ на лот', 'num'], ['Последние данные']].forEach(function (h) { add(tr2, 'th', h[1] || null, h[0]); });
  th2.appendChild(tr2); t2.appendChild(th2);
  var tb2 = el('tbody');
  doc.sources.forEach(function (s) {
    var row = el('tr');
    var td = el('td');
    td.appendChild(el('span', null, s.name));
    td.appendChild(el('div', 'small muted', s.enabled ? 'включён' : 'выключен'));
    row.appendChild(td);
    var tds = el('td'); tds.appendChild(sourceStatusBadge(s.status)); row.appendChild(tds);
    add(row, 'td', 'num', fmtInt(s.lots));
    add(row, 'td', 'num', String(s.snapshots));
    add(row, 'td', 'num', fmtPct(s.share));
    add(row, 'td', 'small muted', s.agents.length ? s.agents.map(function (id) {
      var a = doc.agents.filter(function (x) { return x.id === id; })[0];
      return a ? a.name : id;
    }).join(', ') : 'не привязаны');
    add(row, 'td', 'num', s.agentsRub === null ? '—' : money(s.agentsRub, s.agentsRubComplete));
    add(row, 'td', 'num', s.costPerLot === null ? '—' : money(s.costPerLot, true));
    add(row, 'td', null, s.lastDate ? fmtDay(s.lastDate) : '—');
    tb2.appendChild(row);
  });
  t2.appendChild(tb2); wrap2.appendChild(t2); c2.appendChild(wrap2);
  c2.appendChild(el('div', 'hintline', 'Расход источника — это сумма расхода агентов, которые с ним работают. Это не «цена за лот»: токены и лоты считаются разными механизмами, поэтому цифра «₽ на лот» — ориентир, а не тариф.'));
  s2.appendChild(c2);
  view.appendChild(s2);

  // --- недели ---
  var s3 = section('Динамика по неделям', 'задачи, лоты и расход');
  var c3 = card();
  if (doc.weeks.length === 0) {
    c3.appendChild(el('div', 'muted', 'Данных по неделям нет.'));
  } else {
    var maxW = 1;
    doc.weeks.forEach(function (w) { if (w.lots > maxW) maxW = w.lots; });
    var wbars = el('div', 'bars');
    doc.weeks.forEach(function (w) {
      wbars.appendChild(barRow(w.week, w.lots, maxW,
        fmtInt(w.lots) + ' лотов · ' + (w.rubComplete ? money(w.rub, true) : money(w.rub, false)) + ' · задач создано ' + w.tasksCreated,
        '', 'токенов ' + fmtInt(w.tokens) + ', задач готово ' + w.tasksDone));
    });
    c3.appendChild(wbars);
    var w3 = el('div', 'table-wrap');
    w3.style.marginTop = '12px';
    var t3 = el('table', 'data');
    var th3 = el('thead'); var tr3 = el('tr');
    [['Неделя'], ['Лотов', 'num'], ['Токенов', 'num'], ['Расход', 'num'], ['Задач создано', 'num'], ['Задач готово', 'num']].forEach(function (h) { add(tr3, 'th', h[1] || null, h[0]); });
    th3.appendChild(tr3); t3.appendChild(th3);
    var tb3 = el('tbody');
    doc.weeks.forEach(function (w) {
      var row = el('tr');
      add(row, 'td', 'mono', w.week);
      add(row, 'td', 'num', fmtInt(w.lots));
      add(row, 'td', 'num', fmtTokens(w.tokens));
      add(row, 'td', 'num', money(w.rub, w.rubComplete));
      add(row, 'td', 'num', String(w.tasksCreated));
      add(row, 'td', 'num', String(w.tasksDone));
      tb3.appendChild(row);
    });
    t3.appendChild(tb3); w3.appendChild(t3); c3.appendChild(w3);
  }
  s3.appendChild(c3);
  view.appendChild(s3);

  // --- проекты ---
  var s4 = section('Проекты', 'задачи, агенты и расход по каждому ЖК');
  var c4 = card();
  if (doc.projects.length === 0) {
    c4.appendChild(el('div', 'muted', 'Проектов в реестре нет.'));
  } else {
    var p4 = el('div', 'table-wrap');
    var t4 = el('table', 'data');
    var th4 = el('thead'); var tr4 = el('tr');
    [['Проект'], ['Задач', 'num'], ['Готово', 'num'], ['Агентов', 'num'], ['Токенов', 'num'], ['Расход', 'num']].forEach(function (h) { add(tr4, 'th', h[1] || null, h[0]); });
    th4.appendChild(tr4); t4.appendChild(th4);
    var tb4 = el('tbody');
    doc.projects.forEach(function (p) {
      var row = el('tr');
      add(row, 'td', null, p.name);
      add(row, 'td', 'num', String(p.tasks.total));
      add(row, 'td', 'num', String(p.tasks.done));
      add(row, 'td', 'num', String(p.agents.length));
      add(row, 'td', 'num', fmtTokens(p.tokens.totalTokens));
      add(row, 'td', 'num', money(p.rub, p.rubComplete));
      tb4.appendChild(row);
    });
    t4.appendChild(tb4); p4.appendChild(t4); c4.appendChild(p4);
  }
  s4.appendChild(c4);
  view.appendChild(s4);

  // --- честные пометки ---
  var s5 = section('Как это считается');
  var c5 = card();
  var ul = el('ul', 'clean');
  (doc.notes || []).forEach(function (x) { ul.appendChild(el('li', null, x)); });
  c5.appendChild(ul);
  if (doc.warnings && doc.warnings.length) {
    doc.warnings.forEach(function (w) { c5.appendChild(note('warn', w)); });
  }
  s5.appendChild(c5);
  view.appendChild(s5);
};

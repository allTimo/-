/* Вкладки: Задачи, Проекты, Расходы, Инфраструктура. */
'use strict';

var taskFilters = { status: 'all', group: 'all', owner: 'all', q: '' };

/* ---------------- Задачи ---------------- */
function filteredTasks() {
  var list = (STATE.tasks && STATE.tasks.tasks) || [];
  return list.filter(function (t) {
    if (taskFilters.status !== 'all' && t.status !== taskFilters.status) return false;
    if (taskFilters.group !== 'all' && t.group !== taskFilters.group) return false;
    if (taskFilters.owner !== 'all') {
      var key = t.ownerLabel || t.ownerName || t.owner || 'без исполнителя';
      if (key !== taskFilters.owner) return false;
    }
    if (taskFilters.q) {
      var hay = (t.id + ' ' + t.subject + ' ' + (t.group || '') + ' ' + (t.category || '') + ' ' + (t.ownerLabel || '') + ' ' + (t.ownerName || '') + ' ' + (t.description || '')).toLowerCase();
      if (hay.indexOf(taskFilters.q.toLowerCase()) === -1) return false;
    }
    return true;
  });
}

function buildTree(tasks) {
  var groups = {};
  var order = [];
  tasks.forEach(function (t) {
    var g = t.group || 'Без группы';
    var c = t.category || 'Без категории';
    if (!groups[g]) { groups[g] = { group: g, cats: {}, total: 0 }; order.push(g); }
    if (!groups[g].cats[c]) groups[g].cats[c] = { category: c, tasks: [], total: 0 };
    groups[g].cats[c].tasks.push(t);
    groups[g].cats[c].total++;
    groups[g].total++;
  });
  return order.map(function (g) { return groups[g]; });
}

function taskRow(t) {
  var row = el('div', 'task-row');
  var head = el('div', 't-head');
  head.appendChild(el('span', 't-id', t.id));
  head.appendChild(el('span', 't-subject', t.subject));
  head.appendChild(el('span', 'spacer'));
  head.appendChild(statusBadge(t.status));
  if (t.overdue) head.appendChild(badge('просрочена', 'bad'));
  if (t.origin === 'dsh') head.appendChild(badge('лог DSH', 'grey'));
  else head.appendChild(badge('реестр', 'accent'));
  row.appendChild(head);

  var meta = el('div', 't-meta');
  var who = t.ownerLabel || t.ownerName || (t.ownerUnknown ? 'исполнитель в логе не записан' : 'без исполнителя');
  meta.appendChild(el('span', null, 'исполнитель: ' + who));
  if (t.ownerName && t.ownerLabel) meta.appendChild(el('span', null, 'сессия: ' + t.ownerName));
  if (t.project) meta.appendChild(el('span', null, 'проект: ' + t.project));
  if (t.due) meta.appendChild(el('span', null, 'срок: ' + t.due));
  if (t.created) meta.appendChild(el('span', null, 'создана: ' + t.created));
  if (t.revision !== null && t.revision !== undefined) meta.appendChild(el('span', null, 'ревизия: ' + t.revision));
  if (t.statusRaw && t.statusRaw !== t.status) meta.appendChild(el('span', null, 'в источнике: ' + t.statusRaw));
  row.appendChild(meta);

  if (t.description) {
    var d = el('div', 'small muted', String(t.description).split('\n')[0].slice(0, 220));
    row.appendChild(d);
  }
  if (t.writeScopes && t.writeScopes.length) {
    row.appendChild(el('div', 'small muted', 'файлы: ' + t.writeScopes.join(', ')));
  }
  return row;
}

VIEWS.tasks = function (view) {
  var doc = STATE.tasks;
  if (!doc) { view.appendChild(note('bad', 'Нет данных по задачам.')); return; }

  var kpis = el('div', 'grid kpi');
  kpis.appendChild(kpi('Всего задач', String(doc.counts.total), 'из них с исполнителем: ' + doc.tasks.filter(function (t) { return t.owner || t.ownerName; }).length, 'accent'));
  kpis.appendChild(kpi('В работе', String(doc.counts.inProgress), 'готово: ' + doc.counts.done, 'warn'));
  kpis.appendChild(kpi('Требует уточнения', String(doc.counts.unassigned),
    'задачи реестра без исполнителя' + (doc.counts.ownerUnknown ? ' · в логах DSH исполнитель не пишется: ' + doc.counts.ownerUnknown + ' задач' : ''),
    doc.counts.unassigned ? 'bad' : 'ok'));
  kpis.appendChild(kpi('Просрочено', String(doc.counts.overdue), 'по полю due из реестра', doc.counts.overdue ? 'bad' : 'ok'));
  view.appendChild(kpis);

  var src = section('Откуда задачи');
  var sc = card();
  var n1 = doc.sources.registry;
  sc.appendChild(note(n1.count > 0 ? 'ok' : 'warn',
    'Реестр registry/tasks/*.yaml: ' + n1.count + ' задач' + (n1.exists ? ' (' + n1.files.length + ' файл(ов))' : ' — папки пока нет') +
    '. Логи DSH (события team/task): ' + doc.sources.dsh.count + ' задач.'));
  sc.appendChild(el('div', 'small muted', 'Задачи без группы и категории раскладываются в дерево по группам агента-исполнителя; явные group/category из реестра имеют приоритет.'));
  sc.appendChild(el('div', 'small muted', 'Важно: события team/task в логах DSH не содержат исполнителя. Он подставляется из dashboard/config/task-owners.yaml — это ручной снимок общей доски задач. Для задач реестра owner берётся из самого файла.'));
  sc.appendChild(el('div', 'small muted', 'Задачи из логов DSH — это задачи сборки и эксплуатации команды, поэтому по умолчанию они попадают в «Сборка системы → Задачи команды». Другую группу можно задать в task-owners.yaml полями group/category.'));
  src.appendChild(sc);
  view.appendChild(src);

  // фильтры
  var fSection = section('Дерево задач', 'группа → категория → задача');
  var fc = card();
  var f = el('div', 'filters');

  var qInput = el('input');
  qInput.type = 'text';
  qInput.placeholder = 'поиск по названию, id, исполнителю…';
  qInput.value = taskFilters.q;
  qInput.style.minWidth = '260px';
  qInput.addEventListener('input', function () { taskFilters.q = this.value; redraw(); });
  var qWrap = el('div'); qWrap.appendChild(el('label', null, 'Поиск: ')); qWrap.appendChild(qInput);
  f.appendChild(qWrap);

  function mkSelect(label, key, options) {
    var w = el('div');
    w.appendChild(el('label', null, label + ': '));
    var sel = el('select');
    options.forEach(function (o) {
      var op = el('option', null, o.label);
      op.value = o.value;
      if (String(taskFilters[key]) === String(o.value)) op.selected = true;
      sel.appendChild(op);
    });
    sel.addEventListener('change', function () { taskFilters[key] = this.value; redraw(); });
    w.appendChild(sel);
    return w;
  }

  var statuses = [['all', 'все']].concat(Object.keys(doc.counts.byStatus).map(function (s) {
    return [s, (STATUS[s] ? STATUS[s].label : s) + ' (' + doc.counts.byStatus[s] + ')'];
  }).map(function (p) { return { value: p[0], label: p[1] }; }));
  f.appendChild(mkSelect('Статус', 'status', statuses));

  var groups = [['all', 'все']].concat(doc.tree.map(function (g) { return { value: g.group, label: g.group + ' (' + g.total + ')' }; }));
  f.appendChild(mkSelect('Группа', 'group', groups));

  var owners = [{ value: 'all', label: 'все' }].concat(doc.owners.map(function (o) { return { value: o.name, label: o.name + ' (' + o.count + ')' }; }));
  f.appendChild(mkSelect('Исполнитель', 'owner', owners));

  var reset = el('button', 'btn small', 'Сбросить');
  reset.addEventListener('click', function () { taskFilters = { status: 'all', group: 'all', owner: 'all', q: '' }; qInput.value = ''; redraw(); });
  f.appendChild(reset);
  fc.appendChild(f);

  var host = el('div');
  fc.appendChild(host);

  function redraw() {
    clear(host);
    var list = filteredTasks();
    host.appendChild(el('div', 'small muted', 'Показано задач: ' + list.length + ' из ' + doc.tasks.length));
    if (list.length === 0) { host.appendChild(note(null, 'Под фильтр ничего не попало.')); return; }
    var tree = buildTree(list);
    var wrap = el('div', 'tree');
    tree.forEach(function (g) {
      var det = el('details', 'tree-group');
      det.open = true;
      var sum = el('summary');
      sum.appendChild(el('span', null, g.group));
      sum.appendChild(el('span', 'spacer'));
      sum.appendChild(badge(g.total + ' задач', 'grey'));
      det.appendChild(sum);
      Object.keys(g.cats).forEach(function (ck) {
        var cat = g.cats[ck];
        var cd = el('details', 'tree-cat');
        cd.open = true;
        var cs = el('summary');
        cs.appendChild(el('span', null, cat.category));
        cs.appendChild(el('span', 'spacer'));
        cs.appendChild(badge(String(cat.total), 'grey'));
        cd.appendChild(cs);
        var box = el('div', 'tree-tasks');
        cat.tasks.forEach(function (t) { box.appendChild(taskRow(t)); });
        cd.appendChild(box);
        det.appendChild(cd);
      });
      wrap.appendChild(det);
    });
    host.appendChild(wrap);
  }
  redraw();
  fSection.appendChild(fc);
  view.appendChild(fSection);

  if (doc.unassigned.length > 0) {
    var uSection = section('Требует уточнения', 'эти задачи не имеют понятного исполнителя');
    var uc = card();
    var st = el('div', 'stack');
    doc.unassigned.forEach(function (t) { st.appendChild(taskRow(t)); });
    uc.appendChild(st);
    uSection.appendChild(uc);
    view.appendChild(uSection);
  }
};

/* ---------------- Проекты ---------------- */
VIEWS.projects = function (view) {
  var doc = STATE.projects;
  if (!doc) { view.appendChild(note('bad', 'Нет данных по проектам.')); return; }

  var kpis = el('div', 'grid kpi');
  var totalTok = 0, totalRub = 0, rubComplete = true;
  doc.projects.forEach(function (p) {
    totalTok += p.metrics.tokens.totalTokens;
    if (p.metrics.rub === null) rubComplete = false; else totalRub += p.metrics.rub;
  });
  kpis.appendChild(kpi('Проектов в реестре', String(doc.projects.length), 'источник: registry/projects.yaml', 'accent'));
  kpis.appendChild(kpi('Токенов на проектах', fmtTokens(totalTok), 'по привязанным агентам', 'purple'));
  kpis.appendChild(kpi('Расход проектов', rubComplete ? fmtMoney(totalRub) : fmtMoney(totalRub) + ' *', rubComplete ? '' : '* часть моделей без цены — сумма неполная', rubComplete ? 'ok' : 'warn', true));
  kpis.appendChild(kpi('Рабочих пространств', String(doc.sessionProjects.length), 'по cwd в логах сессий', ''));
  view.appendChild(kpis);

  var s1 = section('Проекты (ЖК)', 'какие агенты ведут проект и сколько это стоит');
  var grid = el('div', 'grid cards');
  doc.projects.forEach(function (p) {
    var c = el('div', 'card');
    var head = el('div', 'agent-head');
    var left = el('div');
    left.appendChild(el('h3', 'agent-name', p.name));
    left.appendChild(el('div', 'agent-role', 'id: ' + p.id + (p.developer ? ' · застройщик: ' + p.developer : '')));
    head.appendChild(left);
    var right = el('div');
    right.appendChild(badge(p.klass || 'класс не задан', 'purple'));
    head.appendChild(right);
    c.appendChild(head);

    var meta = el('div', 'agent-meta');
    meta.appendChild(badge(p.status === 'active' ? 'активен' : p.status, p.status === 'active' ? 'ok' : 'grey'));
    meta.appendChild(badge('агентов: ' + p.agentsDetail.length, 'accent'));
    meta.appendChild(badge('задач: ' + p.metrics.tasks.total, 'grey'));
    c.appendChild(meta);

    var stats = el('div', 'agent-stats');
    function stat(k, v, title) {
      var d = el('div', 'stat');
      d.appendChild(el('div', 'k', k));
      var val = el('div', 'v', v);
      if (title) val.title = title;
      d.appendChild(val);
      return d;
    }
    stats.appendChild(stat('сессий', String(p.metrics.sessions)));
    stats.appendChild(stat('токенов', fmtTokens(p.metrics.tokens.totalTokens), fmtInt(p.metrics.tokens.totalTokens)));
    stats.appendChild(stat('расход', p.metrics.tokens.totalTokens === 0 ? '—' : money(p.metrics.rub, p.metrics.rubComplete)));
    c.appendChild(stats);

    c.appendChild(el('div', 'small muted', 'Агенты: ' + (p.agentsDetail.length ? p.agentsDetail.map(function (a) { return a.name + (a.enabled ? ' (вкл)' : ' (выкл)'); }).join(', ') : 'не назначены')));
    if (p.linkedMembers.length) c.appendChild(el('div', 'small muted', 'Исполнители DSH: ' + p.linkedMembers.join(', ')));
    c.appendChild(el('div', 'small muted', 'Последняя активность: ' + (p.metrics.lastActivityAt ? fmtAgo(p.metrics.lastActivityAt) : '—')));

    if (p.metrics.tasks.total > 0) {
      var stack = el('div', 'stack');
      stack.style.marginTop = '10px';
      (STATE.tasks.tasks || []).filter(function (t) { return t.project === p.id; }).slice(0, 6).forEach(function (t) { stack.appendChild(taskRow(t)); });
      c.appendChild(stack);
    }
    grid.appendChild(c);
  });
  s1.appendChild(grid);
  view.appendChild(s1);

  var s2 = section('Рабочие пространства из логов', 'проект определяется по cwd сессии');
  var c2 = card();
  var wrap = el('div', 'table-wrap');
  var t = el('table', 'data');
  var thead = el('thead'); var tr = el('tr');
  [['Рабочее пространство'], ['Путь'], ['Сессий', 'num'], ['Токенов', 'num'], ['Расход', 'num'], ['Кто работал'], ['Активность']].forEach(function (h) { add(tr, 'th', h[1] || null, h[0]); });
  thead.appendChild(tr); t.appendChild(thead);
  var tb = el('tbody');
  doc.sessionProjects.forEach(function (p) {
    var row = el('tr');
    add(row, 'td', null, p.label);
    add(row, 'td', 'mono', p.cwd);
    add(row, 'td', 'num', String(p.sessions));
    var tdT = add(row, 'td', 'num', fmtTokens(p.tokens.totalTokens));
    tdT.title = fmtInt(p.tokens.totalTokens) + ' токенов';
    add(row, 'td', 'num', money(p.rub, p.rubComplete));
    add(row, 'td', 'small muted', p.agents.join(', '));
    add(row, 'td', null, p.lastActivityAt ? fmtAgo(p.lastActivityAt) : '—');
    tb.appendChild(row);
  });
  t.appendChild(tb); wrap.appendChild(t); c2.appendChild(wrap);
  c2.appendChild(el('div', 'small muted', 'Проекты реестра (ЖК) и рабочие пространства — разные вещи: первое про клиентов, второе про то, где физически лежат файлы.'));
  s2.appendChild(c2);
  view.appendChild(s2);
};

/* ---------------- Расходы ---------------- */
VIEWS.usage = function (view) {
  var u = STATE.usage;
  if (!u) { view.appendChild(note('bad', 'Нет данных по расходу.')); return; }

  var kpis = el('div', 'grid kpi');
  kpis.appendChild(kpi('Всего токенов', fmtTokens(u.totals.tokens.totalTokens), fmtInt(u.totals.tokens.totalTokens), 'accent', true));
  kpis.appendChild(kpi('Вход / выход', fmtTokens(u.totals.tokens.inputTokens) + ' / ' + fmtTokens(u.totals.tokens.outputTokens), 'некэшированный вход и ответы модели', 'purple'));
  kpis.appendChild(kpi('Чтение из кэша', fmtTokens(u.cache.cacheReadTokens), 'доля кэша: ' + fmtPct(u.cache.share) + ' — это главная экономия', 'ok'));
  kpis.appendChild(kpi('Расход в рублях', fmtMoney(u.totals.rub), fmtUsd(u.totals.usd) + (u.currency.usdRub ? ' по курсу ' + u.currency.usdRub : ''), u.totals.rubComplete ? 'ok' : 'bad', true));
  view.appendChild(kpis);

  var pSection = section('Тариф и курс');
  var pc = card();
  kv(pc, [
    ['источник цен', (u.pricing.schema || '—') + ' · ' + u.currency.source + (u.currency.path ? ' · ' + u.currency.path : '')],
    ['дата прайса', u.pricing.fetchedAt],
    ['тип цены', u.pricing.priceKind === 'minimum_across_providers' ? 'минимум среди провайдеров' : u.pricing.priceKind],
    ['курс', u.currency.usdRub ? u.currency.usdRub + ' ₽/$' : 'не задан'],
    ['откуда курс', u.currency.note],
    ['моделей с ценой', String(u.pricing.modelCount)]
  ]);
  if (u.pricing.cacheAssumptionNote) pc.appendChild(note('warn', u.pricing.cacheAssumptionNote + ' Модели: ' + u.pricing.cachePriceAssumedFor.slice(0, 6).join(', ') + (u.pricing.cachePriceAssumedFor.length > 6 ? ' и др.' : '')));
  if (u.unknownPriceModels.length > 0) {
    pc.appendChild(note('warn', 'Без цены в прайсе: ' + u.unknownPriceModels.join(', ') + '. Их токены посчитаны, но рубли по ним не начислены — «цена неизвестна».'));
  }
  if (u.peak && u.peak.multiplier > 1) {
    pc.appendChild(note(null, 'Пиковые часы: x' + u.peak.multiplier + ' (' + (u.peak.windowsUtc || []).map(function (w) { return Math.floor(w[0] / 60) + ':00–' + Math.floor(w[1] / 60) + ':00 UTC'; }).join(', ') + '). ' + (u.peak.note || '')));
  }
  pSection.appendChild(pc);
  view.appendChild(pSection);

  // по дням
  var dSection = section('По дням', 'расход и объём по каждому дню');
  var dc = card();
  var maxTok = 1;
  u.byDay.forEach(function (d) { if (d.tokens.totalTokens > maxTok) maxTok = d.tokens.totalTokens; });
  var bars = el('div', 'bars');
  u.byDay.slice(-21).forEach(function (d) {
    bars.appendChild(barRow(fmtDay(d.date), d.tokens.totalTokens, maxTok,
      fmtTokens(d.tokens.totalTokens) + ' · ' + money(d.rub, d.rubComplete) + ' · сессий: ' + d.sessions,
      '', fmtInt(d.tokens.totalTokens) + ' токенов'));
  });
  if (u.byDay.length === 0) bars.appendChild(el('div', 'muted', 'Нет данных.'));
  dc.appendChild(bars);
  dSection.appendChild(dc);
  view.appendChild(dSection);

  // по моделям
  var mSection = section('По моделям', 'сколько токенов и денег ушло на каждую модель');
  var mc = card();
  var wrap = el('div', 'table-wrap');
  var t = el('table', 'data');
  var thead = el('thead'); var tr = el('tr');
  [['Модель'], ['Провайдер'], ['Вход', 'num'], ['Выход', 'num'], ['Кэш', 'num'], ['Всего', 'num'], ['Доля', 'num'], ['Рубли', 'num'], ['Доллары', 'num']].forEach(function (h) { add(tr, 'th', h[1] || null, h[0]); });
  thead.appendChild(tr); t.appendChild(thead);
  var tb = el('tbody');
  u.byModel.forEach(function (m) {
    var row = el('tr');
    add(row, 'td', 'mono', m.model);
    add(row, 'td', 'small muted', m.provider || '—');
    add(row, 'td', 'num', fmtInt(m.tokens.inputTokens));
    add(row, 'td', 'num', fmtInt(m.tokens.outputTokens));
    add(row, 'td', 'num', fmtInt(m.tokens.cacheReadTokens));
    add(row, 'td', 'num', fmtTokens(m.tokens.totalTokens));
    add(row, 'td', 'num', fmtPct(u.totals.tokens.totalTokens > 0 ? m.tokens.totalTokens / u.totals.tokens.totalTokens : 0));
    add(row, 'td', 'num', m.priceKnown ? fmtMoney(m.rub) : 'цена неизвестна');
    add(row, 'td', 'num', m.priceKnown ? fmtUsd(m.usd) : '—');
    tb.appendChild(row);
  });
  t.appendChild(tb); wrap.appendChild(t); mc.appendChild(wrap);
  mSection.appendChild(mc);
  view.appendChild(mSection);

  // по агентам
  var aSection = section('По исполнителям', 'кто сколько сжёг');
  var ac = card();
  var maxA = 1;
  u.byAgent.forEach(function (a) { if (a.tokens.totalTokens > maxA) maxA = a.tokens.totalTokens; });
  var ab = el('div', 'bars');
  u.byAgent.forEach(function (a) {
    ab.appendChild(barRow(a.name, a.tokens.totalTokens, maxA,
      fmtTokens(a.tokens.totalTokens) + ' · ' + money(a.rub, a.rubComplete) + ' · ' + a.sessions + ' сесс.',
      'ok', fmtInt(a.tokens.totalTokens) + ' токенов, проектов: ' + Object.keys(a.projects || {}).length));
  });
  ac.appendChild(ab);
  aSection.appendChild(ac);
  view.appendChild(aSection);

  var lSection = section('Что это значит');
  var lc = card();
  var ul = el('ul', 'clean');
  [
    'Расход считается по событиям assistant/message в логах сессий: у каждого свой timestamp и своя модель.',
    'Звёздочка (*) у суммы означает, что в неё не вошли модели без цены в прайсе — сумма неполная, но не выдуманная.',
    'Доля кэша ' + fmtPct(u.cache.share) + ': кэшированный вход стоит в разы дешевле. Если доля падает — проверьте, не меняется ли начало системного промпта.',
    'Цены берутся из registry/prices.yaml (schema prices/v1). Модель без цены не выдумывается: показывается «цена неизвестна».',
    'Данные только из локальных сессий и реестра — ничего не отправляется наружу.'
  ].forEach(function (x) { ul.appendChild(el('li', null, x)); });
  lc.appendChild(ul);
  lSection.appendChild(lc);
  view.appendChild(lSection);
};

/* ---------------- Инфраструктура ---------------- */
function esc(s) { return String(s === null || s === undefined ? '' : s).replace(/"/g, '\\"'); }

function parseList(s) {
  return String(s || '').split(',').map(function (x) { return x.trim(); }).filter(function (x) { return x !== ''; });
}

function yamlFragment(f) {
  var L = [];
  L.push('  - id: ' + (f.id || 'agent-new'));
  L.push('    name: "' + esc(f.name) + '"');
  L.push('    role: "' + esc(f.role) + '"');
  L.push('    enabled: ' + (f.enabled ? 'true' : 'false'));
  L.push('    status: ' + (f.status || 'planned'));
  L.push('    model: "' + esc(f.model) + '"');
  if (f.modelHint) L.push('    model_hint: "' + esc(f.modelHint) + '"');
  var projects = parseList(f.projects);
  L.push('    projects: ' + (projects.length ? '[' + projects.join(', ') + ']' : '[]') + (projects.length ? '' : '          # пусто = все проекты из projects.yaml'));
  var groups = parseList(f.groups);
  L.push('    groups: [' + groups.map(function (g) { return '"' + esc(g) + '"'; }).join(', ') + ']');
  L.push('    schedule: "' + esc(f.schedule || 'on-demand') + '"');
  var inputs = parseList(f.inputs);
  L.push('    inputs: [' + inputs.map(function (g) { return '"' + esc(g) + '"'; }).join(', ') + ']');
  var outputs = parseList(f.outputs);
  L.push('    outputs: [' + outputs.map(function (g) { return '"' + esc(g) + '"'; }).join(', ') + ']');
  if (f.runbook) L.push('    runbook: "' + esc(f.runbook) + '"');
  if (f.notes) L.push('    notes: "' + esc(f.notes) + '"');
  return L.join('\n');
}

var REC_TITLES = {
  default_agent: 'Модель по умолчанию для агента',
  subagents_light: 'Лёгкие субагенты',
  heavy_analysis: 'Тяжёлый анализ',
  vision_screenshots: 'Скриншоты и картинки',
  text_only_warning: 'Только текст — картинки не принимает'
};

VIEWS.infra = function (view) {
  var meta = STATE.meta, prices = STATE.prices;

  var s1 = section('Как запустить', 'одна команда');
  var c1 = card();
  c1.appendChild(el('div', 'small muted', 'Сборка данных + локальный сервер:'));
  var pre = el('pre', null, 'node marketing-agents/dashboard/serve.mjs');
  c1.appendChild(pre);
  c1.appendChild(el('div', 'small muted', 'Откроется http://127.0.0.1:8787 — только локально, наружу ничего не публикуется.'));
  c1.appendChild(el('div', 'small muted', 'Пересобрать данные без сервера: node marketing-agents/dashboard/collector/collect.mjs'));
  c1.appendChild(el('div', 'small muted', 'Другой порт: $env:DASHBOARD_PORT=8788; node marketing-agents/dashboard/serve.mjs'));
  s1.appendChild(c1);
  view.appendChild(s1);

  // форма добавления агента
  var s2 = section('Добавить агента', 'заполните поля — получите готовый фрагмент для registry/agents.yaml');
  var c2 = card();
  var form = el('div', 'grid three');
  var fields = {};
  function field(key, label, value, placeholder) {
    var w = el('div');
    w.appendChild(el('label', 'small muted', label));
    var inp = el('input');
    inp.type = 'text';
    inp.value = value || '';
    if (placeholder) inp.placeholder = placeholder;
    inp.style.width = '100%';
    inp.style.marginTop = '4px';
    inp.addEventListener('input', function () { fields[key] = this.value; regenerate(); });
    w.appendChild(inp);
    fields[key] = value || '';
    form.appendChild(w);
    return inp;
  }
  field('id', 'id (латиница, дефисы)', 'agent-5-new', 'agent-5-new');
  field('name', 'Название', 'Агент 5 — Новый контур');
  field('role', 'Что делает (роль)', 'Опишите задачу агента одной фразой.');
  field('groups', 'Группы задач (через запятую)', 'Аналитика, Отчёты');
  field('projects', 'Проекты (id через запятую, пусто = все)', '');
  field('schedule', 'Расписание', 'weekly:monday:10:00');
  field('inputs', 'Входы (через запятую)', 'registry/intake');
  field('outputs', 'Выходы (через запятую)', 'reports');
  field('runbook', 'Runbook (путь)', '00-admin/runbook.md');
  field('modelHint', 'Почему такая модель', 'дешёвая модель для рутины');

  var modelWrap = el('div');
  modelWrap.appendChild(el('label', 'small muted', 'Модель'));
  var modelSel = el('select');
  modelSel.style.width = '100%';
  modelSel.style.marginTop = '4px';
  var modelIds = prices && prices.models ? prices.models.map(function (m) { return m.id; }) : [];
  modelIds.forEach(function (id) {
    var op = el('option', null, id);
    op.value = id;
    modelSel.appendChild(op);
  });
  modelSel.addEventListener('change', function () { fields.model = this.value; regenerate(); });
  modelWrap.appendChild(modelSel);
  form.appendChild(modelWrap);
  fields.model = modelIds.length ? modelIds[0] : 'deepseek/deepseek-v4.1-flash';

  var statusWrap = el('div');
  statusWrap.appendChild(el('label', 'small muted', 'Статус'));
  var statusSel = el('select');
  statusSel.style.width = '100%';
  statusSel.style.marginTop = '4px';
  ['planned', 'active', 'paused'].forEach(function (s) { var op = el('option', null, s); op.value = s; statusSel.appendChild(op); });
  statusSel.addEventListener('change', function () { fields.status = this.value; regenerate(); });
  statusWrap.appendChild(statusSel);
  form.appendChild(statusWrap);
  fields.status = 'planned';

  var enabledWrap = el('div');
  enabledWrap.appendChild(el('label', 'small muted', 'Включить сразу'));
  var enabledCb = el('input');
  enabledCb.type = 'checkbox';
  enabledCb.style.marginTop = '10px';
  enabledCb.addEventListener('change', function () { fields.enabled = this.checked; regenerate(); });
  enabledWrap.appendChild(enabledCb);
  form.appendChild(enabledWrap);
  fields.enabled = false;

  c2.appendChild(form);

  var out = el('pre');
  var actions = el('div', 'filters');
  var copyBtn = el('button', 'btn small primary', 'Скопировать фрагмент');
  copyBtn.addEventListener('click', function () {
    var text = out.textContent;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast('Фрагмент скопирован.'); }, function () { toast('Не удалось скопировать — выделите вручную.', 'bad'); });
    } else {
      var r = document.createRange(); r.selectNodeContents(out);
      var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
      toast('Фрагмент выделен — нажмите Ctrl+C.');
    }
  });
  actions.appendChild(copyBtn);
  var howto = el('button', 'btn small', 'Как вставить');
  howto.addEventListener('click', function () {
    openDrawer('Как добавить агента', function (d) {
      d.appendChild(note(null, 'Фрагмент вставляется в конец блока agents: в registry/agents.yaml, с тем же отступом (два пробела перед дефисом).'));
      d.appendChild(el('pre', null, 'agents:\n  - id: agent-1-competitor-watch\n    ...\n' + yamlFragment(fields)));
      d.appendChild(el('div', 'small muted', 'После сохранения нажмите «Обновить данные» — карточка агента появится на вкладке «Агенты». Тумблер вкл/выкл там же.'));
    });
  });
  actions.appendChild(howto);
  c2.appendChild(actions);
  c2.appendChild(out);

  function regenerate() { out.textContent = yamlFragment(fields); }
  regenerate();
  s2.appendChild(c2);
  view.appendChild(s2);

  // схема
  var s3 = section('Поля агента', 'схема registry/agents.yaml');
  var c3 = card();
  var wrap = el('div', 'table-wrap');
  var t = el('table', 'data');
  var thead = el('thead'); var tr = el('tr');
  [['Поле'], ['Обязательное'], ['Что значит']].forEach(function (h) { add(tr, 'th', null, h); });
  thead.appendChild(tr); t.appendChild(thead);
  var tb = el('tbody');
  [
    ['id', 'да', 'уникальный идентификатор латиницей с дефисами'],
    ['name', 'да', 'человеческое название для дашборда'],
    ['role', 'да', 'что агент делает — попадает в карточку'],
    ['enabled', 'да', 'тумблер: true/false. Его правит кнопка в дашборде'],
    ['status', 'нет', 'active | planned | paused'],
    ['model', 'да', 'id модели, например deepseek/deepseek-v4.1-flash'],
    ['model_hint', 'нет', 'почему выбрана эта модель — показывается в деталях'],
    ['projects', 'нет', 'список id проектов; пусто = все проекты'],
    ['groups', 'нет', 'группы задач: первая — группа, вторая — категория в дереве'],
    ['schedule', 'нет', 'например weekly:monday:10:00 или on-demand'],
    ['inputs / outputs', 'нет', 'откуда берёт и куда кладёт результаты'],
    ['runbook', 'нет', 'путь к инструкции'],
    ['notes', 'нет', 'свободная заметка']
  ].forEach(function (r) {
    var row = el('tr');
    add(row, 'td', 'mono', r[0]);
    var td = el('td');
    td.appendChild(badge(r[1], r[1] === 'да' ? 'accent' : 'grey'));
    row.appendChild(td);
    add(row, 'td', 'small muted', r[2]);
    tb.appendChild(row);
  });
  t.appendChild(tb); wrap.appendChild(t); c3.appendChild(wrap);
  s3.appendChild(c3);
  view.appendChild(s3);

  // рекомендации по моделям
  if (prices && prices.recommendations) {
    var s4 = section('Какую модель выбрать', 'из registry/prices.yaml — рекомендации T11');
    var grid = el('div', 'grid cards');
    Object.keys(prices.recommendations).forEach(function (key) {
      var r = prices.recommendations[key];
      var c = el('div', 'card');
      c.appendChild(el('h3', null, REC_TITLES[key] || key));
      if (r.model) c.appendChild(el('div', 'agent-meta')).appendChild(badge(r.model, 'accent'));
      if (r.why) c.appendChild(el('div', 'small muted', r.why));
      if (r.alternative) c.appendChild(el('div', 'small muted', 'Альтернатива: ' + r.alternative + (r.alternative_why ? ' — ' + r.alternative_why : '')));
      if (r.models) c.appendChild(el('div', 'small muted', 'Модели: ' + r.models.join(', ')));
      if (r.avoid) c.appendChild(el('div', 'small muted', 'Избегать: ' + r.avoid.join(', ')));
      if (r.avoid_why) c.appendChild(el('div', 'small muted', r.avoid_why));
      grid.appendChild(c);
    });
    s4.appendChild(grid);
    view.appendChild(s4);
  }

  // прайс-лист
  if (prices && prices.models && prices.models.length) {
    var s5 = section('Прайс-лист моделей', (prices.schema || '') + ' · ' + (prices.fetchedAt || '') + ' · ' + (prices.priceKind === 'minimum_across_providers' ? 'минимум среди провайдеров' : ''));
    var c5 = card();
    var w5 = el('div', 'table-wrap');
    var t5 = el('table', 'data');
    var th5 = el('thead'); var tr5 = el('tr');
    [['Модель'], ['Вход ₽/1M', 'num'], ['Выход ₽/1M', 'num'], ['Кэш ₽/1M', 'num'], ['Типовой ход, ₽', 'num'], ['Картинки'], ['Контекст', 'num']].forEach(function (h) { add(tr5, 'th', h[1] || null, h[0]); });
    th5.appendChild(tr5); t5.appendChild(th5);
    var tb5 = el('tbody');
    prices.models.forEach(function (m) {
      var row = el('tr');
      add(row, 'td', 'mono', m.id);
      add(row, 'td', 'num', fmtNum(m.rubIn));
      add(row, 'td', 'num', fmtNum(m.rubOut));
      add(row, 'td', 'num', m.rubCacheRead === null ? 'не указана' : fmtNum(m.rubCacheRead));
      add(row, 'td', 'num', fmtNum(m.typicalTurnRub));
      var td = el('td');
      td.appendChild(badge(m.acceptsImages === true ? 'да' : (m.acceptsImages === false ? 'нет' : '?'), m.acceptsImages === true ? 'ok' : 'grey'));
      row.appendChild(td);
      add(row, 'td', 'num', m.contextTokens === null ? '—' : fmtInt(m.contextTokens));
      tb5.appendChild(row);
    });
    t5.appendChild(tb5); w5.appendChild(t5); c5.appendChild(w5);
    c5.appendChild(el('div', 'small muted', '«Типовой ход» = 100 000 токенов на входе и 20 000 на выходе — порядок величины агентской задачи.'));
    c5.appendChild(el('div', 'small muted', 'Единственный источник цен — registry/prices.yaml (схема ' + (prices.schema || 'prices/v1') + '). Файл dashboard/config/prices.example.yaml — только образец схемы, сборщик его не читает: второй прайс дал бы разъехавшиеся суммы в рублях.'));
    c5.appendChild(el('div', 'small muted', 'Курс валюты: ' + (prices.rate && prices.rate.usdRub ? prices.rate.usdRub + ' ₽/$' : 'не задан') + '.'));
    s5.appendChild(c5);
    view.appendChild(s5);
  }

  // источники и ограничения
  var s6 = section('Данные и ограничения');
  var c6 = card();
  var wrap6 = el('div', 'table-wrap');
  var t6 = el('table', 'data');
  var th6 = el('thead'); var tr6 = el('tr');
  [['Источник'], ['Путь'], ['Записей', 'num'], ['Есть?']].forEach(function (h) { add(tr6, 'th', h[1] || null, h[0]); });
  th6.appendChild(tr6); t6.appendChild(th6);
  var tb6 = el('tbody');
  (meta ? meta.sources : []).forEach(function (s) {
    var row = el('tr');
    add(row, 'td', null, s.label);
    add(row, 'td', 'mono', s.path);
    add(row, 'td', 'num', fmtInt(s.items));
    var td = el('td'); td.appendChild(badge(s.exists ? 'да' : 'нет', s.exists ? 'ok' : 'bad')); row.appendChild(td);
    tb6.appendChild(row);
  });
  t6.appendChild(tb6); wrap6.appendChild(t6); c6.appendChild(wrap6);

  var ul = el('ul', 'clean');
  [
    'Дашборд читает только локальные данные: логи сессий DSH, проекцию сессий и папку registry.',
    'Наружу ничего не отправляется. Сервер слушает 127.0.0.1 и не публикуется в интернет.',
    'Единственная запись за пределами dashboard/ — поле enabled в registry/agents.yaml по кнопке тумблера. Перед правкой делается копия .bak-<timestamp>, запись атомарная.',
    'Задачи и расход по агентам реестра появляются только если агент запускался: сопоставление «агент реестра ↔ исполнитель DSH» задаётся в dashboard/config/links.yaml.',
    'Если модель отсутствует в registry/prices.yaml, расход в рублях по ней не считается — показывается «цена неизвестна».'
  ].forEach(function (x) { ul.appendChild(el('li', null, x)); });
  c6.appendChild(ul);
  s6.appendChild(c6);
  view.appendChild(s6);
};

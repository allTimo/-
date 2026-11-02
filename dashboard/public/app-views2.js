/* Вкладки: Интеграции API, Источники мониторинга. */
'use strict';

/* ============================ ИНТЕГРАЦИИ API ============================ */

var INTEGRATION_STATE_CLS = {
  connected: 'ok',
  disabled: 'warn',
  broken: 'bad',
  'needs-key': 'warn',
  'not-installed': 'grey',
};

var KIND_LABEL = {
  llm: 'модели', plugin: 'плагин', search: 'поиск', skills: 'скилы',
  channel: 'канал', mcp: 'MCP', other: 'прочее',
};

function keyCell(item) {
  var td = el('td');
  if (!item.needsKey) { td.appendChild(badge('не нужен', 'grey')); return td; }
  if (item.keyPresent) { td.appendChild(badge('ключ есть', 'ok')); return td; }
  td.appendChild(badge('ключа нет', 'bad'));
  return td;
}

VIEWS.integrations = function (view) {
  var doc = STATE.integrations;
  if (!doc) { view.appendChild(note('bad', 'Нет данных по интеграциям. Пересоберите данные: node marketing-agents/dashboard/collector/collect.mjs')); return; }
  var s = doc.summary;

  var working = doc.integrations.filter(function (i) { return i.state === 'connected' && (!i.needsKey || i.keyPresent); });

  var kpis = el('div', 'grid kpi');
  kpis.appendChild(kpi('Подключено и работает', String(working.length) + ' / ' + s.total,
    'загружено в профиль: ' + s.connected + ' · требуют внимания: ' + s.attention, 'ok'));
  kpis.appendChild(kpi('Нет ключа', String(s.keysMissing.length), s.keysMissing.join(', ') || 'все ключи на месте', s.keysMissing.length ? 'warn' : 'ok'));
  kpis.appendChild(kpi('Установлено, но выключено', String(s.installedDisabled), 'есть в профиле, но не в списке загрузки', s.installedDisabled ? 'warn' : 'ok'));
  kpis.appendChild(kpi('Бандлов в профиле', String(doc.profile.bundlesCount),
    'из них сообщества: ' + doc.profile.communityBundlesCount, 'accent'));
  view.appendChild(kpis);

  view.appendChild(note(null, 'Блок «Подключено» строится по фактам: читается package.json профиля DSH (dsh.profile.bundles + dependencies), проверяется наличие пакета в node_modules и его точка входа. Каталог registry/integrations-catalog.yaml — это только список того, что МОЖНО подключить; если он расходится с фактами, дашборд показывает факты и помечает расхождение.'));
  view.appendChild(note('ok', 'Секреты не читаются и не показываются: проверяется только ФАКТ наличия ключа (переменная окружения или имя записи в файле учётных данных). Значения ключей дашборд не видит.'));

  // --- Подключено ---
  var s1 = section('Подключено', 'что реально загружено в профиль DSH');
  var c1 = card();
  var wrap = el('div', 'table-wrap');
  var t = el('table', 'data');
  var thead = el('thead'); var tr = el('tr');
  [['Интеграция'], ['Тип'], ['Что даёт'], ['Пакет'], ['Версия'], ['Загрузка'], ['Ключ']].forEach(function (h) { add(tr, 'th', null, h); });
  thead.appendChild(tr); t.appendChild(thead);
  var tb = el('tbody');
  var connectedList = doc.integrations.filter(function (i) { return i.state === 'connected'; });
  connectedList.forEach(function (i) {
    var row = el('tr');
    add(row, 'td', null, i.name);
    add(row, 'td', null, KIND_LABEL[i.kind] || i.kind);
    add(row, 'td', 'small muted', (i.purpose || '').slice(0, 80));
    add(row, 'td', 'mono', i.package || '—');
    add(row, 'td', 'mono', i.version || '—');
    var td = el('td');
    td.appendChild(badge('в списке загрузки', 'ok'));
    row.appendChild(td);
    row.appendChild(keyCell(i));
    tb.appendChild(row);
  });
  if (connectedList.length === 0) {
    var empty = el('tr'); var c = el('td', 'muted', 'Ничего не подключено.');
    c.colSpan = 7; empty.appendChild(c); tb.appendChild(empty);
  }
  t.appendChild(tb); wrap.appendChild(t); c1.appendChild(wrap);
  s1.appendChild(c1);
  view.appendChild(s1);

  // --- Требует внимания ---
  var s2 = section('Требует внимания', 'что уже установлено, но пока не работает');
  var grid = el('div', 'grid cards');
  if (doc.attention.length === 0) {
    s2.appendChild(card()).appendChild(note('ok', 'Нерешённых интеграций нет.'));
  } else {
    doc.attention.forEach(function (i) {
      var c = el('div', 'card');
      var head = el('div', 'agent-head');
      var left = el('div');
      left.appendChild(el('h3', 'agent-name', i.name));
      left.appendChild(el('div', 'agent-role', i.purpose || '—'));
      head.appendChild(left);
      var right = el('div');
      right.appendChild(badge(i.stateLabel, INTEGRATION_STATE_CLS[i.state] || 'grey'));
      head.appendChild(right);
      c.appendChild(head);

      var meta = el('div', 'agent-meta');
      meta.appendChild(badge(KIND_LABEL[i.kind] || i.kind, 'accent'));
      if (i.package) meta.appendChild(badge(i.package, 'grey'));
      if (i.needsKey) meta.appendChild(badge(i.keyPresent ? 'ключ есть' : 'ключа нет', i.keyPresent ? 'ok' : 'bad'));
      c.appendChild(meta);

      var stack = el('div', 'stack');
      stack.style.marginTop = '10px';
      if (i.needsKey && !i.keyPresent) {
        stack.appendChild(note('warn', 'Нужен ключ ' + (i.keyEnv || '') + '. Где взять: ' + (i.where || '—')));
      }
      if (i.state === 'disabled') {
        stack.appendChild(note('warn', 'Пакет установлен, но его нет в списке загрузки профиля (dsh.profile.bundles) — поэтому интеграция не работает. Добавьте пакет в список загрузки и перезапустите DSH.'));
      }
      if (i.state === 'broken') {
        stack.appendChild(note('bad', 'Пакет есть, но не загружается: ' + (i.entryReason || 'не найдена точка входа') + '.'));
      }
      if (i.mismatch) stack.appendChild(note('bad', 'Расхождение с каталогом: ' + i.mismatch + '.'));
      if (i.where && !(i.needsKey && !i.keyPresent)) stack.appendChild(el('div', 'small muted', 'Подключение: ' + i.where));
      c.appendChild(stack);
      grid.appendChild(c);
    });
    s2.appendChild(grid);
  }
  view.appendChild(s2);

  // --- Можно подключить ---
  var s3 = section('Можно подключить', 'из registry/integrations-catalog.yaml');
  var c3 = card();
  if (doc.available.length === 0) {
    c3.appendChild(note('ok', 'Всё из каталога уже установлено на этой машине — новых позиций нет. Каталог: ' + doc.catalogFile));
  } else {
    var w3 = el('div', 'table-wrap');
    var t3 = el('table', 'data');
    var th3 = el('thead'); var tr3 = el('tr');
    [['Интеграция'], ['Тип'], ['Что даёт'], ['Пакет'], ['Как подключить']].forEach(function (h) { add(tr3, 'th', null, h); });
    th3.appendChild(tr3); t3.appendChild(th3);
    var tb3 = el('tbody');
    doc.available.forEach(function (i) {
      var row = el('tr');
      add(row, 'td', null, i.name);
      add(row, 'td', null, KIND_LABEL[i.kind] || i.kind);
      add(row, 'td', 'small muted', (i.purpose || '').slice(0, 90));
      add(row, 'td', 'mono', i.package || '—');
      add(row, 'td', 'small muted', i.where || '—');
      tb3.appendChild(row);
    });
    t3.appendChild(tb3); w3.appendChild(t3); c3.appendChild(w3);
  }
  s3.appendChild(c3);
  view.appendChild(s3);

  // --- Пакеты профиля ---
  var s4 = section('Пакеты профиля DSH', 'полный список: что объявлено и что реально загружается');
  var c4 = card();
  var w4 = el('div', 'table-wrap');
  var t4 = el('table', 'data');
  var th4 = el('thead'); var tr4 = el('tr');
  [['Пакет'], ['Версия'], ['В бандлах'], ['Установлен'], ['Точка входа'], ['Патч']].forEach(function (h) { add(tr4, 'th', null, h); });
  th4.appendChild(tr4); t4.appendChild(th4);
  var tb4 = el('tbody');
  doc.profilePackages.forEach(function (p) {
    var row = el('tr');
    add(row, 'td', 'mono', p.name + (p.inbox ? '  (встроенный)' : ''));
    add(row, 'td', 'mono', p.version || p.declaredVersion || '—');
    var td1 = el('td'); td1.appendChild(badge(p.inBundles ? 'да' : 'нет', p.inBundles ? 'ok' : 'grey')); row.appendChild(td1);
    var td2 = el('td'); td2.appendChild(badge(p.installed ? 'да' : 'нет', p.installed ? 'ok' : 'bad')); row.appendChild(td2);
    var td3 = el('td'); td3.appendChild(badge(p.ok ? 'ок' : (p.carrier ? 'носитель' : 'нет'), p.ok ? 'ok' : (p.carrier ? 'warn' : 'bad'))); row.appendChild(td3);
    var td4 = el('td'); td4.appendChild(badge(p.hasPatch ? 'есть' : '—', p.hasPatch ? 'accent' : 'grey')); row.appendChild(td4);
    tb4.appendChild(row);
  });
  t4.appendChild(tb4); w4.appendChild(t4); c4.appendChild(w4);
  if (doc.profile.manifestPath) c4.appendChild(el('div', 'small muted', 'Файл профиля: ' + doc.profile.manifestPath));
  else c4.appendChild(el('div', 'small muted', 'Профиль DSH: ' + doc.profile.bundlesCount + ' бандлов (в автономной копии пути скрыты).'));
  c4.appendChild(el('div', 'small muted', 'Встроенные бандлы DeepSeek поставляются вместе с приложением — их нет в node_modules профиля, это нормально.'));
  s4.appendChild(c4);
  view.appendChild(s4);
};

/* ======================= ИСТОЧНИКИ МОНИТОРИНГА ======================= */

var SOURCE_STATUS = {
  working: { label: 'работает', cls: 'ok' },
  partial: { label: 'частично', cls: 'warn' },
  blocked: { label: 'заблокирован', cls: 'bad' },
  paused: { label: 'на паузе', cls: 'grey' },
  'not-tested': { label: 'не проверялся', cls: 'grey' },
};

var SOURCE_KIND = { http: 'HTTP', browser: 'браузер', feed: 'фид/выгрузка', manual: 'вручную' };

function sourceStatusBadge(st) {
  var s = SOURCE_STATUS[st] || { label: st || '—', cls: 'grey' };
  return badge(s.label, s.cls);
}

function showSourceFragment(id, next, name) {
  openDrawer('Источник: ' + (name || id), function (d) {
    d.appendChild(note('warn', 'Это автономная копия — она открыта с диска (file://) и не может менять registry/sources.yaml. Ниже готовый фрагмент: вставьте его вручную или пользуйтесь версией с сервером («Открыть дашборд.cmd»).'));
    d.appendChild(el('h4', null, 'Что вставить в registry/sources.yaml'));
    d.appendChild(el('pre', null, '  - id: ' + id + '\n    enabled: ' + (next ? 'true' : 'false')));
    d.appendChild(el('h4', null, 'Куда вставлять'));
    d.appendChild(el('div', 'small muted', 'В блок этого источника в marketing-agents/registry/sources.yaml — строка enabled: должна быть ровно одна. Остальные строки и комментарии не трогайте.'));
    d.appendChild(el('h4', null, 'На что это влияет'));
    d.appendChild(el('div', 'small muted', 'Скрипты сбора обязаны пропускать источники с enabled: false. Включение источника разрешает сбор, но не запускает его само.'));
    var row = el('div', 'filters');
    var copy = el('button', 'btn small primary', 'Скопировать фрагмент');
    copy.addEventListener('click', function () {
      var text = '  - id: ' + id + '\n    enabled: ' + (next ? 'true' : 'false');
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { toast('Фрагмент скопирован.'); }, function () { toast('Не удалось скопировать.', 'bad'); });
      } else { toast('Скопируйте фрагмент вручную.'); }
    });
    row.appendChild(copy);
    d.appendChild(row);
  });
}

function toggleSource(id, next, btn, onDone) {
  if (STANDALONE) { showSourceFragment(id, next, btn && btn.getAttribute ? btn.getAttribute('data-source-name') : null); return; }
  btn.classList.add('busy');
  fetch('/api/sources/' + encodeURIComponent(id) + '/toggle', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: next })
  }).then(function (r) { return r.json(); }).then(function (res) {
    btn.classList.remove('busy');
    if (!res.ok) { toast('Не удалось переключить: ' + res.message, 'bad'); return; }
    toast('Источник «' + id + '» теперь ' + (res.enabled ? 'ВКЛЮЧЁН' : 'ВЫКЛЮЧЕН') + '. Реестр обновлён' + (res.backup ? ', бэкап: ' + res.backup : '') + '.');
    if (onDone) onDone(res);
  }).catch(function (e) {
    btn.classList.remove('busy');
    toast('Ошибка запроса: ' + e.message, 'bad');
  });
}

VIEWS.sources = function (view) {
  var doc = STATE.sources;
  if (!doc) { view.appendChild(note('bad', 'Нет данных по источникам. Пересоберите данные: node marketing-agents/dashboard/collector/collect.mjs')); return; }
  var s = doc.summary;

  var kpis = el('div', 'grid kpi');
  kpis.appendChild(kpi('Источников включено', String(s.enabled) + ' / ' + s.total,
    'выключено: ' + s.disabled + ' · с данными: ' + s.withData, 'ok'));
  kpis.appendChild(kpi('Лотов собрано', fmtInt(s.totalLots), 'из ' + s.snapshots + ' снимков · недель: ' + s.weeks, 'purple'));
  kpis.appendChild(kpi('Больше всего данных', s.topSource ? s.topSource.name : '—',
    s.topSource ? fmtInt(s.topSource.lots) + ' лотов' : 'данных пока нет', 'accent'));
  kpis.appendChild(kpi('Журнал запусков', doc.runLog.exists ? String(doc.runLog.count) : 'пуст',
    doc.runLog.exists ? 'записей в source-runs.jsonl' : 'появится после T18', doc.runLog.exists ? 'ok' : 'grey'));
  view.appendChild(kpis);

  view.appendChild(note(null, 'Тумблер правит ровно одно поле enabled в registry/sources.yaml — атомарно (temp + rename) и с копией .bak-<timestamp>. Включение источника разрешает сбор, но не запускает его само.'));

  // --- УПРАВЛЕНИЕ ИСТОЧНИКАМИ ---
  var ctlSection = section('Управление источниками', 'выключенный источник пропускается сбором — это уже реализовано в движке (T18)');
  var ctl = card();
  var onSrc = doc.sources.filter(function (x) { return x.enabled; }).length;
  ctl.appendChild(note(onSrc > 0 ? 'ok' : 'warn',
    'Включено ' + onSrc + ' из ' + doc.sources.length + '. Включённый источник разрешён к сбору; выключенный пропускается — данные по нему не обновляются, но уже собранные снимки остаются в статистике.'));
  var actions = el('div', 'group-actions');
  actions.appendChild(bulkBtn('Включить все', 'sources', null, true, 'small'));
  actions.appendChild(bulkBtn('Выключить все', 'sources', null, false, 'small'));
  var working = el('button', 'btn small', 'Только рабочие');
  working.title = 'Включить источники со статусом «работает» или «частично», остальные выключить';
  working.addEventListener('click', function () {
    var on = doc.sources.filter(function (x) { return x.status === 'working' || x.status === 'partial'; }).map(function (x) { return x.id; });
    var off = doc.sources.filter(function (x) { return !(x.status === 'working' || x.status === 'partial'); }).map(function (x) { return x.id; });
    runBulk('sources', on, true, working, function () {
      runBulk('sources', off, false, null, function () { loadState().then(boot); });
    });
  });
  actions.appendChild(working);
  ctl.appendChild(actions);
  var byKind = {};
  doc.sources.forEach(function (x) { (byKind[x.kind] = byKind[x.kind] || []).push(x.id); });
  var kinds = Object.keys(byKind).sort();
  if (kinds.length > 0) {
    ctl.appendChild(el('div', 'small muted', 'По типу источника:'));
    var krows = el('div', 'group-actions');
    kinds.forEach(function (k) {
      var chip = el('span');
      chip.appendChild(el('span', 'small muted', (SOURCE_KIND[k] || k) + ': '));
      chip.appendChild(bulkBtn('вкл', 'sources', byKind[k], true, 'small'));
      chip.appendChild(document.createTextNode(' '));
      chip.appendChild(bulkBtn('выкл', 'sources', byKind[k], false, 'small'));
      krows.appendChild(chip);
    });
    ctl.appendChild(krows);
  }
  var hb = STATE.meta && STATE.meta.history ? STATE.meta.history.backups : null;
  if (hb) {
    ctl.appendChild(el('div', 'hintline', 'История переключений источников: копий sources.yaml — ' + hb.sources.count +
      '. Последняя правка: ' + (hb.sources.newestAt ? fmtAgo(hb.sources.newestAt) : 'не было') + '.'));
  }
  ctlSection.appendChild(ctl);
  view.appendChild(ctlSection);

  // --- карточки источников ---
  var s1 = section('Источники', 'реестр + фактическая статистика по снимкам');
  var grid = el('div', 'grid cards');
  doc.sources.forEach(function (src) {
    var c = el('div', 'card agent-card');
    var head = el('div', 'agent-head');
    var left = el('div');
    left.appendChild(el('h3', 'agent-name', src.name));
    left.appendChild(el('div', 'agent-role', 'id: ' + src.id + ' · приоритет ' + (src.priority === null ? '—' : src.priority)));
    head.appendChild(left);
    var right = el('div');
    right.style.textAlign = 'right';
    var sw = el('button', 'switch' + (src.enabled ? ' on' : ''));
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-checked', src.enabled ? 'true' : 'false');
    sw.setAttribute('data-source-name', src.name);
    sw.title = src.enabled
      ? 'Выключить: сбор пропустит этот источник, новые данные по нему не появятся'
      : 'Включить: сбор снова будет брать этот источник (запуск сбора — отдельно)';
    sw.appendChild(el('span', 'knob'));
    sw.addEventListener('click', function (e) {
      e.stopPropagation();
      toggleSource(src.id, !src.enabled, sw, function () { loadState().then(boot); });
    });
    right.appendChild(sw);
    right.appendChild(el('div', 'small muted', src.enabled ? 'включён' : 'выключен'));
    head.appendChild(right);
    c.appendChild(head);

    var meta = el('div', 'agent-meta');
    meta.appendChild(sourceStatusBadge(src.status));
    meta.appendChild(badge(SOURCE_KIND[src.kind] || src.kind, 'accent'));
    meta.appendChild(badge('авторизация: ' + (src.auth || '—'), 'grey'));
    if (src.stats.lots > 0) meta.appendChild(badge('доля ' + fmtPct(src.stats.share), 'purple'));
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
    stats.appendChild(stat('лотов', fmtInt(src.stats.lots), 'строк с этим источником в снимках'));
    stats.appendChild(stat('снимков', String(src.stats.snapshots)));
    stats.appendChild(stat('последний', src.stats.lastDate ? fmtDay(src.stats.lastDate) : '—'));
    c.appendChild(stats);

    if (src.stats.projects.length > 0) {
      c.appendChild(el('div', 'small muted', 'Проекты: ' + src.stats.projects.slice(0, 4).map(function (p) { return p.name + ' (' + p.lots + ')'; }).join(', ')));
    }
    if (src.limits) c.appendChild(el('div', 'small muted', 'Ограничения: ' + src.limits));
    if (src.howto) c.appendChild(el('div', 'small mono', 'Запуск: ' + src.howto));
    if (src.lastRun) c.appendChild(el('div', 'small muted', 'Последний запуск по реестру: ' + src.lastRun));
    if (src.lastRunFromLog) {
      var lr = src.lastRunFromLog;
      c.appendChild(el('div', 'small muted', 'Журнал: ' + (lr.ts || lr.time || lr.finished_at || '—') +
        (lr.lots !== undefined ? ', лотов ' + lr.lots : '') + (lr.status !== undefined ? ', ' + lr.status : '')));
    }
    c.appendChild(el('div', 'small muted', 'Даты снимков: ' + (src.stats.dates.length ? src.stats.dates.map(fmtDay).join(', ') : 'нет данных')));
    var ch = lastChangeFor('sources', src.id);
    if (ch) {
      c.appendChild(el('div', 'changed', 'Последнее изменение тумблера: ' + fmtDateTime(ch.at) + ' (' + fmtAgo(ch.at) + '), было ' + (ch.previous ? 'включён' : 'выключен') + ' → стало ' + (ch.now ? 'включён' : 'выключен') + '.'));
    } else {
      c.appendChild(el('div', 'hintline', 'Через дашборд этот источник ещё не переключали.'));
    }
    grid.appendChild(c);
  });
  s1.appendChild(grid);
  view.appendChild(s1);

  // --- доля по источникам ---
  var s2 = section('Доля по источникам', 'по количеству лотов во всех снимках');
  var c2 = card();
  if (doc.share.length === 0) {
    c2.appendChild(note(null, 'Снимков пока нет — доли считать не из чего.'));
  } else {
    var bars = el('div', 'bars');
    var maxLots = doc.share[0].lots;
    doc.share.forEach(function (x) {
      bars.appendChild(barRow(x.name, x.lots, maxLots,
        fmtInt(x.lots) + ' · ' + fmtPct(x.share) + (x.inRegistry ? '' : ' · нет в реестре'),
        x.enabled ? 'ok' : 'warn',
        x.enabled === null ? 'нет в реестре источников' : (x.enabled ? 'источник включён' : 'источник выключен')));
    });
    c2.appendChild(bars);
    c2.appendChild(el('div', 'small muted', 'Полоса показывает, сколько лотов дал источник. Цвет: зелёный — источник включён, жёлтый — выключен.'));
  }
  s2.appendChild(c2);
  view.appendChild(s2);

  // --- по неделям ---
  var s3 = section('По неделям', 'сколько лотов собрано за неделю');
  var c3 = card();
  if (doc.byWeek.length === 0) {
    c3.appendChild(el('div', 'muted', 'Данных по неделям нет.'));
  } else {
    var w3 = el('div', 'table-wrap');
    var t3 = el('table', 'data');
    var th3 = el('thead'); var tr3 = el('tr');
    [['Неделя'], ['Лотов', 'num'], ['По источникам']].forEach(function (h) { add(tr3, 'th', h[1] || null, h[0]); });
    th3.appendChild(tr3); t3.appendChild(th3);
    var tb3 = el('tbody');
    doc.byWeek.forEach(function (w) {
      var row = el('tr');
      add(row, 'td', 'mono', w.week);
      add(row, 'td', 'num', fmtInt(w.lots));
      add(row, 'td', 'small muted', Object.keys(w.bySource).map(function (k) { return k + ': ' + w.bySource[k]; }).join(', '));
      tb3.appendChild(row);
    });
    t3.appendChild(tb3); w3.appendChild(t3); c3.appendChild(w3);
  }
  s3.appendChild(c3);
  view.appendChild(s3);

  // --- снимки ---
  var s4 = section('Снимки', 'что лежит в data/snapshots');
  var c4 = card();
  if (doc.snapshots.length === 0) {
    c4.appendChild(el('div', 'muted', 'Снимков нет.'));
  } else {
    var w4 = el('div', 'table-wrap');
    var t4 = el('table', 'data');
    var th4 = el('thead'); var tr4 = el('tr');
    [['Папка снимка'], ['Дата'], ['Лотов', 'num'], ['Источники'], ['Проекты']].forEach(function (h) { add(tr4, 'th', h[1] || null, h[0]); });
    th4.appendChild(tr4); t4.appendChild(th4);
    var tb4 = el('tbody');
    doc.snapshots.forEach(function (x) {
      var row = el('tr');
      add(row, 'td', 'mono', x.dir);
      add(row, 'td', null, x.date ? fmtDay(x.date) : '—');
      add(row, 'td', 'num', fmtInt(x.rows));
      add(row, 'td', 'small muted', Object.keys(x.sources).map(function (k) { return k + ': ' + x.sources[k]; }).join(', '));
      add(row, 'td', 'small muted', Object.keys(x.projects).join(', ') || '—');
      tb4.appendChild(row);
    });
    t4.appendChild(tb4); w4.appendChild(t4); c4.appendChild(w4);
  }
  if (doc.runLog.exists) {
    c4.appendChild(el('div', 'small muted', 'Журнал запусков: ' + doc.runLog.file + ' — записей ' + doc.runLog.count + '.'));
  } else {
    c4.appendChild(note(null, doc.runLog.note));
  }
  if (doc.unknownInSnapshots.length > 0) {
    doc.unknownInSnapshots.forEach(function (u) {
      c4.appendChild(note('warn', 'Источник «' + u.id + '» есть в снимках (' + u.lots + ' лотов), но не описан в registry/sources.yaml. Добавьте его в реестр или задайте соответствие в dashboard/config/source-aliases.yaml.'));
    });
  }
  s4.appendChild(c4);
  view.appendChild(s4);
};

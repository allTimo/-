/* ЖК для наблюдения + автоподбор конкурентов (Агент 1). */
'use strict';

var WATCH_FILTER = { status: 'all', radius: 'all' };
var STALE_REFRESH_DONE = false;

// Проверка свежести: файлы кандидатов и настроек могли обновиться ПОСЛЕ сборки данных.
// Так выглядит дефект «движок положил файл, а панель показывает пусто».
function staleReason() {
  var gen = (STATE.meta && STATE.meta.generatedAtMs) || 0;
  var c = (STATE['candidates'] || {}).newestMtimeMs || 0;
  var s = (STATE['agent-settings'] || {}).newestMtimeMs || 0;
  var newest = Math.max(c, s);
  if (!gen || !newest) return null;
  if (newest > gen + 2000) {
    return 'Файлы данных новее собранной статистики на ' + Math.round((newest - gen) / 1000) + ' с.';
  }
  return null;
}

function refreshDataNow(btn, noteHost) {
  if (btn) btn.disabled = true;
  if (noteHost) { clear(noteHost); noteHost.appendChild(note(null, 'Пересобираю данные…')); }
  return fetch('/api/collect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    .then(function (r) { return r.json(); })
    .then(function () { return fetch('/api/state', { cache: 'no-store' }).then(function (r) { return r.json(); }); })
    .then(function (j) { STATE = j; renderSidebar(); renderActive(); toast('Данные обновлены'); })
    .catch(function (e) { if (btn) btn.disabled = false; toast('Не удалось обновить: ' + e.message, 'bad'); });
}

function staleBanner() {
  var why = staleReason();
  if (!why) return null;
  var box = el('div', 'stale-banner');
  box.appendChild(note('warn', why + ' Показанное ниже может быть неполным — нажмите «Обновить данные».'));
  var btn = el('button', 'btn primary small', 'Обновить данные');
  var host = el('div');
  btn.addEventListener('click', function () { refreshDataNow(btn, host); });
  box.appendChild(btn);
  box.appendChild(host);
  // И один автоматический пересбор при первом открытии — чтобы «ничего не найдено» не вводило в заблуждение.
  if (!STALE_REFRESH_DONE) {
    STALE_REFRESH_DONE = true;
    setTimeout(function () { refreshDataNow(btn, host); }, 400);
  }
  return box;
}

// Трёхуровневый путь agent1.watch.<поле> в существующем блоке настроек.
(function patchSettings() {
  var origValue = agFieldValue;
  agFieldValue = function (rec, group, field) {
    if (String(group).indexOf('.') >= 0) {
      var cur = rec;
      String(group).split('.').forEach(function (p) {
        if (cur === null || cur === undefined) return;
        cur = cur[p === 'source_agent' ? 'sourceAgent' : p];
      });
      if (cur === null || cur === undefined) return undefined;
      var v = cur[field];
      return Array.isArray(v) ? v.map(String) : v;
    }
    return origValue(rec, group, field);
  };
  // Режим сбора по источнику: единственное место, где задаётся доступ и способ сбора.
  AG_SCHEMA.splice(9, 0, ['agent1.source_modes', 'Режим сбора по источникам', [
    ['cian', 'CIAN', 'enum', 'Проверено: работает обычным HTTP без логина (200, реальные цены).', ['http', 'browser', 'off']],
    ['avito', 'Avito', 'enum', 'Проверено: работает через браузер без логина (движок взял 50 лотов).', ['http', 'browser', 'off']],
    ['yandex-realty', 'Яндекс Недвижимость', 'enum', 'Требует ссылок уровня проекта — включаем с пометкой.', ['http', 'browser', 'off']],
    ['domclick', 'Домклик', 'enum', 'Проверено: закрыт (401/403) — держим выключенным.', ['http', 'browser', 'off']],
    ['developer-sites', 'Сайты застройщиков', 'enum', 'Обычный HTTP без логина.', ['http', 'browser', 'off']]
  ]]);
  AG_SCHEMA.splice(8, 0, ['agent1.watch', 'ЖК для наблюдения', [
    ['name', 'Название ЖК', 'str', 'Ваш проект, вокруг которого ищем конкурентов.'],
    ['address', 'Адрес', 'str', 'Нужен, чтобы определить координаты. Если номера дома нет, геокодер может ошибиться — тогда укажите координаты вручную.'],
    ['url', 'Ссылка на сайт ЖК', 'str', 'Для сбора данных о своём проекте (необязательно).'],
    ['lat', 'Широта', 'str', 'Если пусто — агент определит по адресу сам.'],
    ['lon', 'Долгота', 'str', 'Если пусто — агент определит по адресу сам.'],
    ['radius_km', 'Радиус поиска конкурентов, км', 'num', 'Ищем конкурентов в этом радиусе по прямой. По умолчанию 10 км; точность ±0,5 км.'],
    ['klass', 'Класс / сегмент', 'list', 'Совпадающие по классу проекты попадают в список первыми. Можно несколько: бизнес, премиум, комфорт.'],
    ['price_min_per_m2', 'Цена от, ₽/м²', 'int', 'Нижняя граница: дешевле — не наш сегмент.'],
    ['price_max_per_m2', 'Цена до, ₽/м²', 'int', 'Верхняя граница: дороже — не наш сегмент.'],
    ['sources', 'Источники поиска', 'list', 'Где искать: cian, avito, yandex-realty, domclick, web-search.', ['cian', 'avito', 'yandex-realty', 'domclick', 'web-search']],
    ['max_candidates', 'Максимум кандидатов', 'int', 'Сколько кандидатов показать за один поиск.']
  ]]);
  // 2026-11-01: карта «домен → ключ проекта» для сопоставления бюджетов (agent1.competitor_domains).
  // Группа динамическая: строки берём из данных, потому что домены заранее неизвестны.
  var origBlock0 = agentSettingsBlock;
  agentSettingsBlock = function (agentId) {
    var box = origBlock0(agentId);
    if (agentId !== 'agent-1-competitor-watch') return box;
    var rec = agSettings(agentId);
    if (!rec || !rec.agent1) return box;
    var map = rec.agent1.competitorDomains || {};
    var grp = el('div', 'ag-group');
    grp.appendChild(el('div', 'ag-group-title', 'Домены конкурентов (для сопоставления бюджетов)'));
    grp.appendChild(el('div', 'ag-what', 'Карта «домен → канонический ключ проекта». Нужна, когда срез сервиса отдаёт только домен (seliger-city.ru), а профиль называется по ключу (zhk-seliger-siti). Читает и движок, и панель.'));
    Object.keys(map).forEach(function (dom) {
      var row = el('div', 'ag-row');
      var lab = el('div', 'ag-label');
      lab.appendChild(el('div', 'ag-name', dom));
      lab.appendChild(el('div', 'ag-what', 'канонический ключ проекта:'));
      row.appendChild(lab);
      var inp = el('input'); inp.type = 'text'; inp.value = map[dom]; inp.style.flex = '0 0 220px';
      row.appendChild(inp);
      var btn = el('button', 'btn small', 'Сохранить');
      btn.addEventListener('click', function () {
        if (!window.confirm('Сохранить домен ' + dom + ' → ' + inp.value + '?')) return;
        fetch('/api/agent-settings/set', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent: agentId, group: 'agent1.competitor_domains', field: dom, value: inp.value }) })
          .then(function (r) { return r.json(); }).then(function (res) {
            toast(res.ok ? ('Сохранено: ' + dom + ' → ' + inp.value) : ('Не удалось: ' + res.message), res.ok ? 'ok' : 'bad');
            if (res.ok) refreshDataNow();
          });
      });
      row.appendChild(btn);
      grp.appendChild(row);
    });
    var addRow = el('div', 'ag-row');
    var dIn = el('input'); dIn.type = 'text'; dIn.placeholder = 'новый домен, например seliger-city.ru'; dIn.style.flex = '1 1 220px';
    var kIn = el('input'); kIn.type = 'text'; kIn.placeholder = 'ключ проекта zhk-…'; kIn.style.flex = '0 0 200px';
    var aBtn = el('button', 'btn small primary', 'Добавить домен');
    aBtn.addEventListener('click', function () {
      if (!dIn.value) { toast('Укажите домен', 'bad'); return; }
      fetch('/api/agent-settings/set', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent: agentId, group: 'agent1.competitor_domains', field: dIn.value, value: kIn.value }) })
        .then(function (r) { return r.json(); }).then(function (res) {
          toast(res.ok ? ('Добавлено: ' + dIn.value + ' → ' + kIn.value) : ('Не удалось: ' + res.message), res.ok ? 'ok' : 'bad');
          if (res.ok) refreshDataNow();
        });
    });
    addRow.appendChild(dIn); addRow.appendChild(kIn); addRow.appendChild(aBtn);
    grp.appendChild(addRow);
    box.appendChild(grp);
    return box;
  };
  var origBlock = agentSettingsBlock;
  agentSettingsBlock = function (agentId) {
    var box = origBlock(agentId);
    if (agentId === 'agent-1-competitor-watch') box.appendChild(watchCandidatesBlock());
    return box;
  };
})();

function watchCandidatesBlock() {
  var d = STATE['candidates'] || { exists: false, projects: [], counts: { total: 0 } };
  var box = el('div', 'watch-box');
  box.appendChild(el('div', 'ag-group-title', 'Подбор конкурентов'));

  var rec = agSettings('agent-1-competitor-watch') || {};
  var w = (rec.agent1 && rec.agent1.watch) ? rec.agent1.watch : {};
  var modes = (rec.agent1 && rec.agent1.source_modes) ? rec.agent1.source_modes : {};
  var modeHints = Object.keys(modes).map(function (k) { return k + ' — ' + (modes[k] === 'off' ? 'выключен' : modes[k]); }).join(', ');
  box.appendChild(el('div', 'hintline', 'Ищем конкурентов вокруг «' + (w.name || 'вашего ЖК') + '» в радиусе ' + (w.radius_km || 10) + ' км. Источники автоподбора: ' + ((w.sources || []).join(', ') || 'не заданы') + '. Режим сбора: ' + (modeHints || 'не задан') + '. Найденное приходит на подтверждение — автоподбор не заменяет решение человека.'));
  box.appendChild(el('div', 'hintline', 'Что реально включено ДЛЯ КЛИЕНТА, задаётся в его конфиге 01-competitor-watch/config/clients/<client-id>.yaml — это главный источник правды. Подтверждённые конкуренты хранятся там же, а не в настройках агента.'));

  var row = el('div', 'filters');
  var btn = el('button', 'btn primary small', 'Подобрать конкурентов');
  var out = el('div');
  btn.addEventListener('click', function () {
    if (!window.confirm('Запустить подбор конкурентов в радиусе ' + (w.radius_km || 10) + ' км вокруг «' + (w.name || 'ЖК') + '»?')) return;
    btn.disabled = true;
    clear(out);
    out.appendChild(note(null, 'Запрашиваю поиск…'));
    fetch('/api/agent1/discover', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: (STATE.projects && STATE.projects.projects[0]) ? STATE.projects.projects[0].id : '' }) })
      .then(function (r) { return r.json(); }).then(function (res) {
        btn.disabled = false;
        clear(out);
        out.appendChild(note(res.ok ? 'ok' : 'bad', res.message));
        if (res.stub) out.appendChild(el('div', 'hintline', 'Это честная заглушка: панель ничего не выдумывает. Как только движок (задача T57) положит файлы в 01-competitor-watch/data/candidates/, список появится здесь сам.'));
      }).catch(function (e) { btn.disabled = false; clear(out); out.appendChild(note('bad', 'Ошибка запроса: ' + e.message)); });
  });
  row.appendChild(btn);
  box.appendChild(row);
  box.appendChild(out);

  // ---- список кандидатов ----
  if (!d.exists || !d.projects.length) {
    var empty = el('div', 'empty-state');
    empty.appendChild(el('div', 'empty-title', 'Кандидатов пока нет'));
    empty.appendChild(el('div', 'empty-hint', 'Список появится после первого поиска. Что нужно сделать: 1) заполнить блок «ЖК для наблюдения» выше — название, адрес, радиус; 2) нажать «Подобрать конкурентов». Пока движок поиска не подключён (задача T57), панель не показывает выдуманных кандидатов — это честно.'));
    if (d.dir) empty.appendChild(el('div', 'small muted', 'Папка для результатов: ' + d.dir));
    // Честная строка на случай, когда файл уже появился, а данные не успели пересобраться.
    empty.appendChild(el('div', 'empty-hint', 'Данные могли устареть — обновить, если движок уже положил файл кандидатов.'));
    var reBtn = el('button', 'btn primary small', 'Данные могли устареть — обновить');
    var reHost = el('div');
    reBtn.addEventListener('click', function () { refreshDataNow(reBtn, reHost); });
    empty.appendChild(reBtn);
    empty.appendChild(reHost);
    box.appendChild(empty);
    return box;
  }

  var all = [];
  d.projects.forEach(function (p) { p.items.forEach(function (i) { all.push(Object.assign({ projectId: p.projectId }, i)); }); });

  // Файл движка ЕСТЬ, но кандидатов в нём нет: объясняем почему, а не показываем пустую таблицу.
  if (all.length === 0) {
    var p0 = d.projects[0];
    var es = el('div', 'empty-state');
    es.appendChild(el('div', 'empty-title', 'Движок отработал, но кандидатов не нашёл'));
    var when = p0.foundAt ? (' (' + String(p0.foundAt).replace('T', ' ').slice(0, 16) + ')') : '';
    es.appendChild(el('div', 'empty-hint', 'Файл результатов есть: ' + p0.fileName + when + '. Список кандидатов в нём пуст — панель не выдумывает данные.'));
    if (p0.summary) {
      var s = p0.summary;
      es.appendChild(el('div', 'small muted', 'Итог движка: всего найдено ' + (s.total !== undefined ? s.total : '—') + ', в радиусе ' + (s.in_radius !== undefined ? s.in_radius : '—') + ', без расстояния ' + (s.without_distance !== undefined ? s.without_distance : '—') + ', без цены ' + (s.without_price !== undefined ? s.without_price : '—') + ', не тот класс ' + (s.class_mismatch !== undefined ? s.class_mismatch : '—') + '.'));
    }
    if (p0.platformAttempts && p0.platformAttempts.length) {
      es.appendChild(el('div', 'small muted', 'Что ответили площадки: ' + p0.platformAttempts.map(function (a) { return a.source + ' — ' + a.status + (a.note ? ' (' + a.note + ')' : ''); }).join('; ') + '.'));
    }
    if (p0.limitations && p0.limitations.length) {
      var ul0 = el('ul', 'clean');
      p0.limitations.forEach(function (l) { ul0.appendChild(el('li', null, l)); });
      es.appendChild(el('div', 'small muted', 'Ограничения прогона:'));
      es.appendChild(ul0);
    }
    es.appendChild(el('div', 'empty-hint', 'Данные могли устареть — обновить, если движок только что переписал файл.'));
    var rb0 = el('button', 'btn primary small', 'Данные могли устареть — обновить');
    var rh0 = el('div');
    rb0.addEventListener('click', function () { refreshDataNow(rb0, rh0); });
    es.appendChild(rb0);
    es.appendChild(rh0);
    box.appendChild(es);
    return box;
  }
  var f = el('div', 'filters');
  var fs = el('div');
  fs.appendChild(el('label', null, 'Статус: '));
  var ssel = el('select');
  [['all', 'все'], ['candidate', 'новые'], ['approved', 'добавленные'], ['rejected', 'отклонённые']].forEach(function (o) {
    var op = el('option', null, o[1]); op.value = o[0]; if (WATCH_FILTER.status === o[0]) op.selected = true; ssel.appendChild(op);
  });
  ssel.addEventListener('change', function () { WATCH_FILTER.status = this.value; renderActive(); });
  fs.appendChild(ssel);
  f.appendChild(fs);
  var fr = el('div');
  fr.appendChild(el('label', null, 'Радиус: '));
  var rsel = el('select');
  [['all', 'любой'], ['5', 'до 5 км'], ['10', 'до 10 км'], ['20', 'до 20 км']].forEach(function (o) {
    var op = el('option', null, o[1]); op.value = o[0]; if (WATCH_FILTER.radius === o[0]) op.selected = true; rsel.appendChild(op);
  });
  rsel.addEventListener('change', function () { WATCH_FILTER.radius = this.value; renderActive(); });
  fr.appendChild(rsel);
  f.appendChild(fr);
  var addAll = el('button', 'btn small', 'Добавить всех в радиусе');
  addAll.addEventListener('click', function () {
    var inR = list.filter(function (c) { return c.status === 'candidate' && c.distanceKm !== null && c.distanceKm <= Number(w.radius_km || 10); });
    if (!inR.length) { toast('В радиусе нет новых кандидатов', 'bad'); return; }
    if (!window.confirm('Добавить в конкуренты ' + inR.length + ' кандидат(ов) в радиусе ' + (w.radius_km || 10) + ' км?\n\nКаждый будет записан в клиентский конфиг с копией .bak.')) return;
    inR.forEach(function (c) { candidateAct(c, 'approve'); });
    setTimeout(function () { refreshState(); }, 900);
  });
  f.appendChild(addAll);
  box.appendChild(f);

  var list = all.filter(function (c) {
    if (WATCH_FILTER.status !== 'all' && c.status !== WATCH_FILTER.status) return false;
    if (WATCH_FILTER.radius !== 'all') {
      if (c.distanceKm === null) return false;
      if (c.distanceKm > Number(WATCH_FILTER.radius)) return false;
    }
    return true;
  });
  box.appendChild(el('div', 'small muted', 'Показано ' + list.length + ' из ' + all.length + '. Без расстояния: ' + all.filter(function (c) { return c.distanceKm === null; }).length + ' — по ним площадка не отдала координаты.'));
  var tbl = el('div', 'table-wrap');
  rowsTable(tbl, [['Название'], ['Застройщик'], ['Класс'], ['Расстояние', 'num'], ['Цена за м²', 'num'], ['Площадки'], ['Статус'], ['']], list.map(function (c) {
    var dist = c.distanceKm === null ? el('span', 'muted small', 'данных нет') : el('span', 'mono', String(Math.round(c.distanceKm * 10) / 10) + ' км');
    if (c.distanceKm !== null && Number(w.radius_km || 10) && c.distanceKm > Number(w.radius_km || 10)) dist.title = 'Вне радиуса ' + (w.radius_km || 10) + ' км';
    var price = c.pricePerM2 === null ? el('span', 'muted small', 'данных нет') : el('span', 'mono', money(c.pricePerM2, true));
    var links = el('span');
    if (!c.sources.length) links.appendChild(el('span', 'muted small', 'нет'));
    c.sources.forEach(function (s, i) {
      if (i > 0) links.appendChild(document.createTextNode(' · '));
      if (s.url) { var a = el('a', 'small', s.platform); a.href = s.url; a.target = '_blank'; links.appendChild(a); }
      else links.appendChild(el('span', 'small muted', s.platform));
    });
    var st = el('span');
    st.appendChild(badge(c.status === 'approved' ? 'добавлен' : (c.status === 'rejected' ? 'отклонён' : 'новый'), c.status === 'approved' ? 'ok' : (c.status === 'rejected' ? 'grey' : 'accent')));
    var act = el('span');
    var addB = el('button', 'btn small primary', 'Добавить в конкуренты');
    addB.disabled = c.status === 'approved';
    addB.addEventListener('click', function () {
      if (!window.confirm('Добавить «' + c.name + '» в конкуренты клиента? Запись пойдёт в клиентский конфиг Агента 1 с копией .bak.')) return;
      candidateAct(c, 'approve');
    });
    var rejB = el('button', 'btn small', 'Отклонить');
    rejB.disabled = c.status === 'rejected';
    rejB.title = 'Решение сохранится и кандидат больше не будет предлагаться';
    rejB.addEventListener('click', function () { candidateAct(c, 'reject'); });
    act.appendChild(addB); act.appendChild(document.createTextNode(' ')); act.appendChild(rejB);
    return [c.name, c.developer || '—', c.klass || '—', dist, price, links, st, act];
  }));
  box.appendChild(tbl);
  box.appendChild(el('div', 'hintline', 'Расстояние считается по прямой, точность ±0,5 км — для отбора достаточно, для юридических целей нет. «данных нет» означает, что площадка не отдала значение на публичной странице: панель не подставляет выдуманные числа.'));
  return box;
}

function candidateAct(c, action) {
  fetch('/api/agent1/candidate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project: c.projectId, name: c.name, action: action, client: 'client-svet' })
  }).then(function (r) { return r.json(); }).then(function (res) {
    if (!res.ok) { toast('Не удалось: ' + res.message, 'bad'); return; }
    toast(res.target + (res.backup ? ' · копия ' + res.backup : ''));
    if (action === 'approve') refreshState();
    else refreshState();
  }).catch(function (e) { toast('Ошибка: ' + e.message, 'bad'); });
}


// Встраиваем блок «Тонкие настройки» в карточки агентов и источников.
(function wrapAgentViews() {
  function wrap(origName, matcher) {
    var orig = VIEWS[origName];
    if (!orig) return;
    VIEWS[origName] = function (view) {
      var stage = document.createElement('div');
      orig(stage);
      while (stage.firstChild) view.appendChild(stage.firstChild);
      matcher(view);
    };
  }
  function appendToCards(view, agentIds) {
    var cards = view.querySelectorAll('.agent-card');
    cards.forEach(function (card, idx) {
      var nameEl = card.querySelector('.agent-name');
      var name = nameEl ? String(nameEl.textContent).trim() : '';
      var agentId = null;
      agentIds.forEach(function (id) { if (!agentId && name && name.indexOf(id) >= 0) agentId = id; });
      if (!agentId && agentIds.length > idx) agentId = agentIds[idx];
      if (!agentId) return;
      card.appendChild(agentSettingsBlock(agentId));
    });
  }
  wrap('agentsExecutors', function (view) {
    var banner = staleBanner();
    if (banner) view.insertBefore(banner, view.firstChild);
    var d = STATE['agent-settings'];
    var ids = d && d.byAgent ? Object.keys(d.byAgent).filter(function (k) { return k.indexOf('source') === -1; }) : [];
    appendToCards(view, ids);
  });
  wrap('agentsSources', function (view) {
    var banner = staleBanner();
    if (banner) view.insertBefore(banner, view.firstChild);
    var d = STATE['agent-settings'];
    var ids = d && d.byAgent ? Object.keys(d.byAgent).filter(function (k) { return k.indexOf('source') >= 0; }) : [];
    appendToCards(view, ids);
  });
})();

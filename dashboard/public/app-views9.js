/* Раздел «Интеграции»: полный каталог по API с фильтрами. */
'use strict';

var intFilters = { group: 'all', status: 'all', direction: 'all', q: '' };

var INT_STATUS_CLS = { connected: 'ok', available: 'accent', partnership: 'warn', 'no-api': 'bad' };

function intCount(STATE1, pred) {
  var d = STATE1.integrations;
  if (!d || !d.catalog) return 0;
  var n = 0;
  d.catalog.groups.forEach(function (g) { g.items.forEach(function (i) { if (pred(i)) n++; }); });
  return n;
}

VIEWS.integrations = function (view) {
  var doc = STATE.integrations;
  if (!doc) { view.appendChild(note('bad', 'Нет данных по интеграциям.')); return; }
  var cat = doc.catalog;
  if (!cat) { view.appendChild(note('bad', 'Каталог интеграций не найден: dashboard/config/integrations-full.yaml')); return; }

  var k = el('div', 'grid kpi');
  k.appendChild(kpi('Подключено', String(cat.counts.connected), 'работает прямо сейчас', 'ok'));
  k.appendChild(kpi('Можно подключить', String(cat.counts.available), 'нужен доступ или ключ', 'accent'));
  k.appendChild(kpi('Требует партнёрства', String(cat.counts.partnership), 'договор с площадкой', cat.counts.partnership ? 'warn' : 'ok'));
  k.appendChild(kpi('Нет открытого API', String(cat.counts.noApi), 'только выгрузка файлом', cat.counts.noApi ? 'bad' : 'ok'));
  view.appendChild(k);

  view.appendChild(note(null, 'Статус «подключено» панель ставит по ФАКТАМ: проверяет, установлен ли пакет в профиле DSH и есть ли он в списке загрузки. Наличие ключа проверяется как факт — значение ключа не читается и не показывается никогда. Где открытого API нет, так и написано: предлагаем выгрузку файлом.'));

  // --- что подключено сейчас (факты профиля) ---
  var working = doc.integrations.filter(function (i) { return i.state === 'connected' && (!i.needsKey || i.keyPresent); });
  var s0 = section('Подключено у вас сейчас', 'по фактам профиля DSH');
  var c0 = card();
  if (working.length === 0) c0.appendChild(el('div', 'muted', 'Ничего не подключено.'));
  else {
    var ul = el('ul', 'clean');
    working.forEach(function (i) {
      ul.appendChild(el('li', null, i.name + ' — ' + (i.purpose || '') + (i.needsKey ? (i.keyPresent ? ' (ключ есть)' : ' (ключа нет)') : '')));
    });
    c0.appendChild(ul);
  }
  if (doc.attention.length > 0) {
    c0.appendChild(el('div', 'hintline', 'Требуют внимания: ' + doc.attention.map(function (i) { return i.name + ' — ' + i.stateLabel; }).join('; ')));
  }
  s0.appendChild(c0);
  view.appendChild(s0);

  // --- фильтры ---
  var s1 = section('Каталог интеграций', 'источник: dashboard/config/integrations-full.yaml · записей ' + cat.counts.total + ' в ' + cat.groups.length + ' группах');
  var fc = card();
  var f = el('div', 'filters');

  var qWrap = el('div');
  qWrap.appendChild(el('label', null, 'Поиск: '));
  var qIn = el('input');
  qIn.type = 'text';
  qIn.placeholder = 'название или что даёт';
  qIn.value = intFilters.q;
  qIn.style.minWidth = '220px';
  qIn.addEventListener('input', function () { intFilters.q = this.value; redraw(); });
  qWrap.appendChild(qIn);
  f.appendChild(qWrap);

  function sel(label, key, options) {
    var w = el('div');
    w.appendChild(el('label', null, label + ': '));
    var s = el('select');
    options.forEach(function (o) {
      var op = el('option', null, o[1]); op.value = o[0];
      if (String(intFilters[key]) === String(o[0])) op.selected = true;
      s.appendChild(op);
    });
    s.addEventListener('change', function () { intFilters[key] = this.value; redraw(); });
    w.appendChild(s);
    return w;
  }
  f.appendChild(sel('Группа', 'group', [{ value: 'all', label: 'все' }].concat(cat.groups.map(function (g) { return { value: g.id, label: g.title + ' (' + g.total + ')' }; }))));
  f.appendChild(sel('Статус', 'status', [
    { value: 'all', label: 'все' },
    { value: 'connected', label: 'подключено (' + cat.counts.connected + ')' },
    { value: 'available', label: 'можно подключить (' + cat.counts.available + ')' },
    { value: 'partnership', label: 'требует партнёрства (' + cat.counts.partnership + ')' },
    { value: 'no-api', label: 'нет открытого API (' + cat.counts.noApi + ')' }
  ]));
  f.appendChild(sel('Направление', 'direction', [
    { value: 'all', label: 'все' },
    { value: 'read', label: 'читаем' },
    { value: 'write', label: 'пишем' },
    { value: 'both', label: 'оба' }
  ]));
  var reset = el('button', 'btn small', 'Сбросить');
  reset.addEventListener('click', function () { intFilters = { group: 'all', status: 'all', direction: 'all', q: '' }; qIn.value = ''; redraw(); });
  f.appendChild(reset);
  fc.appendChild(f);

  var host = el('div');
  fc.appendChild(host);

  function matches(i) {
    if (intFilters.status !== 'all' && i.status !== intFilters.status) return false;
    if (intFilters.direction !== 'all' && i.direction !== intFilters.direction) return false;
    if (intFilters.q) {
      var hay = (i.name + ' ' + (i.what || '') + ' ' + (i.method || '') + ' ' + (i.where || '')).toLowerCase();
      if (hay.indexOf(intFilters.q.toLowerCase()) === -1) return false;
    }
    return true;
  }

  function redraw() {
    clear(host);
    var shown = 0;
    var groups = cat.groups.filter(function (g) { return intFilters.group === 'all' || g.id === intFilters.group; });
    groups.forEach(function (g) {
      var items = g.items.filter(matches);
      if (items.length === 0) return;
      shown += items.length;
      var gs = section(g.title, items.length + ' из ' + g.total);
      var grid = el('div', 'grid cards');
      items.forEach(function (i) {
        var c = el('div', 'card agent-card');
        var head = el('div', 'agent-head');
        var left = el('div');
        left.appendChild(el('h3', 'agent-name', i.name));
        head.appendChild(left);
        var right = el('div');
        right.appendChild(badge(i.statusLabel, INT_STATUS_CLS[i.status] || 'grey'));
        head.appendChild(right);
        c.appendChild(head);
        c.appendChild(el('div', 'agent-role', i.what || ''));

        var meta = el('div', 'agent-meta');
        meta.appendChild(badge('направление: ' + i.directionLabel, 'purple'));
        meta.appendChild(badge(i.method || 'способ не указан', 'grey'));
        if (i.needsKey) meta.appendChild(badge(i.keyPresent ? 'ключ есть' : 'ключа нет', i.keyPresent ? 'ok' : 'warn'));
        c.appendChild(meta);

        if (i.where) c.appendChild(el('div', 'small muted', 'Где взять доступ: ' + i.where));
        if (i.factNote) c.appendChild(el('div', 'hintline', 'По фактам профиля: ' + i.factNote));
        if (i.status === 'no-api') c.appendChild(el('div', 'hintline', 'Открытого API нет — работаем выгрузкой файла.'));

        var row = el('div', 'filters');
        var b = el('button', 'btn small' + (i.status === 'connected' ? '' : ' primary'), i.status === 'connected' ? 'Подробнее' : 'Подключить');
        b.title = i.status === 'connected'
          ? 'Уже работает. Показать, где взять доступ'
          : (i.status === 'no-api' ? 'Открытого API нет: подключение через выгрузку файлом' : 'Подключение появится позже: сейчас это инструкция');
        b.addEventListener('click', function () {
          if (i.status === 'connected') toast(i.name + ': ' + (i.where || 'доступ уже настроен'), 'ok');
          else if (i.status === 'no-api') toast(i.name + ': открытого API нет. Вариант — выгрузка файлом: ' + (i.where || ''), 'bad');
          else toast(i.name + ' — раздел в подготовке. Где взять доступ: ' + (i.where || '—'), 'bad');
        });
        row.appendChild(b);
        c.appendChild(row);
        grid.appendChild(c);
      });
      gs.appendChild(grid);
      host.appendChild(gs);
    });
    if (shown === 0) host.appendChild(note(null, 'Под фильтр ничего не попало.'));
    else host.appendChild(el('div', 'hintline', 'Показано записей: ' + shown + ' из ' + cat.counts.total + '.'));
  }
  redraw();
  s1.appendChild(fc);
  view.appendChild(s1);

  // --- служебное ---
  var s2 = section('Профиль DSH', 'что реально установлено на этой машине');
  var c2 = card();
  c2.appendChild(el('div', 'small muted', 'Бандлов в профиле: ' + doc.profile.bundlesCount + ', из них сообщества: ' + doc.profile.communityBundlesCount + '.'));
  rowsTable(c2, [['Пакет'], ['Версия'], ['В бандлах'], ['Установлен'], ['Точка входа']], doc.profilePackages.filter(function (p) { return !p.inbox; }).map(function (p) {
    return [p.name, p.version || p.declaredVersion || '—', p.inBundles ? 'да' : 'нет', p.installed ? 'да' : 'нет', p.ok ? 'ок' : (p.carrier ? 'носитель' : 'нет')];
  }));
  s2.appendChild(c2);
  view.appendChild(s2);
};

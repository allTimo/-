/* Тонкие настройки агента в его карточке. */
'use strict';

// Схема отображения: группа -> поля. h — «что произойдёт», если поменять значение.
var AG_SCHEMA = [
  ['schedule', 'Расписание', [
    ['enabled', 'Автозапуск по расписанию', 'bool', 'Агент будет запускаться сам в указанные дни и время.'],
    ['frequency', 'Частота', 'enum', 'Как часто повторять запуск.', ['daily', 'weekly', 'monthly', 'on-demand']],
    ['days', 'Дни недели', 'list', 'В какие дни недели запускать (1 — понедельник, 7 — воскресенье).', null, 'ints'],
    ['time', 'Время запуска', 'time', 'Во сколько стартовать (в вашем часовом поясе).'],
    ['timezone', 'Часовой пояс', 'str', 'Относительно какого пояса считается время.'],
    ['only_on_new_data', 'Только при новых данных', 'bool', 'Если новых данных нет — прогон пропускается, расход не тратится.']
  ]],
  ['model', 'Модель и расход', [
    ['name', 'Модель', 'str', 'На какой модели работает агент. Цена модели — в registry/prices.yaml.'],
    ['limit_rub', 'Лимит расхода, ₽', 'num', 'При достижении лимита сработает выбранное поведение. 0 — без лимита.'],
    ['limit_tokens', 'Лимит токенов', 'int', 'Верхняя граница по токенам за период. 0 — без лимита.'],
    ['on_limit', 'При превышении лимита', 'enum', 'Что делать, когда расход дошёл до лимита.', ['pause', 'stop', 'warn']]
  ]],
  ['priority', 'Приоритет и параллельность', [
    ['level', 'Приоритет', 'enum', 'Насколько высоко ставить задачи агента в очереди.', ['low', 'normal', 'high']],
    ['max_parallel', 'Максимум одновременных прогонов', 'int', 'Сколько прогонов агента может идти одновременно.'],
    ['timeout_sec', 'Таймаут прогона, сек', 'int', 'Сколько ждать прогон, прежде чем считать его зависшим.'],
    ['retries', 'Повторы при сбое', 'int', 'Сколько раз повторять неудачный прогон автоматически.']
  ]],
  ['report', 'Отчёт', [
    ['formats', 'Форматы', 'list', 'В каких файлах готовить результат.', ['md', 'xlsx', 'csv', 'pdf']],
    ['language', 'Язык отчёта', 'enum', 'На каком языке готовить отчёт.', ['ru', 'en']],
    ['branding', 'Брендинг клиента', 'bool', 'Подставлять название клиента в шапку отчёта.']
  ]],
  ['delivery', 'Доставка', [
    ['channels', 'Каналы', 'list', 'Куда отправлять готовый отчёт.', ['telegram', 'email', 'vk', 'link']],
    ['auto_send', 'Отправлять автоматически', 'bool', 'Отчёт уйдёт сам после сборки. Если выключено — отправляете вручную.'],
    ['copy_to', 'Копия на адрес', 'str', 'Кому отправить копию (можно оставить пустым).']
  ]],
  ['alerts', 'Алерты', [
    ['when', 'Когда беспокоить', 'list', 'В каких случаях присылать уведомление.', ['never', 'fail', 'low_data', 'always']],
    ['price_threshold_pct', 'Порог изменения цены, %', 'num', 'Изменения меньше порога не считаются значимыми.'],
    ['quiet_hours', 'Тихие часы', 'str', 'В этом интервале уведомления не приходят, например 22:00-08:00.']
  ]],
  ['limits', 'Пауза и ограничения', [
    ['skip_weekends', 'Не запускать в выходные', 'bool', 'Суббота и воскресенье пропускаются.'],
    ['min_interval_hours', 'Не чаще, чем раз в N часов', 'num', 'Защита от слишком частых запусков.'],
    ['stop_switch', 'Стоп-кран', 'bool', 'Немедленно запретить любые запуски агента.']
  ]],
  ['agent1', 'Специфика Агента 1', [
    ['price_threshold_pct', 'Порог цены, %', 'num', 'На сколько должна измениться цена, чтобы попасть в отчёт.'],
    ['min_lots', 'Минимум лотов', 'int', 'Если лотов меньше — данные считаются неполными.'],
    ['collect_mode', 'Режим сбора', 'enum', 'HTTP — быстрее и без браузера; браузер — если сайт отдаёт данные только в окне.', ['http', 'browser']],
    ['compare_depth_weeks', 'Глубина сравнения, недель', 'int', 'С какой неделей сравнивать текущий снимок.'],
    ['promo_words', 'Словарь акций', 'list', 'Слова, по которым ищем промо в текстах.']
  ]],
  ['source_agent', 'Специфика агента-источника', [
    ['rate_limit_per_min', 'Запросов в минуту', 'int', 'Сколько запросов к площадке делать в минуту.'],
    ['pause_ms', 'Пауза между запросами, мс', 'int', 'Плавность сбора: защищает от блокировки.'],
    ['max_pages', 'Максимум страниц', 'int', 'Сколько страниц обходить за прогон.'],
    ['timeout_sec', 'Таймаут запроса, сек', 'int', 'Сколько ждать ответ площадки.'],
    ['stop_on_block', 'Стоп при блокировке', 'bool', 'Если площадка начала блокировать — немедленно остановиться.'],
    ['use_browser', 'Использовать браузер', 'bool', 'Собирать через Chrome без логина (медленнее, но проходит блокировки).']
  ]]
];

function agSettings(agentId) {
  var d = STATE['agent-settings'];
  return d && d.byAgent ? d.byAgent[agentId] : null;
}

function agFieldValue(rec, group, field) {
  var g = rec[group === 'source_agent' ? 'sourceAgent' : group];
  if (!g) return undefined;
  var v = g[field];
  if (Array.isArray(v)) return v.map(String);
  return v;
}

function agDefaultsOf(group, field) {
  var D = { enabled: false, only_on_new_data: false, frequency: 'weekly', days: [1], time: '10:00', timezone: 'Europe/Moscow',
    name: 'deepseek/deepseek-v4.1-flash', limit_rub: 0, limit_tokens: 0, on_limit: 'warn',
    level: 'normal', max_parallel: 1, timeout_sec: 900, retries: 0,
    formats: ['md'], language: 'ru', branding: false,
    channels: [], auto_send: false, copy_to: '',
    when: ['fail'], price_threshold_pct: 5, quiet_hours: '',
    skip_weekends: true, min_interval_hours: 24, stop_switch: false,
    min_lots: 10, collect_mode: 'http', compare_depth_weeks: 2, promo_words: [],
    rate_limit_per_min: 10, pause_ms: 1500, max_pages: 5, stop_on_block: true, use_browser: false };
  return D[field];
}

function agInput(rec, group, field, type, options, extra) {
  var cur = agFieldValue(rec, group, field);
  var w = el('div', 'ag-field');
  var v;
  if (type === 'bool') {
    v = el('button', 'switch' + (cur === true ? ' on' : ''));
    v.setAttribute('role', 'switch');
    v.appendChild(el('span', 'knob'));
    v.dataset.value = cur === true ? '1' : '0';
    v.addEventListener('click', function () {
      var on = v.dataset.value !== '1';
      v.dataset.value = on ? '1' : '0';
      v.className = 'switch' + (on ? ' on' : '');
      w.dataset.changed = '1';
    });
  } else if (type === 'enum') {
    v = el('select');
    options.forEach(function (o) { var op = el('option', null, o); op.value = o; if (String(cur) === o) op.selected = true; v.appendChild(op); });
    v.addEventListener('change', function () { w.dataset.changed = '1'; });
  } else if (type === 'list') {
    v = el('input'); v.type = 'text';
    v.value = Array.isArray(cur) ? cur.join(', ') : '';
    if (extra === 'ints') v.placeholder = 'например 1, 4';
    v.addEventListener('input', function () { w.dataset.changed = '1'; });
  } else if (type === 'time') {
    v = el('input'); v.type = 'text'; v.value = cur === undefined || cur === null ? '' : String(cur); v.placeholder = 'ЧЧ:ММ';
    v.addEventListener('input', function () { w.dataset.changed = '1'; });
  } else {
    v = el('input'); v.type = (type === 'num' || type === 'int') ? 'number' : 'text';
    v.value = cur === undefined || cur === null ? '' : String(cur);
    if (type === 'int') v.step = '1';
    v.addEventListener('input', function () { w.dataset.changed = '1'; });
  }
  v.disabled = !rec.editable;
  w.appendChild(v);
  return w;
}

function agReadValue(host) {
  var c = host.querySelector('button.switch, select, input');
  if (!c) return null;
  if (c.className && String(c.className).indexOf('switch') === 0) return c.dataset.value === '1';
  if (c.tagName === 'SELECT') return c.value;
  if (c.type === 'number') { var n = Number(c.value); return isFinite(n) ? n : c.value; }
  var t = String(c.value || '').trim();
  if (host.dataset.listlike === '1') return t === '' ? [] : t.split(',').map(function (x) { return x.trim(); }).filter(function (x) { return x !== ''; });
  return t;
}

function agentSettingsBlock(agentId) {
  var rec = agSettings(agentId);
  var box = el('details', 'ag-settings');
  var sum = el('summary');
  sum.appendChild(el('span', 'ag-sum-title', 'Тонкие настройки'));
  sum.appendChild(el('span', 'ag-sum-hint', rec ? (rec.editable ? 'расписание, модель, отчёт, доставка, алерты, ограничения' : 'настройки появятся вместе с агентом') : 'файл настроек не найден'));
  box.appendChild(sum);
  if (!rec) {
    box.appendChild(note('warn', 'Для этого агента нет файла registry/agent-settings/' + agentId + '.yaml'));
    return box;
  }
  if (!rec.editable) box.appendChild(note('warn', (rec.note || 'Агент ещё не реализован: настройки появятся вместе с агентом.') + ' Сохранять нельзя, поля показаны для примера.'));
  box.appendChild(el('div', 'hintline', 'Файл: registry/agent-settings/' + rec.fileName + (rec.updated ? ' · обновлён ' + rec.updated : '') + '. Правка атомарная, с копией .bak-<timestamp>; обратимость по SHA-256.'));

  var pending = [];
  AG_SCHEMA.forEach(function (grp) {
    var sectionEl = el('div', 'ag-group');
    sectionEl.appendChild(el('div', 'ag-group-title', grp[1]));
    if (grp[0] === 'agent1' && !rec.agent1) return sectionEl;
    if (grp[0] === 'source_agent' && !rec.sourceAgent) return sectionEl;
    grp[2].forEach(function (f) {
      var row = el('div', 'ag-row');
      var lab = el('div', 'ag-label');
      lab.appendChild(el('div', 'ag-name', f[1]));
      lab.appendChild(el('div', 'ag-what', f[3] || ''));
      row.appendChild(lab);
      var ctl = agInput(rec, grp[0], f[0], f[2], f[4], f[5]);
      if (f[2] === 'list') ctl.dataset.listlike = '1';
      row.appendChild(ctl);
      var was = el('button', 'btn small ag-revert', 'вернуть как было');
      was.disabled = !rec.editable;
      was.title = 'Вернуть значение из последней копии файла';
      was.addEventListener('click', function () { agRevertLast(agentId, was); });
      row.appendChild(was);
      sectionEl.appendChild(row);
      pending.push({ group: grp[0], field: f[0], type: f[2], host: ctl, label: f[1] });
    });
    box.appendChild(sectionEl);
  });

  // предупреждение о противоречиях
  var warnHost = el('div');
  function checkContradictions() {
    clear(warnHost);
    var autoSend = agFieldValue(rec, 'delivery', 'auto_send') === true;
    var limit = Number(agFieldValue(rec, 'model', 'limit_rub') || 0);
    if (autoSend && limit === 0) warnHost.appendChild(note('warn', 'Противоречие: автоотправка включена, а лимит расхода 0 ₽ — отчёты будут уходить без контроля бюджета.'));
    var stop = agFieldValue(rec, 'limits', 'stop_switch') === true;
    var sched = agFieldValue(rec, 'schedule', 'enabled') === true;
    if (stop && sched) warnHost.appendChild(note('bad', 'Противоречие: стоп-кран включён, но автозапуск по расписанию тоже включён — расписание не сработает.'));
    var quiet = String(agFieldValue(rec, 'alerts', 'quiet_hours') || '');
    if (quiet !== '' && !/^\d{2}:\d{2}-\d{2}:\d{2}$/.test(quiet)) warnHost.appendChild(note('warn', 'Тихие часы записаны не по шаблону ЧЧ:ММ-ЧЧ:ММ: «' + quiet + '» — сохранение не пройдёт.'));
  }
  checkContradictions();
  box.appendChild(warnHost);

  var actions = el('div', 'ag-actions');
  var save = el('button', 'btn primary small', 'Сохранить');
  save.disabled = !rec.editable;
  var lastBackup = null;
  save.addEventListener('click', function () {
    var changed = pending.filter(function (p) { return p.host.dataset.changed === '1'; });
    if (changed.length === 0) { toast('Нечего сохранять: значения не менялись.'); return; }
    if (!window.confirm('Сохранить настройки агента «' + agentId + '»? Изменений: ' + changed.length + '\n\nКаждое изменение пишется атомарно, с копией .bak-<timestamp>.')) return;
    save.disabled = true;
    var i = 0;
    (function step() {
      if (i >= changed.length) { save.disabled = false; toast('Настройки сохранены: ' + changed.length + ' поле(й). Вернуть можно кнопкой «Вернуть как было».'); refreshState(); return; }
      var p = changed[i++];
      fetch('/api/agent-settings/set', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent: agentId, group: p.group, field: p.field, value: agReadValue(p.host) })
      }).then(function (r) { return r.json(); }).then(function (res) {
        if (!res.ok) { save.disabled = false; toast('Не удалось сохранить «' + p.label + '»: ' + res.message, 'bad'); return; }
        lastBackup = res.backup || lastBackup;
        box.dataset.backup = lastBackup || '';
        step();
      }).catch(function (e) { save.disabled = false; toast('Ошибка: ' + e.message, 'bad'); });
    })();
  });
  actions.appendChild(save);

  var revert = el('button', 'btn small', 'Вернуть как было');
  revert.disabled = !rec.editable;
  revert.title = 'Восстановить файл настроек из последней копии .bak';
  revert.addEventListener('click', function () { agRevertLast(agentId, revert, box.dataset.backup); });
  actions.appendChild(revert);

  var reset = el('button', 'btn small', 'Сбросить к умолчаниям');
  reset.disabled = !rec.editable;
  reset.addEventListener('click', function () {
    if (!window.confirm('Подставить значения по умолчанию во все поля? Файл изменится только после «Сохранить».')) return;
    pending.forEach(function (p) {
      var c = p.host.querySelector('button.switch, select, input');
      if (!c) return;
      var d = agDefaultsOf(p.group, p.field);
      if (p.type === 'bool') { c.dataset.value = d ? '1' : '0'; c.className = 'switch' + (d ? ' on' : ''); }
      else if (p.type === 'list') c.value = Array.isArray(d) ? d.join(', ') : '';
      else c.value = d === undefined || d === null ? '' : String(d);
      p.host.dataset.changed = '1';
    });
    toast('Подставлены умолчания — проверьте и нажмите «Сохранить».');
  });
  actions.appendChild(reset);

  var cancel = el('button', 'btn small', 'Отменить');
  cancel.addEventListener('click', function () {
    clear(box);
    box.appendChild(sum);
    box.appendChild(note(null, 'Изменения отменены — показываю значения из файла.'));
    refreshState();
  });
  actions.appendChild(cancel);
  box.appendChild(actions);
  return box;
}

function refreshState() {
  return fetch('/api/state', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) { STATE = j; renderSidebar(); renderActive(); });
}

function agRevertLast(agentId, ctl, backup) {
  var b = backup || null;
  if (!b) {
    fetch('/api/settings/backups?file=' + encodeURIComponent(agentId + '.yaml')).then(function (r) { return r.json(); }).catch(function () { return null; });
    toast('Нет копии для возврата: сначала сохраните изменение — панель сделает копию автоматически.', 'bad');
    return;
  }
  if (!window.confirm('Вернуть настройки агента «' + agentId + '» из копии ' + b + '?')) return;
  fetch('/api/settings/revert', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file: 'agent-settings/' + agentId, backup: b }) })
    .then(function (r) { return r.json(); }).then(function (res) {
      toast(res.ok ? 'Настройки возвращены из копии' : ('Не удалось: ' + res.message), res.ok ? 'ok' : 'bad');
      if (res.ok) refreshState();
    });
}

// Встраиваем блок в карточки агентов и источников, не трогая исходные экраны.
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
    var d = STATE['agent-settings'];
    var ids = d && d.byAgent ? Object.keys(d.byAgent).filter(function (k) { return k.indexOf('source') === -1; }) : [];
    appendToCards(view, ids);
  });
  wrap('agentsSources', function (view) {
    var d = STATE['agent-settings'];
    var ids = d && d.byAgent ? Object.keys(d.byAgent).filter(function (k) { return k.indexOf('source') >= 0; }) : [];
    appendToCards(view, ids);
  });
})();

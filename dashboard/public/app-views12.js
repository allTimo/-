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
    ['top_deals_count', 'Лотов в топах изменений', 'int', 'Сколько лотов показывать в топах подорожаний и подешевений.'],
    ['promo_words', 'Словарь акций', 'list', 'Слова, по которым ищем промо в текстах.']
  ]],
  // ЧТО АНАЛИЗИРОВАТЬ (Агент 1) — группа agent1.selection.
  // Контракт: docs/agent-1-marketing-settings-contract.md, группа 2.
  // Имена и типы обязаны совпадать с serve.mjs (AGENT_SETTINGS_SCHEMA['agent1.selection'])
  // и collector/lib/agent-settings.mjs (SELECTION_FIELDS/SELECTION_SPEC).
  ['agent1.selection', 'Что анализировать', [
    ['room_types', 'Типы квартир', 'list', 'Какие типы учитывать: 0 — студия, 1, 2, 3, 4, 5+. Пусто — все. Ограничение применяется к лотам конкурентов при сборе.', ['0', '1', '2', '3', '4', '5+']],
    ['area_min_m2', 'Площадь от, м²', 'num', 'Лоты меньшей площади не попадут в срез. 0 — без ограничения.', null, null, { min: 0, max: 400 }],
    ['area_max_m2', 'Площадь до, м²', 'num', 'Лоты большей площади не попадут в срез. 0 — без ограничения.', null, null, { min: 0, max: 400 }],
    ['price_min_rub', 'Цена от, ₽', 'int', 'Лоты дешевле не попадут в срез. 0 — без ограничения.', null, null, { min: 0, max: 1000000000 }],
    ['price_max_rub', 'Цена до, ₽', 'int', 'Лоты дороже не попадут в срез. 0 — без ограничения.', null, null, { min: 0, max: 1000000000 }],
    ['exclude_first_floor', 'Не учитывать первые этажи', 'bool', 'Лоты на первом этаже исключаются из расчёта.'],
    ['exclude_last_floor', 'Не учитывать последние этажи', 'bool', 'Лоты на последнем этаже исключаются из расчёта.'],
    ['finishes', 'Тип отделки', 'list', 'Какие типы отделки учитывать. Пусто — все.', ['без отделки', 'white box', 'чистовая', 'с мебелью', 'unknown']],
    ['only_active', 'Только лоты в продаже', 'bool', 'Учитывать только лоты «в продаже»: забронированные и проданные — нет.'],
    ['promo_only', 'Только лоты с акцией', 'bool', 'Оставить в срезе только лоты, у которых есть акция.'],
    ['price_metric', 'Показатель цены', 'enum', 'Что печатать в отчёте: медиана, среднее или минимум и максимум.', ['median', 'mean', 'min_max']],
    ['outlier_guard', 'Отбраковывать аномалии', 'bool', 'Аномальные цены не искажают медиану; срез при этом помечается как недостоверный.'],
    ['outlier_same_price_min_lots', 'Порог одинаковой цены, лотов', 'int', 'С какого числа лотов с одинаковой ценой срез считается артефактом парсинга.', null, null, { min: 2, max: 50 }],
    ['outlier_ppm2_min', 'Правдоподобная цена от, ₽/м²', 'int', 'Ниже этой границы цена считается аномальной.', null, null, { min: 0, max: 10000000 }],
    ['outlier_ppm2_max', 'Правдоподобная цена до, ₽/м²', 'int', 'Выше этой границы цена считается аномальной.', null, null, { min: 0, max: 10000000 }]
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
    min_lots: 10, collect_mode: 'http', compare_depth_weeks: 2, promo_words: [], top_deals_count: 5,
    // «Что анализировать» (agent1.selection) — дефолты контракта, группа 2.
    room_types: ['0', '1', '2', '3', '4', '5+'], area_min_m2: 0, area_max_m2: 0,
    price_min_rub: 0, price_max_rub: 0, exclude_first_floor: false, exclude_last_floor: false,
    finishes: ['без отделки', 'white box', 'чистовая', 'с мебелью', 'unknown'],
    only_active: true, promo_only: false, price_metric: 'median', outlier_guard: true,
    outlier_same_price_min_lots: 5, outlier_ppm2_min: 150000, outlier_ppm2_max: 800000,
    rate_limit_per_min: 10, pause_ms: 1500, max_pages: 5, stop_on_block: true, use_browser: false };
  return D[field];
}

// Белый список групп для карточки конкретного агента. null = показывать всю схему.
// Переопределяется в app-views13.js: в карточке Агента 1 остаются только
// маркетинговые группы, системные (расписание, модель, приоритет, лимиты, источник) — нет.
function agGroupsForAgent(agentId) { return null; }
// Заголовок группы в карточке. Переопределяется там же: у Агента 1 группы называются
// по-маркетинговому («Охват и радиус», «Что анализировать», «Сравнение и выводы»).
function agGroupTitle(agentId, group, fallback) { return fallback; }
// Подпись у «Тонкие настройки». Тоже переопределяется для Агента 1: там нет
// системных групп, и подпись обязана называть только то, что реально видно.
function agSummaryHint(agentId, rec) {
  return rec ? (rec.editable ? 'расписание, модель, отчёт, доставка, алерты, ограничения' : 'настройки появятся вместе с агентом') : 'файл настроек не найден';
}

function agInput(rec, group, field, type, options, extra, limits) {
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
    // Границы из контракта: браузер подсказывает предел ещё до отправки,
    // а серверная валидация остаётся последним словом.
    if (limits && limits.min !== undefined) v.min = String(limits.min);
    if (limits && limits.max !== undefined) v.max = String(limits.max);
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
  sum.appendChild(el('span', 'ag-sum-hint', agSummaryHint(agentId, rec)));
  box.appendChild(sum);
  if (!rec) {
    box.appendChild(note('warn', 'Для этого агента нет файла registry/agent-settings/' + agentId + '.yaml'));
    return box;
  }
  if (!rec.editable) box.appendChild(note('warn', (rec.note || 'Агент ещё не реализован: настройки появятся вместе с агентом.') + ' Сохранять нельзя, поля показаны для примера.'));
  box.appendChild(el('div', 'hintline', 'Файл: registry/agent-settings/' + rec.fileName + (rec.updated ? ' · обновлён ' + rec.updated : '') + '. Правка атомарная, с копией .bak-<timestamp>; обратимость по SHA-256.'));

  var pending = [];
  var visibleGroups = agGroupsForAgent(agentId);
  AG_SCHEMA.forEach(function (grp) {
    // Прячем группы, которых в карточке этого агента быть не должно (например,
    // системные у Агента 1): они не рендерятся вовсе, а не просто скрыты стилями.
    if (visibleGroups && visibleGroups.indexOf(grp[0]) < 0) return;
    var sectionEl = el('div', 'ag-group');
    sectionEl.dataset.group = grp[0];
    sectionEl.appendChild(el('div', 'ag-group-title', agGroupTitle(agentId, grp[0], grp[1])));
    if (grp[0] === 'agent1' && !rec.agent1) return sectionEl;
    if (grp[0] === 'source_agent' && !rec.sourceAgent) return sectionEl;
    // Поля с пометкой 'hidden' (7-й элемент описания) не удаляются из YAML, а прячутся
    // под «дополнительно». Сейчас так не помечено ни одно поле Агента 1 (его маркетинговые
    // группы показываются целиком) — механизм оставлен рабочим для будущих групп.
    var moreRows = [];
    grp[2].forEach(function (f) {
      // Подраздел внутри одной группы: строка вида ['id', 'Заголовок', 'sub'].
      // Нужна, чтобы «Сравнение и выводы» (agent1) и «Тумблеры аналитики» (agent1.analytics)
      // были ОДНОЙ группой, а не двумя однотипными заголовками.
      if (f[2] === 'sub') { sectionEl.appendChild(el('div', 'ag-sub-title', f[1])); return; }
      // 9-й элемент описания поля — группа, из которой читается и куда пишется значение.
      // Пусто — группа самой секции. Так поля agent1.analytics живут внутри группы agent1.
      var fgroup = f[8] || grp[0];
      var row = el('div', 'ag-row');
      var lab = el('div', 'ag-label');
      lab.appendChild(el('div', 'ag-name', f[1]));
      lab.appendChild(el('div', 'ag-what', f[3] || ''));
      row.appendChild(lab);
      var ctl = agInput(rec, fgroup, f[0], f[2], f[4], f[5], f[7]);
      if (f[2] === 'list') ctl.dataset.listlike = '1';
      row.appendChild(ctl);
      var was = el('button', 'btn small ag-revert', 'вернуть как было');
      was.disabled = !rec.editable;
      was.title = 'Вернуть значение из последней копии файла';
      was.addEventListener('click', function () { agRevertLast(agentId, was); });
      row.appendChild(was);
      if (f[6] === 'hidden') moreRows.push(row);
      else sectionEl.appendChild(row);
      pending.push({ group: fgroup, field: f[0], type: f[2], host: ctl, label: f[1] });
    });
    if (moreRows.length) {
      var more = el('details', 'ag-more');
      var msum = el('summary', 'ag-more-sum', 'дополнительно' + (grp[4] ? ': ' + grp[4] : '') + ' (' + moreRows.length + ')');
      more.appendChild(msum);
      moreRows.forEach(function (r) { more.appendChild(r); });
      sectionEl.appendChild(more);
    }
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
  if (backup) { agDoRevert(agentId, backup); return; }
  // Копий у тонких настроек агента может быть несколько: берём самую свежую.
  fetch('/api/settings/backups?file=' + encodeURIComponent('agent-settings/' + agentId))
    .then(function (r) { return r.json(); })
    .then(function (res) {
      var list = (res && res.backups) || [];
      if (!list.length) {
        toast('Нет копии для возврата: сначала сохраните изменение — панель сделает копию автоматически.', 'bad');
        return;
      }
      agDoRevert(agentId, list[0].name, res.current);
    })
    .catch(function (e) { toast('Не удалось получить список копий: ' + e.message, 'bad'); });
}

function agDoRevert(agentId, b, current) {
  if (!window.confirm('Вернуть настройки агента «' + agentId + '» из копии ' + b + '?\n\nТекущее состояние тоже сохранится отдельной копией.')) return;
  fetch('/api/settings/revert', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file: 'agent-settings/' + agentId, backup: b }) })
    .then(function (r) { return r.json(); }).then(function (res) {
      toast(res.ok ? ('Настройки возвращены из копии ' + b + (res.sha256 ? ' · SHA-256 совпал' : '')) : ('Не удалось: ' + res.message), res.ok ? 'ok' : 'bad');
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
      // Защита от дубля: на карточке может быть ровно ОДИН блок «Тонкие настройки».
      // Даже если обёртку VIEWS.agentsExecutors зарегистрируют повторно, второй блок не появится.
      if (card.querySelector && card.querySelector('.ag-settings')) return;
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

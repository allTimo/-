/* WP3/T-A1: панель Агента 1 — маркетинговые тонкие настройки (охват и радиус, что
   анализировать, сравнение и выводы), тумблеры аналитики, индикатор «работа сделана /
   не сделана» и раздел «Аналитика» с результатами движка.
   Файл подключается последним: он дополняет уже собранные экраны, ничего не переписывая. */
'use strict';

var A1_ID = 'agent-1-competitor-watch';

// Тумблеры аналитики. Имена обязаны совпадать с collector/lib/agent-settings.mjs
// (ANALYTICS_FIELDS), serve.mjs (AGENT_SETTINGS_SCHEMA['agent1.analytics'])
// и verify-data.mjs — расхождение ловит валидатор панели.
var A1_ANALYTICS_TOGGLES = [
  ['enabled', 'Аналитика включена', 'Общий выключатель: без него движок не считает аналитику по конкурентам.'],
  ['lots_all_on_sale', 'Лоты в продаже', 'Считать все лоты в продаже: количество и min/медиана/max ₽/м² по конкурентам и сайтам.'],
  ['price_dynamics', 'Динамика цен', 'Сравнивать медианы ₽/м² с предыдущим снимком.'],
  ['promos', 'Акции', 'Показывать акции конкурентов.'],
  ['new_promos_only', 'Только новые акции', 'Показывать акции, которых не было в предыдущем снимке; известные сворачивать в счётчик.'],
  ['dedup_promos', 'Убирать повторы акций', 'Одинаковые акции одного проекта показывать один раз.'],
  ['developers_sites', 'Сайты застройщиков', 'Добавлять данные с сайтов застройщиков.'],
  ['forecast', 'Прогноз', 'Прогноз медианы ₽/м² по истории снимков; всегда помечается словом «оценка».']
];

var A1_DISCOVER_HOST = null;

/* ---------- 1. Схема настроек: тумблеры аналитики + одно поле ввода ---------- */
(function patchAgent1Schema() {
  if (typeof AG_SCHEMA === 'undefined') return;

  // (а) Контракт v2 (§3): «Сравнение и выводы» — ОДНА группа. Поля agent1.* и тумблеры
  // agent1.analytics.* живут в ней же, тумблеры идут подразделом «Тумблеры аналитики».
  // 9-й элемент описания поля — группа, из которой читается и куда пишется значение.
  var toggles = A1_ANALYTICS_TOGGLES.map(function (t) {
    return [t[0], t[1], 'bool', t[2], null, null, null, null, 'agent1.analytics'];
  });
  var aIdx = -1;
  AG_SCHEMA.forEach(function (g, i) { if (g[0] === 'agent1') aIdx = i; });
  var baseFields = aIdx >= 0 ? AG_SCHEMA[aIdx][2].filter(function (f) { return f[2] !== 'sub'; }) : [];
  var merged = ['agent1', 'Сравнение и выводы', baseFields.concat([['analytics-toggles', 'Тумблеры аналитики', 'sub']], toggles)];
  if (aIdx >= 0) AG_SCHEMA[aIdx] = merged;
  else AG_SCHEMA.push(merged);
  // Отдельной группы agent1.analytics на карточке быть не должно — убираем, если осталась.
  for (var ai = AG_SCHEMA.length - 1; ai >= 0; ai--) {
    if (AG_SCHEMA[ai][0] === 'agent1.analytics') AG_SCHEMA.splice(ai, 1);
  }

  // (б) Охват и радиус: ОДНО поле «Мой ЖК» (query). Поля name и url из карточки убраны
  // (контракт v2 §3): они остаются в YAML, движок выводит их из query, если пусты.
  var wIdx = -1;
  AG_SCHEMA.forEach(function (g, i) { if (g[0] === 'agent1.watch') wIdx = i; });
  if (wIdx >= 0) {
    var query = ['query', 'Мой ЖК: название или сайт', 'str',
      'Например: ЖК «Свет» или https://svetdom.ru/. По этому значению агент ищет конкурентов; после сохранения подбор запускается сам.'];
    var drop = { query: 1, name: 1, url: 1 };
    var rest = AG_SCHEMA[wIdx][2].filter(function (f) { return !drop[f[0]]; });
    AG_SCHEMA[wIdx] = ['agent1.watch', 'Охват и радиус', [query].concat(rest), null,
      'свой ЖК, радиус, класс, цены за м², источники поиска и число кандидатов'];
  }

  // (в) Умолчания для новых полей: аналитика включена (безопасный дефолт движка),
  // query пустой. Без этого «Сбросить к умолчаниям» обнулял бы тумблеры.
  if (typeof agDefaultsOf === 'function') {
    var origDefaults = agDefaultsOf;
    agDefaultsOf = function (group, field) {
      if (group === 'agent1.analytics') return true;
      if (group === 'agent1.watch' && field === 'query') return '';
      return origDefaults(group, field);
    };
  }
})();

/* ---------- 2. Индикатор «работа сделана / не сделана» ---------- */
function a1Val(v, fmt) {
  if (v === null || v === undefined) return el('span', 'muted small', 'данных нет');
  if (fmt === 'money') return el('span', 'mono', money(v, true));
  if (fmt === 'pct') return el('span', 'mono', String(v) + '%');
  if (fmt === 'text') return el('span', null, String(v));
  return el('span', 'mono', fmtInt(v));
}
function a1NoData(text) { return el('div', 'small muted', 'данных нет: ' + text); }

function agent1StatusBlock() {
  var d = STATE['agent1-status'];
  var box = el('div', 'a1-status');
  box.appendChild(el('div', 'ag-group-title', 'Работа сделана / не сделана'));
  if (!d) {
    box.appendChild(note('warn', 'Статус прогона не собран: в данных нет документа agent1-status.json — нажмите «Обновить данные».'));
    var r0 = el('div', 'filters');
    var b0 = el('button', 'btn small', 'Обновить данные');
    var h0 = el('div');
    b0.addEventListener('click', function () { refreshDataNow(b0, h0); });
    r0.appendChild(b0); box.appendChild(r0); box.appendChild(h0);
    return box;
  }
  var kind = d.state === 'done' ? 'ok' : (d.state === 'failed' ? 'bad' : 'grey');
  var head = el('div', 'a1-verdict');
  head.appendChild(badge(d.verdict || 'состояние неизвестно', kind));
  head.appendChild(el('span', 'a1-verdict-note', d.reason || ''));
  box.appendChild(head);

  if ((d.evidence || []).length) {
    var tbl = el('div');
    rowsTable(tbl, [['Что проверяем'], ['Значение']], d.evidence.map(function (e) {
      return [e.label, a1Val(e.value, 'text')];
    }));
    box.appendChild(tbl);
  }
  box.appendChild(el('div', 'hintline',
    'Прогонов Агента 1 в registry/runs.jsonl: ' + d.runs.total + ' (успешно ' + d.runs.ok + ', ошибок ' + d.runs.failed + ').'
    + (d.runs.lastOk && d.state !== 'done' ? ' Последний успешный: ' + String(d.runs.lastOk.ts || '').replace('T', ' ').slice(0, 19) + '.' : '')));
  if (d.results && d.results.last) {
    var lr = d.results.last;
    box.appendChild(el('div', 'hintline', 'Последний результат: «' + (lr.title || lr.id) + '» от '
      + String(lr.created || '—').replace('T', ' ').slice(0, 16) + ' · отправка: ' + (lr.sentChannel === 'telegram' ? 'Telegram' : lr.sentChannel) + ' ' + (lr.sentTo || '') + ' — ' + lr.sentStatus));
  }
  if (d.state === 'never') {
    box.appendChild(el('div', 'hintline', 'Проверенные источники: ' + (d.sources || []).map(function (s) {
      return s.path + (s.exists ? '' : ' (нет)');
    }).join('; ') + '.'));
  }
  var row = el('div', 'filters');
  var btn = el('button', 'btn small', 'Обновить данные');
  var host = el('div');
  btn.addEventListener('click', function () { refreshDataNow(btn, host); });
  row.appendChild(btn);
  box.appendChild(row);
  box.appendChild(host);
  A1_DISCOVER_HOST = el('div');
  box.appendChild(A1_DISCOVER_HOST);
  return box;
}

/* ---------- 3. Автоподбор после сохранения поля query ---------- */
function a1DiscoverSay(kind, text) {
  if (A1_DISCOVER_HOST) { clear(A1_DISCOVER_HOST); A1_DISCOVER_HOST.appendChild(note(kind, text)); }
  else toast(text, kind === 'bad' ? 'bad' : undefined);
}

function runAgent1Discover(reason) {
  var proj = (STATE.projects && STATE.projects.projects[0]) ? STATE.projects.projects[0].id : '';
  a1DiscoverSay(null, 'Подбор конкурентов запущен автоматически: ' + reason + '. Запрашиваю поиск…');
  fetch('/api/agent1/discover', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project: proj })
  }).then(function (r) { return r.json(); }).then(function (res) {
    a1DiscoverSay(res.ok ? 'ok' : 'warn', res.message + (res.stub
      ? ' Это честная заглушка: панель ничего не выдумывает. Как только движок положит файлы в 01-competitor-watch/data/candidates/, список появится здесь сам.'
      : ''));
    if (res.ok) refreshDataNow();
  }).catch(function (e) {
    a1DiscoverSay('bad', 'Не удалось запустить автоподбор: ' + e.message);
  });
}

// Перехватываем ровно одну операцию: сохранение agent1.watch.query.
// После успешной записи, если агент включён, подбор стартует без отдельной кнопки.
(function autoDiscoverOnQuerySave() {
  var origFetch = window.fetch;
  window.fetch = function (url, opts) {
    var promise = origFetch.apply(this, arguments);
    try {
      var u = String(url || '');
      if (u.indexOf('/api/agent-settings/set') >= 0 && opts && opts.method === 'POST' && opts.body) {
        var body = JSON.parse(opts.body);
        if (body && body.agent === A1_ID && body.group === 'agent1.watch' && body.field === 'query') {
          promise = promise.then(function (res) {
            if (!res.ok) return res;
            var rec = agSettings(A1_ID) || {};
            var on = rec.schedule ? rec.schedule.enabled === true : false;
            var stop = rec.limits ? rec.limits.stop_switch === true : false;
            if (on && !stop) {
              setTimeout(function () { runAgent1Discover('сохранено «название проекта или сайт»'); }, 250);
            } else {
              a1DiscoverSay('warn', 'Автоподбор не запущен: тумблер агента (автозапуск по расписанию) выключен'
                + (stop ? ' или включён стоп-кран' : '') + '. Включите агента и сохраните поле ещё раз.');
            }
            return res;
          });
        }
      }
    } catch (e) { /* не наша операция — не мешаем */ }
    return promise;
  };
})();

/* ---------- 4. Раздел «Аналитика»: результаты движка ---------- */
function a1TogglesLine(toggles) {
  var keys = toggles ? Object.keys(toggles) : [];
  if (!keys.length) return el('div', 'small muted', 'данных нет: движок не прислал список включённых тумблеров');
  var row = el('div', 'filters');
  keys.forEach(function (k) {
    row.appendChild(badge(k + ': ' + (toggles[k] === true ? 'вкл' : (toggles[k] === false ? 'выкл' : String(toggles[k]))), toggles[k] === true ? 'ok' : 'grey'));
  });
  return row;
}

function a1ClientCard(cl) {
  var sub = 'файл ' + (cl.fileName || '—') + (cl.date ? ' · дата ' + cl.date : '') + (cl.generatedAt ? ' · собран ' + cl.generatedAt : '');
  var c = card('Клиент ' + cl.clientId, sub);
  if (cl.emptyReason) c.appendChild(note('warn', cl.emptyReason));
  c.appendChild(el('div', 'hintline', 'Лотов в продаже: ' + (cl.lotsOnSale === null ? 'данных нет' : fmtInt(cl.lotsOnSale))
    + ' · конкурентов: ' + cl.byCompetitor.length + ' · источников: ' + cl.bySource.length + '.'));
  c.appendChild(a1TogglesLine(cl.toggles));

  // По конкурентам: лоты и медианы ₽/м².
  c.appendChild(el('div', 'ag-group-title', 'Лоты в продаже и медианы ₽/м² по конкурентам'));
  if (cl.byCompetitor.length) {
    rowsTable(c, [['Конкурент'], ['Застройщик'], ['Лотов в продаже', 'num'], ['Мин, ₽/м²', 'num'], ['Медиана, ₽/м²', 'num'], ['Макс, ₽/м²', 'num'], ['Площадки']], cl.byCompetitor.map(function (p) {
      return [p.project, p.developer || '—', a1Val(p.lotsOnSale), a1Val(p.pricePerM2.min, 'money'), a1Val(p.pricePerM2.median, 'money'), a1Val(p.pricePerM2.max, 'money'),
        (p.sources.length ? p.sources.join(', ') : '—')];
    }));
  } else c.appendChild(a1NoData('движок не прислал блок «по конкурентам» (by_competitor)'));

  // По сайтам/источникам.
  c.appendChild(el('div', 'ag-group-title', 'Лоты и медианы по сайтам-источникам'));
  if (cl.bySource.length) {
    rowsTable(c, [['Источник'], ['Лотов в продаже', 'num'], ['Медиана, ₽/м²', 'num'], ['Мин, ₽/м²', 'num'], ['Макс, ₽/м²', 'num']], cl.bySource.map(function (s) {
      return [s.source, a1Val(s.lotsOnSale), a1Val(s.medianPricePerM2, 'money'), a1Val(s.min, 'money'), a1Val(s.max, 'money')];
    }));
  } else c.appendChild(a1NoData('движок не прислал блок «по источникам» (by_source)'));

  // Динамика к предыдущему снимку.
  c.appendChild(el('div', 'ag-group-title', 'Динамика к предыдущему снимку'));
  if (cl.dynamics.length) {
    rowsTable(c, [['Конкурент'], ['Новых лотов', 'num'], ['Ушедших лотов', 'num'], ['Δ медианы, %', 'num'], ['Период']], cl.dynamics.map(function (d) {
      return [d.project, a1Val(d.lotsNew), a1Val(d.lotsGone), a1Val(d.medianDeltaPct, 'pct'),
        ((d.periodPrev || d.periodCurr) ? ((d.periodPrev || '—') + ' → ' + (d.periodCurr || '—')) : '—')];
    }));
  } else c.appendChild(a1NoData('движок не прислал динамику (dynamics) — сравнивать нечего'));

  // Новые акции.
  c.appendChild(el('div', 'ag-group-title', 'Новые акции'));
  if (cl.promosNew.length) {
    rowsTable(c, [['Конкурент'], ['Акция'], ['Впервые']], cl.promosNew.map(function (p) {
      return [p.project, p.text, p.firstSeen || '—'];
    }));
    if (cl.promosKnownCount !== null) c.appendChild(el('div', 'hintline', 'Известных (не новых) акций, свёрнутых в счётчик: ' + fmtInt(cl.promosKnownCount) + '.'));
  } else c.appendChild(a1NoData(cl.promosKnownCount ? ('новых акций нет, известных в счётчике: ' + fmtInt(cl.promosKnownCount)) : 'движок не прислал новые акции (promos_new)'));

  // Прогноз.
  c.appendChild(el('div', 'ag-group-title', 'Прогноз'));
  if (cl.forecast && cl.forecast.length) {
    rowsTable(c, [['Конкурент'], ['Метрика'], ['Метод'], ['Точек', 'num'], ['Горизонт, нед.', 'num'], ['Прогноз']], cl.forecast.map(function (f) {
      var vals = (f.values || []).map(function (v) { return v.week + ': ' + (v.value === null ? 'данных нет' : money(v.value, true)); }).join('; ') || 'значений нет';
      var fc = el('span');
      fc.appendChild(el('span', null, vals));
      if (f.estimate) fc.appendChild(badge('оценка', 'warn'));
      return [f.project, f.metric, f.method || 'метод не указан', a1Val(f.points), a1Val(f.weeks), fc];
    }));
  } else c.appendChild(a1NoData(cl.forecastReason || 'движок не прислал прогноз'));

  // Доступность источников данных.
  if (cl.dataStatus.length) {
    c.appendChild(el('div', 'ag-group-title', 'Доступность источников данных'));
    rowsTable(c, [['Источник'], ['Статус'], ['Причина']], cl.dataStatus.map(function (s) {
      return [s.source, s.status, s.reason || '—'];
    }));
  }

  if (cl.consistency && cl.consistency.ok === false) {
    c.appendChild(note('warn', 'Связность чисел не сошлась: ' + cl.consistency.notes.join('; ') + '. Панель показывает данные движка как есть, ничего не подгоняя.'));
  }
  return c;
}

function a1EmailBlock(e) {
  var wrap = el('div');
  if (!e) { wrap.appendChild(a1NoData('блок отправки на почту не собран')); return wrap; }
  if (e.note) wrap.appendChild(el('div', 'hintline', e.note));
  if (!(e.recipients || []).length) { wrap.appendChild(a1NoData('адреса почты не заданы в delivery.addresses — получателей нет')); return wrap; }
  rowsTable(wrap, [['Получатель'], ['Статус'], ['Когда'], ['Чем подтверждено']], e.recipients.map(function (r) {
    var st = el('span');
    st.appendChild(badge(r.status, /^отправлено/i.test(String(r.status)) ? 'ok' : (/нет подтверждения|ошибк/i.test(String(r.status)) ? 'warn' : 'grey')));
    return [r.address, st, r.at ? String(r.at).replace('T', ' ').slice(0, 16) : '—', el('span', 'small muted', r.evidence || '—')];
  }));
  return wrap;
}

function competitorAnalyticsBlock() {
  var d = STATE['competitor-analytics'];
  var box = el('div', 'ca-box');
  var sec = section('Аналитика конкурентов (результаты движка Агента 1)',
    'лоты в продаже, медианы ₽/м² по конкурентам и сайтам, динамика, новые акции, прогноз и статус отправки на почту');
  if (!d) {
    var c0 = card('Данные не собраны');
    c0.appendChild(note('warn', 'Документ competitor-analytics.json не собран — нажмите «Обновить данные».'));
    sec.appendChild(c0); box.appendChild(sec);
    return box;
  }
  var withData = (d.clients || []).filter(function (c) { return c.exists && ((c.byCompetitor || []).length || (c.bySource || []).length || c.lotsOnSale !== null); });

  if (withData.length === 0) {
    var ce = card('Данных аналитики пока нет');
    ce.appendChild(note('warn', d.emptyReason || 'движок ещё не положил файлы аналитики — панель не подставляет цифры.'));
    ce.appendChild(el('div', 'hintline', 'Где панель ищет файлы: ' + d.dir + '\\<клиент>\\.cache\\analytics-<ГГГГ-ММ-ДД>.json — новейший по каждому клиенту; имена ключей согласованы с движком (WP2).'));
    (d.sources || []).forEach(function (s) {
      ce.appendChild(el('div', 'small muted', 'Проверено: ' + s.path + ' — ' + (s.exists ? (s.note || 'папка есть') : 'папки нет')));
    });
    var cee = card('Отправка на почту');
    cee.appendChild(a1EmailBlock(d.email));
    if (d.crossCheck && d.crossCheck.note) cee.appendChild(note('warn', 'Связность с профилями конкурентов: ' + d.crossCheck.note));
    ce.appendChild(cee);
    var re = el('div', 'filters');
    var be = el('button', 'btn primary small', 'Обновить данные');
    var he = el('div');
    be.addEventListener('click', function () { refreshDataNow(be, he); });
    re.appendChild(be); ce.appendChild(re); ce.appendChild(he);
    sec.appendChild(ce); box.appendChild(sec);
    return box;
  }

  withData.forEach(function (cl) { sec.appendChild(a1ClientCard(cl)); });

  var cc = card('Связность и отправка на почту');
  // task-6: здесь раньше печаталось legacy totals.competitors (сумма by_competitor) просто как
  // «конкурентов» — это путало с истинным списком. Показываем честные числа коллектора с подписью,
  // а legacy-число называем словами. Нет поля — «данных нет», не 0.
  var tt = d.totals || {};
  function tn(v) { return (v === null || v === undefined) ? 'данных нет' : fmtInt(v); }
  cc.appendChild(el('div', 'hintline', 'Итог по клиентам: лотов в продаже ' + tn(tt.lotsOnSale)
    + ' · конкурентов в анализе ' + tn(tt.competitorsInAnalysis)
    + ' · конкурентов в списках ' + tn(tt.competitorsInList)
    + ' · конкурентов с профилями ' + tn(tt.competitors)
    + ' · источников ' + tn(tt.sources) + ' · новых акций ' + tn(tt.promosNew) + '.'));
  cc.appendChild(el('div', 'hintline', '«В анализе» — записи истинного списка, доступные анализу (с сайтом или площадкой). «В списках» — всего записей в клиентских конфигах, включая те, у которых источника нет. «С профилями» — сколько конкурентов есть в профилях снимка (прежнее число панели, не истинный список).'));
  if (d.crossCheck && d.crossCheck.note) cc.appendChild(note(d.crossCheck.ok === true ? 'ok' : 'warn', 'Связность с профилями конкурентов: ' + d.crossCheck.note));
  cc.appendChild(a1EmailBlock(d.email));
  sec.appendChild(cc);
  box.appendChild(sec);
  return box;
}

/* ---------- 5. Встраивание в существующие экраны ---------- */
(function wrapAgent1Card() {
  if (typeof VIEWS === 'undefined' || !VIEWS.agentsExecutors) return;
  var orig = VIEWS.agentsExecutors;
  VIEWS.agentsExecutors = function (view) {
    orig(view);
    var card1 = view.querySelector('.switch[data-agent-id="' + A1_ID + '"]');
    if (card1) {
      var card = card1.closest ? card1.closest('.agent-card') : null;
      if (card) card.appendChild(agent1StatusBlock());
    }
  };
})();

// Подсказка про источник тумблеров и одно поле: появляется в блоке настроек Агента 1.
(function wrapAgent1SettingsHint() {
  if (typeof agentSettingsBlock !== 'function') return;
  var orig = agentSettingsBlock;
  agentSettingsBlock = function (agentId) {
    var box = orig(agentId);
    if (agentId !== A1_ID) return box;
    var rec = agSettings(A1_ID);
    if (rec && rec.agent1) {
      if (rec.agent1.analyticsPresent === false) {
        box.appendChild(note('warn', 'В файле registry/agent-settings/' + rec.fileName + ' блока agent1.analytics ещё нет — показаны значения по умолчанию (включено). Переключение тумблера создаст блок в файле.'));
      }
      if ((rec.agent1.analyticsInvalid || []).length) {
        box.appendChild(note('bad', 'В файле недопустимые значения тумблеров аналитики: ' + rec.agent1.analyticsInvalid.join(', ') + ' — показаны значения по умолчанию.'));
      }
      if ((rec.agent1.analyticsUnknown || []).length) {
        box.appendChild(note('warn', 'В agent1.analytics есть неизвестные ключи, панель их не показывает: ' + rec.agent1.analyticsUnknown.join(', ') + '.'));
      }
      box.appendChild(el('div', 'hintline', 'Тумблеры аналитики читаются из agent1.analytics того же файла и сохраняются так же, как тумблер агента: атомарно, с копией .bak-<timestamp> и откатом по SHA-256.'));
    }
    return box;
  };
})();

/* ---------- 6. Группы «Конкуренты в анализе» и «Отправка отчёта» ---------- */

// Клиенты, по которым коллектор отдал истинный список конкурентов (truth).
// Пока коллектор не прислал truth — честно пишем «данных нет», а не ноль.
function a1ClientsWithTruth() {
  var d = STATE['competitor-analytics'];
  var out = [];
  ((d && d.clients) || []).forEach(function (cl) { if (cl && cl.truth) out.push(cl); });
  return out;
}

function a1ClientIds() {
  var d = STATE['competitor-analytics'];
  var ids = [];
  ((d && d.clients) || []).forEach(function (cl) { if (cl && cl.clientId) ids.push(String(cl.clientId)); });
  if (!ids.length) ids.push('client-svet');
  return ids;
}

function a1DataMissing(text) { return el('div', 'hintline', 'данных нет: ' + text); }

// Одна строка истинного списка: имя, застройщик, класс, сайт, источник и удаление.
function a1TruthRow(cl, row) {
  var site = el('span');
  if (row.site) {
    var a = el('a', 'small', String(row.site));
    a.href = String(row.site); a.target = '_blank';
    site.appendChild(a);
  } else {
    site.appendChild(el('span', 'muted small', '—'));
  }
  var src = el('span');
  var platforms = [];
  var p = row.platforms || {};
  Object.keys(p).forEach(function (k) { if (p[k]) platforms.push(k); });
  // «Источник» = площадки или сайт застройщика. Без них запись анализу недоступна —
  // это и написано словами (контракт §5.1), а не молчание.
  var hasSource = !!(row.site || platforms.length);
  if (!hasSource) {
    src.appendChild(el('span', 'small muted', 'без источника — в анализ не попадает'));
  } else if (platforms.length) {
    src.appendChild(el('span', 'small', platforms.join(', ')));
  } else {
    src.appendChild(el('span', 'small muted', 'сайт застройщика'));
  }
  if (hasSource && row.hasSource === false) {
    src.appendChild(el('div', 'small muted', 'коллектор пометил запись как «без источника» — проверьте сайт и площадки'));
  }
  var act = el('span');
  var del = el('button', 'btn small', 'Удалить');
  del.title = 'Убрать конкурента из истинного списка: в ближайшем прогоне он в анализ не попадёт';
  del.addEventListener('click', function () {
    if (!window.confirm('Удалить «' + (row.name || row.id) + '» из истинного списка конкурентов клиента ' + cl.clientId + '?\n\nЗапись уйдёт из клиентского конфига (с копией .bak).')) return;
    del.disabled = true;
    a1CompetitorListAct({ client: cl.clientId, action: 'remove', id: row.id, name: row.name }, 'Удалено');
  });
  act.appendChild(del);
  return [row.name || row.id || '—', row.developer || '—', row.klass || '—', site, src, act];
}

function a1CompetitorListAct(body, okLabel) {
  return fetch('/api/agent1/competitor-list', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  }).then(function (r) { return r.json(); }).then(function (res) {
    if (res && res.ok) {
      toast((res.message || okLabel || 'Готово') + (res.competitorsCount !== undefined ? ' · записей в списке: ' + res.competitorsCount : '') + (res.backup ? ' · копия ' + res.backup : ''), 'ok');
      refreshDataNow();
    } else {
      toast('Не удалось: ' + ((res && res.message) || 'панель не ответила на /api/agent1/competitor-list'), 'bad');
    }
    return res;
  }).catch(function (e) {
    toast('Ошибка запроса к /api/agent1/competitor-list: ' + e.message, 'bad');
  });
}

// Ручное добавление: только с сайтом запись попадает в анализ (контракт §5.1).
function a1ManualAddForm() {
  var ids = a1ClientIds();
  var form = el('div');
  form.appendChild(el('div', 'ag-sub-title', 'Добавить конкурента вручную'));
  form.appendChild(el('div', 'hintline', 'Истинный список. Запись без сайта анализу недоступна: в панели она видна, но помечена «без источника — в анализ не попадает».'));
  var row = el('div', 'filters');
  var sel = null;
  if (ids.length > 1) {
    sel = el('select');
    ids.forEach(function (id) { var op = el('option', null, id); op.value = id; sel.appendChild(op); });
    row.appendChild(sel);
  }
  function mk(ph) { var i = el('input'); i.type = 'text'; i.placeholder = ph; return i; }
  var nIn = mk('название, например ЖК «Северный»');
  var dIn = mk('застройщик');
  var kIn = mk('класс: комфорт / бизнес / премиум');
  var sIn = mk('сайт, например https://example.ru/');
  [nIn, dIn, kIn, sIn].forEach(function (i) { i.style.flex = '1 1 160px'; row.appendChild(i); });
  var btn = el('button', 'btn primary small', 'Добавить в анализ');
  btn.addEventListener('click', function () {
    if (!String(nIn.value || '').trim()) { toast('Укажите название конкурента', 'bad'); return; }
    var client = sel ? sel.value : ids[0];
    var site = String(sIn.value || '').trim();
    if (!window.confirm('Добавить «' + nIn.value + '» в истинный список конкурентов клиента ' + client + '?'
      + (site ? '' : '\n\nВнимание: сайт не указан — запись не попадёт в анализ (в панели будет помечена «без источника»).'))) return;
    btn.disabled = true;
    a1CompetitorListAct({ client: client, action: 'add', name: String(nIn.value || '').trim(), developer: String(dIn.value || '').trim(), klass: String(kIn.value || '').trim(), site: site }, 'Добавлено')
      .then(function () { btn.disabled = false; });
  });
  row.appendChild(btn);
  form.appendChild(row);
  return form;
}

function a1CompetitorsBlock() {
  var grp = el('div', 'ag-group');
  grp.dataset.group = 'agent1.competitors';
  grp.appendChild(el('div', 'ag-group-title', 'Конкуренты в анализе'));
  grp.appendChild(el('div', 'ag-what', 'Итоговый список — истина для анализа конкурентов: он собирается из ручных записей и подтверждённых кандидатов радиуса. Живёт в клиентском конфиге 01-competitor-watch/config/clients/<client-id>.yaml; движок берёт цели только оттуда.'));
  grp.appendChild(el('div', 'hintline', 'Добавили — конкурент в анализе, удалили — он ушёл из анализа в ближайшем прогоне. Ни одно обновление данных не отправляет отчёт на почту.'));

  var withTruth = a1ClientsWithTruth();
  if (!withTruth.length) {
    var d = STATE['competitor-analytics'];
    grp.appendChild(a1DataMissing((d && d.clients && d.clients.length)
      ? 'коллектор ещё не прислал истинный список конкурентов (truth.list) — панель не подставляет вместо него ноль'
      : 'документ competitor-analytics.json не собран — нажмите «Обновить данные»'));
  }
  withTruth.forEach(function (cl) {
    var t = cl.truth || {};
    var listKnown = Array.isArray(t.list);
    var list = listKnown ? t.list : [];
    // D-CARD (task-7): рядом со списком показываем метрику движка по этому же клиенту —
    // «в анализе 19 · с данными 8 из 19». Размер списка (21) — не то же самое, что «в анализе».
    var mt = cl.metrics || {};
    var inA = (typeof mt.competitorsInAnalysis === 'number') ? mt.competitorsInAnalysis : null;
    var wData = (typeof mt.competitorsWithData === 'number') ? mt.competitorsWithData : null;
    var metricPart = (inA === null)
      ? ' · в анализе: данных нет'
      : (' · в анализе ' + fmtInt(inA) + (wData === null ? '' : ' · с данными ' + fmtInt(wData) + ' из ' + fmtInt(inA)));
    grp.appendChild(el('div', 'ag-sub-title', 'Клиент ' + cl.clientId + ' — записей: ' + (listKnown ? fmtInt(list.length) : 'данных нет')
      + (t.withoutSource !== undefined ? ', без источника: ' + fmtInt(t.withoutSource) : '') + metricPart));
    if (!listKnown) {
      grp.appendChild(el('div', 'hintline', 'Коллектор не прислал сам список (truth.list) — панель не подставляет вместо него ноль. Список появится после ближайшего сбора данных.'));
    } else if (!list.length) {
      grp.appendChild(el('div', 'hintline', 'Список пуст: добавьте конкурента вручную или подтвердите кандидатов радиуса ниже.'));
    } else {
      var tbl = el('div', 'table-wrap');
      rowsTable(tbl, [['Имя'], ['Застройщик'], ['Класс'], ['Сайт'], ['Источник'], ['']], list.map(function (row) { return a1TruthRow(cl, row); }));
      grp.appendChild(tbl);
    }
  });

  grp.appendChild(a1ManualAddForm());
  if (typeof watchCandidatesBlock === 'function') grp.appendChild(watchCandidatesBlock());
  // task-6: карта «домен → ключ проекта» — подраздел этой же группы (свёрнутый details),
  // а не отдельная группа карточки: по data-group в карточке ровно 5 контрактных групп.
  if (typeof competitorDomainsBlock === 'function') {
    var domains = competitorDomainsBlock();
    if (domains) grp.appendChild(domains);
  }
  return grp;
}

function a1SaveSetting(group, field, value, label) {
  return fetch('/api/agent-settings/set', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent: A1_ID, group: group, field: field, value: value })
  }).then(function (r) { return r.json(); }).then(function (res) {
    toast(res && res.ok ? ('Сохранено: ' + label) : ('Не удалось: ' + ((res && res.message) || 'панель не ответила')), res && res.ok ? 'ok' : 'bad');
    if (res && res.ok) refreshState();
    return res;
  }).catch(function (e) { toast('Ошибка сохранения: ' + e.message, 'bad'); });
}

function a1Switch(on, label, onChange, disabled) {
  var row = el('div', 'ag-row');
  var lab = el('div', 'ag-label');
  lab.appendChild(el('div', 'ag-name', label));
  row.appendChild(lab);
  var w = el('div', 'ag-field');
  var sw = el('button', 'switch' + (on ? ' on' : ''));
  sw.setAttribute('role', 'switch');
  sw.dataset.value = on ? '1' : '0';
  sw.appendChild(el('span', 'knob'));
  if (disabled) { sw.disabled = true; sw.title = 'Файл настроек доступен только для чтения'; }
  sw.addEventListener('click', function () {
    if (disabled) return;
    var next = sw.dataset.value !== '1';
    sw.dataset.value = next ? '1' : '0';
    sw.className = 'switch' + (next ? ' on' : '');
    onChange(next);
  });
  w.appendChild(sw);
  row.appendChild(w);
  return row;
}

function a1DeliveryBlock() {
  var grp = el('div', 'ag-group');
  grp.dataset.group = 'delivery';
  grp.appendChild(el('div', 'ag-group-title', 'Отправка отчёта'));
  var rec = agSettings(A1_ID) || {};
  var del = rec.delivery || {};
  var ro = rec.editable === false;
  var channels = Array.isArray(del.channels) ? del.channels.map(String) : [];
  var hasEmail = channels.indexOf('email') >= 0;
  var addresses = Array.isArray(del.addresses) ? del.addresses.map(String) : [];

  grp.appendChild(el('div', 'ag-what', 'Отчёт уходит только по кнопке ниже или в запланированное время. Обновление данных и сохранение настроек отчёт НЕ отправляют.'));
  grp.appendChild(a1Switch(del.auto_send === true, 'отправлять в запланированное время', function (next) {
    a1SaveSetting('delivery', 'auto_send', next, 'автоотправка ' + (next ? 'включена' : 'выключена'));
  }, ro));
  grp.appendChild(a1Switch(hasEmail, 'канал email', function (next) {
    var list = [];
    channels.forEach(function (c) { if (c !== 'email') list.push(c); });
    if (next) list.push('email');
    a1SaveSetting('delivery', 'channels', list, 'каналы: ' + (list.length ? list.join(', ') : 'нет'));
  }, ro));
  grp.appendChild(el('div', 'hintline', 'Получатели (delivery.addresses, белый список): ' + (addresses.length ? addresses.join(', ') : 'данных нет: адреса не заданы')));

  var row = el('div', 'filters');
  var send = el('button', 'btn primary small', 'Отправить отчёт на почту сейчас');
  if (ro) { send.disabled = true; send.title = 'Отправка недоступна: файл настроек только для чтения'; }
  var out = el('div');
  send.addEventListener('click', function () {
    var client = a1ClientIds()[0];
    if (!window.confirm('Отправить последний готовый отчёт на почту сейчас?\n\nПолучатели — только белый список из 00-admin/config/settings.yaml. Обновление данных и сохранение настроек отчёт не отправляют.')) return;
    send.disabled = true;
    clear(out);
    out.appendChild(note(null, 'Отправляю…'));
    fetch('/api/agent1/send-report', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client: client })
    }).then(function (r) { return r.json(); }).then(function (res) {
      send.disabled = false;
      clear(out);
      out.appendChild(note(res && res.ok ? 'ok' : 'bad', (res && res.message) || (res && res.ok ? 'Отправлено' : 'Панель не ответила на /api/agent1/send-report')));
      if (res && res.sent && res.sent.length) out.appendChild(el('div', 'hintline', 'Отправлено получателям: ' + res.sent.join(', ') + '.'));
    }).catch(function (e) {
      send.disabled = false;
      clear(out);
      out.appendChild(note('bad', 'Ошибка запроса к /api/agent1/send-report: ' + e.message));
    });
  });
  row.appendChild(send);
  grp.appendChild(row);
  grp.appendChild(out);
  return grp;
}

// Размещение: «Конкуренты в анализе» — сразу после «Охвата и радиуса»,
// «Отправка отчёта» — последней группой перед кнопками сохранения.
(function placeAgent1ExtraGroups() {
  if (typeof agentSettingsBlock !== 'function') return;
  var orig = agentSettingsBlock;
  agentSettingsBlock = function (agentId) {
    var box = orig(agentId);
    if (agentId !== A1_ID || !box || !box.querySelectorAll) return box;
    var groups = Array.prototype.slice.call(box.querySelectorAll('.ag-group'));
    var watchGrp = null;
    groups.forEach(function (n) { if (!watchGrp && n.dataset && n.dataset.group === 'agent1.watch') watchGrp = n; });
    var competitors = a1CompetitorsBlock();
    if (watchGrp) {
      var idx = groups.indexOf(watchGrp);
      var next = (idx >= 0 && groups[idx + 1]) ? groups[idx + 1] : null;
      box.insertBefore(competitors, next);
    } else {
      box.appendChild(competitors);
    }
    var actions = box.querySelector('.ag-actions');
    var delivery = a1DeliveryBlock();
    if (actions) box.insertBefore(delivery, actions);
    else box.appendChild(delivery);
    return box;
  };
})();

(function wrapAnalyticsView() {
  if (typeof VIEWS === 'undefined' || !VIEWS.analytics) return;
  var orig = VIEWS.analytics;
  VIEWS.analytics = function (view) {
    orig(view);
    view.appendChild(competitorAnalyticsBlock());
  };
})();

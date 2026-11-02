/* Блок «Отчёт Агента 1 по конкурентам»: иерархия раскрывающихся групп,
   срезы, фильтры, сортировка и единый формат метрики.
   Каталог групп приходит из коллектора (STATE['competitor-report'].catalogue) —
   поэтому новая метрика появляется в интерфейсе и в правилах полноты одновременно. */
'use strict';

var CR_OPEN_KEY = 'dsh.cr.open';
var CR_MODE_KEY = 'dsh.cr.mode';
var CR_MODES = ['competitors', 'metrics', 'sources'];
var CR_STATE = null;

// РЕЖИМ БЛОКА: по конкурентам | по метрикам | по источникам.
// Хранится в адресе (#analytics/<режим>) и в localStorage — поэтому работает назад/вперёд и перезагрузка.
function crModeFromHash() {
  var m = /^#analytics\/([a-z]+)/i.exec(String(window.location.hash || ''));
  return m && CR_MODES.indexOf(m[1]) >= 0 ? m[1] : null;
}
function crMode() {
  var fromHash = crModeFromHash();
  if (fromHash) return fromHash;
  try { var saved = window.localStorage.getItem(CR_MODE_KEY); if (saved && CR_MODES.indexOf(saved) >= 0) return saved; } catch (e) { /* ignore */ }
  return 'competitors';
}
function crSetMode(mode) {
  if (CR_MODES.indexOf(mode) < 0) return;
  try { window.localStorage.setItem(CR_MODE_KEY, mode); } catch (e) { /* ignore */ }
  var target = '#analytics/' + mode;
  if (window.location.hash !== target) window.location.hash = target;   // сработает hashchange -> renderActive
  else renderActive();
}

function crFilters() {
  if (!CR_STATE) CR_STATE = { q: '', klass: 'all', developer: 'all', radius: 'all', data: 'all', mode: 'competitors', sort: null, dir: 1 };
  return CR_STATE;
}
function crSaveOpen(open) { try { window.localStorage.setItem(CR_OPEN_KEY, JSON.stringify(open)); } catch (e) { /* ignore */ } }
function crLoadOpen() { try { return JSON.parse(window.localStorage.getItem(CR_OPEN_KEY) || '{}') || {}; } catch (e) { return {}; } }
function crAgo(iso) { if (!iso) return null; var t = Date.parse(iso); return isNaN(t) ? String(iso) : fmtAgo(t); }

// ЕДИНЫЙ ФОРМАТ МЕТРИКИ: значение · единица · источник · метод · дата · точность.
// null -> «данных нет: причина»; method=estimate -> «оценка».
function crValue(m, fmt, opts) {
  opts = opts || {};
  var w = el('span', 'cr-val');
  var tip = m ? ('Источник: ' + (m.source || 'не указан')
    + (m.method ? '\nМетод: ' + m.method : '')
    + (m.date ? '\nДата сбора: ' + m.date : '')
    + (m.accuracy ? '\nТочность: ' + m.accuracy : '')
    + (m.unit ? '\nЕдиница: ' + m.unit : '')
    + (m.comment ? '\nКомментарий движка: ' + m.comment : '')) : '';
  if (!m || ((m.value === null || m.value === undefined) && !m.text)) {
    var why = (m && m.comment) ? String(m.comment) : (opts.planned ? 'движок ещё не собирает эти метрики' : 'нет в источнике');
    var n = el('span', 'cr-nodata', 'данных нет: ' + (why.length > 96 ? why.slice(0, 96) + '…' : why));
    n.title = tip || 'данных нет';
    return n;
  }
  var text;
  if (m.text !== null && m.text !== undefined) text = m.text;
  else if (fmt === 'money') text = money(m.value, true);
  else if (fmt === 'pct') text = m.value + '%';
  else if (fmt === 'int') text = fmtInt(m.value);
  else text = String(m.value);
  if (m.estimate && !m.text) text = text + ' (оценка)';
  w.appendChild(document.createTextNode(text));
  w.title = tip;
  if (opts.withSource && (m.source || m.date)) {
    var s = el('span', 'cr-src', ' · ' + (m.source ? String(m.source).split(' (')[0] : 'источник не указан') + (m.date ? ', ' + m.date : ''));
    s.title = tip;
    w.appendChild(s);
  }
  return w;
}

function crMetricOf(profile, key) {
  if (!profile) return null;
  if (key === 'soldShareBySite') return profile.soldShareBySite;
  if (profile.metrics && profile.metrics[key]) return profile.metrics[key];
  if (profile.derived && profile.derived[key]) return profile.derived[key];
  return null;
}

function crProfiles(cl) {
  var f = crFilters();
  return cl.profiles.filter(function (p) {
    if (f.q && String(p.project).toLowerCase().indexOf(f.q.toLowerCase()) < 0) return false;
    if (f.klass !== 'all' && String(p.klass || '') !== f.klass) return false;
    // ФИЛЬТР ПО ЗАСТРОЙЩИКУ: раньше значение попадало в поле класса и ни на что не влияло.
    if (f.developer && f.developer !== 'all' && String(p.developer || '') !== f.developer) return false;
    // ФИЛЬТР ПО РАДИУСУ: обработчика у этого select вообще не было.
    if (f.radius && f.radius !== 'all') {
      if (p.distanceKm === null || p.distanceKm === undefined || p.distanceKm > Number(f.radius)) return false;
    }
    if (f.data !== 'all') {
      var keys = ['lotsInSale', 'pricePerM2Median', 'priceMinRub'];
      var has = keys.some(function (k) { var m = crMetricOf(p, k); return m && (m.value !== null || m.text); });
      if (f.data === 'with' && !has) return false;
      if (f.data === 'without' && has) return false;
    }
    return true;
  });
}

function crSortProfiles(list) {
  var f = crFilters();
  if (!f.sort) return list;
  var out = list.slice();
  out.sort(function (a, b) {
    var va, vb;
    if (f.sort === 'project') { va = a.project; vb = b.project; }
    else if (f.sort === 'klass') { va = a.klass || ''; vb = b.klass || ''; }
    else if (f.sort === 'distance') { va = a.distanceKm; vb = b.distanceKm; }
    else { var ma = crMetricOf(a, f.sort), mb = crMetricOf(b, f.sort); va = ma ? (ma.value !== null ? ma.value : (ma.text || null)) : null; vb = mb ? (mb.value !== null ? mb.value : (mb.text || null)) : null; }
    if (va === null || va === undefined) return 1;
    if (vb === null || vb === undefined) return -1;
    if (va < vb) return -1 * f.dir;
    if (va > vb) return 1 * f.dir;
    return 0;
  });
  return out;
}

function crMetricsTable(cl, g, list) {
  var byMetric = crMode() === 'metrics';
  var wrap = el('div', 'table-wrap');
  var t = el('table', 'data');
  var thead = el('thead'); var trh = el('tr');
  if (byMetric) {
    add(trh, 'th', null, 'Метрика');
    list.forEach(function (p) { add(trh, 'th', 'num', p.project); });
    thead.appendChild(trh); t.appendChild(thead);
    var tb = el('tbody');
    (g.metrics || []).forEach(function (spec) {
      var tr = el('tr');
      var nameCell = add(tr, 'td', null, spec.label + (spec.estimate ? ' · оценка' : ''));
      if (spec.note) nameCell.appendChild(el('div', 'small muted', spec.note));
      list.forEach(function (p) {
        var td = el('td', 'num');
        td.appendChild(crValue(crMetricOf(p, spec.key), spec.fmt, { planned: g.planned }));
        tr.appendChild(td);
      });
      tb.appendChild(tr);
    });
    t.appendChild(tb);
  } else {
    add(trh, 'th', null, 'Конкурент');
    (g.metrics || []).forEach(function (spec) { add(trh, 'th', 'num', spec.label); });
    thead.appendChild(trh); t.appendChild(thead);
    var tb2 = el('tbody');
    list.forEach(function (p) {
      var tr = el('tr');
      add(tr, 'td', null, p.project);
      (g.metrics || []).forEach(function (spec) {
        var td = el('td', 'num');
        td.appendChild(crValue(crMetricOf(p, spec.key), spec.fmt, { planned: g.planned }));
        tr.appendChild(td);
      });
      tb2.appendChild(tr);
    });
    t.appendChild(tb2);
  }
  wrap.appendChild(t); return wrap;
}

function crGroupBody(g, cl, list) {
  var body = el('div', 'cr-body');
  if (g.kind === 'metrics' && (g.metrics || []).length) {
    var withData = (g.metrics || []).filter(function (spec) {
      return list.some(function (p) { var m = crMetricOf(p, spec.key); return m && (m.value !== null || m.text); });
    }).length;
    body.appendChild(el('div', 'small muted', 'Метрик с данными: ' + withData + ' из ' + (g.metrics || []).length + '. Пустые показаны с причиной — не нулём.'));
    body.appendChild(crMetricsTable(cl, g, list));
    if (g.id === 'buildings') body.appendChild(el('div', 'hintline', 'Источник группы — официальный сайт застройщика, метод dom. Доля проданного считается только при обоих числах и помечена «не Росреестр».'));
    if (g.id === 'official') body.appendChild(el('div', 'hintline', 'Официальные данные не смешиваем с сайтом застройщика. Если значение приходит как 0 — это недоступность источника, а не отсутствие данных, поэтому показываем причину.'));
    if (g.id === 'promos') body.appendChild(el('div', 'hintline', 'Акции сайта застройщика и лоты с акцией на площадке — разные источники, мы их не складываем.'));
    if (g.id === 'marketing') body.appendChild(el('div', 'hintline', 'Бюджеты будут браться из отчётности публичных застройщиков с уровнем «по компании» — это не бюджет конкретного ЖК. Пока движок такие метрики не собирает, поэтому здесь «данных нет».'));
    if (g.id === 'visits') body.appendChild(el('div', 'hintline', 'Звонки, визиты и конверсия публично не публикуются. Панель не подставляет прокси-оценки: пока данных нет — так и написано.'));
  }
  if (g.kind === 'summary') {
    var k = el('div', 'grid kpi');
    k.appendChild(kpi('Конкурентов', String(cl.agg.competitors), 'в мониторинге', 'accent'));
    k.appendChild(kpi('Лотов', fmtInt(cl.agg.lotsTotal), 'сумма по конкурентам', ''));
    k.appendChild(kpi('Медиана ₽/м²', money(cl.agg.medianPerM2Summary !== null ? cl.agg.medianPerM2Summary : cl.agg.medianPerM2Market, true), 'из сводки движка', 'ok'));
    k.appendChild(kpi('Акций', String(cl.agg.promosActive), 'лотов с промо', cl.agg.promosActive ? 'warn' : 'ok'));
    k.appendChild(kpi('Риск-флагов', String(cl.agg.risks), 'по конкурентам', cl.agg.risks ? 'warn' : 'ok'));
    k.appendChild(kpi('Метрик со значением', cl.agg.metricsWithValue + ' / ' + cl.agg.metricsTotal, 'оценок: ' + cl.agg.metricsEstimate, ''));
    body.appendChild(k);
    body.appendChild(el('div', 'small muted', 'Дата прогона: ' + (cl.agg.lastRunAt ? String(cl.agg.lastRunAt).replace('T', ' ').slice(0, 16) + ' (' + (crAgo(cl.agg.lastRunAt) || '') + ')' : 'не указана') + ' · Себестоимость прогона: ' + (cl.agg.costRub === null || cl.agg.costRub === undefined ? 'данных нет: движок не передаёт себестоимость' : money(cl.agg.costRub, true))));
  }
  if (g.kind === 'table') {
    // В режиме «по метрикам» таблица конкурентов тоже переворачивается: строка = метрика.
    if (crMode() === 'metrics' && (g.metrics || []).length) {
      body.appendChild(crMetricsTable(cl, g, list));
      body.appendChild(el('div', 'hintline', 'Режим «По метрикам»: каждая строка — показатель, столбцы — конкуренты.'));
      return body;
    }
    var f = crFilters();
    var wrap = el('div', 'table-wrap');
    var t = el('table', 'data');
    var thead = el('thead'); var trh = el('tr');
    function th(label, key, num) {
      var cell = add(trh, 'th', num ? 'num' : null, label + (f.sort === key ? (f.dir > 0 ? ' ↑' : ' ↓') : ''));
      cell.style.cursor = 'pointer';
      cell.title = 'Сортировать по столбцу';
      cell.addEventListener('click', function () {
        var s = crFilters();
        // ПЕРВЫЙ клик — по УБЫВАНИЮ. Иначе для столбца, данные которого уже идут по возрастанию
        // (например «Проект» — файлы профилей отсортированы по имени), порядок визуально НЕ менялся,
        // и сортировка выглядела неработающей. Повторный клик переворачивает направление.
        if (s.sort === key) s.dir = -s.dir; else { s.sort = key; s.dir = -1; }
        renderActive();
      });
    }
    th('Проект', 'project'); th('Класс', 'klass'); th('Расстояние', 'distance', true);
    (g.metrics || []).forEach(function (spec) { th(spec.label, spec.key, true); });
    thead.appendChild(trh); t.appendChild(thead);
    var tb = el('tbody');
    crSortProfiles(list).forEach(function (p) {
      var tr = el('tr');
      add(tr, 'td', null, p.project);
      add(tr, 'td', null, p.klass || '—');
      var dtd = el('td', 'num');
      dtd.appendChild(p.distanceKm === null ? crValue(null, null, {}) : el('span', 'mono', Math.round(p.distanceKm * 10) / 10 + ' км'));
      tr.appendChild(dtd);
      (g.metrics || []).forEach(function (spec) {
        var td = el('td', 'num');
        td.appendChild(crValue(crMetricOf(p, spec.key), spec.fmt, {}));
        tr.appendChild(td);
      });
      tb.appendChild(tr);
    });
    t.appendChild(tb); wrap.appendChild(t);
    body.appendChild(wrap);
    body.appendChild(el('div', 'hintline', 'Клик по заголовку столбца — сортировка. Источник, метод, дата и точность каждой цифры — в подсказке при наведении.'));
  }
  if (g.kind === 'marketing') {
    var mstate = cl.marketing || { status: 'no_key', note: 'Ключ API не подключён: бюджет появится после подключения SpyWords/Keys.so', weeks: [] };
    // ОБЯЗАТЕЛЬНАЯ ПОДПИСЬ ЧЕСТНОСТИ
    body.appendChild(note('warn', 'Ориентировочный бюджет по данным SpyWords / Keys.so — ОЦЕНКА СЕРВИСА, не фактический расход. Это не отчётность застройщика и не наши измерения: сервис оценивает бюджет по объёму рекламы.'));
    if (mstate.demo) body.appendChild(note('bad', 'ДЕМО-ОБРАЗЕЦ: данные взяты из демонстрационного файла выгрузки, а не из вашего аккаунта SpyWords / Keys.so. Не принимайте эти суммы за реальные бюджеты конкурентов.'));
    var anyData = list.some(function (p) { return p.marketing && p.marketing.state === 'ok'; });
    if (!anyData) {
      var why = (mstate.note) || (mstate.status === 'no_key'
        ? 'Ключ API не подключён: бюджет появится после подключения SpyWords/Keys.so'
        : 'нет данных по домену в базе сервиса');
      body.appendChild(note('bad', why));
      body.appendChild(el('div', 'hintline', 'Нулей вместо отсутствия не показываем: пока данных нет, здесь честное состояние. Как только движок подключит SpyWords/Keys.so и соберёт бюджеты, таблица появится сама.'));
      body.appendChild(el('div', 'hintline', 'Ниже — таблица с теми же колонками: в каждой ячейке честно указано, почему данных нет. Нулей вместо отсутствия не показываем.'));
      var st = el('div', 'filters');
      var ob = el('button', 'btn primary small', 'Обновить данные');
      var oh = el('div');
      ob.addEventListener('click', function () { refreshDataNow(ob, oh); });
      st.appendChild(ob);
      body.appendChild(st); body.appendChild(oh);
    }
    {
      var rowsM = list.map(function (p) {
        var mk = p.marketing || {};
        var budgetCell = el('span');
        if (mk.state === 'ok') {
          budgetCell.appendChild(badge('оценка', 'warn'));
          budgetCell.appendChild(document.createTextNode(' '));
        }
        if (mk.demo) {
          var demoBadge = badge('ДЕМО-ОБРАЗЕЦ', 'bad');
          demoBadge.title = 'данные из демонстрационного файла, не из вашего аккаунта';
          budgetCell.appendChild(demoBadge);
          budgetCell.appendChild(document.createTextNode(' '));
        }
        budgetCell.appendChild(crValue(crMetricOf(p, 'marketingBudgetEstimateRub'), 'money', { withSource: false }));
        budgetCell.title = mk.caption || mk.note || '';
        var safeState = el('span');
        safeState.appendChild(badge(mk.state === 'ok' ? 'оценка сервиса' : (mk.state === 'no_key' ? 'ключ не подключён' : 'нет домена в базе'), mk.state === 'ok' ? 'warn' : 'grey'));
        safeState.title = mk.note || '';
        return [p.project, budgetCell, crValue(crMetricOf(p, 'marketingPeriod'), 'text', {}), crValue(crMetricOf(p, 'marketingAds'), 'int', {}), crValue(crMetricOf(p, 'marketingKeywords'), 'int', {}), crValue(crMetricOf(p, 'marketingLandings'), 'int', {}), crValue(crMetricOf(p, 'marketingSource'), 'text', {}), crValue(crMetricOf(p, 'marketingMethod'), 'text', {}), mk.date || '—', safeState];
      });
      rowsTable(body, [['Конкурент'], ['Бюджет за период', 'num'], ['Период'], ['Объявлений', 'num'], ['Ключевых слов', 'num'], ['Посадочных', 'num'], ['Источник'], ['Метод'], ['Дата сбора'], ['Состояние']], rowsM);
      body.appendChild(el('div', 'hintline', 'Источник: Keys.so / SpyWords (оценка сервиса). Метод сбора: api | csv | mcp. Точность указывает сервис. Бюджет — ОЦЕНКА СЕРВИСА, не фактический расход.'));
      if (mstate.weeks && mstate.weeks.length) {
        body.appendChild(el('div', 'ag-group-title', 'Динамика бюджетов по неделям (оценка сервиса)'));
        var weeksHost = el('div');
        var values = mstate.weeks.map(function (w) { return { label: w.date, m: { value: w.budgetRub !== undefined ? w.budgetRub : null, source: w.source, date: w.date, method: w.method, estimate: true, comment: null }, extra: w.source }; });
        var bars = el('div');
        values.forEach(function (vv) {
          var row = el('div', 'hb-row');
          row.appendChild(el('div', 'hb-name', vv.label));
          var track = el('div', 'hb-track');
          var fill = el('div', 'hb-fill');
          fill.style.width = (vv.m.value === null ? 2 : Math.max(2, Math.min(100, Math.round(vv.m.value / 10000 * 100)))) + '%';
          track.appendChild(fill);
          row.appendChild(track);
          var val = el('div', 'hb-val');
          val.appendChild(crValue(vv.m, 'money', {}));
          row.appendChild(val);
          bars.appendChild(row);
        });
        weeksHost.appendChild(bars);
        weeksHost.appendChild(el('div', 'hintline', 'Каждое значение — оценка сервиса по недельному срезу, не факт расхода.'));
        body.appendChild(weeksHost);
      } else {
        body.appendChild(el('div', 'small muted', 'Динамика бюджетов по неделям: данных нет — нужен минимум один недельный срез в data/clients/<id>/budgets/.'));
      }
    }
  }
  if (g.kind === 'risks') {
    var risks = [];
    list.forEach(function (p) { p.riskFlags.forEach(function (fl) { risks.push({ project: p.project, level: fl.level, text: fl.comment, code: fl.code }); }); });
    if (!risks.length) body.appendChild(el('div', 'muted small', 'Риск-флагов нет.'));
    else rowsTable(body, [['Проект'], ['Уровень'], ['Что замечено'], ['Код']], risks.map(function (r) {
      return [r.project, r.level === 'critical' ? 'критично' : (r.level === 'warning' ? 'внимание' : 'заметка'), r.text, r.code || '—'];
    }));
  }
  if (g.kind === 'sources') {
    var srcRows = [];
    list.forEach(function (p) {
      var seen = {};
      ['metrics', 'derived'].forEach(function (bucket) {
        var src = bucket === 'metrics' ? p.metrics : p.derived;
        Object.keys(src || {}).forEach(function (kk) {
          var m = src[kk];
          if (!m || !m.source) return;
          var id = m.source + '|' + (m.method || '') + '|' + (m.date || '') + '|' + (m.accuracy || '');
          if (seen[id]) return;
          seen[id] = true;
          srcRows.push([p.project, String(m.source).slice(0, 70), m.method || '—', m.date || '—', m.accuracy || '—', ((m.value === null && !m.text) ? 'не получено: ' + String(m.comment || '—').slice(0, 50) : 'ок')]);
        });
      });
    });
    if (!srcRows.length) body.appendChild(el('div', 'muted small', 'Движок не передал источники.'));
    else rowsTable(body, [['Проект'], ['Источник'], ['Метод'], ['Дата'], ['Точность'], ['Результат']], srcRows.slice(0, 60));
    if (cl.profiles[0] && cl.profiles[0].officialSources) {
      var off = cl.profiles[0].officialSources;
      body.appendChild(el('h4', null, 'Официальные источники: попытки получения'));
      if (off.attempts && off.attempts.length) {
        rowsTable(body, [['Источник'], ['Адрес'], ['HTTP'], ['Браузер']], off.attempts.map(function (a) {
          return [a.source || '—', el('code', null, String(a.url || '—')), a.http ? (a.http.status === null || a.http.status === undefined ? ('ошибка: ' + String(a.http.error || '—').slice(0, 70)) : String(a.http.status)) : '—', a.browser ? String(a.browser) : 'не пробовали'];
        }));
      }
    }
  }
  return body;
}

// КЛАССИФИКАЦИЯ ИСТОЧНИКОВ: приводим разные подписи движка к понятным группам.
function crSourceGroup(rawSource) {
  var s = String(rawSource || '').toLowerCase();
  if (!s) return { id: 'unknown', title: 'Источник не указан', what: 'метрика без источника — так быть не должно' };
  if (/keys\.so|spywords|демо-образец/.test(s)) return { id: 'keysso', title: 'Keys.so / SpyWords', what: 'ориентировочные бюджеты и объёмы рекламы конкурентов (оценка сервиса)' };
  if (/cian-connector|connector/.test(s)) return { id: 'cian-connector', title: 'cian-connector', what: 'сбор через коннектор Циан: лоты, цены, комнатность' };
  if (/cian|циан/.test(s)) return { id: 'cian', title: 'Циан (cian, http)', what: 'лоты в реализации, цены и медианы, комнатность' };
  if (/avito|авито/.test(s)) return { id: 'avito', title: 'Авито (browser)', what: 'лоты и цены с Авито' };
  if (/сайт|застройщик|dom|rg-dev|mrgroup|pik|раздел корпусов/.test(s)) return { id: 'site', title: 'Сайт застройщика', what: 'корпуса, сроки ввода, готовность, акции, ипотечные программы, шахматка' };
  if (/еисжс|наш\.дом|росреестр|дду/.test(s)) return { id: 'official', title: 'Официальные: ЕИСЖС / Росреестр', what: 'официальные корпуса, квартиры, зарегистрированные ДДУ (сейчас недоступны)' };
  if (/дом\.рф|домрф/.test(s)) return { id: 'domrf', title: 'ДОМ.РФ', what: 'аналитика рынка' };
  if (/расч|наш|estimate|индекс|мониторинг/.test(s)) return { id: 'our', title: 'Наш расчёт (оценка)', what: 'производные метрики: динамика, индексы, оценки продаж' };
  return { id: 'other', title: String(rawSource).slice(0, 60), what: 'прочие данные' };
}

// РЕЖИМ «ПО ИСТОЧНИКАМ»: группировка по источнику, а не по метрике и не по конкуренту.
function crSourcesView(cl, list) {
  var body = el('div', 'cr-body');
  var map = {};
  list.forEach(function (p) {
    ['metrics', 'derived'].forEach(function (bucket) {
      var src = bucket === 'metrics' ? p.metrics : p.derived;
      Object.keys(src || {}).forEach(function (k) {
        var m = src[k];
        if (!m) return;
        var g = crSourceGroup(m.source);
        if (!map[g.id]) map[g.id] = { title: g.title, what: g.what, metrics: {}, projects: {}, dates: {}, methods: {}, unavailable: 0, total: 0, samples: {} };
        var e = map[g.id];
        e.total++;
        if (m.value === null && !m.text) e.unavailable++;
        if (m.source) e.metrics[m.source] = true;
        e.projects[p.project] = true;
        if (m.date) e.dates[m.date] = true;
        if (m.method) e.methods[m.method] = true;
        if (m.value === null && !m.text && m.comment) e.samples[k] = String(m.comment);
      });
    });
    if (p.soldShareBySite) {
      var sg = crSourceGroup(p.soldShareBySite.source);
      if (!map[sg.id]) map[sg.id] = { title: sg.title, what: sg.what, metrics: {}, projects: {}, dates: {}, methods: {}, unavailable: 0, total: 0, samples: {} };
      map[sg.id].total++;
      map[sg.id].projects[p.project] = true;
      map[sg.id].samples.soldShareBySite = p.soldShareBySite.comment || '';
    }
  });
  var ids = Object.keys(map);
  if (!ids.length) {
    body.appendChild(el('div', 'muted small', 'данных нет: ни одной метрики с источником — проверок нечего показать'));
    return body;
  }
  body.appendChild(el('div', 'small muted', 'Сгруппировано по ИСТОЧНИКУ данных: откуда что приходит, сколько метрик, за какие даты и что недоступно. Это третий срез блока — он отличается от «по конкурентам» и «по метрикам».'));
  var rows = ids.sort().map(function (id) {
    var e = map[id];
    var un = el('span');
    if (e.unavailable) { un.appendChild(badge(e.unavailable + ' недоступно', 'warn')); un.title = Object.keys(e.samples).slice(0, 6).map(function (k) { return k + ': ' + e.samples[k]; }).join('\n'); }
    else un.appendChild(badge('все получены', 'ok'));
    var dots = el('div', 'filters');
    Object.keys(e.methods).forEach(function (mm) { dots.appendChild(badge('метод: ' + mm, 'grey')); });
    Object.keys(e.dates).forEach(function (dd) { dots.appendChild(badge('дата: ' + dd, 'grey')); });
    return [e.title, e.what, String(e.total), String(Object.keys(e.projects).length), un, dots];
  });
  rowsTable(body, [['Источник'], ['Что оттуда берём'], ['Метрик', 'num'], ['Проектов', 'num'], ['Доступность'], ['Метод и дата']], rows);
  body.appendChild(el('div', 'hintline', 'Клик по значению любой метрики в других режимах показывает источник, метод, дату и точность в подсказке. Здесь то же самое, но сгруппировано по источнику — видно, какие данные недоступны и почему.'));
  return body;
}

function crAccordion(g, cl, open, list) {
  var box = el('details', 'cr-group');
  box.open = open[g.id] === true;
  box.addEventListener('toggle', function () { var o = crLoadOpen(); o[g.id] = box.open; crSaveOpen(o); });
  var sum = el('summary', 'cr-sum');
  sum.appendChild(el('span', 'cr-sum-title', g.title));
  sum.appendChild(el('span', 'cr-sum-hint', g.hint || ''));
  if (g.planned) sum.appendChild(badge('движок ещё не собирает', 'grey'));
  if ((g.metrics || []).length) {
    var withData = (g.metrics || []).filter(function (spec) { return list.some(function (p) { var m = crMetricOf(p, spec.key); return m && (m.value !== null || m.text); }); }).length;
    sum.appendChild(badge(withData + ' из ' + g.metrics.length + ' с данными', withData ? 'ok' : 'grey'));
  }
  box.appendChild(sum);
  box.appendChild(crGroupBody(g, cl, list));
  return box;
}

function competitorBlock() {
  var d = STATE['competitor-report'];
  var box = el('div', 'cr-box');
  var sec = section('Отчёт Агента 1 по конкурентам', 'раскрывающиеся группы, срезы и единый формат метрики: значение · единица · источник · метод · дата · точность');
  var c1 = card();

  if (!d || d.profilesFound === 0) {
    c1.appendChild(note('warn', (d && d.emptyReason) ? d.emptyReason : 'Данные по конкурентам ещё не собраны.'));
    c1.appendChild(el('div', 'hintline', 'Панель не подставляет нули вместо данных: где метрики нет, будет «данных нет» с причиной.'));
    var rowE = el('div', 'filters');
    var bE = el('button', 'btn primary small', 'Обновить данные');
    var hostE = el('div');
    bE.addEventListener('click', function () { refreshDataNow(bE, hostE); });
    rowE.appendChild(bE);
    c1.appendChild(rowE); c1.appendChild(hostE);
    sec.appendChild(c1); box.appendChild(sec);
    return box;
  }

  var cl = d.clients.filter(function (c) { return c.profiles.length > 0; })[0] || d.clients[0];
  var cat = d.catalogue || { groups: [] };
  var f = crFilters();
  var list = crProfiles(cl);

  var tools = el('div', 'cr-tools');
  var mode = crMode();
  var modes = el('div', 'seg-switch');
  [['competitors', 'По конкурентам', 'Строка — конкурент, столбцы — метрики: сравнение проектов между собой'],
   ['metrics', 'По метрикам', 'Строка — метрика, столбцы — конкуренты: сравнение показателей по всем проектам'],
   ['sources', 'По источникам', 'Откуда какие данные: источник, метод, дата, точность и что недоступно']
  ].forEach(function (mo) {
    var b = el('button', 'seg-btn' + (mode === mo[0] ? ' on' : ''), mo[1]);
    b.setAttribute('data-cr-mode', mo[0]);
    b.title = mo[2];
    b.addEventListener('click', function () { crSetMode(mo[0]); });
    modes.appendChild(b);
  });
  tools.appendChild(modes);

  var fl = el('div', 'filters');
  var q = el('input'); q.type = 'text'; q.placeholder = 'Поиск по ЖК'; q.value = f.q; q.style.minWidth = '170px';
  q.addEventListener('input', function () { var s = crFilters(); s.q = this.value; renderActive(); });
  fl.appendChild(q);
  var ksel = el('select');
  var oAll = el('option', null, 'все застройщики'); oAll.value = 'all'; ksel.appendChild(oAll);
  var devs = {}; cl.profiles.forEach(function (p) { if (p.developer) devs[p.developer] = true; });
  Object.keys(devs).sort().forEach(function (k) { var o = el('option', null, k); o.value = k; if (f.developer === k) o.selected = true; ksel.appendChild(o); });
  ksel.addEventListener('change', function () { var s = crFilters(); s.developer = this.value; renderActive(); });
  fl.appendChild(ksel);
  var rsel = el('select');
  [['all', 'любой радиус'], ['5', 'до 5 км'], ['10', 'до 10 км']].forEach(function (o) { var op = el('option', null, o[1]); op.value = o[0]; if (String(f.radius) === o[0]) op.selected = true; rsel.appendChild(op); });
  rsel.addEventListener('change', function () { var s = crFilters(); s.radius = this.value; renderActive(); });
  fl.appendChild(rsel);
  var dsel = el('select');
  [['all', 'все'], ['with', 'только с данными'], ['without', 'только без данных']].forEach(function (o) { var op = el('option', null, o[1]); op.value = o[0]; if (f.data === o[0]) op.selected = true; dsel.appendChild(op); });
  dsel.addEventListener('change', function () { var s = crFilters(); s.data = this.value; renderActive(); });
  fl.appendChild(dsel);
  var expand = el('button', 'btn small', 'Раскрыть все');
  expand.addEventListener('click', function () { var o = {}; cat.groups.forEach(function (g) { o[g.id] = true; }); o['__cards'] = true; crSaveOpen(o); renderActive(); });
  fl.appendChild(expand);
  var collapse = el('button', 'btn small', 'Свернуть все');
  collapse.addEventListener('click', function () { crSaveOpen({}); renderActive(); });
  fl.appendChild(collapse);
  tools.appendChild(fl);
  tools.appendChild(el('div', 'small muted', 'Клиент: ' + cl.clientId + ' · конкурентов: ' + list.length + ' из ' + cl.profiles.length + ' · групп: ' + cat.groups.length + ' · полнота метрик: ' + (cl.agg.completeness ? (cl.agg.completeness.displayedCount + ' из ' + cl.agg.completeness.seenCount) : '—')));
  c1.appendChild(tools);
  sec.appendChild(c1);

  // РЕЖИМ «ПО ИСТОЧНИКАМ» — структурно другое содержимое: одна сводка по источникам, без аккордеона групп.
  if (mode === 'sources') {
    var sc = card('Источники данных: что откуда приходит');
    sc.appendChild(crSourcesView(cl, list));
    sec.appendChild(sc);
    box.appendChild(sec);
    return box;
  }

  var open = crLoadOpen();
  if (Object.keys(open).length === 0) open = { summary: true, competitors: true };
  // Сводка и Конкуренты — ядро блока: держим их раскрытыми ВСЕГДА, независимо от запомненного состояния.
  // Иначе таблица с сортировкой и фильтрами оказывается скрытой внутри закрытого <details>, и ни
  // пользователь, ни автотест её не видят (это и давало «нет сортируемых заголовков»).
  open.summary = true;
  open.competitors = true;
  cat.groups.forEach(function (g) { sec.appendChild(crAccordion(g, cl, open, list)); });

  var cards = el('details', 'cr-group');
  cards.open = open['__cards'] === true;
  cards.addEventListener('toggle', function () { var o = crLoadOpen(); o['__cards'] = cards.open; crSaveOpen(o); });
  var cs = el('summary', 'cr-sum');
  cs.appendChild(el('span', 'cr-sum-title', 'Карточки конкурентов'));
  cs.appendChild(el('span', 'cr-sum-hint', 'все метрики одного проекта одним списком'));
  cards.appendChild(cs);
  var cbody = el('div', 'cr-body');
  list.forEach(function (p) {
    var cc = el('details', 'cr-sub');
    var ss = el('summary', 'cr-sum');
    ss.appendChild(el('span', 'cr-sum-title', p.project));
    ss.appendChild(el('span', 'cr-sum-hint', (p.klass || 'класс не указан') + (p.distanceKm !== null ? ' · ' + (Math.round(p.distanceKm * 10) / 10) + ' км' : '') + (p.developer ? ' · ' + p.developer : '')));
    cc.appendChild(ss);
    var cb = el('div', 'cr-body');
    var all = [];
    Object.keys(p.metrics).forEach(function (kk) { all.push({ key: kk, m: p.metrics[kk] }); });
    Object.keys(p.derived).forEach(function (kk) { all.push({ key: kk, m: p.derived[kk] }); });
    if (p.soldShareBySite) all.push({ key: 'soldShareBySite', m: p.soldShareBySite });
    rowsTable(cb, [['Метрика'], ['Значение'], ['Источник'], ['Метод'], ['Дата'], ['Точность']], all.map(function (x) {
      var td = el('td');
      td.appendChild(crValue(x.m, 'num', {}));
      return [x.key, td, String(x.m.source || '—').slice(0, 60), x.m.method || '—', x.m.date || '—', x.m.accuracy || '—'];
    }));
    if (p.developerSite && p.developerSite.url) {
      var a = el('a', 'small', 'Сайт застройщика');
      a.href = p.developerSite.url; a.target = '_blank';
      cb.appendChild(a);
    }
    cc.appendChild(cb);
    cbody.appendChild(cc);
  });
  cards.appendChild(cbody);
  sec.appendChild(cards);

  box.appendChild(sec);
  return box;
}

(function wrapAnalytics() {
  var orig = VIEWS.analytics;
  if (!orig) return;
  VIEWS.analytics = function (view) {
    var banner = (typeof staleBanner === 'function') ? staleBanner() : null;
    if (banner) view.appendChild(banner);
    view.appendChild(competitorBlock());
    orig(view);
  };
})();

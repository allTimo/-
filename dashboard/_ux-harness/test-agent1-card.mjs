// Рендер-тест карточки Агента 1 без браузера (контракт v2, 04.11.2026).
//
// Зачем: ux-check.mjs требует Chrome (в песчанице не стартует). Здесь код панели
// (app-views12.js + app-views13.js + app-views15.js) исполняется в минимальном DOM
// и проверяется ровно то, что болит по контракту v2
// (docs/agent-1-rework-2026-11-04.md §3, §4, §7.4):
//   * в карточке Агента 1 РОВНО ОДИН блок «Тонкие настройки» (.ag-settings) —
//     даже если экран агентов отрисовать повторно (защита от дубля №1);
//   * ни одного ПОВТОРЯЮЩЕГОСЯ заголовка группы и ни одной повторяющейся
//     data-group внутри блока;
//   * пять групп контракта в порядке: охват → конкуренты → срез → сравнение → отправка;
//   * поля name/url из группы «Охват и радиус» НЕ рендерятся (только query);
//   * тумблеры аналитики — подраздел ОДНОЙ группы «Сравнение и выводы»,
//     отдельного заголовка «…: срезы отчёта» больше нет;
//   * истинный список конкурентов виден и «без источника — в анализ не попадает»
//     написано словами, а не молчанием (§5.1);
//   * системные группы (расписание, модель, приоритет, лимиты, источник, отчёт,
//     алерты) в карточке не рендерятся.
//
//   node marketing-agents/dashboard/_ux-harness/test-agent1-card.mjs
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DASH = path.dirname(HERE);
const PUBLIC = path.join(DASH, 'public');
const readData = (n) => JSON.parse(fs.readFileSync(path.join(PUBLIC, 'data', n), 'utf8'));

let ok = 0, fail = 0;
function check(label, cond, detail) {
  console.log('  ' + (cond ? 'OK  ' : 'FAIL') + ' ' + label + (detail ? '  (' + detail + ')' : ''));
  if (cond) ok++; else fail++;
}

/* ---------------- минимальный DOM с настоящим поиском по классам ---------------- */
function mkNode(tag) {
  const n = {
    tag: String(tag).toLowerCase(), children: [], parent: null, className: '', style: {}, dataset: {},
    attrs: {}, title: '', disabled: false, value: '', type: '', placeholder: '', min: '', max: '', step: '',
    listeners: {}, _text: '',
    appendChild(c) { if (c === null || c === undefined) return c; if (typeof c === 'string') c = mkText(c); if (c.parent) c.parent.removeChild(c); c.parent = n; n.children.push(c); return c; },
    insertBefore(c, ref) {
      if (typeof c === 'string') c = mkText(c);
      if (c.parent) c.parent.removeChild(c);
      const i = ref ? n.children.indexOf(ref) : -1;
      if (i < 0) n.children.push(c); else n.children.splice(i, 0, c);
      c.parent = n; return c;
    },
    removeChild(c) { const i = n.children.indexOf(c); if (i >= 0) n.children.splice(i, 1); return c; },
    setAttribute(k, v) { n.attrs[k] = String(v); if (k === 'data-agent-id') n.dataset.agentId = String(v); },
    getAttribute(k) { return n.attrs[k] === undefined ? null : n.attrs[k]; },
    addEventListener(k, fn) { (n.listeners[k] = n.listeners[k] || []).push(fn); },
    closest(sel) { let cur = n; while (cur) { if (matches(cur, sel)) return cur; cur = cur.parent; } return null; },
    querySelector(sel) { return n.querySelectorAll(sel)[0] || null; },
    querySelectorAll(sel) { const out = []; walk(n, (x) => { if (x !== n && matches(x, sel)) out.push(x); }); return out; },
    scrollIntoView() { },
    get firstChild() { return n.children[0] || null; },
  };
  Object.defineProperty(n, 'textContent', {
    get() { return n._text + n.children.map((c) => c.textContent).join(''); },
    set(v) { n._text = String(v); n.children = []; },
  });
  Object.defineProperty(n, 'innerText', { get() { return n.textContent; } });
  return n;
}
function mkText(t) { const n = mkNode('#text'); n._text = String(t); return n; }
function walk(node, fn) { (node.children || []).forEach((c) => { walk(c, fn); fn(c); }); }
function matches(node, sel) {
  const s = String(sel).trim();
  if (s.indexOf('[') >= 0) {
    const m = /([.#]?[\w-]*)\[data-agent-id="([^"]+)"\]/.exec(s);
    if (m) return node.dataset && node.dataset.agentId === m[2];
  }
  if (s[0] === '.') return String(node.className || '').split(/\s+/).indexOf(s.slice(1)) >= 0;
  if (s[0] === '#') return false;
  return node.tag === s.toLowerCase();
}
const byClass = (node, cls, out) => { out = out || []; if (String(node.className || '').split(/\s+/).indexOf(cls) >= 0) out.push(node); (node.children || []).forEach((c) => byClass(c, cls, out)); return out; };
const byTag = (node, tag, out) => { out = out || []; if (String(node.tag) === String(tag).toLowerCase()) out.push(node); (node.children || []).forEach((c) => byTag(c, tag, out)); return out; };
const flat = (node) => { const out = []; const rec = (x) => { if (x._text) out.push(x._text); (x.children || []).forEach(rec); }; rec(node); return out.join(' | '); };
const textsOf = (nodes) => nodes.map((n) => String(n.textContent).trim());

/* ---------------- окружение панели ---------------- */
const el = (tag, cls, text) => { const e = mkNode(tag); if (cls) e.className = cls; if (text !== undefined && text !== null) e.textContent = text; return e; };
const note = (kind, text) => el('div', 'note ' + (kind || ''), text);
const badge = (text, cls) => el('span', 'badge ' + (cls || 'grey'), text);
const card = (title, sub) => { const c = el('div', 'card'); if (title) c.appendChild(el('h3', null, title)); if (sub) c.appendChild(el('div', 'card-sub', sub)); return c; };
const section = (title, hint) => { const s = el('div', 'section'); s.appendChild(el('h2', null, title)); if (hint) s.appendChild(el('div', 'hint', hint)); return s; };
const money = (n) => (n === null || n === undefined ? '—' : String(n) + ' ₽');
const fmtInt = (n) => (n === null || n === undefined ? '—' : String(n));
function rowsTable(host, headers, rows) {
  const t = el('table', 'data');
  const thead = el('thead'); const tr = el('tr');
  headers.forEach((h) => tr.appendChild(el('th', h[1] || null, h[0])));
  thead.appendChild(tr); t.appendChild(thead);
  const tb = el('tbody');
  rows.forEach((r) => { const row = el('tr'); r.forEach((c) => { const td = el('td'); td.appendChild(typeof c === 'string' ? mkText(c) : c); row.appendChild(td); }); tb.appendChild(row); });
  t.appendChild(tb); host.appendChild(t); return t;
}

const STATE = {
  'agent-settings': readData('agent-settings.json'),
  'competitor-analytics': readData('competitor-analytics.json'),
  'agent1-status': readData('agent1-status.json'),
  candidates: readData('candidates.json'),
  projects: readData('projects.json'),
};

// Базовый экран агентов: карточка + .agent-name с id. Обёртки app-views12/13/15
// регистрируются поверх него — так проверяется вся цепочка, как в браузере.
function baseAgentsScreen(view) {
  Object.keys((STATE['agent-settings'] && STATE['agent-settings'].byAgent) || {})
    .filter((k) => k.indexOf('source') === -1)
    .forEach((id) => {
      const c = el('div', 'agent-card');
      c.appendChild(el('div', 'agent-name', id));
      view.appendChild(c);
    });
}

const ctx = {
  STATE, AG_SCHEMA: null, el, note, badge, card, section, rowsTable, money, fmtInt,
  clear: (n) => { n.children = []; n._text = ''; },
  toast: () => { }, refreshDataNow: () => { }, refreshState: () => Promise.resolve(),
  renderActive: () => { }, renderSidebar: () => { },
  agSettings: (id) => (STATE['agent-settings'].byAgent || {})[id] || null,
  VIEWS: { agentsExecutors: baseAgentsScreen }, q: () => null,
  watchCandidatesBlock: undefined,
  document: { createElement: (t) => mkNode(t), createTextNode: (t) => mkText(t), addEventListener: () => { }, querySelector: () => null, getElementById: () => null },
  window: { location: { hash: '' }, fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }), localStorage: { getItem: () => null, setItem: () => { } }, confirm: () => false },
  setTimeout: () => 0, console, JSON, Object, Array, String, Number, isFinite, Math, Date, RegExp, Promise, isNaN, parseInt, parseFloat,
};
ctx.globalThis = ctx;
vm.createContext(ctx);
// Схема строится ровно как в браузере: app-views12.js объявляет AG_SCHEMA,
// app-views13.js и app-views15.js дополняют её. Поэтому подключаем файлы по порядку.
vm.runInContext(fs.readFileSync(path.join(PUBLIC, 'app-views12.js'), 'utf8'), ctx, { filename: 'app-views12.js' });
vm.runInContext(fs.readFileSync(path.join(PUBLIC, 'app-views13.js'), 'utf8'), ctx, { filename: 'app-views13.js' });
vm.runInContext(fs.readFileSync(path.join(PUBLIC, 'app-views15.js'), 'utf8'), ctx, { filename: 'app-views15.js' });

const A1 = 'agent-1-competitor-watch';
// Контракт v2 §3: пять групп карточки Агента 1. Динамические (не в AG_SCHEMA)
// «Конкуренты в анализе» и «Отправка отчёта» добавляет app-views15.js.
const CONTRACT_GROUPS = ['agent1.watch', 'agent1.competitors', 'agent1.selection', 'agent1', 'delivery'];
const CONTRACT_TITLES = ['Охват и радиус', 'Конкуренты в анализе', 'Что анализировать', 'Сравнение и выводы', 'Отправка отчёта'];
// Системные группы контракта §3 (delivery в этом списке НЕТ: это группа 5 контракта).
const SYSTEM_GROUPS = ['schedule', 'model', 'priority', 'limits', 'source_agent', 'source_modes', 'report', 'alerts'];

/* ---------------- 1. схема: группы и поля по контракту v2 ---------------- */
const AG_SCHEMA = ctx.AG_SCHEMA;
const selGroup = AG_SCHEMA.filter((g) => g[0] === 'agent1.selection')[0];
check('группа «Что анализировать» есть в схеме панели', !!selGroup, selGroup ? selGroup[2].length + ' полей' : 'нет');
check('в группе ровно 15 полей контракта', !!selGroup && selGroup[2].length === 15, selGroup ? selGroup[2].map((f) => f[0]).join(', ') : '—');
check('у каждого поля есть подпись «что произойдёт, если изменить»',
  !!selGroup && selGroup[2].every((f) => String(f[3] || '').length > 10),
  selGroup ? String(selGroup[2].filter((f) => String(f[3] || '').length <= 10).map((f) => f[0]).join(', ') || 'подписи есть') : '—');

const a1Group = AG_SCHEMA.filter((g) => g[0] === 'agent1')[0];
check('top_deals_count добавлен в «Сравнение и выводы»', !!a1Group && a1Group[2].some((f) => f[0] === 'top_deals_count'), a1Group ? a1Group[2].map((f) => f[0]).join(', ') : '—');
// Контракт §3, группа 4: тумблеры аналитики — ПОДРАЗДЕЛ группы agent1, а не отдельная группа.
check('отдельной группы agent1.analytics в схеме карточки нет', !AG_SCHEMA.some((g) => g[0] === 'agent1.analytics'), AG_SCHEMA.map((g) => g[0]).join(', '));
const subMarkers = !!a1Group && a1Group[2].filter((f) => f[2] === 'sub');
check('в «Сравнении и выводах» ровно один подраздел «Тумблеры аналитики»',
  !!a1Group && subMarkers.length === 1 && subMarkers[0][1] === 'Тумблеры аналитики', subMarkers.map((f) => f[1]).join(', ') || 'нет');
const toggleFields = a1Group ? a1Group[2].filter((f) => f[8] === 'agent1.analytics') : [];
check('8 тумблеров аналитики встроены как поля группы agent1', toggleFields.length === 8 && toggleFields.every((f) => f[2] === 'bool'), toggleFields.map((f) => f[0]).join(', '));

const watchGroup = AG_SCHEMA.filter((g) => g[0] === 'agent1.watch')[0];
const visibleWatch = watchGroup[2].filter((f) => f[6] !== 'hidden').map((f) => f[0]);
check('поля «Охвата и радиуса» видимы, а не спрятаны',
  visibleWatch.length === watchGroup[2].length && visibleWatch.indexOf('radius_km') >= 0 && visibleWatch.indexOf('sources') >= 0 && visibleWatch.indexOf('max_candidates') >= 0,
  visibleWatch.join(', '));
check('в группе watch есть единственное поле query и нет name/url',
  visibleWatch.indexOf('query') >= 0 && visibleWatch.indexOf('name') < 0 && visibleWatch.indexOf('url') < 0,
  visibleWatch.join(', '));
check('room_types нет в группе watch', !!watchGroup && !watchGroup[2].some((f) => f[0] === 'room_types'), 'watch: ' + watchGroup[2].map((f) => f[0]).join(', '));

/* ---------------- 2. белый список и заголовки групп для карточки Агента 1 ---------------- */
const groupsForA1 = ctx.agGroupsForAgent(A1);
check('схемный белый список Агента 1 не содержит системных групп',
  groupsForA1.every((g) => CONTRACT_GROUPS.indexOf(g) >= 0) && ['agent1.watch', 'agent1.selection', 'agent1'].every((g) => groupsForA1.indexOf(g) >= 0),
  JSON.stringify(groupsForA1));
check('у остальных агентов схема не урезана', ctx.agGroupsForAgent('agent-2-direct-semantics') === null, String(ctx.agGroupsForAgent('agent-2-direct-semantics')));
check('группы переименованы по-маркетинговому',
  ctx.agGroupTitle(A1, 'agent1.watch', 'x') === 'Охват и радиус'
  && ctx.agGroupTitle(A1, 'agent1.selection', 'x') === 'Что анализировать'
  && ctx.agGroupTitle(A1, 'agent1', 'x') === 'Сравнение и выводы',
  [ctx.agGroupTitle(A1, 'agent1.watch', 'x'), ctx.agGroupTitle(A1, 'agent1.selection', 'x'), ctx.agGroupTitle(A1, 'agent1', 'x')].join(' · '));
check('подпись «Тонкие настройки» называет все пять групп контракта',
  ctx.agSummaryHint(A1, { editable: true }) === 'охват и радиус, конкуренты в анализе, что анализировать, сравнение и выводы, отправка отчёта',
  ctx.agSummaryHint(A1, { editable: true }));

/* ---------------- 3. рендер блока карточки ---------------- */
const block = ctx.agentSettingsBlock(A1);
const agSettingsInside = byClass(block, 'ag-settings');
check('в блоке карточки Агента 1 РОВНО один .ag-settings', agSettingsInside.length === 1, 'найдено: ' + agSettingsInside.length);

const groupNodes = byClass(block, 'ag-group');
const rendered = groupNodes.map((g) => (g.dataset && g.dataset.group) || '?');
const named = rendered.filter((g) => g !== '?');
check('группы считаются по data-group: пять групп контракта в порядке контракта',
  JSON.stringify(named) === JSON.stringify(CONTRACT_GROUPS), named.join(' → '));
check('ни одна data-group не повторяется', new Set(named).size === named.length, named.join(', '));
// Контракт §3: групп ровно пять, «одна на смысл». Любая лишняя .ag-group (в т.ч. без
// data-group) нарушает таблицу §3 — это проверяется отдельно от подсчёта по data-group
// (задача A1-UI-FIX переносит «Домены конкурентов» внутрь группы «Конкуренты в анализе»).
check('лишних групп сверх пяти контрактных нет (каждая .ag-group имеет контрактную data-group)',
  groupNodes.length === CONTRACT_GROUPS.length && rendered.indexOf('?') < 0,
  'всего .ag-group: ' + groupNodes.length + ', из них по data-group: ' + named.length + (rendered.indexOf('?') >= 0 ? ', без data-group: ' + rendered.filter((g) => g === '?').length : ''));
const leaked = named.filter((g) => SYSTEM_GROUPS.indexOf(g) >= 0);
check('в отрендеренной карточке нет системных групп', leaked.length === 0, leaked.length ? leaked.join(', ') : ('группы: ' + named.join(', ')));

const titles = textsOf(byClass(block, 'ag-group-title'));
const titleCount = {};
titles.forEach((t) => { titleCount[t] = (titleCount[t] || 0) + 1; });
const repeated = Object.keys(titleCount).filter((t) => titleCount[t] > 1);
check('ни одного повторяющегося заголовка группы', repeated.length === 0,
  repeated.length ? repeated.map((t) => '«' + t + '» ×' + titleCount[t]).join(', ') : titles.join(' · '));
check('пять заголовков контракта есть по одному разу',
  CONTRACT_TITLES.every((t) => titleCount[t] === 1),
  CONTRACT_TITLES.map((t) => t + ':' + (titleCount[t] || 0)).join(', '));
check('заголовка «Сравнение и выводы: срезы отчёта» больше нет', !titles.some((t) => /срезы отчёта/.test(t)), titles.join(' · '));

const names = textsOf(byClass(block, 'ag-name'));
check('поля name/url не рендерятся (нет «Название ЖК» и «Сайт»)',
  !names.some((n) => /Название ЖК/i.test(n)) && !/Название ЖК/.test(flat(block)),
  names.slice(0, 8).join(' · '));
check('подписи полей на экране читаемы (например «Радиус поиска конкурентов, км»)',
  names.some((n) => /Радиус/.test(n)) && names.some((n) => /Показатель цены/.test(n)), names.slice(0, 6).join(' · '));
check('внутри групп есть поля с текущим значением из данных',
  byClass(block, 'ag-field').length >= 25, 'полей: ' + byClass(block, 'ag-field').length);
check('кнопка «вернуть как было» есть у полей', byClass(block, 'ag-revert').length >= 25, 'кнопок: ' + byClass(block, 'ag-revert').length);
const texts = flat(block);
check('видно текущее значение «Что анализировать» из файла настроек',
  /Что анализировать/.test(texts) && /Типы квартир/.test(texts), 'группа «Что анализировать» на экране');

/* ---------------- 4. истинный список конкурентов на экране (§5.1) ---------------- */
const ca = STATE['competitor-analytics'];
const expectedRows = (ca.clients || []).reduce((a, cl) => a + (((cl.truth || {}).list) || []).length, 0);
const expectedNoSource = (ca.clients || []).reduce((a, cl) => a + (((cl.truth || {}).withoutSource) || 0), 0);
// В блоке есть и таблица кандидатов радиуса (подраздел группы «Конкуренты в анализе»),
// поэтому таблицу истинного списка узнаём по её первому заголовку «Имя».
const truthTables = byClass(block, 'table-wrap')
  .map((w) => byClass(w, 'data')[0])
  .filter((t) => t && String(((byTag(t, 'th')[0] || {}).textContent) || '') === 'Имя');
const truthTableRows = truthTables.reduce((a, t) => {
  const tb = byTag(t, 'tbody')[0];
  return a + (tb ? byTag(tb, 'tr').length : 0);
}, 0);
check('таблица истинного списка отрисована: строк ровно столько, сколько в truth.list',
  truthTables.length >= 1 && truthTableRows === expectedRows,
  'клиентов: ' + (ca.clients || []).length + ', таблиц: ' + truthTables.length + ', строк: ' + truthTableRows + ' / ожидалось ' + expectedRows);
// D-CARD (task-7): в подписи клиента рядом со списком обязана быть метрика ДВИЖКА —
// «в анализе 19 · с данными 8 из 19» — а не размер списка (21) под видом «в анализе».
const expectedSubtitles = (ca.clients || []).map((cl) => {
  const t = cl.truth || {};
  const mt = cl.metrics || {};
  const n = Array.isArray(t.list) ? t.list.length : null;
  let s = 'Клиент ' + cl.clientId + ' — записей: ' + (n === null ? 'данных нет' : fmtInt(n))
    + (t.withoutSource !== undefined ? ', без источника: ' + fmtInt(t.withoutSource) : '');
  s += (typeof mt.competitorsInAnalysis === 'number')
    ? (' · в анализе ' + fmtInt(mt.competitorsInAnalysis) + (typeof mt.competitorsWithData === 'number' ? ' · с данными ' + fmtInt(mt.competitorsWithData) + ' из ' + fmtInt(mt.competitorsInAnalysis) : ''))
    : ' · в анализе: данных нет';
  return s;
});
check('подпись каждого клиента называет размер списка И метрику движка «в анализе N»',
  expectedSubtitles.length > 0 && expectedSubtitles.every((s) => texts.indexOf(s) >= 0),
  expectedSubtitles.map((s) => s.slice(0, 78)).join(' @@ '));
const enginePerClient = (ca.clients || []).filter((cl) => cl.metrics && typeof cl.metrics.competitorsInAnalysis === 'number');
const listPerClient = (ca.clients || []).filter((cl) => cl.truth && typeof cl.truth.competitors === 'number');
check('число «в анализе» у клиента — метрика движка, а не размер его списка',
  enginePerClient.length > 0 && enginePerClient.every((cl) => cl.metrics.competitorsInAnalysis !== cl.truth.competitors
    ? texts.indexOf('· в анализе ' + fmtInt(cl.metrics.competitorsInAnalysis)) >= 0
    : true),
  enginePerClient.map((cl) => cl.clientId + ': в анализе ' + cl.metrics.competitorsInAnalysis + ' / список ' + (cl.truth ? cl.truth.competitors : '?')).join(', '));
const tableTexts = truthTables.map((t) => flat(t)).join(' | ');
check('записи «без источника» подписаны словами, а не молчанием',
  expectedNoSource > 0 && (tableTexts.match(/без источника — в анализ не попадает/g) || []).length === expectedNoSource,
  'ожидалось подписей в таблицах: ' + expectedNoSource + ', найдено: ' + (tableTexts.match(/без источника — в анализ не попадает/g) || []).length);
check('у записей истинного списка есть кнопка «Удалить»', byClass(block, 'ag-group').some((g) => g.dataset && g.dataset.group === 'agent1.competitors' && textsOf(byClass(g, 'btn')).some((t) => /Удалить/.test(t))), 'кнопки удаления внутри группы «Конкуренты в анализе»');
check('форма ручного добавления «Добавить в анализ» на месте', /Добавить в анализ/.test(texts), 'форма добавления');
check('две группы контракта, которые добавляет views15, реально вставлены',
  named.indexOf('agent1.competitors') >= 0 && named.indexOf('delivery') >= 0, named.join(' → '));
check('порядок вставки: конкуренты сразу после «Охвата», отправка — последней',
  named.join(',') === CONTRACT_GROUPS.join(','), named.join(','));
check('в группе «Конкуренты в анализе» есть подпись про динамику «добавили/удалили»',
  /Добавили — конкурент в анализе, удалили — он ушёл из анализа/.test(texts), 'подпись про динамику');
check('в группе «Отправка отчёта» есть кнопка явной отправки',
  /Отправить отчёт на почту сейчас/.test(texts), 'кнопка отправки');
check('в группе «Отправка отчёта» сказано, что обновление данных почту не шлёт',
  /Обновление данных и сохранение настроек отчёт НЕ отправляют/.test(texts), 'честная надпись про почту');

/* ---------------- 5. дубль №1: один .ag-settings на карточку при повторной отрисовке ---------------- */
const view = el('div');
ctx.VIEWS.agentsExecutors(view);
ctx.VIEWS.agentsExecutors(view);   // повторный вызов = повторная регистрация обёртки, как в дубле №1
const cardEls = byClass(view, 'agent-card');
const perCard = cardEls.map((c) => byClass(c, 'ag-settings').length);
check('карточки агентов отрисованы (экранов вызвано два, карточек >= 4)', cardEls.length >= 4, 'карточек: ' + cardEls.length);
check('на КАЖДОЙ карточке ровно один .ag-settings даже при повторной отрисовке',
  perCard.length > 0 && perCard.every((n) => n === 1), JSON.stringify(perCard));
const a1Cards = cardEls.filter((c) => /agent-1-competitor-watch/.test(String((c.querySelector('.agent-name') || {}).textContent || '')));
check('карточка Агента 1 найдена и в ней один блок настроек',
  a1Cards.length >= 1 && a1Cards.every((c) => byClass(c, 'ag-settings').length === 1), 'карточек Агента 1: ' + a1Cards.length);
const a1Titles = a1Cards.length ? textsOf(byClass(a1Cards[0], 'ag-group-title')) : [];
check('в карточке Агента 1 (через экран агентов) нет дублей заголовков',
  a1Titles.length > 0 && new Set(a1Titles).size === a1Titles.length, a1Titles.join(' · '));

/* ---------------- 6. вёрстка и кнопка «Детали» (статические проверки) ---------------- */
const css = fs.readFileSync(path.join(PUBLIC, 'styles.css'), 'utf8');
const rowRule = (css.match(/\.ag-row\s*\{[^}]*\}/) || [''])[0];
check('поля в одну колонку: label над полем (grid, метка на всю ширину)',
  /grid-template-columns/.test(rowRule) && /\.ag-label\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/.test(css),
  rowRule.replace(/\s+/g, ' ').slice(0, 80));
check('длинный текст переносится, а не выходит за края',
  /\.ag-what\s*\{[^}]*overflow-wrap:\s*anywhere/.test(css) && /\.ag-name\s*\{[^}]*overflow-wrap:\s*anywhere/.test(css), 'overflow-wrap: anywhere');
check('для мобильной ширины поля тоже в одну колонку', /@media \(max-width: 430px\)[\s\S]{0,200}\.ag-revert\s*\{[^}]*grid-column:\s*1/.test(css), 'медиа-запрос 430px');

const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
check('клик по карточке агента больше не открывает drawer',
  !/c\.classList\.add\('clickable'\)/.test(appJs) && !/c\.addEventListener\('click',\s*function\s*\(\)\s*\{\s*showAgent/.test(appJs),
  'обработчик на карточке отсутствует');
check('в карточке есть отдельная кнопка «Детали», открывающая меню',
  /var more = el\('button', 'btn small', 'Детали'\)/.test(appJs) && /more\.addEventListener\('click'/.test(appJs) && /showAgent\(a\)/.test(appJs),
  'кнопка «Детали» → showAgent');
check('openDrawer по-прежнему используется там, где меню нужно',
  (appJs.match(/openDrawer\(/g) || []).length >= 2, 'вызовов openDrawer(): ' + (appJs.match(/openDrawer\(/g) || []).length);

/* ---------------- 7. метрики карточки Агента 1 (§4): честные числа вместо задач/токенов ---------------- */
// Загружаем НАСТОЯЩИЙ app.js и вызываем его же функцию метрик — не копию логики в тесте.
let appLoadError = null;
try { vm.runInContext(fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8'), ctx, { filename: 'app.js' }); }
catch (e) { appLoadError = String(e.message); }
check('app.js загрузился в стенд (метрики карточки проверяются кодом панели)', appLoadError === null, String(appLoadError || 'ok').slice(0, 90));
if (appLoadError === null) {
  ctx.STATE = STATE;                       // app.js объявляет `var STATE = null` — возвращаем данные
  const statsToMap = (agent) => {
    const rows = ctx.a1CardStats(agent) || [];
    const m = {}; rows.forEach((r) => { m[r[0]] = r[1]; });
    return m;
  };
  const a1map = statsToMap({ id: A1 });
  const otherMap = statsToMap({ id: 'agent-2-direct-semantics' });
  check('у карточки Агента 1 четыре плитки контракта вместо задач/токенов/расхода',
    ['конкурентов в анализе', 'с данными', 'лотов проанализировано', 'самый дешёвый лот'].every((k) => a1map[k] !== undefined)
    && a1map['задач'] === undefined && a1map['токенов'] === undefined && a1map['расход'] === undefined,
    Object.keys(a1map).join(', '));
  check('у остальных агентов метрики не подменены (a1CardStats = null)', ctx.a1CardStats({ id: 'agent-2-direct-semantics' }) === null, String(otherMap && Object.keys(otherMap).length));
  const caNow = STATE['competitor-analytics'];
  let engineSum = 0, engineKnown = false, listSum = 0, listKnown = false;
  (caNow.clients || []).forEach((c) => {
    const v = c.metrics ? c.metrics.competitorsInAnalysis : null;
    if (typeof v === 'number') { engineSum += v; engineKnown = true; }
    const t = c.truth ? c.truth.competitors : null;
    if (typeof t === 'number') { listSum += t; listKnown = true; }
  });
  check('«конкурентов в анализе» = числа движка (не размер истинного списка)',
    engineKnown && a1map['конкурентов в анализе'] === fmtInt(engineSum) && (!listKnown || engineSum === listSum || a1map['конкурентов в анализе'] !== fmtInt(listSum)),
    'карточка: ' + a1map['конкурентов в анализе'] + ' · движок: ' + fmtInt(engineSum) + ' · список: ' + fmtInt(listSum));
  const digits = (s) => Number(String(s).replace(/\s|\u00a0/g, '').replace(/₽/g, '').replace(',', '.').replace(/[^\d.]/g, '')) || null;
  check('«лотов проанализировано» и «самый дешёвый лот» взяты из metrics движка',
    a1map['лотов проанализировано'] === fmtInt(caNow.totals.lotsAnalyzed) && digits(a1map['самый дешёвый лот']) === caNow.totals.cheapestLotRub,
    a1map['лотов проанализировано'] + ' · ' + a1map['самый дешёвый лот'] + ' (ожидалось ' + caNow.totals.cheapestLotRub + ')');
  check('«с данными» показано как «N из M», где M — число движка «в анализе»',
    a1map['с данными'] === fmtInt(caNow.totals.withData) + ' из ' + fmtInt(engineSum),
    a1map['с данными'] + ' (ожидалось ' + fmtInt(caNow.totals.withData) + ' из ' + fmtInt(engineSum) + ')');
  // Размер истинного списка не подставляется НИ В ОДНУ плитку: если он отличается от числа
  // движка, ни одно значение плитки не должно ему равняться.
  const tileValues = [a1map['конкурентов в анализе'], a1map['с данными'], a1map['лотов проанализировано'], a1map['самый дешёвый лот']];
  check('размер истинного списка не подставлен ни в одну плитку',
    !listKnown || engineSum === listSum || tileValues.every((v) => String(v).indexOf(fmtInt(listSum)) !== 0 || String(v) === fmtInt(engineSum)),
    'список ' + fmtInt(listSum) + ' · плитки: ' + JSON.stringify(tileValues));
  // Отдельная честная строка про список (task-7): «в списках 29, без источника 2».
  const hint = ctx.a1CardListHint({ id: A1 });
  const expectedHint = 'Истинный список конкурентов: в списках ' + fmtInt(listSum)
    + (caNow.totals.withoutSource === null || caNow.totals.withoutSource === undefined ? '' : ', без источника ' + fmtInt(caNow.totals.withoutSource));
  check('под плитками есть отдельная строка «в списках N, без источника K»',
    typeof hint === 'string' && hint.indexOf(expectedHint) === 0 && /в анализе/.test(hint),
    String(hint).slice(0, 110));
  check('строка про список не подставляет его размер в плитки (она отдельная)', hint !== null && a1map['конкурентов в анализе'] !== fmtInt(listSum) || engineSum === listSum, 'карточка ' + a1map['конкурентов в анализе'] + ' / список ' + fmtInt(listSum));
  // Плитки без метрик, но со списком: числа движка нет — «данных нет», список отдельной строкой.
  const keepCa1 = STATE['competitor-analytics'];
  const noMetricsDoc = JSON.parse(JSON.stringify(keepCa1));
  (noMetricsDoc.clients || []).forEach((c) => { c.metrics = { competitorsInAnalysis: null, competitorsWithData: null, lotsAnalyzed: null, cheapestLotRub: null }; });
  ['competitorsInAnalysis', 'withData', 'lotsAnalyzed', 'cheapestLotRub'].forEach((k) => { noMetricsDoc.totals[k] = null; });
  STATE['competitor-analytics'] = noMetricsDoc;
  const noMetMap = statsToMap({ id: A1 });
  const noMetHint = ctx.a1CardListHint({ id: A1 });
  check('метрик движка нет, а список есть -> плитки «данных нет», список остаётся отдельной строкой',
    ['конкурентов в анализе', 'с данными', 'лотов проанализировано', 'самый дешёвый лот'].every((k) => noMetMap[k] === 'данных нет')
    && typeof noMetHint === 'string' && noMetHint.indexOf('в списках ' + fmtInt(listSum)) >= 0,
    JSON.stringify(noMetMap) + ' · ' + String(noMetHint).slice(0, 60));
  STATE['competitor-analytics'] = keepCa1;
  // totals пуст, но per-client metrics есть: плитки обязаны собрать сумму метрик движка,
  // а не подставить размер списка и не показать «данных нет».
  const keepCa2 = STATE['competitor-analytics'];
  const perClientOnly = JSON.parse(JSON.stringify(keepCa2));
  ['competitorsInAnalysis', 'withData', 'lotsAnalyzed', 'cheapestLotRub'].forEach((k) => { perClientOnly.totals[k] = null; });
  STATE['competitor-analytics'] = perClientOnly;
  const pcMap = statsToMap({ id: A1 });
  check('нет totals, но есть per-client metrics -> сумма метрик движка, а не список и не «данных нет»',
    pcMap['конкурентов в анализе'] === fmtInt(engineSum) && pcMap['с данными'] === fmtInt(caNow.totals.withData) + ' из ' + fmtInt(engineSum)
    && pcMap['лотов проанализировано'] === fmtInt(caNow.totals.lotsAnalyzed)
    && !/29/.test(pcMap['конкурентов в анализе']),
    JSON.stringify(pcMap));
  // totals есть, но значение — не число (мусор из данных): не выдумываем, падаем на per-client.
  const keepCa3 = STATE['competitor-analytics'];
  const junkDoc = JSON.parse(JSON.stringify(keepCa3));
  junkDoc.totals.competitorsInAnalysis = 'двадцать семь';
  STATE['competitor-analytics'] = junkDoc;
  const junkMap = statsToMap({ id: A1 });
  check('мусор вместо числа в totals не показывается: берётся per-client метрика',
    junkMap['конкурентов в анализе'] === fmtInt(engineSum), 'карточка ' + junkMap['конкурентов в анализе'] + ' / ожидалось ' + fmtInt(engineSum));
  STATE['competitor-analytics'] = keepCa3;
  const keepCa = keepCa1;
  STATE['competitor-analytics'] = { clients: [] };
  const emptyMap = statsToMap({ id: A1 });
  check('нет данных коллектора -> все четыре плитки «данных нет», а не 0',
    ['конкурентов в анализе', 'с данными', 'лотов проанализировано', 'самый дешёвый лот'].every((k) => emptyMap[k] === 'данных нет')
    && ctx.a1CardListHint({ id: A1 }) === null,
    JSON.stringify(emptyMap));
  STATE['competitor-analytics'] = keepCa;
}

console.log('Итог: OK ' + ok + ', ПРОВАЛ ' + fail);
process.exit(fail === 0 ? 0 : 1);

// Рендер-тест панели без браузера: код app-views15.js исполняется в минимальном
// DOM-окружении на реальных данных из public/data.
//
// Зачем: ux-check.mjs требует Chrome с отладочным портом, а в песочнице агента
// Chrome не запускается. Этот тест проверяет именно КОД отрисовки: что блоки
// строятся, что пустое состояние объяснено, что цифры берутся из данных, а не
// выдумываются, и что таблицы не появляются пустыми.
//
//   node marketing-agents/dashboard/_ux-harness/test-render.mjs
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DASH = path.dirname(HERE);
const DATA = path.join(DASH, 'public', 'data');
const readData = (n) => JSON.parse(fs.readFileSync(path.join(DATA, n), 'utf8'));

let ok = 0, fail = 0;
function check(label, cond, detail) {
  console.log('  ' + (cond ? 'OK  ' : 'FAIL') + ' ' + label + (detail ? '  (' + detail + ')' : ''));
  if (cond) ok++; else fail++;
}

/* ---------------- минимальный DOM ---------------- */
function mkNode(tag) {
  const n = {
    tag: String(tag).toLowerCase(), children: [], className: '', style: {}, dataset: {}, attrs: {},
    title: '', disabled: false, value: '', type: '', placeholder: '', listeners: {}, _text: '',
    appendChild(c) { if (c === null || c === undefined) return c; if (typeof c === 'string') c = mkText(c); c.parent = n; n.children.push(c); return c; },
    removeChild(c) { const i = n.children.indexOf(c); if (i >= 0) n.children.splice(i, 1); return c; },
    setAttribute(k, v) { n.attrs[k] = String(v); },
    getAttribute(k) { return n.attrs[k] === undefined ? null : n.attrs[k]; },
    addEventListener(k, fn) { (n.listeners[k] = n.listeners[k] || []).push(fn); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
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

const texts = (node, out) => {
  out = out || [];
  if (node._text) out.push(node._text);
  (node.children || []).forEach((c) => texts(c, out));
  return out;
};
const flat = (node) => texts(node).join(' | ');
const byClass = (node, cls, out) => {
  out = out || [];
  if (String(node.className || '').split(/\s+/).indexOf(cls) >= 0) out.push(node);
  (node.children || []).forEach((c) => byClass(c, cls, out));
  return out;
};

/* ---------------- окружение панели ---------------- */
function el(tag, cls, text) {
  const e = mkNode(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
}
const note = (kind, text) => el('div', 'note ' + (kind || ''), text);
const badge = (text, cls) => el('span', 'badge ' + (cls || 'grey'), text);
const card = (title, sub) => { const c = el('div', 'card'); if (title) c.appendChild(el('h3', null, title)); if (sub) c.appendChild(el('div', 'card-sub', sub)); return c; };
const section = (title, hint) => { const s = el('div', 'section'); s.appendChild(el('h2', null, title)); if (hint) s.appendChild(el('div', 'hint', hint)); return s; };
const money = (n) => (n === null || n === undefined ? '—' : String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' ₽');
const fmtInt = (n) => (n === null || n === undefined ? '—' : String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' '));
function rowsTable(host, headers, rows) {
  const t = el('table', 'data');
  const thead = el('thead'); const tr = el('tr');
  headers.forEach((h) => tr.appendChild(el('th', h[1] || null, h[0])));
  thead.appendChild(tr); t.appendChild(thead);
  const tb = el('tbody');
  rows.forEach((r) => { const row = el('tr'); r.forEach((c) => { const td = el('td'); td.appendChild(typeof c === 'string' ? mkText(c) : c); row.appendChild(td); }); tb.appendChild(row); });
  t.appendChild(tb); host.appendChild(t);
  return t;
}

const STATE = {
  'competitor-analytics': readData('competitor-analytics.json'),
  'agent1-status': readData('agent1-status.json'),
  'agent-settings': readData('agent-settings.json'),
  projects: readData('projects.json'),
};

const AG_SCHEMA = [
  ['agent1', 'Специфика Агента 1', [['min_lots', 'Минимум лотов', 'int', 'x'], ['top_deals_count', 'Лотов в топах', 'int', 'x']]],
  ['agent1.watch', 'ЖК для наблюдения', [
    ['name', 'Название ЖК', 'str', 'x'], ['address', 'Адрес', 'str', 'x'], ['radius_km', 'Радиус', 'num', 'x'],
    ['sources', 'Источники поиска', 'list', 'x'], ['max_candidates', 'Максимум кандидатов', 'int', 'x'],
  ]],
  ['agent1.selection', 'Что анализировать', [
    ['room_types', 'Типы квартир', 'list', 'x'], ['area_min_m2', 'Площадь от', 'num', 'x'], ['area_max_m2', 'Площадь до', 'num', 'x'],
    ['price_min_rub', 'Цена от', 'int', 'x'], ['price_max_rub', 'Цена до', 'int', 'x'], ['exclude_first_floor', 'Первый этаж', 'bool', 'x'],
    ['exclude_last_floor', 'Последний этаж', 'bool', 'x'], ['finishes', 'Отделка', 'list', 'x'], ['only_active', 'В продаже', 'bool', 'x'],
    ['promo_only', 'Только с акцией', 'bool', 'x'], ['price_metric', 'Показатель цены', 'enum', 'x'], ['outlier_guard', 'Аномалии', 'bool', 'x'],
    ['outlier_same_price_min_lots', 'Порог цены', 'int', 'x'], ['outlier_ppm2_min', 'Цена от ₽/м²', 'int', 'x'], ['outlier_ppm2_max', 'Цена до ₽/м²', 'int', 'x'],
  ]],
];
const ctx = {
  STATE, AG_SCHEMA, el, note, badge, card, section, rowsTable, money, fmtInt,
  clear: (n) => { n.children = []; n._text = ''; },
  toast: () => { }, refreshDataNow: () => { },
  agSettings: (id) => (STATE['agent-settings'].byAgent || {})[id] || null,
  agDefaultsOf: () => undefined,
  agentSettingsBlock: function (agentId) { return el('details', 'ag-settings'); },
  VIEWS: { agentsExecutors: function () { }, analytics: function () { } },
  window: { location: { hash: '' }, fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }) },
  document: { createElement: (t) => mkNode(t), createTextNode: (t) => mkText(t) },
  setTimeout: () => 0, console, JSON, Object, Array, String, Number, isFinite, Math, Date, RegExp, Promise,
};
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(DASH, 'public', 'app-views15.js'), 'utf8'), ctx, { filename: 'app-views15.js' });

/* ---------------- 1. схема настроек (контракт v2) ---------------- */
// Контракт v2 §3: «Сравнение и выводы» — ОДНА группа agent1; тумблеры аналитики
// (agent1.analytics) встроены в неё подразделом, отдельной группы быть не должно.
const anGroup = AG_SCHEMA.filter((g) => g[0] === 'agent1.analytics')[0];
check('отдельной группы agent1.analytics в схеме нет', !anGroup, anGroup ? anGroup[2].length + ' тумблеров отдельной группой' : 'группы нет');
const a1 = AG_SCHEMA.filter((g) => g[0] === 'agent1')[0];
const toggles = a1 ? a1[2].filter((f) => f[8] === 'agent1.analytics') : [];
check('8 тумблеров аналитики встроены в «Сравнение и выводы»', toggles.length === 8, toggles.map((f) => f[0]).join(', '));
check('все тумблеры — bool', toggles.length === 8 && toggles.every((f) => f[2] === 'bool'), toggles.map((f) => f[2]).join(', '));
check('подраздел «Тумблеры аналитики» объявлен один раз', !!a1 && a1[2].filter((f) => f[2] === 'sub' && f[1] === 'Тумблеры аналитики').length === 1, 'подраздел');
const watchGroup = AG_SCHEMA.filter((g) => g[0] === 'agent1.watch')[0];
const visible = watchGroup[2].filter((f) => f[6] !== 'hidden').map((f) => f[0]);
// Контракт: в карточке Агента 1 группа «Охват и радиус» показывает ВСЕ маркетинговые
// поля (query + адрес, радиус, класс, цены, источники, кандидаты) — они правимы.
check('в группе ЖК видно поле query и маркетинговые параметры',
  visible.indexOf('query') >= 0 && visible.indexOf('radius_km') >= 0 && visible.indexOf('sources') >= 0 && visible.length === watchGroup[2].length,
  visible.join(', '));
// Дубль №2 контракта v2: name/url из карточки убраны (остаются в YAML), поэтому
// патч views15 обязан выкинуть их из схемы, даже если объявление их ещё содержит.
check('поля name/url из карточки убраны, хотя были в схеме',
  visible.indexOf('name') < 0 && visible.indexOf('url') < 0, visible.join(', '));
check('параметры ЖК не удалены из схемы и не помечены hidden',
  watchGroup[2].every((f) => f[6] !== 'hidden') && watchGroup[2].some((f) => f[0] === 'max_candidates'),
  'полей: ' + watchGroup[2].length);
check('группа ЖК названа по контракту «Охват и радиус»', watchGroup[1] === 'Охват и радиус', String(watchGroup[1]));
const selGroup15 = AG_SCHEMA.filter((g) => g[0] === 'agent1.selection')[0];
check('группа «Что анализировать» объявлена схемой (15 полей контракта)',
  !!selGroup15 && selGroup15[2].length === 15, selGroup15 ? selGroup15[2].length + ' полей' : 'нет группы');

/* ---------------- 2. индикатор прогона на реальных данных ---------------- */
const realStatus = STATE['agent1-status'];
const statusNode = ctx.agent1StatusBlock();
const statusText = flat(statusNode);
check('индикатор строится без ошибок', statusText.length > 20, statusText.slice(0, 90));
check('в индикаторе есть вердикт из данных', statusText.indexOf(realStatus.verdict) >= 0, realStatus.verdict);
check('в индикаторе есть дата снимка, время прогона, результат и источник',
  statusText.indexOf('Дата снимка') >= 0 && statusText.indexOf('Время прогона') >= 0 && statusText.indexOf('Результат') >= 0 && statusText.indexOf('Источник данных') >= 0,
  String(realStatus.evidence.map((e) => e.label).join(', ')));
check('в индикаторе есть число прогонов', statusText.indexOf('Прогонов Агента 1') >= 0, 'прогонов ' + realStatus.runs.total);

// состояние «ещё не запускался»: причина обязана быть на экране
const keep = STATE['agent1-status'];
STATE['agent1-status'] = {
  agent: 'agent-1-competitor-watch', state: 'never', done: false, verdict: 'Ещё не запускался',
  reason: 'В registry/runs.jsonl нет ни одной записи по Агенту 1 — прогон не журналировался.',
  runs: { total: 0, ok: 0, failed: 0, last: null, lastOk: null }, results: { last: null },
  snapshots: { count: 0 }, evidence: [], sources: [{ path: 'registry/runs.jsonl', exists: false }, { path: 'registry/results.yaml', exists: true }],
};
const neverText = flat(ctx.agent1StatusBlock());
check('«ещё не запускался» показано с причиной', neverText.indexOf('Ещё не запускался') >= 0 && neverText.indexOf('прогон не журналировался') >= 0, neverText.slice(0, 80));
check('в пустом состоянии перечислены проверенные источники', neverText.indexOf('Проверенные источники') >= 0, 'да');
STATE['agent1-status'] = keep;

/* ---------------- 3. раздел «Аналитика»: пустое состояние ---------------- */
const realAnalytics = STATE['competitor-analytics'];
const emptyDoc = {
  dir: 'C:\\x\\01-competitor-watch\\reports\\clients',
  clients: [{ clientId: 'client-svet', exists: false, emptyReason: 'Файлов аналитики нет' }, { clientId: 'client-granel', exists: false, emptyReason: 'Файлов аналитики нет' }],
  totals: { clients: 2, clientsWithData: 0, lotsOnSale: null, competitors: 0, sources: 0, promosNew: 0, forecasts: 0 },
  emptyReason: 'Файлы аналитики движка не найдены: проверено 2 клиент(ов) в reports/clients/*/.cache (ожидается analytics-<ГГГГ-ММ-ДД>.json).',
  crossCheck: { ok: null, note: 'Сравнение с профилями конкурентов не выполняется: данных аналитики от движка ещё нет.' },
  email: { channelEnabled: true, addresses: ['tyurina@d-a.ru', 'vodnev@d-a.ru'], recipients: [
    { address: 'tyurina@d-a.ru', status: 'нет подтверждения отправки', at: null, evidence: 'нет подтверждения отправки: записи нет' },
    { address: 'vodnev@d-a.ru', status: 'нет подтверждения отправки', at: null, evidence: 'нет подтверждения отправки: записи нет' }], note: 'Статус берётся из файла аналитики движка.' },
  sources: [{ id: 'analytics-cache', path: '...\\clients\\*\\.cache\\analytics-<дата>.json', exists: true, note: 'файлов аналитики движка ещё нет' }],
};
STATE['competitor-analytics'] = emptyDoc;
const emptyNode = ctx.competitorAnalyticsBlock();
const emptyText = flat(emptyNode);
check('раздел «Аналитика» строится без ошибок', emptyText.length > 40, emptyText.slice(0, 80));
check('пустое состояние объяснено причиной', emptyText.indexOf('Файлы аналитики движка не найдены') >= 0, 'причина на экране');
check('пустое состояние не показывает выдуманных цифр', !/₽\/м²\s*\|/.test(emptyText) && emptyText.indexOf('0 ₽') < 0, 'нет подставленных чисел');
check('в пустом состоянии видно, где искать файлы', emptyText.indexOf('analytics-<ГГГГ-ММ-ДД>.json') >= 0, 'путь подсказан');
check('в пустом состоянии есть статус почты по каждому получателю',
  emptyText.indexOf('tyurina@d-a.ru') >= 0 && emptyText.indexOf('vodnev@d-a.ru') >= 0 && (emptyText.match(/нет подтверждения отправки/g) || []).length >= 2,
  'получателей: ' + emptyDoc.email.recipients.length);
check('в пустом состоянии таблиц без строк нет', byClass(emptyNode, 'data').every((t) => (t.children.filter((c) => c.tag === 'tbody')[0].children || []).length > 0), 'таблицы только с данными');

/* ---------------- 4. раздел «Аналитика»: реальные данные ---------------- */
STATE['competitor-analytics'] = realAnalytics;
const dataNode = ctx.competitorAnalyticsBlock();
const dataText = flat(dataNode);
const tables = byClass(dataNode, 'data');
check('раздел «Аналитика» рисуется на собранных данных', tables.length >= 1, 'таблиц: ' + tables.length);
check('таблицы не пустые', tables.every((t) => (t.children.filter((c) => c.tag === 'tbody')[0].children || []).length > 0), 'все таблицы с строками');
check('виден заголовок раздела и источник файла', dataText.indexOf('Аналитика конкурентов') >= 0, dataText.slice(0, 70));
check('итог по лотам не выдуман: либо число из данных, либо причина пустоты',
  realAnalytics.totals.lotsOnSale === null
    ? dataText.indexOf(String(realAnalytics.emptyReason).slice(0, 40)) >= 0
    : dataText.indexOf(fmtInt(realAnalytics.totals.lotsOnSale)) >= 0,
  'lotsOnSale=' + realAnalytics.totals.lotsOnSale);
check('статус почты по получателям показан и на данных', dataText.indexOf('tyurina@d-a.ru') >= 0 || (realAnalytics.email.addresses || []).length === 0, (realAnalytics.email.addresses || []).join(', '));
check('несходящиеся числа объясняются, а не прячутся',
  (realAnalytics.crossCheck.ok !== false) || dataText.indexOf('Связность') >= 0, String(realAnalytics.crossCheck.note || '').slice(0, 60));

/* ---------------- 5. итог по клиентам: три разных числа названы по-разному (task-6) ---------------- */
const tn = (v) => (v === null || v === undefined ? 'данных нет' : fmtInt(v));
const rt = realAnalytics.totals;
check('итог называет «конкурентов в анализе» числом коллектора (не legacy)',
  dataText.indexOf('конкурентов в анализе ' + tn(rt.competitorsInAnalysis)) >= 0,
  'ожидалось ' + tn(rt.competitorsInAnalysis));
check('итог называет «конкурентов в списках» отдельно от «в анализе»',
  dataText.indexOf('конкурентов в списках ' + tn(rt.competitorsInList)) >= 0,
  'ожидалось ' + tn(rt.competitorsInList));
check('legacy-число подписано «конкурентов с профилями», а не просто «конкурентов»',
  dataText.indexOf('конкурентов с профилями ' + tn(rt.competitors)) >= 0 && !/· конкурентов \d/.test(dataText),
  'с профилями ' + tn(rt.competitors));
check('число «в анализе» не подменено числом «в списках» (разные ключи)',
  rt.competitorsInAnalysis === null || rt.competitorsInList === null
    || tn(rt.competitorsInAnalysis) !== tn(rt.competitorsInList)
    || rt.competitorsInAnalysis === rt.competitorsInList,
  'в анализе ' + tn(rt.competitorsInAnalysis) + ' · в списках ' + tn(rt.competitorsInList) + ' · с профилями ' + tn(rt.competitors));
// Честность: если коллектор не отдал число — в интерфейсе «данных нет», а не 0.
const keepTotals = STATE['competitor-analytics'].totals;
STATE['competitor-analytics'] = Object.assign({}, realAnalytics, { totals: Object.assign({}, rt, { competitorsInAnalysis: null, competitorsInList: null }) });
const nullText = flat(ctx.competitorAnalyticsBlock());
check('нет числа «в анализе»/«в списках» -> «данных нет», а не 0',
  nullText.indexOf('конкурентов в анализе данных нет') >= 0 && nullText.indexOf('конкурентов в списках данных нет') >= 0,
  'пустые числа подписаны словами');
STATE['competitor-analytics'] = Object.assign({}, realAnalytics, { totals: keepTotals });

console.log('Итог: OK ' + ok + ', ПРОВАЛ ' + fail);
process.exit(fail === 0 ? 0 : 1);

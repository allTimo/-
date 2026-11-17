// Проверка подхвата файлов аналитики движка (WP2) и истинного списка конкурентов
// (контракт v2 §5.1/§5.3) — БЕЗ записи в 01-competitor-watch (зона движка).
//
//   node marketing-agents/dashboard/_ux-harness/test-analytics-pickup.mjs
//
// Что проверяем:
//   1) пустое состояние честное: причина есть, цифр нет (null, а не 0);
//   2) файл analytics-<дата>.json подхватывается: лоты, медианы, динамика, новые акции, прогноз;
//   3) из двух дат берётся новейшая;
//   4) прогноз без метода/точек считается несвязным (валидатор это ловит);
//   5) статус отправки на почту берётся из email[] файла движка;
//   6) битый JSON не роняет сборщик: предупреждение + пустое состояние с причиной;
//   7) связность с профилями конкурентов считается по проектам;
//   8) ИСТИНА (v2): truth.list строится только из копии клиентского конфига;
//      metrics.competitorsInAnalysis берётся у движка, а без аналитики считается
//      как «список минус записи без источника» (не ноль и не весь список);
//   9) границы: пустой список, битый отступ, чужой клиент (нет конфига),
//      расхождение «с данными» больше списка.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, 'tmp', 'cw-reports');
const CLIENTS = path.join(HERE, 'tmp', 'cw-clients');

let ok = 0, fail = 0;
function check(label, cond, detail) {
  console.log('  ' + (cond ? 'OK  ' : 'FAIL') + ' ' + label + (detail ? '  (' + detail + ')' : ''));
  if (cond) ok++; else fail++;
}
function clean(p) { fs.rmSync(p, { recursive: true, force: true }); }
function write(file, obj) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 1), 'utf8'); }

// --- копии клиентских конфигов (истина конкурентов, §5.1). Реальные НЕ трогаем. ---
const svetYaml = [
  'client_id: client-svet',
  'name: "Свет"',
  'competitors:',
  '  - { id: seliger, name: "Селигер Сити", developer: "MR Group", class: "бизнес", site: "https://a.example", platforms: { cian: "https://cian.example/a", avito: "", yandex_realty: "", domclick: "" }, source: "вручную", added: "2026-11-04" }',
  '  - { id: very, name: "Very", developer: "ГК Основа", class: "", site: "", platforms: { cian: "https://cian.example/very", avito: "", yandex_realty: "", domclick: "" } }',
  '  - { id: nosource, name: "ЖК Без источника", developer: "X", class: "", site: "", platforms: { cian: "", avito: "", yandex_realty: "", domclick: "" } }',
  '  - { id: zhk-a, name: "zhk-a", developer: "Застройщик А", class: "", site: "https://zhk-a.example", platforms: {} }',
  '',
].join('\n');
const brokenYaml = [
  'client_id: client-broken',
  'competitors:',
  '  - { name: "Нормальный", site: "https://ok.example" }',
  '    - { name: "Вложенный", site: "https://bad.example" }',
  '',
].join('\n');
const emptyYaml = ['client_id: client-empty', 'name: "Пустой"', 'competitors: []', ''].join('\n');

const AGENT_SETTINGS = { byAgent: { 'agent-1-competitor-watch': { delivery: { channels: ['telegram', 'email'], addresses: ['@svet_marketing', 'tyurina@d-a.ru', 'vodnev@d-a.ru'] } } } };
const SERVICE_RESULTS = [
  { id: 'res-old', sentChannel: 'email', sentTo: 'tyurina@d-a.ru', sentStatus: 'ожидает', sentAt: null, created: '2026-10-30T10:12:00+03:00', artifacts: [] },
];
const COMPETITOR_REPORT = {
  profilesFound: 2,
  clients: [{ clientId: 'client-svet', profiles: [
    { project: 'Селигер Сити', metrics: { lotsInSale: { value: 10 } } },
    { project: 'Very', metrics: { lotsInSale: { value: 5 } } },
  ] }],
};

const ENGINE = {
  schema_version: 1,
  date: '2026-11-03',
  generated_at: '2026-11-03T11:20:00+03:00',
  client_id: 'client-svet',
  toggles: { enabled: true, lots_all_on_sale: true, price_dynamics: true, promos: true, new_promos_only: true, dedup_promos: true, developers_sites: true, forecast: true },
  // §5.3: число «конкурентов в анализе» обязано приходить от движка.
  metrics: { competitorsInAnalysis: 2, competitorsWithData: 2, lotsAnalyzed: 15, cheapestLotRub: 12_000_000 },
  by_competitor: [
    { project: 'Селигер Сити', developer: 'MR Group', lots_on_sale: 10, price_per_m2: { min: 300000, median: 350000, max: 420000 }, sources: ['cian', 'avito'] },
    { project: 'Very', developer: 'ГК Основа', lots_on_sale: 5, price_per_m2: { min: 280000, median: 310000, max: 360000 }, sources: ['cian'] },
  ],
  by_source: [
    { source: 'cian', lots_on_sale: 11, median_price_per_m2: 340000, min: 280000, max: 420000 },
    { source: 'avito', lots_on_sale: 4, median_price_per_m2: 330000, min: 300000, max: 400000 },
  ],
  dynamics: [{ project: 'Селигер Сити', lots_new: 2, lots_gone: 1, median_delta_pct: 1.5, period: { prev: '2026-10-27', curr: '2026-11-03' } }],
  promos_new: [{ project: 'Селигер Сити', text: 'Скидка 5% на 2-комнатные', first_seen: '2026-11-03' }],
  promos_known_count: 4,
  forecast: [{ project: 'Селигер Сити', metric: 'median_price_per_m2', method: 'trend-linear', points: 4, weeks: 2, values: [{ week: '2026-11-10', value: 355000 }, { week: '2026-11-17', value: 360000 }], estimate: true }],
  email: [{ to: 'tyurina@d-a.ru', status: 'отправлено', sent_at: '2026-11-03T11:25:00+03:00', file: '2026-11-03-competitor-watch.xlsx' }],
  data_status: [{ source: 'domclick', status: 'недоступен', reason: '401 без логина' }],
};

// --- подготовка каталогов под тест (никаких реальных конфигов) ---
clean(ROOT);
clean(CLIENTS);
fs.mkdirSync(path.join(ROOT, 'client-svet'), { recursive: true });
fs.mkdirSync(CLIENTS, { recursive: true });
write(path.join(CLIENTS, 'client-svet.yaml'), svetYaml);
process.env.DASHBOARD_CW_CLIENTS_REPORTS_DIR = ROOT;
process.env.DASHBOARD_CW_CLIENTS_DIR = CLIENTS;
const { loadCompetitorAnalytics } = await import('../collector/lib/competitor-analytics.mjs');

const byId = (doc, id) => doc.clients.filter((c) => c.clientId === id)[0] || null;

// ---- 1. пустое состояние: конфиг есть, аналитики нет ----
let doc = loadCompetitorAnalytics({ agentSettings: AGENT_SETTINGS, competitorReport: COMPETITOR_REPORT, serviceResults: SERVICE_RESULTS });
check('нет файлов — есть причина, а не пустота', doc.totals.clientsWithData === 0 && !!doc.emptyReason, String(doc.emptyReason).slice(0, 80));
check('нет файлов — цифры не выдуманы (null, не 0)', doc.totals.lotsOnSale === null && doc.totals.competitors === 0, 'lotsOnSale=' + doc.totals.lotsOnSale);
check('нет файлов — статус почты по каждому получателю всё равно есть',
  doc.email.recipients.length === 2 && doc.email.recipients.every((r) => !!r.status), doc.email.recipients.map((r) => r.address + '=' + r.status).join(', '));
check('нет файлов — связность объяснена, а не пустая', !!doc.crossCheck.note, String(doc.crossCheck.note).slice(0, 70));
// §5.3: истина читается из конфига независимо от файлов аналитики.
let svet = byId(doc, 'client-svet');
check('клиент с конфигом виден, даже если аналитики нет', !!svet && svet.truth.exists === true, svet ? svet.truth.fileName : 'нет');
check('truth.list = ровно записи competitors[] копии конфига (4), withoutSource=1',
  !!svet && svet.truth.competitors === 4 && svet.truth.withoutSource === 1, svet ? JSON.stringify({ competitors: svet.truth.competitors, withoutSource: svet.truth.withoutSource, list: svet.truth.list.length }) : '—');
check('запись без site и площадок помечена hasSource=false, с сайтом — true',
  !!svet && svet.truth.list.filter((r) => r.name === 'ЖК Без источника')[0].hasSource === false
  && svet.truth.list.filter((r) => r.name === 'Селигер Сити')[0].hasSource === true,
  svet ? svet.truth.list.map((r) => r.name + ':' + r.hasSource).join(', ') : '—');
check('без аналитики «конкурентов в анализе» = список минус без источника (3), а не 4 и не 0',
  !!svet && svet.metrics.competitorsInAnalysis === 3, svet ? String(svet.metrics.competitorsInAnalysis) : '—');
check('без аналитики источник числа назван словами',
  !!svet && /истинный список 4 минус записи без источника 1 = 3/.test(String(svet.metrics.competitorsInAnalysisSource)), svet ? String(svet.metrics.competitorsInAnalysisSource) : '—');
check('без аналитики «с данными» — null (неизвестно), а не 0',
  !!svet && svet.metrics.competitorsWithData === null && !!svet.truth.withDataReason, svet ? String(svet.truth.withData) + ' / ' + String(svet.truth.withDataReason).slice(0, 50) : '—');
check('без аналитики лоты и дешёвый лот — null, не 0',
  !!svet && svet.metrics.lotsAnalyzed === null && svet.metrics.cheapestLotRub === null, svet ? JSON.stringify(svet.metrics) : '—');

// ---- 2. подхват файла движка + метрики от движка ----
write(path.join(ROOT, 'client-svet', '.cache', 'analytics-2026-11-03.json'), ENGINE);
doc = loadCompetitorAnalytics({ agentSettings: AGENT_SETTINGS, competitorReport: COMPETITOR_REPORT, serviceResults: SERVICE_RESULTS });
svet = byId(doc, 'client-svet');
check('файл движка подхвачен', doc.totals.clientsWithData === 1 && svet.exists === true, 'клиентов с данными: ' + doc.totals.clientsWithData + ', файл ' + svet.fileName);
check('лоты в продаже посчитаны', doc.totals.lotsOnSale === 15 && svet.lotsOnSale === 15, 'итог ' + doc.totals.lotsOnSale);
check('медианы ₽/м² по конкурентам прочитаны', svet.medians.byCompetitor.length === 2 && svet.medians.byCompetitor[0].median === 350000, JSON.stringify(svet.medians.byCompetitor[0]));
check('медианы по сайтам прочитаны', svet.medians.bySource.length === 2 && svet.medians.bySource[0].median === 340000, JSON.stringify(svet.medians.bySource[0]));
check('динамика прочитана', svet.dynamics.length === 1 && svet.dynamics[0].lotsNew === 2 && svet.dynamics[0].periodCurr === '2026-11-03', JSON.stringify(svet.dynamics[0]));
check('новые акции прочитаны + счётчик известных', svet.promosNew.length === 1 && svet.promosKnownCount === 4, svet.promosNew[0].text);
check('прогноз прочитан и помечен оценкой', !!svet.forecast && svet.forecast[0].method === 'trend-linear' && svet.forecast[0].estimate === true && svet.forecast[0].values.length === 2, JSON.stringify(svet.forecast[0].values));
check('внутренняя связность сошлась', svet.consistency.ok === true, (svet.consistency.notes || []).join('; ') || 'расхождений нет');
check('связность с профилями конкурентов посчитана по проектам', doc.crossCheck.comparedProjects === 2 && doc.crossCheck.ok === true, JSON.stringify({ compared: doc.crossCheck.comparedProjects, matched: doc.crossCheck.matched, note: doc.crossCheck.note }));
check('доступность источников данных прочитана', svet.dataStatus.length === 1 && svet.dataStatus[0].source === 'domclick', JSON.stringify(svet.dataStatus[0]));
// §5.3: метрики — ЧИСЛА ДВИЖКА, панель их не подменяет своим списком.
check('metrics движка прочитаны как есть (2/2/15/12 000 000)',
  svet.metrics.competitorsInAnalysis === 2 && svet.metrics.competitorsWithData === 2 && svet.metrics.lotsAnalyzed === 15 && svet.metrics.cheapestLotRub === 12000000,
  JSON.stringify(svet.metrics).slice(0, 140));
check('источник числа «в анализе» — файл движка, а не истинный список',
  /metrics\.competitorsInAnalysis/.test(String(svet.metrics.competitorsInAnalysisSource)) && !/минус/.test(String(svet.metrics.competitorsInAnalysisSource)),
  String(svet.metrics.competitorsInAnalysisSource));
check('«с данными» взято из metrics движка и не больше истинного списка (2 из 4)',
  svet.truth.withData === 2 && svet.truth.withData <= svet.truth.competitors && /metrics\.competitorsWithData/.test(String(svet.truth.withDataSource)),
  String(svet.truth.withDataSource));
check('итог по всем клиентам повторяет правило клиента (в анализе 2, в списках 4)',
  doc.totals.competitorsInAnalysis === 2 && doc.totals.competitorsInList === 4 && doc.totals.lotsAnalyzed === 15,
  JSON.stringify({ inAnalysis: doc.totals.competitorsInAnalysis, inList: doc.totals.competitorsInList, lots: doc.totals.lotsAnalyzed }));
const rec = doc.email.recipients.filter((r) => r.address === 'tyurina@d-a.ru')[0] || {};
check('статус почты взят из файла движка', rec.status === 'отправлено' && rec.at === '2026-11-03T11:25:00+03:00', rec.status + ' · ' + rec.evidence);
const rec2 = doc.email.recipients.filter((r) => r.address === 'vodnev@d-a.ru')[0] || {};
check('получатель без подтверждения назван явно', rec2.status === 'нет подтверждения отправки' && /нет подтверждения/.test(String(rec2.evidence)), rec2.status);
check('телеграм-адрес не попал в почтовые получатели', doc.email.addresses.indexOf('@svet_marketing') < 0, doc.email.addresses.join(', '));

// ---- 2б. движок прислал метрики в snake_case и больше, чем есть в списке ----
const snake = JSON.parse(JSON.stringify(ENGINE));
delete snake.metrics;
snake.metrics = { competitors_in_analysis: 3, competitors_with_data: 5, lots_analyzed: 14, cheapest_lot_rub: 9_000_000 };
snake.date = '2026-11-04';   // панель берёт дату из самого файла: держим её согласованной с именем
write(path.join(ROOT, 'client-svet', '.cache', 'analytics-2026-11-04.json'), snake);
doc = loadCompetitorAnalytics({ agentSettings: AGENT_SETTINGS, competitorReport: COMPETITOR_REPORT, serviceResults: SERVICE_RESULTS });
svet = byId(doc, 'client-svet');
check('snake_case-метрики движка читаются тем же кодом',
  svet.metrics.competitorsInAnalysis === 3 && svet.metrics.lotsAnalyzed === 14 && svet.metrics.cheapestLotRub === 9000000, JSON.stringify(svet.metrics).slice(0, 130));
check('«с данными» больше истинного списка — расхождение названо предупреждением, а не подогнано',
  svet.truth.withData === 5 && doc.warnings.some((w) => /больше истинного списка/.test(w)), (doc.warnings || []).slice(0, 2).join(' | '));
check('из двух дат выбран новейший ФАЙЛ (analytics-2026-11-04.json) и его метрики',
  svet.fileName === 'analytics-2026-11-04.json' && svet.metrics.competitorsInAnalysis === 3, 'файл ' + svet.fileName + ', дата в файле ' + svet.date);

// ---- 3. файл без metrics: «в анализе» считается по списку, «с данными» — по by_competitor ----
const noMetrics = JSON.parse(JSON.stringify(ENGINE));
delete noMetrics.metrics;
write(path.join(ROOT, 'client-svet', '.cache', 'analytics-2026-11-05.json'), noMetrics);
doc = loadCompetitorAnalytics({ agentSettings: AGENT_SETTINGS, competitorReport: COMPETITOR_REPORT, serviceResults: SERVICE_RESULTS });
svet = byId(doc, 'client-svet');
check('без metrics движка «в анализе» = список минус без источника (3)',
  svet.metrics.competitorsInAnalysis === 3, String(svet.metrics.competitorsInAnalysis) + ' · ' + String(svet.metrics.competitorsInAnalysisSource).slice(0, 70));
check('без metrics «с данными» считается по by_competitor и это видно в источнике',
  svet.truth.withData === 2 && /by_competitor/.test(String(svet.truth.withDataSource)), String(svet.truth.withDataSource));

// ---- 4. несвязный прогноз и несходящиеся суммы ----
clean(path.join(ROOT, 'client-svet', '.cache'));
const broken = JSON.parse(JSON.stringify(ENGINE));
broken.lots_on_sale = 14;                 // сумма частей 15 — расходится с итогом
broken.by_competitor[1].lots_on_sale = 7; // и с профилями конкурентов (там 5)
broken.forecast = [{ project: 'Селигер Сити', metric: 'median_price_per_m2', values: [], estimate: false }];
write(path.join(ROOT, 'client-svet', '.cache', 'analytics-2026-11-04.json'), broken);
doc = loadCompetitorAnalytics({ agentSettings: AGENT_SETTINGS, competitorReport: COMPETITOR_REPORT, serviceResults: SERVICE_RESULTS });
svet = byId(doc, 'client-svet');
check('расхождение суммы лотов поймано', svet.consistency.ok === false && svet.consistency.notes.some((n) => /≠/.test(n)), svet.consistency.notes.join('; '));
check('несвязный прогноз виден (нет метода и точек)', !!svet.forecast && !svet.forecast[0].method && svet.forecast[0].points === null, JSON.stringify({ method: svet.forecast[0].method, points: svet.forecast[0].points, estimate: svet.forecast[0].estimate }));
check('расхождение с профилями конкурентов объяснено', doc.crossCheck.ok === false && !!doc.crossCheck.note, String(doc.crossCheck.note).slice(0, 90));

// ---- 5. битый JSON не роняет сборщик ----
write(path.join(ROOT, 'client-svet', '.cache', 'analytics-2026-11-05.json'), '{ это не json');
doc = loadCompetitorAnalytics({ agentSettings: AGENT_SETTINGS, competitorReport: COMPETITOR_REPORT, serviceResults: SERVICE_RESULTS });
svet = byId(doc, 'client-svet');
check('битый JSON не уронил сборщик и объяснён', !!svet && svet.emptyReason !== null && doc.warnings.length > 0, svet.emptyReason);
check('битый JSON не дал выдуманных чисел', !!svet && svet.lotsOnSale === null, 'lotsOnSale=' + (svet && svet.lotsOnSale));
check('битый JSON не обнулил истину списка', !!svet && svet.truth.competitors === 4, 'competitors=' + (svet && svet.truth.competitors));

// ---- 6. границы: битый отступ, пустой список, чужой клиент ----
clean(ROOT);
fs.mkdirSync(path.join(ROOT, 'client-broken'), { recursive: true });
fs.mkdirSync(path.join(ROOT, 'client-empty'), { recursive: true });
fs.mkdirSync(path.join(ROOT, 'client-foreign'), { recursive: true });   // отчёты есть, конфига нет
write(path.join(CLIENTS, 'client-broken.yaml'), brokenYaml);
write(path.join(CLIENTS, 'client-empty.yaml'), emptyYaml);
doc = loadCompetitorAnalytics({ agentSettings: AGENT_SETTINGS, competitorReport: COMPETITOR_REPORT, serviceResults: SERVICE_RESULTS });
const brokenCl = byId(doc, 'client-broken');
const emptyCl = byId(doc, 'client-empty');
const foreignCl = byId(doc, 'client-foreign');
check('битый отступ назван в truth и в предупреждениях, запись не выброшена молча',
  !!brokenCl && brokenCl.truth.brokenIndent === 1 && /битым отступом/.test(String(brokenCl.truth.note)) && /Вложенный/.test(String(brokenCl.truth.note))
  && doc.warnings.some((w) => /битым отступом/.test(w)),
  brokenCl ? String(brokenCl.truth.note).slice(0, 90) : '—');
check('чужой клиент (нет конфига) — truth.exists=false и «данных нет» с причиной, а не 0',
  !!foreignCl && foreignCl.truth.exists === false && foreignCl.truth.competitors === null && /не найден/.test(String(foreignCl.truth.reason)),
  foreignCl ? String(foreignCl.truth.reason).slice(0, 80) : '—');
check('пустой список конкурентов не выдаётся за число: null + причина словами',
  !!emptyCl && emptyCl.truth.competitors === null && /не разобран/.test(String(emptyCl.truth.reason)),
  emptyCl ? String(emptyCl.truth.reason).slice(0, 80) : '—');
// Итоги считаются ТОЛЬКО по клиентам, где число известно: client-broken (2) + client-svet (4) = 6;
// client-empty и client-foreign дают null и в сумму не попадают (не превращаются в 0).
check('итог «в списках» суммирует только известных клиентов: 2 + 4 = 6 (null не считается нулём)',
  doc.totals.competitorsInList === 6, JSON.stringify({ inList: doc.totals.competitorsInList, inAnalysis: doc.totals.competitorsInAnalysis }));
check('итог «в анализе»: 2 (client-broken) + 3 (client-svet) = 5, null-клиенты пропущены',
  doc.totals.competitorsInAnalysis === 5, JSON.stringify({ inList: doc.totals.competitorsInList, inAnalysis: doc.totals.competitorsInAnalysis }));
check('источник истины перечисляет клиентов и записи без источника',
  (doc.truthSources || []).length === 1 && /без источника/.test(String(doc.truthSources[0].note)),
  (doc.truthSources || []).map((s) => s.note).join(' | ').slice(0, 110));

clean(ROOT);
clean(CLIENTS);
console.log('Итог: OK ' + ok + ', ПРОВАЛ ' + fail);
process.exit(fail === 0 ? 0 : 1);

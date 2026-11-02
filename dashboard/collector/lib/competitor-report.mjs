// Блок «Отчёт Агента 1 по конкурентам»: читаем профили конкурентов от движка.
//
// ФАКТИЧЕСКАЯ СХЕМА ДВИЖКА (task-59):
// профиль: { project, source_url, source_platform, collected_at, distance_km, class,
//   metrics: { <метрика>: { value, unit, source, collected_at, method, accuracy, comment } },
//   derived: { <метрика>: { value, unit, source, method, accuracy, comment } },
//   by_rooms: { "студии"|"1"|"2"|"3"|"4+": { count, median_price, median_price_per_m2, median_area } },
//   risk_flags: [ { code, level, comment } ], limitations: [], history: { weeks, needed, available } }
// сводка (_summary.json): { client, generated_at, projects, projects_with_lots, lots_total,
//   price_per_m2_median, risk_flags[], rosreestr{status, detail, attempts}, files[] }
//
// Каждая метрика знает свой источник, дату, метод и комментарий — блок показывает их как есть.
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_DIR } from './paths.mjs';
import { parseYaml } from './yaml.mjs';

const CLIENTS_DIR = path.join(PROJECT_DIR, '01-competitor-watch', 'data', 'clients');

// Домен из URL и проверка «похоже на домен» — нужны для сопоставления срезов движка,
// где вместо ключа проекта может лежать домен (rg-dev.ru, seliger-city.ru).
function domainOf(url) {
  const m = /^https?:\/\/([^\/]+)/i.exec(String(url || ''));
  return m ? m[1].replace(/^www\./i, '').toLowerCase() : null;
}
function looksLikeDomain(v) { return /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(String(v || '')); }

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

// Движок иногда ставит 0 там, где признака просто НЕТ на странице
// (например reserved_lots: 0 с комментарием «на странице признака брони нет»).
// Это не ноль, а отсутствие данных: показываем «данных нет: причина», а не выдуманный нуль.
const ABSENT_RE = /признака .{0,12}нет|нет признака|недоступ|нет на странице|нужно минимум|не отдаёт|не отдает/i;

// Метрика движка -> наш вид. value === null означает «данных нет», и у нас есть причина.
function metric(m) {
  if (!m || typeof m !== 'object') return { value: null, unit: null, source: null, date: null, method: null, accuracy: null, comment: null, estimate: false, rawValue: null };
  let v = num(m.value);
  let comment = m.comment !== undefined && m.comment !== null && String(m.comment) !== '' ? String(m.comment) : null;
  let zeroWasAbsence = false;
  // ТЕКСТОВЫЕ метрики: сроки ввода («4 кв 2027»), названия стадий и подобное.
  // Раньше числовая конверсия превращала их в null, и значение пропадало.
  let text = null;
  if (v === null && typeof m.value === 'string' && m.value.trim() !== '') text = m.value.trim();
  if (v === 0 && comment && ABSENT_RE.test(comment)) { v = null; zeroWasAbsence = true; }
  // Пустая строка у движка означает «метод не указан» — приводим к null.
  const methodRaw = m.method !== undefined && m.method !== null ? String(m.method).trim() : '';
  const method = methodRaw === '' ? null : methodRaw;
  return {
    value: v,
    text: text,
    hasAny: v !== null || text !== null,
    unit: m.unit !== undefined && m.unit !== null ? String(m.unit) : null,
    source: m.source !== undefined && m.source !== null && String(m.source) !== '' ? String(m.source) : null,
    date: m.collected_at !== undefined && m.collected_at !== null ? String(m.collected_at) : null,
    method: method,
    accuracy: m.accuracy !== undefined && m.accuracy !== null && String(m.accuracy) !== '' ? String(m.accuracy) : null,
    comment: comment,
    // «оценка» — всё, что посчитано, а не собрано (method: estimate)
    estimate: method === 'estimate',
    // Признак, что движок прислал 0, но это не ноль, а отсутствие данных.
    zeroWasAbsence: zeroWasAbsence,
    rawValue: m.value !== undefined ? m.value : null,
  };
}

function group(obj, map) {
  const out = {};
  Object.keys(map).forEach(function (ourKey) { out[ourKey] = metric(obj ? obj[map[ourKey]] : null); });
  return out;
}

// Расширенные метрики движка (корпуса, стройка, акции с сайта застройщика, шахматка, официальные).
// ВАЖНО: каждая новая метрика движка должна быть либо в этих картах, либо в HIDDEN_METRICS.
// За этим следит правило полноты в verify-data — иначе новые поля теряются молча.
const METRIC_MAP = {
  // --- корпуса и стройка (сайт застройщика) ---
  siteCorpiNamed: 'site_corpi_named',
  siteDeadlines: 'site_deadlines',
  siteReadinessPct: 'site_readiness_pct',
  // --- шахматка сайта застройщика ---
  siteFlatsTotal: 'site_flats_total',
  siteFlatsInSale: 'site_flats_in_sale',
  siteFlatsSold: 'site_flats_sold',
  siteFlatsReserved: 'site_flats_reserved',
  // --- акции и программы с сайта застройщика ---
  sitePromoCount: 'site_promo_count',
  siteMortgageCount: 'site_mortgage_count',
  // --- ОФИЦИАЛЬНЫЕ данные: Росреестр / ЕИСЖС (сейчас недоступны) ---
  corpiTotal: 'corpi_total',
  corpiBuilt: 'corpi_built',
  corpiUnderConstruction: 'corpi_under_construction',
  flatsTotal: 'flats_total',
  dduRegistered: 'ddu_registered',
  soldOfficialRosreestr: 'sold_official_rosreestr',
  // --- МАРКЕТИНГ: бюджеты из SpyWords / Keys.so (task-67 движка) ---
  // Контракт имён с движком (snake_case): эти ключи движок добавит в профиль,
  // панель их уже знает и разложит по группе «Маркетинг».
  marketingBudgetEstimateRub: 'marketing_budget_estimate_rub',
  marketingAds: 'marketing_ads_count',
  marketingKeywords: 'marketing_keywords_count',
  marketingLandings: 'marketing_landings_count',
  marketingPeriod: 'marketing_period',
  marketingSource: 'marketing_source',
  marketingMethod: 'marketing_method',
  // --- оценка продаж по нашему мониторингу ---
  soldEstimateByGoneLots: 'sold_estimate_by_gone_lots',
  // --- базовые ---
  lotsInSale: 'lots_in_sale',
  priceMinRub: 'price_min_rub',
  priceMedianRub: 'price_median_rub',
  priceMaxRub: 'price_max_rub',
  pricePerM2Median: 'price_per_m2_median',
  averageAreaM2: 'average_area_m2',
  medianAreaM2: 'median_area_m2',
  reservedLots: 'reserved_lots',
  promoCount: 'promo_count',
};
const DERIVED_MAP = {
  soldShareOfficialPct: 'sold_share_official_pct',
  salesSpeedPerWeek: 'sales_speed_per_week',
  absorptionRate: 'absorption_rate',
  monthsToSellOut: 'months_to_sell_out',
  entryPriceDynamicsPct: 'entry_price_dynamics_pct',
  supplyDynamicsPct: 'supply_dynamics_pct',
  promoPressureWeeks: 'promo_pressure_weeks',
  priceIndexVsDistrict: 'price_index_vs_district',
  gapPriceVsUsPct: 'gap_price_vs_us_pct',
};

// ГРУППЫ ОТОБРАЖЕНИЯ: единый источник правды и для интерфейса, и для правила полноты.
// Каждая запись: { id, title, hint, kind, planned, metrics: [ { key, label, unit, fmt } ] }
// kind: summary | metrics | official | risks | sources
// planned: true — группа есть, но движок пока таких метрик не присылает (показываем честно).
// Ключи — наши имена из METRIC_MAP/DERIVED_MAP. Новую метрику движка нужно добавить сюда,
// иначе правило полноты в verify-data упадёт с перечислением неразложенных ключей.
const DISPLAY_GROUPS = [
  { id: 'summary', title: 'Сводка', kind: 'summary', hint: 'сколько конкурентов, лотов, медианы, акции, флаги, дата и себестоимость прогона' },
  { id: 'competitors', title: 'Конкуренты', kind: 'table', hint: 'таблица по проектам с сортировкой и поиском', metrics: [
    { key: 'lotsInSale', label: 'Лотов', fmt: 'int' },
    { key: 'pricePerM2Median', label: 'Медиана ₽/м²', fmt: 'money' },
    { key: 'priceMinRub', label: 'Мин. вход, ₽', fmt: 'money' },
    { key: 'priceMedianRub', label: 'Медиана цены, ₽', fmt: 'money' },
    { key: 'averageAreaM2', label: 'Ср. площадь, м²', fmt: 'num' },
    { key: 'promoCount', label: 'Лотов с акцией', fmt: 'int' },
    { key: 'reservedLots', label: 'Бронь', fmt: 'int' }
  ] },
  { id: 'prices', title: 'Цены', kind: 'metrics', hint: 'медианы, минимум и максимум, ₽/м², разрез по типам квартир', metrics: [
    { key: 'priceMinRub', label: 'Минимальная цена, ₽', fmt: 'money' },
    { key: 'priceMedianRub', label: 'Медианная цена, ₽', fmt: 'money' },
    { key: 'priceMaxRub', label: 'Максимальная цена, ₽', fmt: 'money' },
    { key: 'pricePerM2Median', label: 'Медиана ₽/м²', fmt: 'money' },
    { key: 'priceIndexVsDistrict', label: 'Индекс цены к району, ×', fmt: 'num', estimate: true },
    { key: 'gapPriceVsUsPct', label: 'Разрыв с нашей ценой, %', fmt: 'num', estimate: true }
  ] },
  { id: 'product', title: 'Продукт', kind: 'metrics', hint: 'площади, структура по комнатности, сдвиги', metrics: [
    { key: 'averageAreaM2', label: 'Средняя площадь, м²', fmt: 'num' },
    { key: 'medianAreaM2', label: 'Медианная площадь, м²', fmt: 'num' },
    { key: 'lotsInSale', label: 'Лотов в реализации', fmt: 'int' }
  ] },
  { id: 'buildings', title: 'Корпуса и стройка', kind: 'metrics', hint: 'корпуса, стадии, сроки ввода, готовность, шахматка (сайт застройщика, метод dom)', metrics: [
    { key: 'siteCorpiNamed', label: 'Корпусов названо', fmt: 'int' },
    { key: 'siteDeadlines', label: 'Сроки ввода', fmt: 'text' },
    { key: 'siteReadinessPct', label: 'Готовность, %', fmt: 'num' },
    { key: 'siteFlatsTotal', label: 'Квартир по шахматке', fmt: 'int' },
    { key: 'siteFlatsInSale', label: 'В продаже (сайт)', fmt: 'int' },
    { key: 'siteFlatsSold', label: 'Продано (сайт)', fmt: 'int' },
    { key: 'siteFlatsReserved', label: 'Забронировано (сайт)', fmt: 'int' },
    { key: 'reservedLots', label: 'Бронь (площадка)', fmt: 'int' },
    { key: 'soldShareBySite', label: 'Доля проданного по сайту, %', fmt: 'pct', estimate: true, note: 'не Росреестр' }
  ] },
  { id: 'promos', title: 'Акции и программы', kind: 'metrics', hint: 'тексты акций сайта, число ипотечных программ, давление промо', metrics: [
    { key: 'sitePromoCount', label: 'Акций на сайте застройщика', fmt: 'int' },
    { key: 'siteMortgageCount', label: 'Ипотечных программ', fmt: 'int' },
    { key: 'promoCount', label: 'Лотов с акцией (площадка)', fmt: 'int' },
    { key: 'promoPressureWeeks', label: 'Недель подряд с акциями', fmt: 'num', estimate: true }
  ] },
  { id: 'dynamics', title: 'Динамика', kind: 'metrics', hint: 'скорость продаж, absorption, прогноз распродажи, изменения цены и предложения (расчёт)', metrics: [
    { key: 'salesSpeedPerWeek', label: 'Скорость продаж, лотов/нед', fmt: 'num', estimate: true },
    { key: 'absorptionRate', label: 'Absorption, %', fmt: 'pct', estimate: true },
    { key: 'monthsToSellOut', label: 'Месяцев до распродажи', fmt: 'num', estimate: true },
    { key: 'entryPriceDynamicsPct', label: 'Динамика цены входа, %', fmt: 'pct', estimate: true },
    { key: 'supplyDynamicsPct', label: 'Динамика предложения, %', fmt: 'pct', estimate: true }
  ] },
  { id: 'marketing', title: 'Маркетинг', kind: 'marketing', hint: 'ориентировочные бюджеты по данным SpyWords / Keys.so — оценка сервиса, не фактический расход', metrics: [
    { key: 'marketingBudgetEstimateRub', label: 'Бюджет за период, ₽ (оценка)', fmt: 'money', estimate: true },
    { key: 'marketingPeriod', label: 'Период', fmt: 'text' },
    { key: 'marketingAds', label: 'Объявлений', fmt: 'int', estimate: true },
    { key: 'marketingKeywords', label: 'Ключевых слов', fmt: 'int', estimate: true },
    { key: 'marketingLandings', label: 'Уникальных посадочных', fmt: 'int', estimate: true },
    { key: 'marketingSource', label: 'Источник', fmt: 'text' },
    { key: 'marketingMethod', label: 'Метод сбора', fmt: 'text' }
  ] },
  { id: 'visits', title: 'Обращения и визиты', kind: 'metrics', planned: true, hint: 'звонки, конверсия, визиты. Эти данные не публикуются публично — панель не подставляет прокси-оценки без пометки', metrics: [
    { key: 'visitsCount', label: 'Визитов в офис продаж', fmt: 'int' },
    { key: 'callsCount', label: 'Звонков', fmt: 'int' },
    { key: 'conversionPct', label: 'Конверсия в сделку, %', fmt: 'pct' }
  ] },
  { id: 'official', title: 'Официальные данные: Росреестр / ЕИСЖС', kind: 'official', hint: 'отдельно от сайта застройщика; источник сейчас недоступен', metrics: [
    { key: 'corpiTotal', label: 'Корпусов всего (официально)', fmt: 'int' },
    { key: 'corpiBuilt', label: 'Сдано корпусов', fmt: 'int' },
    { key: 'corpiUnderConstruction', label: 'Строится корпусов', fmt: 'int' },
    { key: 'flatsTotal', label: 'Квартир всего (официально)', fmt: 'int' },
    { key: 'dduRegistered', label: 'Зарегистрировано ДДУ', fmt: 'int' },
    { key: 'soldOfficialRosreestr', label: 'Продано официально', fmt: 'int' },
    { key: 'soldShareOfficialPct', label: 'Доля проданного (официальная), %', fmt: 'pct', estimate: true },
    { key: 'soldEstimateByGoneLots', label: 'Продано (оценка по ушедшим лотам)', fmt: 'int', estimate: true }
  ] },
  { id: 'risks', title: 'Риски', kind: 'risks', hint: 'риск-флаги движка и что требует внимания' },
  { id: 'sources', title: 'Источники', kind: 'sources', hint: 'источник, метод, дата, точность и что получить не удалось' }
];

// КАРТА СООТВЕТСТВИЯ: сырой ключ движка (snake_case) -> внутреннее имя панели.
// Контракт: движок ВСЕГДА отдаёт snake_case, панель нормализует у себя и ведёт эту карту.
const KEY_MAP = (function () {
  const out = [];
  Object.keys(METRIC_MAP).forEach(function (ours) { out.push({ raw: METRIC_MAP[ours], internal: ours, bucket: 'metrics' }); });
  Object.keys(DERIVED_MAP).forEach(function (ours) { out.push({ raw: DERIVED_MAP[ours], internal: ours, bucket: 'derived' }); });
  out.push({ raw: '(расчёт панели)', internal: 'soldShareBySite', bucket: 'derived' });
  out.forEach(function (e) {
    const g = DISPLAY_GROUPS.filter(function (gr) { return (gr.metrics || []).some(function (m) { return m.key === e.internal; }); });
    e.groups = g.map(function (gr) { return gr.id; });
  });
  return out;
})();

// Плоский список ключей отображения — для правила полноты.
const DISPLAY_KEYS = (function () {
  const out = [];
  DISPLAY_GROUPS.forEach(function (g) { (g.metrics || []).forEach(function (m) { if (out.indexOf(m.key) < 0) out.push(m.key); }); });
  return out;
})();

// ЯВНЫЙ СПИСОК СКРЫТЫХ: то, что осознанно не показываем, с причиной.
const HIDDEN_METRICS = [];

// Правило полноты: все метрики профиля разложены по группам или явно скрыты.
export function completeness(seenMetricKeys, seenDerivedKeys) {
  const displayed = new Set(DISPLAY_KEYS);
  const hidden = new Set(HIDDEN_METRICS.map(function (h) { return h.key; }));
  const all = seenMetricKeys.concat(seenDerivedKeys);
  const uncovered = [];
  const seenSet = new Set();
  all.forEach(function (k) {
    if (seenSet.has(k)) return;
    seenSet.add(k);
    if (!displayed.has(k) && !hidden.has(k)) uncovered.push(k);
  });
  return {
    seenMetricKeys: seenMetricKeys.slice().sort(),
    seenDerivedKeys: seenDerivedKeys.slice().sort(),
    groups: DISPLAY_GROUPS,
    groupTitles: DISPLAY_GROUPS.map(function (g) { return { id: g.id, title: g.title, kind: g.kind, planned: !!g.planned, metrics: (g.metrics || []).map(function (m) { return m.key; }) }; }),
    hidden: HIDDEN_METRICS,
    displayedCount: seenSet.size - uncovered.length,
    seenCount: seenSet.size,
    uncovered: uncovered.sort(),
    ok: uncovered.length === 0,
  };
}

function normalizeProfile(raw, fileName) {
  const roomsOut = {};
  const br = raw.by_rooms || {};
  [['studio', 'студии'], ['1', '1'], ['2', '2'], ['3', '3'], ['4+', '4+']].forEach(function (r) {
    const r0 = br[r[1]] || null;
    roomsOut[r[0]] = r0 ? { count: num(r0.count), medianPrice: num(r0.median_price), medianPerM2: num(r0.median_price_per_m2), medianArea: num(r0.median_area) } : null;
  });
  const metrics = group(raw.metrics, METRIC_MAP);
  const derived = group(raw.derived, DERIVED_MAP);
  const ds = raw.developer_site || null;
  const os = raw.official_sources || null;
  const officialSources = os ? {
    status: os.status !== undefined ? String(os.status) : null,
    detail: os.detail !== undefined ? String(os.detail) : null,
    checkedAt: os.checked_at !== undefined ? String(os.checked_at) : null,
    attempts: Array.isArray(os.attempts) ? os.attempts.map(function (a) {
      return {
        source: a.source !== undefined ? String(a.source) : '—',
        url: a.url !== undefined ? String(a.url) : null,
        http: a.http || null,
        browser: a.browser !== undefined ? a.browser : null,
        note: a.note !== undefined ? String(a.note) : null,
      };
    }) : [],
  } : null;
  const developerSite = ds ? {
    url: ds.url !== undefined && ds.url !== null ? String(ds.url) : null,
    method: ds.method !== undefined ? String(ds.method) : null,
    note: ds.note !== undefined ? String(ds.note) : null,
    title: ds.title !== undefined ? String(ds.title) : null,
    ok: ds.ok === true,
    corpi: Array.isArray(ds.corpi) ? ds.corpi.map(String) : [],
  } : null;
  // Производная, которую считает ПАНЕЛЬ: доля проданного ПО САЙТУ ЗАСТРОЙЩИКА.
  // Показываем только когда есть оба числа (иначе null — «данных нет»). Это НЕ Росреестр.
  const flatsTotal = metrics.siteFlatsTotal ? metrics.siteFlatsTotal.value : null;
  const flatsSold = metrics.siteFlatsSold ? metrics.siteFlatsSold.value : null;
  const soldShareBySite = (flatsTotal !== null && flatsSold !== null && flatsTotal > 0)
    ? { value: Math.round(flatsSold / flatsTotal * 1000) / 10, unit: '%', source: 'сайт застройщика (наш расчёт)', date: (metrics.siteFlatsSold.date || null), method: 'estimate', accuracy: null, comment: 'доля проданного по шахматке сайта застройщика — НЕ Росреестр', estimate: true, zeroWasAbsence: false, rawValue: null }
    : { value: null, unit: '%', source: 'сайт застройщика', date: null, method: 'estimate', accuracy: null, comment: 'нужны оба числа: всего квартир и продано по шахматке сайта', estimate: true, zeroWasAbsence: false, rawValue: null };
  const sourcesCount = Object.keys(metrics).filter(function (k) { return metrics[k].value !== null && metrics[k].source; }).length
    + Object.keys(derived).filter(function (k) { return derived[k].value !== null && derived[k].source; }).length;
  return {
    projectId: raw.project_id !== undefined && raw.project_id !== null ? String(raw.project_id) : fileName.replace(/\.json$/, ''),
    project: raw.project !== undefined && raw.project !== null ? String(raw.project) : fileName.replace(/\.json$/, ''),
    developer: raw.developer !== undefined && raw.developer !== null ? String(raw.developer) : null,
    klass: raw.class !== undefined && raw.class !== null ? String(raw.class) : null,
    sourceUrl: raw.source_url !== undefined && raw.source_url !== null ? String(raw.source_url) : null,
    sourcePlatform: raw.source_platform !== undefined && raw.source_platform !== null ? String(raw.source_platform) : null,
    collectedAt: raw.collected_at !== undefined && raw.collected_at !== null ? String(raw.collected_at) : null,
    distanceKm: num(raw.distance_km),
    metrics: metrics,
    derived: derived,
    soldShareBySite: soldShareBySite,
    developerSite: developerSite,
    officialSources: officialSources,
    byRooms: roomsOut,
    riskFlags: Array.isArray(raw.risk_flags) ? raw.risk_flags.map(function (f) { return { code: f.code !== undefined ? String(f.code) : null, level: f.level !== undefined ? String(f.level) : 'info', comment: f.comment !== undefined ? String(f.comment) : (f.text !== undefined ? String(f.text) : '—') }; }) : [],
    limitations: Array.isArray(raw.limitations) ? raw.limitations.map(String) : [],
    history: raw.history || null,
    sourcesCount: sourcesCount,
    filedAt: (function () { try { return fs.statSync(path.join(CLIENTS_DIR, '', fileName)).mtimeMs; } catch (e) { return null; } })(),
  };
}

const BUDGETS_SUBDIR = 'budgets';
const AGENT1_SETTINGS = path.join(PROJECT_DIR, 'registry', 'agent-settings', 'agent-1-competitor-watch.yaml');

// Карта «домен → канонический ключ проекта» из тонких настроек Агента 1 (agent1.competitor_domains).
// Движок её тоже читает; панель применяет при сопоставлении бюджетов, когда срез отдаёт только домен.
function loadCompetitorDomains(warnings) {
  try {
    if (!fs.existsSync(AGENT1_SETTINGS)) return {};
    const doc = parseYaml(fs.readFileSync(AGENT1_SETTINGS, 'utf8'));
    const map = doc && doc.agent1 && doc.agent1.competitor_domains ? doc.agent1.competitor_domains : {};
    const out = {};
    Object.keys(map).forEach(function (k) { if (map[k]) out[String(k).toLowerCase()] = String(map[k]); });
    return out;
  } catch (e) { warnings.push('agent1.competitor_domains: не прочиталась — ' + e.message); return {}; }
}

// Срезы бюджетов: data/clients/<id>/budgets/<дата>.json
// Ожидаемый формат (движок task-67): { source, method, status?, projects: [ { project, budget_rub,
//   period, ads_count, keywords_count, landings_count, collected_at, accuracy } ] } или массив записей.
// status: 'no_key' — ключ API не подключён; 'no_domain' — домена нет в базе сервиса.
function readBudgetSlices(clientDir, warnings) {
  const dir = path.join(clientDir, BUDGETS_SUBDIR);
  const out = { dir: dir, exists: false, slices: [], status: null, note: null, source: null, method: null, demo: false };
  if (!fs.existsSync(dir)) { out.status = 'no_key'; out.note = 'Ключ API не подключён: бюджет появится после подключения SpyWords/Keys.so'; return out; }
  out.exists = true;
  const files = fs.readdirSync(dir).filter(function (n) { return /\.json$/.test(n); }).sort();
  files.forEach(function (n) {
    const full = path.join(dir, n);
    let doc = null;
    try { doc = JSON.parse(fs.readFileSync(full, 'utf8')); }
    catch (e) { warnings.push('budgets/' + n + ': не разобрался — ' + e.message); return; }
    // ВАЖНО: запись среза может содержать ТОЛЬКО домен (движок так и делает для Селигера:
    // project: null, name: null, domain: "seliger-city.ru"). Раньше такие записи отсекались фильтром,
    // и конкурент оставался «не сопоставлен», хотя данные в срезе были.
    const items = (Array.isArray(doc) ? doc : (doc.projects || doc.items || [])).filter(function (x) {
      return x && (x.project || x.name || x.domain);
    });
    // Статус среза — канонический: ok | no_key | no_domain. Берём его как состояние клиента.
    if (doc && doc.status) {
      out.status = String(doc.status);
      if (doc.status === 'no_key') out.note = doc.note || 'Ключ API не подключён: бюджет появится после подключения SpyWords/Keys.so';
      if (doc.status === 'no_domain') out.note = doc.note || 'нет данных по домену в базе сервиса';
    }
    out.source = out.source || (doc && doc.source ? String(doc.source) : null);
    // Толерантное чтение метода: движок пишет разные варианты, канонические — api|csv|mcp.
    // «csv-import» приводим к «csv» (движок тоже обещал писать csv) — иначе проверка справедливо ругалась бы.
    const normMethod = function (v) {
      const s = v === undefined || v === null ? '' : String(v).trim().toLowerCase();
      if (s === '') return null;
      if (s === 'csv-import' || s === 'csv_import' || s === 'import') return 'csv';
      if (s === 'api-key' || s === 'apikey') return 'api';
      return s;
    };
    out.method = out.method || (doc && doc.method ? normMethod(doc.method) : null);
    // demo: true — выгрузка из ДЕМОНСТРАЦИОННОГО файла, а не из аккаунта пользователя.
    // Флаг обязателен к показу в интерфейсе: иначе цифру примут за реальный бюджет конкурента.
    const sliceDemo = !!(doc && doc.demo === true);
    if (sliceDemo) out.demo = true;
    out.slices.push({ date: n.replace(/\.json$/, ''), file: full, demo: sliceDemo, source: doc && doc.source ? String(doc.source) : null, method: doc && doc.method ? String(doc.method) : null, items: items.map(function (x) {
      const numOr = function (v) { return num(v); };
      return {
        project: String(x.project || x.name),
        // Канонические ключи денежной метрики: budget_estimate_rub (наш контракт), затем budget_rub.
        budgetRub: numOr(x.budget_estimate_rub !== undefined ? x.budget_estimate_rub : (x.budget_rub !== undefined ? x.budget_rub : x.budget)),
        period: x.period !== undefined ? String(x.period) : null,
        ads: numOr(x.ads_count !== undefined ? x.ads_count : x.ads),
        keywords: numOr(x.keywords_count !== undefined ? x.keywords_count : x.keywords),
        landings: numOr(x.landings_count !== undefined ? x.landings_count : x.landings),
        collectedAt: x.collected_at !== undefined ? String(x.collected_at) : (x.date !== undefined ? String(x.date) : null),
        accuracy: x.accuracy !== undefined && x.accuracy !== null && String(x.accuracy) !== '' ? String(x.accuracy) : null,
        status: x.status !== undefined ? String(x.status) : null,
        note: x.note !== undefined ? String(x.note) : null,
        source: x.source !== undefined ? String(x.source) : (doc && doc.source ? String(doc.source) : null),
        methodRaw: x.method !== undefined ? String(x.method) : (doc && doc.method ? String(doc.method) : null),
        method: (function () {
          const s = (x.method !== undefined ? x.method : (doc && doc.method ? doc.method : ''));
          const t = s === undefined || s === null ? '' : String(s).trim().toLowerCase();
          if (t === '') return null;
          if (t === 'csv-import' || t === 'csv_import' || t === 'import') return 'csv';
          if (t === 'api-key' || t === 'apikey') return 'api';
          return t;
        })(),
        name: x.name !== undefined && x.name !== null ? String(x.name) : null,
        domain: x.domain !== undefined && x.domain !== null ? String(x.domain) : (looksLikeDomain(x.project) ? String(x.project) : null),
        demo: x.demo === true || sliceDemo,
      };
    }) });
  });
  if (!out.status && out.slices.length === 0) { out.status = 'no_key'; out.note = 'Ключ API не подключён: бюджет появится после подключения SpyWords/Keys.so'; }
  return out;
}

// Метрика «оценка сервиса»: у бюджета всегда method=api|csv|mcp и estimate=true.
function marketingMetric(value, unit, source, date, accuracy, comment, method) {
  return { value: value, text: null, hasAny: value !== null, unit: unit, source: source, date: date, method: method || 'api', accuracy: accuracy, comment: comment, estimate: true, zeroWasAbsence: false, rawValue: value };
}
function marketingText(text, source, date, comment) {
  return { value: null, text: text, hasAny: text !== null, unit: null, source: source, date: date, method: null, accuracy: null, comment: comment, estimate: false, zeroWasAbsence: false, rawValue: text };
}

export function loadCompetitorReport(warnings) {
  const out = {
    dir: CLIENTS_DIR, exists: false, clients: [], profilesFound: 0,
    emptyReason: null, newestMtimeMs: null,
    // КАТАЛОГ ГРУПП — единый контракт для интерфейса и правила полноты: интерфейс
    // рисует группы отсюда, поэтому новая метрика появляется в обоих местах сразу.
    catalogue: { version: 1, for: 'agent-1-competitor-watch', groups: DISPLAY_GROUPS, hidden: HIDDEN_METRICS, displayKeys: DISPLAY_KEYS, keyMap: KEY_MAP },
    counts: { clients: 0, profiles: 0, lots: 0, withPrice: 0, withRisk: 0, sourcesCovered: 0, metricsTotal: 0 },
  };
  if (!fs.existsSync(CLIENTS_DIR)) {
    out.emptyReason = 'Папка data/clients ещё не создана: движок не выполнял прогон профилирования.';
    return out;
  }
  out.exists = true;
  let newest = 0;
  const clientDirs = fs.readdirSync(CLIENTS_DIR).filter(function (n) {
    try { return fs.statSync(path.join(CLIENTS_DIR, n)).isDirectory() && n.indexOf('_') !== 0; } catch (e) { return false; }
  }).sort();

  clientDirs.forEach(function (clientId) {
    const pdir = path.join(CLIENTS_DIR, clientId, 'competitor-profiles');
    const rec = { clientId: clientId, dir: pdir, exists: false, summary: null, profiles: [], emptyReason: null };
    if (!fs.existsSync(pdir)) {
      rec.emptyReason = 'Профили конкурентов ещё не сформированы: движок не выполнял прогон профилирования по этому клиенту.';
      out.clients.push(rec);
      return;
    }
    rec.exists = true;
    // Служебные файлы (сводка, статус источников и прочее без project+metrics) в профили не берём.
    const profileFiles = fs.readdirSync(pdir).filter(function (n) {
      if (!/\.json$/.test(n) || n.indexOf('_') === 0) return false;
      try {
        const d = JSON.parse(fs.readFileSync(path.join(pdir, n), 'utf8'));
        return !!(d && (d.project || d.project_id) && d.metrics);
      } catch (e) { return false; }
    }).sort();
    profileFiles.forEach(function (n) {
      const full = path.join(pdir, n);
      try {
        const st = fs.statSync(full);
        if (st.mtimeMs > newest) newest = st.mtimeMs;
        const prof = normalizeProfile(JSON.parse(fs.readFileSync(full, 'utf8')), n);
        prof.filedAt = st.mtimeMs;
        rec.profiles.push(prof);
      } catch (e) { warnings.push('competitor-profiles/' + n + ': не разобрался — ' + e.message); }
    });
    const sumFile = path.join(pdir, '_summary.json');
    if (fs.existsSync(sumFile)) {
      try {
        const st = fs.statSync(sumFile);
        if (st.mtimeMs > newest) newest = st.mtimeMs;
        rec.summary = JSON.parse(fs.readFileSync(sumFile, 'utf8'));
      } catch (e) { warnings.push('competitor-profiles/_summary.json: не разобрался — ' + e.message); }
    }
    if (rec.profiles.length === 0) rec.emptyReason = 'Профилей конкурентов нет: движок не нашёл ни одного конкурента в радиусе.';

    // ---- МАРКЕТИНГ: бюджеты из SpyWords / Keys.so ----
    const bud = readBudgetSlices(path.join(CLIENTS_DIR, clientId), warnings);
    rec.marketing = { exists: bud.exists, dir: bud.dir, status: bud.status, note: bud.note, source: bud.source, method: bud.method, demo: !!bud.demo, slices: bud.slices, weeks: bud.slices.map(function (s) { return { date: s.date, source: s.source, method: s.method, demo: !!s.demo }; }) };
    const latest = bud.slices.length ? bud.slices[bud.slices.length - 1] : null;
    const domainMap = loadCompetitorDomains(warnings);
    // Сопоставление записи среза с профилем: 1) key проекта, 2) человеческое имя, 3) домен,
    // 4) карта agent1.competitor_domains, 5) нестрогое совпадение по слагу.
    // Движок пока кладёт в project домен (rg-dev.ru), поэтому третий способ критичен.
    function matchItem(items, p) {
      const byKey = items.filter(function (x) { return String(x.project) === String(p.projectId); })[0];
      if (byKey) return { item: byKey, by: 'project' };
      const byName = items.filter(function (x) { return x.name && String(x.name) === String(p.project); })[0];
      if (byName) return { item: byName, by: 'name' };
      const myDomain = domainOf(p.developerSite && p.developerSite.url) || domainOf(p.sourceUrl);
      if (myDomain) {
        const byDomain = items.filter(function (x) {
          const d = x.domain ? String(x.domain).toLowerCase().replace(/^www\./, '') : null;
          return d && d === myDomain;
        })[0];
        if (byDomain) return { item: byDomain, by: 'domain' };
      }
      // 4) КАРТА ДОМЕНОВ из тонких настроек: seliger-city.ru -> zhk-seliger-siti.
      //    Это точное сопоставление по нашему же справочнику, помечаем как domain-map.
      const byMap = items.filter(function (x) {
        const d = x.domain ? String(x.domain).toLowerCase().replace(/^www\./, '') : null;
        if (!d || !domainMap[d]) return false;
        return domainMap[d] === String(p.projectId) || domainMap[d] === String(p.project);
      })[0];
      if (byMap) return { item: byMap, by: 'domain-map' };
      // 5) НЕСТРОГОЕ сопоставление по слагу: движок кладёт домен проекта (seliger-city.ru),
      //    а в профиле домен застройщика (mrgroup.ru) и слаги cian/site (seliger-siti).
      //    Совпадающие длинные токены («seliger») считаем совпадением, но помечаем как нестрогое.
      const tokens = function (s) { return String(s || '').toLowerCase().replace(/https?:\/\//g, ' ').replace(/[^a-zа-я0-9]+/gi, ' ').split(/\s+/).filter(function (t) { return t.length >= 4; }); };
      const myText = [p.project, p.projectId || '', p.developer || '', p.sourceUrl || '', (p.developerSite && p.developerSite.url) || '', (p.developerSite && p.developerSite.title) || ''].join(' ');
      const myTokens = tokens(myText);
      const norm = function (t) { return t.replace(/city/g, 'siti').replace(/y/g, 'i'); };
      const myNorm = myTokens.map(norm);
      let best = null;
      items.forEach(function (x) {
        const cand = tokens([x.project, x.name, x.domain].filter(Boolean).join(' '));
        const common = cand.filter(function (t) { const n = norm(t); return myNorm.indexOf(n) >= 0 && t.length >= 6; });
        if (common.length >= 1 && (!best || common.length > best.common.length)) best = { item: x, common: common };
      });
      if (best) return { item: best.item, by: 'slug', fuzzy: true, common: best.common };
      return { item: null, by: null };
    }
    const sliceIds = latest ? latest.items.map(function (x) { return x.domain || x.name || x.project; }).filter(Boolean) : [];

    rec.profiles.forEach(function (p) {
      const m = matchItem(latest ? latest.items : [], p);
      const item = m.item;
      p.matchedBy = m.by;
      const src = (item && item.source) || latest && latest.source || bud.source || 'Keys.so / SpyWords';
      const meth = (item && item.method) || latest && latest.method || bud.method || 'api';
      const date = (item && item.collectedAt) || (latest ? latest.date : null);
      const acc = item && item.accuracy ? item.accuracy : null;
      const isDemo = !!(item ? item.demo : (latest && latest.demo) || bud.demo);
      const CAPTION = 'ориентировочный бюджет по данным ' + src + ' — оценка сервиса, не фактический расход'
        + (isDemo ? '. ВНИМАНИЕ: данные из демонстрационного файла, не из вашего аккаунта' : '');
      if (item && (item.status === 'no_domain' || (item.budgetRub === null && item.note))) {
        p.marketing = { state: 'no_domain', note: item.note || 'нет данных по домену в базе сервиса', source: src, method: meth, date: date };
        p.metrics.marketingBudgetEstimateRub = { value: null, text: null, hasAny: false, unit: '₽', source: src, date: date, method: meth, accuracy: acc, comment: item.note || 'нет данных по домену в базе сервиса', estimate: true, zeroWasAbsence: false, rawValue: null };
      } else if (item) {
        // Нестрогое сопоставление показываем как ok_fuzzy: цифры есть, но просим уточнить домен.
        const fuzzy = m.fuzzy === true;
        const note = fuzzy
          ? (CAPTION + ' Сопоставлено НЕСТРОГО по слагу («' + (m.common || []).join(', ') + '»): добавьте домен ' + (item.domain || item.project) + ' в карточку конкурента, чтобы сопоставление стало точным.')
          : CAPTION;
        p.marketing = { state: fuzzy ? 'ok_fuzzy' : 'ok', note: note, source: src, method: meth, date: date, caption: CAPTION, fuzzy: fuzzy, demo: isDemo, matchedBy: m.by, domain: item.domain || (looksLikeDomain(item.project) ? item.project : null) };
        const CAPTIONX = note;
        p.metrics.marketingBudgetEstimateRub = marketingMetric(item.budgetRub, '₽', src, date, acc, CAPTIONX, meth);
        p.metrics.marketingAds = marketingMetric(item.ads, 'шт.', src, date, acc, CAPTIONX, meth);
        p.metrics.marketingKeywords = marketingMetric(item.keywords, 'шт.', src, date, acc, CAPTIONX, meth);
        p.metrics.marketingLandings = marketingMetric(item.landings, 'шт.', src, date, acc, CAPTIONX, meth);
        p.metrics.marketingPeriod = marketingText(item.period, src, date, CAPTIONX);
        p.metrics.marketingSource = marketingText(src, src, date, CAPTIONX);
        p.metrics.marketingMethod = marketingText(meth, src, date, CAPTIONX);
      } else {
        // ТРИ РАЗНЫХ ПРИЧИНЫ, их нельзя смешивать:
        //  no_key     — ключ API не подключён;
        //  unmatched  — данные в сервисе ЕСТЬ, но проект не сопоставлен (нужно добавить домен);
        //  no_domain  — данных по этому проекту в сервисе нет.
        const hasItems = !!(latest && latest.items.length);
        const why = bud.status === 'no_key'
          ? (bud.note || 'Ключ API не подключён: бюджет появится после подключения SpyWords/Keys.so')
          : (hasItems
            ? 'данные в сервисе есть, но проект не сопоставлен: добавьте домен в карточку конкурента (в срезе: ' + sliceIds.slice(0, 4).join(', ') + ')'
            : 'нет данных по домену в базе сервиса');
        p.marketing = { state: bud.status === 'no_key' ? 'no_key' : (hasItems ? 'unmatched' : 'no_domain'), note: why, source: src, method: meth, date: date, sliceIds: sliceIds };
        p.metrics.marketingBudgetEstimateRub = { value: null, text: null, hasAny: false, unit: '₽', source: src, date: date, method: meth, accuracy: acc, comment: why, estimate: true, zeroWasAbsence: false, rawValue: null };
        p.metrics.marketingAds = { value: null, text: null, hasAny: false, unit: 'шт.', source: src, date: date, method: meth, accuracy: acc, comment: why, estimate: true, zeroWasAbsence: false, rawValue: null };
        p.metrics.marketingKeywords = { value: null, text: null, hasAny: false, unit: 'шт.', source: src, date: date, method: meth, accuracy: acc, comment: why, estimate: true, zeroWasAbsence: false, rawValue: null };
        p.metrics.marketingLandings = { value: null, text: null, hasAny: false, unit: 'шт.', source: src, date: date, method: meth, accuracy: acc, comment: why, estimate: true, zeroWasAbsence: false, rawValue: null };
        p.metrics.marketingPeriod = { value: null, text: null, hasAny: false, unit: null, source: src, date: date, method: null, accuracy: null, comment: why, estimate: false, zeroWasAbsence: false, rawValue: null };
        p.metrics.marketingSource = { value: null, text: null, hasAny: false, unit: null, source: src, date: date, method: null, accuracy: null, comment: why, estimate: false, zeroWasAbsence: false, rawValue: null };
        p.metrics.marketingMethod = { value: null, text: null, hasAny: false, unit: null, source: src, date: date, method: null, accuracy: null, comment: why, estimate: false, zeroWasAbsence: false, rawValue: null };
      }
    });

    // --- агрегаты: считаем по метрикам, а не по выдуманным полям ---
    const lots = rec.profiles.reduce(function (a, p) { return a + (p.metrics.lotsInSale.value || 0); }, 0);
    const prices = rec.profiles.map(function (p) { return p.metrics.pricePerM2Median.value; }).filter(function (v) { return v !== null; }).sort(function (a, b) { return a - b; });
    const medianOfMedians = prices.length ? (prices.length % 2 ? prices[(prices.length - 1) / 2] : Math.round((prices[prices.length / 2 - 1] + prices[prices.length / 2]) / 2)) : null;
    const s = rec.summary || {};
    const metricsAll = [];
    rec.profiles.forEach(function (p) { Object.keys(p.metrics).forEach(function (k) { metricsAll.push(p.metrics[k]); }); Object.keys(p.derived).forEach(function (k) { metricsAll.push(p.derived[k]); }); if (p.soldShareBySite) metricsAll.push(p.soldShareBySite); });
    // Правило полноты: все ключи метрик профилей должны быть разложены по группам.
    const seenM = [];
    const seenD = [];
    rec.profiles.forEach(function (p) { Object.keys(p.metrics).forEach(function (k) { if (seenM.indexOf(k) < 0) seenM.push(k); }); Object.keys(p.derived).forEach(function (k) { if (seenD.indexOf(k) < 0) seenD.push(k); }); });
    if (rec.profiles.some(function (p) { return p.soldShareBySite; })) seenD.push('soldShareBySite');
    rec.completeness = completeness(seenM, seenD);
    const withValue = metricsAll.filter(function (m) { return m.value !== null; });
    rec.agg = {
      competitors: rec.profiles.length,
      lotsTotal: lots,
      lotsBySummary: s.lots_total !== undefined ? num(s.lots_total) : null,
      medianPerM2Market: medianOfMedians,
      medianPerM2Summary: s.price_per_m2_median !== undefined ? num(s.price_per_m2_median) : null,
      promosActive: rec.profiles.reduce(function (a, p) { return a + (p.metrics.promoCount.value || 0); }, 0),
      risks: rec.profiles.reduce(function (a, p) { return a + p.riskFlags.length; }, 0) + (Array.isArray(s.risk_flags) ? 0 : 0),
      lastRunAt: s.generated_at !== undefined && s.generated_at !== null ? String(s.generated_at) : (rec.profiles.map(function (p) { return p.collectedAt; }).filter(Boolean).sort().pop() || null),
      costRub: s.cost_rub !== undefined ? num(s.cost_rub) : null,
      metricsTotal: metricsAll.length,
      metricsWithValue: withValue.length,
      metricsWithSource: withValue.filter(function (m) { return !!m.source; }).length,
      metricsEstimate: withValue.filter(function (m) { return m.estimate; }).length,
      completeness: rec.completeness,
      uncovered: rec.completeness ? rec.completeness.uncovered : [],
    };
    out.profilesFound += rec.profiles.length;
    out.counts.profiles += rec.profiles.length;
    out.counts.lots += lots;
    out.counts.withPrice += prices.length;
    out.counts.withRisk += rec.agg.risks;
    out.counts.sourcesCovered += rec.agg.metricsWithSource;
    out.counts.metricsTotal += rec.agg.metricsTotal;
    out.clients.push(rec);
  });

  out.counts.clients = out.clients.length;
  out.newestMtimeMs = newest || null;
  try {
    const snapsRoot = path.join(PROJECT_DIR, '01-competitor-watch', 'data', 'snapshots');
    if (fs.existsSync(snapsRoot)) {
      const dates = fs.readdirSync(snapsRoot).filter(function (n) { return /^\d{4}-\d{2}-\d{2}$/.test(n); }).sort();
      out.snapshots = { dir: snapsRoot, dates: dates.slice(-5), last: dates[dates.length - 1] || null };
    } else out.snapshots = { dir: snapsRoot, dates: [], last: null };
  } catch (e) { out.snapshots = { dir: null, dates: [], last: null }; }
  if (out.profilesFound === 0 && !out.emptyReason) out.emptyReason = 'Профили конкурентов ещё не сформированы: движок не выполнял прогон профилирования.';
  return out;
}

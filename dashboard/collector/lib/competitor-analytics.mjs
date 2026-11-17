// Раздел «Аналитика»: результаты аналитики конкурентов от движка Агента 1 (WP2).
//
// КОНТРАКТ ФАЙЛА (подтверждён Lead, WP2 пишет по клиенту):
//   01-competitor-watch/reports/clients/<client-id>/.cache/analytics-<YYYY-MM-DD>.json
// Поля: schema_version, date, generated_at, client_id, toggles,
//   by_competitor[{project,developer,lots_on_sale,price_per_m2{min,median,max},sources}],
//   by_source[{source,lots_on_sale,median_price_per_m2,min,max}],
//   dynamics[{project,lots_new,lots_gone,median_delta_pct,period{prev,curr}}],
//   promos_new[{project,text,first_seen}], promos_known_count,
//   forecast[{project,metric,method,points,weeks,values[{week,value}],estimate}] | null,
//   email[{to,status,sent_at,file}], data_status[{source,status,reason}].
//
// ЧТЕНИЕ ТЕРПИМОЕ: движок может прислать не все поля и другие имена ключей — тогда
// соответствующая часть показывается как «данных нет» с причиной. Нулей вместо
// отсутствующих чисел панель НЕ подставляет.
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_DIR } from './paths.mjs';
import { parseYaml, parseScalar } from './yaml.mjs';

const CW_DIR = path.join(PROJECT_DIR, '01-competitor-watch');
// Папка с файлами аналитики движка. Переопределяется только для автотестов панели:
// так проверяется подхват файла без записи в 01-competitor-watch (зона движка).
const CLIENTS_REPORTS_DIR = process.env.DASHBOARD_CW_CLIENTS_REPORTS_DIR && process.env.DASHBOARD_CW_CLIENTS_REPORTS_DIR.trim() !== ''
  ? process.env.DASHBOARD_CW_CLIENTS_REPORTS_DIR
  : path.join(CW_DIR, 'reports', 'clients');

// КЛИЕНТСКИЕ КОНФИГИ — ИСТИНА списка конкурентов (контракт v2, §5.1).
// Переопределяется только для автотестов панели: e2e-проверка add/remove идёт
// на КОПИИ конфига во временном каталоге, реальный client-*.yaml не меняется.
const CLIENTS_DIR = process.env.DASHBOARD_CW_CLIENTS_DIR && process.env.DASHBOARD_CW_CLIENTS_DIR.trim() !== ''
  ? process.env.DASHBOARD_CW_CLIENTS_DIR
  : path.join(CW_DIR, 'config', 'clients');

function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } }

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}
function str(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}
function arr(v) { return Array.isArray(v) ? v : []; }
function pick(o, keys) {
  for (const k of keys) if (o && o[k] !== undefined && o[k] !== null) return o[k];
  return undefined;
}

// Медиана из набора чисел — считаем сами, когда движок отдал список значений.
export function medianOf(list) {
  const v = list.filter(function (x) { return typeof x === 'number' && isFinite(x); }).sort(function (a, b) { return a - b; });
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : Math.round(((v[mid - 1] + v[mid]) / 2) * 100) / 100;
}

function normPrice(m) {
  if (!m || typeof m !== 'object') return { min: null, median: null, max: null, unit: '₽/м²' };
  return {
    min: num(pick(m, ['min', 'min_price_per_m2', 'price_min_per_m2', 'min_price_m2'])),
    median: num(pick(m, ['median', 'median_price_per_m2', 'median_price_m2', 'price_per_m2_median'])),
    max: num(pick(m, ['max', 'max_price_per_m2', 'price_max_per_m2', 'max_price_m2'])),
    unit: str(m.unit) || '₽/м²',
  };
}

function normCompetitor(c) {
  const p = pick(c, ['price_per_m2', 'pricePerM2', 'price']);
  return {
    project: str(pick(c, ['project', 'project_id', 'name'])) || '—',
    developer: str(pick(c, ['developer', 'builder'])),
    lotsOnSale: num(pick(c, ['lots_on_sale', 'lotsOnSale', 'lots', 'lots_total', 'lots_sale'])),
    pricePerM2: normPrice(p),
    sources: arr(pick(c, ['sources', 'by_source'])).map(function (s) { return str(s) || (s && str(s.source)) || null; }).filter(Boolean),
  };
}

function normSource(s) {
  return {
    source: str(pick(s, ['source', 'site', 'platform'])) || '—',
    lotsOnSale: num(pick(s, ['lots_on_sale', 'lotsOnSale', 'lots', 'lots_total'])),
    medianPricePerM2: num(pick(s, ['median_price_per_m2', 'medianPricePerM2', 'median', 'price_per_m2_median'])),
    min: num(pick(s, ['min', 'min_price_per_m2'])),
    max: num(pick(s, ['max', 'max_price_per_m2'])),
  };
}

function normDynamics(d) {
  const period = d && typeof d.period === 'object' && d.period ? d.period : {};
  return {
    project: str(pick(d, ['project', 'project_id', 'name'])) || '—',
    lotsNew: num(pick(d, ['lots_new', 'lotsNew', 'new_lots'])),
    lotsGone: num(pick(d, ['lots_gone', 'lotsGone', 'gone_lots'])),
    medianDeltaPct: num(pick(d, ['median_delta_pct', 'medianDeltaPct', 'delta_pct', 'median_delta'])),
    periodPrev: str(pick(period, ['prev', 'previous'])) || str(pick(d, ['period_prev', 'prev'])),
    periodCurr: str(pick(period, ['curr', 'current'])) || str(pick(d, ['period_curr', 'curr'])),
  };
}

function normPromo(p) {
  return {
    project: str(pick(p, ['project', 'project_id', 'name'])) || '—',
    text: str(pick(p, ['text', 'promo', 'title'])) || '—',
    firstSeen: str(pick(p, ['first_seen', 'firstSeen', 'date'])) ,
  };
}

// Прогноз: честная модель обязана назвать метод, число точек и пометить себя оценкой.
function normForecast(f) {
  const values = arr(pick(f, ['values', 'points_values'])).map(function (v) {
    if (v && typeof v === 'object') return { week: str(pick(v, ['week', 'date'])) || '—', value: num(pick(v, ['value', 'v'])) };
    return { week: '—', value: num(v) };
  });
  return {
    project: str(pick(f, ['project', 'project_id', 'name'])) || '—',
    metric: str(pick(f, ['metric', 'key'])) || 'медиана ₽/м²',
    method: str(pick(f, ['method', 'model'])) ,
    points: num(pick(f, ['points', 'history_points', 'n'])),
    weeks: num(pick(f, ['weeks', 'horizon'])) ,
    values: values,
    estimate: f && (f.estimate === true || f.estimate === 'true') ? true : false,
    note: str(pick(f, ['note', 'comment'])),
  };
}

function readClientFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

// --- ТЕРПИМОЕ ЧТЕНИЕ СЕКЦИИ competitors КЛИЕНТСКОГО КОНФИГА ---------------------------
// Обычный YAML-парсер МОЛЧА отбрасывает запись, вложенную глубже канонического отступа
// (баг данных: «ЖК Нарвин» в client-svet.yaml на 4 пробела). Тогда конкурент пропадал
// бы из истины незаметно. Поэтому читаем секцию построчно, каждую запись разбираем
// отдельно и помечаем записи с битым отступом — панель скажет об этом словами.
function competitorSection(lines) {
  let start = -1, indent = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)competitors\s*:\s*(#.*)?$/.exec(lines[i]);
    if (m) { start = i; indent = m[1].length; break; }
  }
  if (start < 0) return null;
  // Конец секции — последняя строка, реально принадлежащая ей (отступ глубже секции).
  // Комментарии уровня файла после списка в секцию не входят: так их нельзя случайно
  // принять за записи конкурентов.
  let lastOwned = start;
  for (let i = lines.length - 1; i > start; i--) {
    const line = lines[i];
    if (line.trim() === '') continue;
    if (line.match(/^ */)[0].length > indent) { lastOwned = i; break; }
  }
  return { start: start, end: lastOwned + 1, indent: indent };
}

function recordOfBlock(block) {
  const first = String(block[0] || '').replace(/^\s*-\s*/, '').trim();
  if (first.charAt(0) === '{') {
    try { const o = parseScalar(first); if (o && typeof o === 'object' && !Array.isArray(o)) return o; } catch (e) { /* ignore */ }
  }
  // Дефис заменяем на пробелы ТОЙ ЖЕ ширины: иначе продолжение записи (поля ниже дефиса)
  // оказывается глубже её первой строки, и разбор вернул бы только name.
  const shifted = block.map(function (l, i) {
    if (i !== 0) return l;
    return l.replace(/^(\s*)-( +|$)/, '$1 $2');
  });
  try {
    const o = parseYaml(shifted.join('\n'));
    if (o && typeof o === 'object' && !Array.isArray(o)) return o;
  } catch (e) { /* ignore */ }
  return null;
}

// { records: [...], total, canonicalIndent, brokenIndent, brokenNames: [...] }
function readCompetitorsSection(text) {
  const lines = String(text).split(/\r?\n/);
  const sec = competitorSection(lines);
  if (!sec) return { records: [], total: 0, canonicalIndent: null, brokenIndent: 0, brokenNames: [] };
  const starts = [];
  for (let i = sec.start + 1; i < sec.end; i++) {
    if (/^\s*-\s/.test(lines[i]) || /^\s*-\s*$/.test(lines[i])) starts.push({ i: i, indent: lines[i].match(/^ */)[0].length });
  }
  if (!starts.length) return { records: [], total: 0, canonicalIndent: null, brokenIndent: 0, brokenNames: [] };
  const canonical = Math.min.apply(null, starts.map(function (s) { return s.indent; }));
  const records = [];
  const brokenNames = [];
  starts.forEach(function (s, idx) {
    const end = idx + 1 < starts.length ? starts[idx + 1].i : sec.end;
    const rec = recordOfBlock(lines.slice(s.i, end));
    if (!rec) return;
    const nm = str(pick(rec, ['name', 'project', 'title']));
    const idv = str(pick(rec, ['id', 'key']));
    if (!nm && !idv) return;   // не запись конкурента (например, вложенный список ссылок)
    const broken = s.indent !== canonical;
    if (broken) brokenNames.push(nm || idv);
    records.push({ rec: rec, indent: s.indent, indentBroken: broken });
  });
  return { records: records, total: starts.length, canonicalIndent: canonical, brokenIndent: brokenNames.length, brokenNames: brokenNames };
}

// Новейший файл аналитики по клиенту: сначала по дате в имени, потом по mtime.
function newestAnalyticsFor(clientDir) {
  const cache = path.join(clientDir, '.cache');
  const candidates = [];
  [cache, clientDir].forEach(function (dir) {
    if (!isDir(dir)) return;
    let names = [];
    try { names = fs.readdirSync(dir); } catch (e) { return; }
    names.forEach(function (n) {
      const m = /^analytics-(\d{4}-\d{2}-\d{2})\.json$/.exec(n);
      if (!m && n !== 'analytics.json') return;
      const full = path.join(dir, n);
      try {
        const st = fs.statSync(full);
        if (!st.isFile()) return;
        candidates.push({ file: full, fileName: n, date: m ? m[1] : null, mtimeMs: st.mtimeMs });
      } catch (e) { /* ignore */ }
    });
  });
  candidates.sort(function (a, b) {
    const ad = a.date || '', bd = b.date || '';
    if (ad !== bd) return ad < bd ? -1 : 1;
    return (a.mtimeMs || 0) < (b.mtimeMs || 0) ? -1 : 1;
  });
  return candidates.slice(-1)[0] || null;
}

function emailStatusOf(address, engineEmail, serviceResults) {
  const a = String(address).toLowerCase();
  const eng = arr(engineEmail).filter(function (e) { return str(pick(e, ['to', 'address', 'email'])) && String(pick(e, ['to', 'address', 'email'])).toLowerCase() === a; })[0];
  if (eng) {
    return {
      address: String(address),
      status: str(pick(eng, ['status', 'state'])) || 'неизвестно',
      at: str(pick(eng, ['sentAt', 'sent_at', 'at', 'date'])),
      file: str(pick(eng, ['file', 'eml', 'attachment'])),
      evidence: 'файл аналитики движка (email[])',
    };
  }
  const res = arr(serviceResults).filter(function (r) { return String(r.sentChannel) === 'email' && String(r.sentTo || '').toLowerCase().indexOf(a) >= 0; })
    .sort(function (x, y) { return (Date.parse(y.sentAt || y.created || '') || 0) - (Date.parse(x.sentAt || x.created || '') || 0); })[0];
  if (res) {
    return { address: String(address), status: res.sentStatus || 'неизвестно', at: res.sentAt || res.created || null, file: (res.artifacts || [])[0] || null, evidence: 'registry/results.yaml (' + res.id + ')' };
  }
  return { address: String(address), status: 'нет подтверждения отправки', at: null, file: null, evidence: 'нет подтверждения отправки: ни в файле аналитики движка, ни в registry/results.yaml записи для этого адреса нет' };
}

// ---------------------------------------------------------------------------
// ИСТИННЫЙ СПИСОК КОНКУРЕНТОВ (контракт v2, §5.1) и метрики карточки (§5.3).
// Истина — только клиентский конфиг 01-competitor-watch/config/clients/<client>.yaml.
// Панель ничего не придумывает: нет файла или списка — числа null и причина словами.
// ---------------------------------------------------------------------------

function slugOf(s) {
  const t = String(s === null || s === undefined ? '' : s).toLowerCase()
    .replace(/[^a-z0-9а-яё]+/gi, '-').replace(/^-+|-+$/g, '');
  return t || '';
}

function normNameKey(s) {
  return String(s === null || s === undefined ? '' : s).toLowerCase()
    .replace(/[«»"'`]/g, '').replace(/\s+/g, ' ').trim();
}

// Площадки записи: сохраняем то, что записано в конфиге (пустая строка = «ссылки нет»).
function normPlatformsValue(p) {
  const out = {};
  if (p && typeof p === 'object' && !Array.isArray(p)) {
    Object.keys(p).forEach(function (k) {
      const key = String(k).toLowerCase().replace(/-/g, '_');
      out[key] = str(p[k]) || '';
    });
  } else if (Array.isArray(p)) {
    p.forEach(function (x) {
      const key = str(x && typeof x === 'object' ? (x.platform || x.source) : x);
      if (key) out[String(key).toLowerCase().replace(/-/g, '_')] = str(x && typeof x === 'object' ? (x.url || x.link) : null) || '';
    });
  }
  ['cian', 'avito', 'yandex_realty', 'domclick'].forEach(function (k) { if (out[k] === undefined) out[k] = ''; });
  return out;
}

function platformsHaveLink(p) {
  return Object.keys(p || {}).some(function (k) { return str(p[k]) !== null; });
}

// Ключи сопоставления записи аналитики с записью истины: точное имя (нормализованное)
// и слаг имени. Сверка строгая — иначе конкурент считался бы «с данными» зря.
function projectKeys(project) {
  const out = [];
  const n = normNameKey(project); if (n) out.push('n:' + n);
  const s = slugOf(project); if (s) out.push('s:' + s);
  return out;
}

function buildTruth(clientId, byCompetitor, analyticsExists, engineWithData) {
  const file = path.join(CLIENTS_DIR, clientId + '.yaml');
  const truth = {
    clientId: clientId, file: file, fileName: clientId + '.yaml', exists: false, read: false,
    competitors: null, withData: null, withoutSource: null, list: [], reason: null,
  };
  if (!fs.existsSync(file)) {
    truth.reason = 'Клиентский конфиг ' + clientId + '.yaml не найден (проверено ' + CLIENTS_DIR + ') — истинный список конкурентов прочитать неоткуда: «данных нет», не ноль.';
    return truth;
  }
  truth.exists = true;
  const text = (function () { try { return fs.readFileSync(file, 'utf8'); } catch (e) { return null; } })();
  if (text === null) {
    truth.reason = 'Файл ' + clientId + '.yaml найден, но не читается — числа истины не показываем.';
    return truth;
  }
  const parsed = readCompetitorsSection(text);
  if (!parsed.total && !parsed.records.length) {
    truth.reason = 'Файл ' + clientId + '.yaml найден, но список competitors[] не разобран — числа истины не показываем, чтобы не выдумывать.';
    return truth;
  }
  truth.read = true;
  truth.brokenIndent = parsed.brokenIndent;
  truth.brokenIndentNames = parsed.brokenNames;
  if (parsed.brokenIndent) {
    truth.note = 'В конфиге ' + parsed.brokenIndent + ' запись(ей) с битым отступом (' + parsed.brokenNames.join(', ')
      + '): строгий YAML не разбирает файл, а движок такую запись в анализ не берёт. Нужна правка конфига (решает Lead).';
  }
  const used = {};
  const list = [];
  parsed.records.forEach(function (entry) {
    const c = entry.rec;
    if (!c || typeof c !== 'object' || Array.isArray(c)) return;
    const name = str(pick(c, ['name', 'project', 'title']));
    if (!name) return;   // записи без названия не выдумываем имя
    let id = str(pick(c, ['id', 'key']));
    if (!id) id = slugOf(name) || ('competitor-' + (list.length + 1));
    if (used[id]) { let n = 2; while (used[id + '-' + n]) n++; id = id + '-' + n; }
    used[id] = true;
    const platforms = normPlatformsValue(pick(c, ['platforms', 'links', 'platform_links']));
    const site = str(pick(c, ['site', 'url', 'website']));
    const klass = str(pick(c, ['class', 'klass', 'segment']));
    list.push({
      id: id, name: name, developer: str(pick(c, ['developer', 'builder'])),
      klass: klass, class: klass, site: site, platforms: platforms,
      hasSource: !!site || platformsHaveLink(platforms),
      indentBroken: entry.indentBroken === true,
    });
  });
  truth.list = list;
  truth.competitors = list.length;
  truth.withoutSource = list.filter(function (r) { return !r.hasSource; }).length;
  if (engineWithData !== null) {
    truth.withData = engineWithData;
    truth.withDataSource = 'metrics.competitorsWithData из analytics-<дата>.json (движок)';
    return truth;
  }
  if (!analyticsExists) {
    truth.withData = null;
    truth.withDataReason = 'Файла аналитики движка нет — сколько конкурентов дали данные, неизвестно.';
    return truth;
  }
  const keys = {};
  arr(byCompetitor).forEach(function (bc) { projectKeys(bc && bc.project).forEach(function (k) { keys[k] = true; }); });
  truth.withData = list.filter(function (r) {
    const cand = [];
    const n = normNameKey(r.name); if (n) cand.push('n:' + n);
    const s = slugOf(r.name); if (s) cand.push('s:' + s);
    const idn = normNameKey(r.id); if (idn) cand.push('n:' + idn);
    return cand.some(function (k) { return keys[k]; });
  }).length;
  truth.withDataSource = 'сверка truth.list с by_competitor файла аналитики (имя/слаг): движок ещё не прислал metrics.competitorsWithData';
  return truth;
}

// Метрики §5.3: движок обязан отдать их в analytics-<дата>.json (metrics).
// Панель их только читает и НЕ досчитывает: нет числа — null, а не 0.
function engineMetrics(doc) {
  const m = doc && doc.metrics && typeof doc.metrics === 'object' ? doc.metrics : {};
  return {
    competitorsInAnalysis: num(pick(m, ['competitorsInAnalysis', 'competitors_in_analysis'])),
    competitorsWithData: num(pick(m, ['competitorsWithData', 'competitors_with_data'])),
    lotsAnalyzed: num(pick(m, ['lotsAnalyzed', 'lots_analyzed'])),
    cheapestLotRub: num(pick(m, ['cheapestLotRub', 'cheapest_lot_rub'])),
  };
}

function attachTruthAndMetrics(out, doc, warnings) {
  const engine = engineMetrics(doc);
  const truth = buildTruth(out.clientId, out.byCompetitor, out.exists, engine.competitorsWithData);
  out.truth = truth;
  out.metrics = {
    // «конкурентов в анализе» — ЧИСЛО ДВИЖКА из analytics-<дата>.json (сколько реально взято
    // в анализ). Весь истинный список подставлять нельзя: записи без site/platforms движок
    // в анализ не берёт, и в разговоре с клиентом получались бы два разных числа об одном.
    // Если файла аналитики нет — считаем сами: истинный список минус записи без источника.
    competitorsInAnalysis: engine.competitorsInAnalysis !== null
      ? engine.competitorsInAnalysis
      : ((truth.competitors !== null && truth.withoutSource !== null) ? Math.max(0, truth.competitors - truth.withoutSource) : null),
    // «с данными» — из metrics движка; если движок не прислал, считаем по by_competitor (помечено в truth.withDataSource).
    competitorsWithData: truth.withData !== null ? truth.withData : engine.competitorsWithData,
    lotsAnalyzed: engine.lotsAnalyzed,
    cheapestLotRub: engine.cheapestLotRub,
  };
  out.metrics.competitorsInAnalysisSource = engine.competitorsInAnalysis !== null
    ? 'metrics.competitorsInAnalysis из analytics-<дата>.json (движок)'
    : ((truth.competitors !== null && truth.withoutSource !== null)
      ? ('файла аналитики движка нет: истинный список ' + truth.competitors + ' минус записи без источника ' + truth.withoutSource + ' = ' + Math.max(0, truth.competitors - truth.withoutSource))
      : null);
  out.metrics.lotsAnalyzedSource = engine.lotsAnalyzed !== null ? 'metrics.lotsAnalyzed из analytics-<дата>.json' : null;
  out.metrics.cheapestLotRubSource = engine.cheapestLotRub !== null ? 'metrics.cheapestLotRub из analytics-<дата>.json' : null;
  if (truth.withData !== null && truth.competitors !== null && truth.withData > truth.competitors) {
    warnings.push('competitor-analytics/' + out.clientId + ': «с данными» (' + truth.withData + ') больше истинного списка (' + truth.competitors + ') — числа движка и клиентского конфига расходятся, панель ничего не подгоняет');
  }
  if (truth.brokenIndent) {
    warnings.push('клиентский конфиг ' + out.clientId + '.yaml: ' + truth.brokenIndent + ' запись(ей) с битым отступом (' + truth.brokenIndentNames.join(', ') + ') — движок их не видит, нужна правка конфига (решает Lead)');
  }
  return out;
}

function normalizeClient(clientId, fileInfo, doc, warnings) {
  const out = {
    clientId: clientId,
    file: fileInfo ? fileInfo.file : null,
    fileName: fileInfo ? fileInfo.fileName : null,
    mtimeMs: fileInfo ? fileInfo.mtimeMs : null,
    exists: !!doc,
    date: null, generatedAt: null, schemaVersion: null, toggles: null,
    byCompetitor: [], bySource: [], dynamics: [], promosNew: [], promosKnownCount: null,
    forecast: null, forecastReason: null, email: [], dataStatus: [],
    lotsOnSale: null, lotsByCompetitor: null, lotsBySource: null,
    medians: { byCompetitor: [], bySource: [] },
    emptyReason: null,
    consistency: { ok: true, notes: [] },
  };
  if (!doc) {
    // Два РАЗНЫХ случая пустоты, и путать их нельзя:
    //  1) файла аналитики нет вообще (fileInfo === null) — движок ещё не положил результат;
    //  2) файл есть, но не разобрался как JSON — данные не показываем, чтобы не выдумывать.
    out.emptyReason = fileInfo
      ? 'Файл аналитики ' + fileInfo.fileName + ' найден, но не разобрался как JSON — данные не показываем, чтобы не выдумывать.'
      : 'Файлы аналитики движка не найдены: в .cache клиента «' + clientId + '» нет ни одного analytics-<ГГГГ-ММ-ДД>.json (проверено ' + path.join('01-competitor-watch', 'reports', 'clients', clientId, '.cache') + '). Движок (WP2) ещё не положил результаты — панель не подставляет цифры.';
    if (fileInfo) warnings.push('analytics ' + fileInfo.fileName + ': файл не разобрался как JSON');
    return attachTruthAndMetrics(out, null, warnings);
  }
  out.date = str(pick(doc, ['date', 'snapshot_date']));
  out.generatedAt = str(pick(doc, ['generated_at', 'generatedAt']));
  out.schemaVersion = num(pick(doc, ['schema_version', 'schemaVersion']));
  out.toggles = (doc.toggles && typeof doc.toggles === 'object') ? doc.toggles : null;
  out.byCompetitor = arr(pick(doc, ['by_competitor', 'byCompetitor', 'competitors'])).map(normCompetitor);
  out.bySource = arr(pick(doc, ['by_source', 'bySource', 'sources'])).map(normSource);
  out.dynamics = arr(pick(doc, ['dynamics', 'changes'])).map(normDynamics);
  out.promosNew = arr(pick(doc, ['promos_new', 'promosNew', 'new_promos'])).map(normPromo);
  out.promosKnownCount = num(pick(doc, ['promos_known_count', 'promosKnownCount']));
  const fc = pick(doc, ['forecast']);
  out.forecast = Array.isArray(fc) && fc.length ? fc.map(normForecast) : null;
  if (!out.forecast) out.forecastReason = str(pick(doc, ['forecast_reason', 'forecastReason'])) || 'движок не прислал прогноз (тумблер forecast выключен или истории меньше трёх точек)';
  out.email = arr(pick(doc, ['email', 'emails', 'email_status'])).map(function (e) {
    return { to: str(pick(e, ['to', 'address', 'email'])), status: str(pick(e, ['status', 'state'])), sentAt: str(pick(e, ['sent_at', 'at'])), file: str(pick(e, ['file', 'eml'])) };
  }).filter(function (e) { return e.to; });
  out.dataStatus = arr(pick(doc, ['data_status', 'dataStatus'])).map(function (s) {
    return { source: str(pick(s, ['source', 'name'])) || '—', status: str(pick(s, ['status', 'state'])) || '—', reason: str(pick(s, ['reason', 'comment', 'note'])) };
  });

  // Итоги: складываем только реально пришедшие числа; null остаётся null.
  const compLots = out.byCompetitor.map(function (c) { return c.lotsOnSale; }).filter(function (v) { return v !== null; });
  const srcLots = out.bySource.map(function (s) { return s.lotsOnSale; }).filter(function (v) { return v !== null; });
  out.lotsByCompetitor = compLots.length ? compLots.reduce(function (a, b) { return a + b; }, 0) : null;
  out.lotsBySource = srcLots.length ? srcLots.reduce(function (a, b) { return a + b; }, 0) : null;
  out.lotsOnSale = num(pick(doc, ['lots_on_sale', 'lotsOnSale', 'lots_total'])) ;
  if (out.lotsOnSale === null) out.lotsOnSale = out.lotsByCompetitor;
  out.medians.byCompetitor = out.byCompetitor.map(function (c) { return { project: c.project, median: c.pricePerM2.median, min: c.pricePerM2.min, max: c.pricePerM2.max, unit: c.pricePerM2.unit }; });
  out.medians.bySource = out.bySource.map(function (s) { return { source: s.source, median: s.medianPricePerM2, min: s.min, max: s.max, unit: '₽/м²' }; });

  // ВНУТРЕННЯЯ СВЯЗНОСТЬ: сумма частей обязана сходиться с итогом, медиана — лежать в [min,max].
  if (out.lotsOnSale !== null && out.lotsByCompetitor !== null && out.lotsByCompetitor !== out.lotsOnSale) {
    out.consistency.ok = false;
    out.consistency.notes.push('сумма лотов по конкурентам ' + out.lotsByCompetitor + ' ≠ итогу ' + out.lotsOnSale);
  }
  if (out.lotsBySource !== null && out.lotsByCompetitor !== null && out.lotsBySource !== out.lotsByCompetitor) {
    out.consistency.notes.push('сумма лотов по источникам ' + out.lotsBySource + ' ≠ сумме по конкурентам ' + out.lotsByCompetitor);
  }
  out.byCompetitor.forEach(function (c) {
    const p = c.pricePerM2;
    if (p.median !== null && p.min !== null && p.median < p.min) { out.consistency.ok = false; out.consistency.notes.push('«' + c.project + '»: медиана ' + p.median + ' меньше минимума ' + p.min); }
    if (p.median !== null && p.max !== null && p.median > p.max) { out.consistency.ok = false; out.consistency.notes.push('«' + c.project + '»: медиана ' + p.median + ' больше максимума ' + p.max); }
  });
  if (out.byCompetitor.length === 0 && out.bySource.length === 0 && out.lotsOnSale === null) {
    out.emptyReason = str(pick(doc, ['empty_reason', 'emptyReason', 'reason'])) || 'Движок прислал файл, но без разобранных блоков аналитики (по конкурентам и по источникам) — показывать нечего.';
  }
  return attachTruthAndMetrics(out, doc, warnings);
}

export function loadCompetitorAnalytics(ctx) {
  const warnings = [];
  const c = ctx || {};
  const out = {
    generatedAtMs: Date.now(),
    dir: CLIENTS_REPORTS_DIR,
    exists: false,
    clients: [],
    totals: {
      clients: 0, clientsWithData: 0, lotsOnSale: null, competitors: 0, sources: 0, promosNew: 0, forecasts: 0,
      // контракт v2 (§5.3): истина и метрики карточки; null = «данных нет», не 0.
      // competitorsInAnalysis — то же число, что у клиента в metrics (движок), competitorsInList — весь список.
      competitorsInAnalysis: null, competitorsInList: null, withData: null, withoutSource: null, lotsAnalyzed: null, cheapestLotRub: null,
    },
    emptyReason: null,
    newestMtimeMs: null,
    crossCheck: { comparedProjects: 0, matched: 0, mismatched: [], reportLotsTotal: null, analyticsLotsTotal: null, ok: null, note: null },
    email: { channelEnabled: false, addresses: [], recipients: [], note: null },
    sources: [],
    warnings: warnings,
  };

  let clientIds = [];
  if (isDir(CLIENTS_REPORTS_DIR)) {
    try {
      clientIds = fs.readdirSync(CLIENTS_REPORTS_DIR).filter(function (n) { return isDir(path.join(CLIENTS_REPORTS_DIR, n)) && n.indexOf('_') !== 0; }).sort();
    } catch (e) { /* ignore */ }
  }
  out.exists = clientIds.length > 0;

  let newest = 0;
  clientIds.forEach(function (clientId) {
    const clientDir = path.join(CLIENTS_REPORTS_DIR, clientId);
    const fileInfo = newestAnalyticsFor(clientDir);
    if (fileInfo) {
      if (fileInfo.mtimeMs > newest) newest = fileInfo.mtimeMs;
      const doc = readClientFile(fileInfo.file);
      // Предупреждение о битом JSON добавляет сам normalizeClient — здесь не дублируем.
      out.clients.push(normalizeClient(clientId, fileInfo, doc, warnings));
      return;
    }
    out.clients.push(normalizeClient(clientId, null, null, warnings));
  });
  // Истина не должна зависеть от файлов аналитики движка: клиент, у которого есть
  // клиентский конфиг (истинный список конкурентов), но ещё нет .cache, обязан быть
  // виден — с честным «файлов аналитики нет», а не отсутствовать молча.
  let configIds = [];
  if (isDir(CLIENTS_DIR)) {
    try {
      configIds = fs.readdirSync(CLIENTS_DIR)
        .filter(function (n) { return /\.yaml$/i.test(n) && n.indexOf('.') !== 0; })
        .map(function (n) { return n.replace(/\.ya?ml$/i, ''); });
    } catch (e) { /* ignore */ }
  }
  const known = {};
  out.clients.forEach(function (x) { known[x.clientId] = true; });
  configIds.forEach(function (id) {
    if (known[id]) return;
    known[id] = true;
    out.clients.push(normalizeClient(id, null, null, warnings));
  });
  out.clients.sort(function (a, b) { return a.clientId < b.clientId ? -1 : (a.clientId > b.clientId ? 1 : 0); });
  out.newestMtimeMs = newest || null;

  const withData = out.clients.filter(function (x) { return x.exists && (x.byCompetitor.length || x.bySource.length || x.lotsOnSale !== null); });
  out.totals.clients = out.clients.length;
  out.totals.clientsWithData = withData.length;
  const lotVals = out.clients.map(function (x) { return x.lotsOnSale; }).filter(function (v) { return v !== null; });
  out.totals.lotsOnSale = lotVals.length ? lotVals.reduce(function (a, b) { return a + b; }, 0) : null;
  // ВНИМАНИЕ: totals.competitors оставлен прежним (сумма по by_competitor файлов аналитики),
  // чтобы не менять смысл для уже готовых экранов. Новые ключи контракта v2 (§5.3) добавлены рядом.
  out.totals.competitors = out.clients.reduce(function (a, x) { return a + x.byCompetitor.length; }, 0);
  out.totals.sources = out.clients.reduce(function (a, x) { return a + x.bySource.length; }, 0);
  out.totals.promosNew = out.clients.reduce(function (a, x) { return a + x.promosNew.length; }, 0);
  out.totals.forecasts = out.clients.reduce(function (a, x) { return a + (x.forecast ? x.forecast.length : 0); }, 0);
  // §5.3: истина и метрики карточки. Число неизвестно хотя бы у одного клиента → null, не 0.
  function sumKnown(values) {
    const v = values.filter(function (x) { return typeof x === 'number' && isFinite(x); });
    return v.length ? v.reduce(function (a, b) { return a + b; }, 0) : null;
  }
  // «конкурентов в анализе» — сумма по клиентам того же числа, что у каждого клиента в metrics
  // (число движка, а без аналитики — список минус записи без источника). Весь список — отдельный ключ.
  out.totals.competitorsInAnalysis = sumKnown(out.clients.map(function (x) { return x.metrics ? x.metrics.competitorsInAnalysis : null; }));
  out.totals.competitorsInList = sumKnown(out.clients.map(function (x) { return x.truth ? x.truth.competitors : null; }));
  out.totals.withData = sumKnown(out.clients.map(function (x) { return x.truth ? x.truth.withData : null; }));
  out.totals.withoutSource = sumKnown(out.clients.map(function (x) { return x.truth ? x.truth.withoutSource : null; }));
  out.totals.lotsAnalyzed = sumKnown(out.clients.map(function (x) { return x.metrics ? x.metrics.lotsAnalyzed : null; }));
  const cheapVals = out.clients.map(function (x) { return x.metrics ? x.metrics.cheapestLotRub : null; }).filter(function (v) { return typeof v === 'number' && isFinite(v); });
  out.totals.cheapestLotRub = cheapVals.length ? Math.min.apply(null, cheapVals) : null;
  out.truthSources = [
    { id: 'clients-config', label: 'Истинный список конкурентов (клиентские конфиги)', path: path.join(CLIENTS_DIR, '*.yaml'), exists: configIds.length > 0, items: configIds.length, note: configIds.length ? ('клиентов с конфигом: ' + configIds.length + ', записей в списках: ' + (out.totals.competitorsInList === null ? 'данных нет' : out.totals.competitorsInList) + ', из них без источника: ' + (out.totals.withoutSource === null ? 'данных нет' : out.totals.withoutSource)) : 'клиентских конфигов не найдено — истинного списка конкурентов нет' },
  ];

  out.sources = [
    { id: 'analytics-cache', label: 'Аналитика конкурентов от движка (по клиентам)', path: path.join(CLIENTS_REPORTS_DIR, '*', '.cache', 'analytics-<дата>.json'), exists: out.exists, items: withData.length, note: withData.length ? ('клиентов с данными: ' + withData.length + ' из ' + out.clients.length) : 'файлов аналитики движка ещё нет' },
  ];
  if (!out.exists) {
    out.emptyReason = 'Папка reports/clients ещё не создана: движок Агента 1 не выполнял прогон по клиентам.';
  } else if (withData.length === 0) {
    out.emptyReason = 'Файлы аналитики движка не найдены: проверено ' + out.clients.length + ' клиент(ов) в ' + path.join('01-competitor-watch', 'reports', 'clients', '*', '.cache') + ' (ожидается analytics-<ГГГГ-ММ-ДД>.json). Движок (WP2) ещё не положил результаты — панель не подставляет цифры.';
  }

  // --- СВЯЗНОСТЬ с профилями конкурентов (competitor-report.json) ---
  const cr = c.competitorReport;
  if (withData.length === 0) {
    out.crossCheck.note = 'Сравнение с профилями конкурентов не выполняется: данных аналитики от движка ещё нет.';
  } else if (!cr || cr.profilesFound === 0) {
    out.crossCheck.note = 'Сравнение с профилями конкурентов не выполняется: профили (competitor-report.json) ещё не сформированы.';
  }
  if (cr && cr.profilesFound > 0 && withData.length > 0) {
    const reportByProject = {};
    let reportTotal = 0;
    cr.clients.filter(function (x) { return x.profiles.length; }).forEach(function (cl) {
      cl.profiles.forEach(function (p) {
        const v = p.metrics && p.metrics.lotsInSale ? p.metrics.lotsInSale.value : null;
        if (v !== null && v !== undefined) { reportByProject[p.project] = (reportByProject[p.project] || 0) + Number(v); reportTotal += Number(v); }
      });
    });
    const analyticsByProject = {};
    let analyticsTotal = 0;
    withData.forEach(function (x) {
      x.byCompetitor.forEach(function (pc) {
        if (pc.lotsOnSale === null) return;
        analyticsByProject[pc.project] = (analyticsByProject[pc.project] || 0) + pc.lotsOnSale;
        analyticsTotal += pc.lotsOnSale;
      });
    });
    const projects = Object.keys(reportByProject).filter(function (k) { return analyticsByProject[k] !== undefined; });
    const mismatched = projects.filter(function (k) { return reportByProject[k] !== analyticsByProject[k]; })
      .map(function (k) { return { project: k, reportLots: reportByProject[k], analyticsLots: analyticsByProject[k] }; });
    out.crossCheck = {
      comparedProjects: projects.length,
      matched: projects.length - mismatched.length,
      mismatched: mismatched,
      reportLotsTotal: reportTotal,
      analyticsLotsTotal: analyticsTotal,
      ok: mismatched.length === 0,
      note: mismatched.length
        ? ('Лоты в продаже расходятся по ' + mismatched.length + ' проект(ам): ' + mismatched.slice(0, 3).map(function (m) { return '«' + m.project + '» ' + m.reportLots + ' (профили) / ' + m.analyticsLots + ' (аналитика)'; }).join('; ') + '. Разные моменты сбора и охват источников — цифры не подгоняем.')
        : ('Лоты в продаже сходятся с профилями конкурентов по ' + projects.length + ' проект(ам).'),
    };
  }

  // --- СТАТУС ОТПРАВКИ НА ПОЧТУ ПО КАЖДОМУ ПОЛУЧАТЕЛЮ ---
  const aset = c.agentSettings;
  const rec = aset && aset.byAgent ? aset.byAgent['agent-1-competitor-watch'] : null;
  const delivery = rec && rec.delivery ? rec.delivery : {};
  const channels = Array.isArray(delivery.channels) ? delivery.channels.map(String) : [];
  const addresses = Array.isArray(delivery.addresses) ? delivery.addresses.map(String) : [];
  const emails = addresses.filter(function (a) { return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a); });
  const engineEmail = out.clients.reduce(function (a, x) { return a.concat(x.email); }, []);
  out.email.channelEnabled = channels.indexOf('email') >= 0;
  out.email.addresses = emails;
  out.email.otherAddresses = addresses.filter(function (a) { return emails.indexOf(a) < 0; });
  out.email.recipients = emails.map(function (a) { return emailStatusOf(a, engineEmail, c.serviceResults); });
  out.email.note = emails.length === 0
    ? 'Адреса почты не заданы в registry/agent-settings/agent-1-competitor-watch.yaml (delivery.addresses) — отправлять некому.'
    : (!out.email.channelEnabled
      ? 'Канал email не включён в delivery.channels — письма не уйдут, пока канал не включён.'
      : 'Статус берётся из файла аналитики движка (email[]), при его отсутствии — из registry/results.yaml.'
        + (out.email.otherAddresses.length ? ' Не почтовые адреса (' + out.email.otherAddresses.join(', ') + ') в этот список не входят: у них свой канал доставки.' : ''));

  return out;
}

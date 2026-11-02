// Источники мониторинга: карточки из registry/sources.yaml + ФАКТИЧЕСКАЯ статистика
// по снимкам (колонка source в lots.csv) и журналу запусков data/source-runs.jsonl.
import fs from 'node:fs';
import path from 'node:path';
import { parseYaml } from './yaml.mjs';
import { PROJECT_DIR, REGISTRY_DIR } from './paths.mjs';

const SOURCES_FILE = path.join(REGISTRY_DIR, 'sources.yaml');

const SNAPSHOT_ROOTS = [
  path.join(PROJECT_DIR, '01-competitor-watch', 'data', 'snapshots'),
  path.join(PROJECT_DIR, 'data', 'snapshots'),
];

const RUN_LOG_CANDIDATES = [
  path.join(PROJECT_DIR, '01-competitor-watch', 'data', 'source-runs.jsonl'),
  path.join(PROJECT_DIR, 'registry', 'data', 'source-runs.jsonl'),
  path.join(PROJECT_DIR, '00-admin', 'data', 'source-runs.jsonl'),
  path.join(PROJECT_DIR, 'data', 'source-runs.jsonl'),
];

function asArray(v) { return Array.isArray(v) ? v : (v === null || v === undefined ? [] : [v]); }

export function loadSourceAliases(warnings) {
  const file = path.join(PROJECT_DIR, 'dashboard', 'config', 'source-aliases.yaml');
  const map = {};
  if (!fs.existsSync(file)) return { file: file, map: map, exists: false };
  let doc;
  try { doc = parseYaml(fs.readFileSync(file, 'utf8')); }
  catch (e) { warnings.push('source-aliases.yaml: ошибка разбора — ' + e.message); return { file: file, map: map, exists: true }; }
  const block = doc && doc.aliases && typeof doc.aliases === 'object' ? doc.aliases : (doc || {});
  for (const k of Object.keys(block)) {
    if (typeof block[k] === 'string') map[k] = block[k];
  }
  return { file: file, map: map, exists: true };
}

export function loadSourcesConfig(warnings) {
  const list = [];
  if (!fs.existsSync(SOURCES_FILE)) {
    warnings.push('registry/sources.yaml не найден — вкладка «Источники мониторинга» будет пустой');
    return { sources: list, file: SOURCES_FILE, exists: false, updated: null };
  }
  let doc;
  try { doc = parseYaml(fs.readFileSync(SOURCES_FILE, 'utf8')); }
  catch (e) {
    warnings.push('registry/sources.yaml: ошибка разбора — ' + e.message);
    return { sources: list, file: SOURCES_FILE, exists: true, updated: null };
  }
  for (const raw of asArray(doc.sources)) {
    if (!raw || typeof raw !== 'object' || raw.id === undefined) continue;
    list.push({
      id: String(raw.id),
      name: raw.name !== undefined && raw.name !== null ? String(raw.name) : String(raw.id),
      enabled: raw.enabled === true,
      kind: raw.kind !== undefined && raw.kind !== null ? String(raw.kind) : 'unknown',
      auth: raw.auth !== undefined && raw.auth !== null ? String(raw.auth) : 'unknown',
      status: raw.status !== undefined && raw.status !== null ? String(raw.status) : 'unknown',
      priority: raw.priority !== undefined && raw.priority !== null ? Number(raw.priority) : null,
      lastRun: raw.last_run !== undefined && raw.last_run !== null ? String(raw.last_run) : null,
      limits: raw.limits !== undefined && raw.limits !== null ? String(raw.limits) : null,
      howto: raw.howto !== undefined && raw.howto !== null ? String(raw.howto) : null,
      note: raw.note !== undefined && raw.note !== null ? String(raw.note) : null,
    });
  }
  return { sources: list, file: SOURCES_FILE, exists: true, updated: doc.updated !== undefined ? String(doc.updated) : null };
}

// Разбор строки CSV с кавычками.
function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

export function scanSnapshots(warnings, aliases) {
  const map = aliases || {};
  const roots = SNAPSHOT_ROOTS.filter(function (r) { return fs.existsSync(r); });
  const snapshots = [];
  const bySource = {};
  const byWeek = {};
  let totalLots = 0;
  let badFiles = 0;

  function noteRow(sourceId, row, rawSource) {
    if (!bySource[sourceId]) {
      bySource[sourceId] = { id: sourceId, lots: 0, snapshots: {}, dates: {}, projects: {}, competitors: {}, rooms: {}, priceSum: 0, priceCount: 0, promo: 0, rawIds: {} };
    }
    const s = bySource[sourceId];
    if (rawSource) s.rawIds[rawSource] = (s.rawIds[rawSource] || 0) + 1;
    s.lots++;
    if (row.project) s.projects[row.project] = (s.projects[row.project] || 0) + 1;
    if (row.competitor) s.competitors[row.competitor] = (s.competitors[row.competitor] || 0) + 1;
    if (row.rooms) s.rooms[row.rooms] = (s.rooms[row.rooms] || 0) + 1;
    if (row.promo === '1' || row.promo === 'true') s.promo++;
    const p = Number(row.price_rub);
    if (!isNaN(p) && p > 0) { s.priceSum += p; s.priceCount++; }
  }

  for (const root of roots) {
    let dirs = [];
    try { dirs = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { continue; }
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const csv = path.join(root, d.name, 'lots.csv');
      if (!fs.existsSync(csv)) continue;
      let text;
      try { text = fs.readFileSync(csv, 'utf8'); }
      catch (e) { badFiles++; warnings.push('снимок ' + d.name + ': не удалось прочитать lots.csv'); continue; }
      const lines = text.split(/\r?\n/).filter(function (l) { return l.trim() !== ''; });
      if (lines.length < 2) { badFiles++; continue; }
      const header = splitCsvLine(lines[0]).map(function (h) { return h.trim(); });
      const idx = {};
      header.forEach(function (h, i) { idx[h] = i; });
      if (idx.source === undefined) {
        badFiles++;
        warnings.push('снимок ' + d.name + ': в lots.csv нет колонки source — статистика по источникам неполная');
        continue;
      }
      const snapshot = {
        dir: d.name,
        file: csv,
        date: null,
        rows: 0,
        sources: {},
        projects: {},
        competitors: {},
        firstDate: null,
        lastDate: null,
      };
      for (let i = 1; i < lines.length; i++) {
        const cells = splitCsvLine(lines[i]);
        const row = {};
        for (const key of Object.keys(idx)) row[key] = cells[idx[key]] !== undefined ? cells[idx[key]].trim() : '';
        const rawSource = row.source || 'не указан';
        const sourceId = map[rawSource] || rawSource;
        const date = row.snapshot_date || null;
        snapshot.rows++;
        snapshot.sources[sourceId] = (snapshot.sources[sourceId] || 0) + 1;
        if (row.project) snapshot.projects[row.project] = (snapshot.projects[row.project] || 0) + 1;
        if (row.competitor) snapshot.competitors[row.competitor] = (snapshot.competitors[row.competitor] || 0) + 1;
        if (date) {
          if (!snapshot.firstDate || date < snapshot.firstDate) snapshot.firstDate = date;
          if (!snapshot.lastDate || date > snapshot.lastDate) snapshot.lastDate = date;
          const s = bySource[sourceId] || null;
          noteRow(sourceId, row, rawSource);
          const src = bySource[sourceId];
          src.dates[date] = (src.dates[date] || 0) + 1;
          const week = isoWeek(date);
          if (!byWeek[week]) byWeek[week] = { week: week, lots: 0, bySource: {} };
          byWeek[week].lots++;
          byWeek[week].bySource[sourceId] = (byWeek[week].bySource[sourceId] || 0) + 1;
        } else {
          noteRow(sourceId, row, rawSource);
        }
        totalLots++;
      }
      snapshot.date = snapshot.lastDate || (d.name.match(/(\d{4}-\d{2}-\d{2})/) ? d.name.match(/(\d{4}-\d{2}-\d{2})/)[1] : d.name);
      snapshot.sourceList = Object.keys(snapshot.sources);
      for (const sid of snapshot.sourceList) {
        const s = bySource[sid];
        if (s) s.snapshots[snapshot.dir] = true;
      }
      snapshots.push(snapshot);
    }
  }
  snapshots.sort(function (a, b) { return String(a.date) < String(b.date) ? -1 : 1; });

  const sourceList = Object.keys(bySource).map(function (id) {
    const s = bySource[id];
    return {
      id: id,
      lots: s.lots,
      snapshots: Object.keys(s.snapshots).length,
      snapshotDirs: Object.keys(s.snapshots),
      dates: Object.keys(s.dates).sort(),
      projects: Object.keys(s.projects).map(function (p) { return { name: p, lots: s.projects[p] }; }).sort(function (a, b) { return b.lots - a.lots; }),
      competitors: Object.keys(s.competitors).map(function (c) { return { name: c, lots: s.competitors[c] }; }).sort(function (a, b) { return b.lots - a.lots; }),
      rooms: s.rooms,
      promo: s.promo,
      rawIds: Object.keys(s.rawIds || {}),
      avgPriceRub: s.priceCount > 0 ? Math.round(s.priceSum / s.priceCount) : null,
      firstDate: Object.keys(s.dates).sort()[0] || null,
      lastDate: Object.keys(s.dates).sort().slice(-1)[0] || null,
    };
  }).sort(function (a, b) { return b.lots - a.lots; });

  return {
    roots: roots,
    snapshots: snapshots,
    bySource: sourceList,
    byWeek: Object.keys(byWeek).map(function (w) { return byWeek[w]; }).sort(function (a, b) { return a.week < b.week ? -1 : 1; }),
    totalLots: totalLots,
    badFiles: badFiles,
  };
}

// Принимает и строку 'YYYY-MM-DD', и миллисекунды — аналитике нужны оба вида.
export function isoWeekOf(value) {
  if (typeof value === 'number') {
    const dt = new Date(value);
    if (isNaN(dt.getTime())) return String(value);
    return isoWeek(dt.toISOString().slice(0, 10));
  }
  return isoWeek(value);
}

function isoWeek(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr));
  if (!m) return String(dateStr);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  const day = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return d.getUTCFullYear() + '-W' + String(week).padStart(2, '0');
}

export function buildSourcesDoc(ctx) {
  const cfg = ctx.config;
  const scan = ctx.scan;
  const runLog = ctx.runLog;
  const warnings = [];

  const statsById = {};
  for (const s of scan.bySource) statsById[s.id] = s;

  const sources = cfg.sources.map(function (s) {
    const st = statsById[s.id] || null;
    return Object.assign({}, s, {
      stats: {
        lots: st ? st.lots : 0,
        snapshots: st ? st.snapshots : 0,
        snapshotDirs: st ? st.snapshotDirs : [],
        dates: st ? st.dates : [],
        firstDate: st ? st.firstDate : null,
        lastDate: st ? st.lastDate : null,
        projects: st ? st.projects : [],
        competitors: st ? st.competitors : [],
        rooms: st ? st.rooms : {},
        promo: st ? st.promo : 0,
        avgPriceRub: st ? st.avgPriceRub : null,
        share: scan.totalLots > 0 && st ? st.lots / scan.totalLots : 0,
      },
      lastRunFromLog: runLog.latest[s.id] || null,
    });
  }).sort(function (a, b) {
    const pa = a.priority === null ? 99 : a.priority;
    const pb = b.priority === null ? 99 : b.priority;
    return pa - pb;
  });

  const known = {};
  for (const s of cfg.sources) known[s.id] = true;
  // Неизвестные — это «сырые» значения колонки source, для которых нет ни записи
  // в реестре, ни соответствия в dashboard/config/source-aliases.yaml.
  const unknownInSnapshots = [];
  for (const s of scan.bySource) {
    if (known[s.id]) continue;
    unknownInSnapshots.push({ id: s.id, lots: s.lots, rawIds: s.rawIds || [], note: 'есть в снимках, но нет в registry/sources.yaml' });
  }
  for (const u of unknownInSnapshots) {
    warnings.push('источник «' + u.id + '» встречается в снимках (' + u.lots + ' лотов), но не описан в registry/sources.yaml');
  }

  const enabled = sources.filter(function (s) { return s.enabled; });
  const withData = sources.filter(function (s) { return s.stats.lots > 0; });
  const top = sources.slice().sort(function (a, b) { return b.stats.lots - a.stats.lots; })[0] || null;

  const share = scan.bySource.map(function (s) {
    const cfgEntry = sources.filter(function (x) { return x.id === s.id; })[0];
    return {
      id: s.id,
      name: cfgEntry ? cfgEntry.name : s.id,
      enabled: cfgEntry ? cfgEntry.enabled : null,
      lots: s.lots,
      share: scan.totalLots > 0 ? s.lots / scan.totalLots : 0,
      inRegistry: !!cfgEntry,
    };
  }).sort(function (a, b) { return b.lots - a.lots; });

  const snapshots = scan.snapshots.map(function (s) {
    return {
      dir: s.dir,
      date: s.date,
      rows: s.rows,
      sources: s.sources,
      sourceList: s.sourceList,
      projects: s.projects,
      competitors: s.competitors,
      firstDate: s.firstDate,
      lastDate: s.lastDate,
      file: s.file,
    };
  });

  const weeks = scan.byWeek.map(function (w) {
    return { week: w.week, lots: w.lots, bySource: w.bySource };
  });

  return {
    configFile: cfg.file,
    configExists: cfg.exists,
    configUpdated: cfg.updated,
    summary: {
      total: sources.length,
      enabled: enabled.length,
      disabled: sources.length - enabled.length,
      withData: withData.length,
      withoutData: sources.length - withData.length,
      totalLots: scan.totalLots,
      topSource: top && top.stats.lots > 0 ? { id: top.id, name: top.name, lots: top.stats.lots } : null,
      snapshots: snapshots.length,
      weeks: weeks.length,
    },
    sources: sources,
    share: share,
    snapshots: snapshots,
    byWeek: weeks,
    unknownInSnapshots: unknownInSnapshots,
    runLog: {
      exists: runLog.exists,
      file: runLog.file,
      count: runLog.count,
      badLines: runLog.badLines,
      note: runLog.exists ? 'журнал запусков прочитан' : 'журнал запусков пока пуст (data/source-runs.jsonl появится после T18)',
    },
    warnings: warnings,
  };
}

export function loadSourceRuns(warnings) {
  for (const file of RUN_LOG_CANDIDATES) {
    if (!fs.existsSync(file)) continue;
    const runs = [];
    let bad = 0;
    let text;
    try { text = fs.readFileSync(file, 'utf8'); }
    catch (e) { warnings.push('source-runs.jsonl: не удалось прочитать ' + file); continue; }
    for (const line of text.split(/\r?\n/)) {
      if (line.trim() === '') continue;
      try {
        const obj = JSON.parse(line);
        if (obj && typeof obj === 'object') runs.push(obj);
        else bad++;
      } catch (e) { bad++; }
    }
    if (bad > 0) warnings.push('source-runs.jsonl: ' + bad + ' строк не разобрались');
    const byId = {};
    for (const r of runs) {
      const id = r.source !== undefined ? r.source : (r.source_id !== undefined ? r.source_id : r.id);
      if (id === undefined || id === null) continue;
      const key = String(id);
      if (!byId[key]) byId[key] = [];
      byId[key].push(r);
    }
    for (const key of Object.keys(byId)) {
      byId[key].sort(function (a, b) { return String(a.ts || a.time || a.finished_at || '') < String(b.ts || b.time || b.finished_at || '') ? 1 : -1; });
    }
    const latest = {};
    for (const key of Object.keys(byId)) latest[key] = byId[key][0];
    return { exists: true, file: file, runs: runs, count: runs.length, bySource: byId, latest: latest, badLines: bad };
  }
  return { exists: false, file: null, runs: [], count: 0, bySource: {}, latest: {}, badLines: 0 };
}

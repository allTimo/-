// Статус Агента 1 «Мониторинг конкурентов»: «работа сделана / не сделана».
//
// Источники фактов (все — только чтение, ничего не выдумываем):
//   registry/runs.jsonl        — журнал прогонов: время, статус ok/failed, артефакт, стоимость
//   registry/results.yaml      — готовые результаты и факт отправки заказчику
//   01-competitor-watch/data/snapshots/*/lots.csv          — снимки лотов (общие)
//   01-competitor-watch/data/clients/<client>/snapshots/*  — снимки лотов по клиентам
//
// Если прогонов нет — отдаём состояние «ещё не запускался» с причиной и списком
// проверенных путей, а не пустое место.
import fs from 'node:fs';
import path from 'node:path';
import { parseYaml } from './yaml.mjs';
import { REGISTRY_DIR, PROJECT_DIR } from './paths.mjs';

const AGENT = 'agent-1-competitor-watch';
const SERVICE = 'competitor-watch';
const RUNS_FILE = path.join(REGISTRY_DIR, 'runs.jsonl');
const RESULTS_FILE = path.join(REGISTRY_DIR, 'results.yaml');
const CW_DIR = path.join(PROJECT_DIR, '01-competitor-watch');
const SNAPSHOTS_DIR = path.join(CW_DIR, 'data', 'snapshots');
const CLIENTS_DIR = path.join(CW_DIR, 'data', 'clients');

function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } }

// Считаем лоты по снимку: строки CSV минус заголовок. Пустые строки не считаем.
function countLots(file) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(function (l) { return l.trim() !== ''; });
    if (lines.length === 0) return 0;
    const head = lines[0].toLowerCase();
    return /(^|,)\s*(lot_id|snapshot_date|project)\s*(,|$)/.test(head) ? lines.length - 1 : lines.length;
  } catch (e) { return null; }
}

function scanSnapshotRoot(root, kind, list) {
  if (!isDir(root)) return;
  let names = [];
  try { names = fs.readdirSync(root).filter(function (n) { return isDir(path.join(root, n)); }).sort(); } catch (e) { return; }
  names.forEach(function (n) {
    const dir = path.join(root, n);
    const csv = path.join(dir, 'lots.csv');
    const exists = fs.existsSync(csv);
    let mtimeMs = null;
    try { mtimeMs = fs.statSync(exists ? csv : dir).mtimeMs; } catch (e) { /* ignore */ }
    const rec = {
      name: n,
      dir: dir,
      kind: kind,
      date: /^\d{4}-\d{2}-\d{2}$/.test(n) ? n : null,
      special: /^_/.test(n) ? n.replace(/^_/, '') : null,
      csv: exists ? csv : null,
      lots: exists ? countLots(csv) : null,
      mtimeMs: mtimeMs,
    };
    list.push(rec);
  });
}

export function loadAgent1Status(warnings) {
  const out = {
    agent: AGENT,
    generatedAtMs: Date.now(),
    files: { runs: RUNS_FILE, results: RESULTS_FILE, snapshotsDir: SNAPSHOTS_DIR, clientsDir: CLIENTS_DIR },
    runs: { exists: false, file: RUNS_FILE, total: 0, ok: 0, failed: 0, other: 0, last: null, lastOk: null, lastFailed: null },
    results: { exists: false, file: RESULTS_FILE, total: 0, last: null },
    snapshots: { roots: [], items: [], count: 0, last: null, byRoot: [], dated: [] },
    state: 'never',
    done: false,
    verdict: 'Ещё не запускался',
    reason: null,
    sourceOfTruth: null,
    evidence: [],
    sources: [],
  };

  // --- прогоны ---
  if (fs.existsSync(RUNS_FILE)) {
    out.runs.exists = true;
    const rows = [];
    let bad = 0;
    fs.readFileSync(RUNS_FILE, 'utf8').split(/\r?\n/).forEach(function (line) {
      if (line.trim() === '') return;
      try { const o = JSON.parse(line); if (o && typeof o === 'object') rows.push(o); else bad++; }
      catch (e) { bad++; }
    });
    if (bad > 0) warnings.push('runs.jsonl: ' + bad + ' строк не разобрались — статус Агента 1 может быть неполным');
    const mine = rows.filter(function (r) { return String(r.agent || '') === AGENT || String(r.service || '') === SERVICE; });
    mine.sort(function (a, b) { return String(a.ts || '') < String(b.ts || '') ? -1 : 1; });
    out.runs.total = mine.length;
    out.runs.ok = mine.filter(function (r) { return String(r.status) === 'ok'; }).length;
    out.runs.failed = mine.filter(function (r) { return String(r.status) === 'failed'; }).length;
    out.runs.other = mine.length - out.runs.ok - out.runs.failed;
    const pack = function (r) {
      if (!r) return null;
      return {
        runId: r.run_id !== undefined ? String(r.run_id) : null,
        ts: r.ts !== undefined ? String(r.ts) : null,
        status: r.status !== undefined ? String(r.status) : null,
        kind: r.kind !== undefined && r.kind !== null ? String(r.kind) : null,
        client: r.client !== undefined && r.client !== null ? String(r.client) : null,
        durationMs: r.duration_ms !== undefined ? Number(r.duration_ms) : null,
        costRub: r.cost_rub !== undefined ? Number(r.cost_rub) : null,
        artifact: r.artifact !== undefined && r.artifact !== null ? String(r.artifact) : null,
        error: r.error !== undefined && r.error !== null ? String(r.error) : null,
      };
    };
    out.runs.last = pack(mine[mine.length - 1] || null);
    out.runs.lastOk = pack(mine.filter(function (r) { return String(r.status) === 'ok'; }).slice(-1)[0] || null);
    out.runs.lastFailed = pack(mine.filter(function (r) { return String(r.status) === 'failed'; }).slice(-1)[0] || null);
  }

  // --- результаты (registry/results.yaml) ---
  if (fs.existsSync(RESULTS_FILE)) {
    out.results.exists = true;
    let doc = null;
    try { doc = parseYaml(fs.readFileSync(RESULTS_FILE, 'utf8')); }
    catch (e) { warnings.push('results.yaml: ошибка разбора — ' + e.message); }
    const list = doc && Array.isArray(doc.results) ? doc.results : [];
    const mine = list.filter(function (r) { return r && String(r.agent || '') === AGENT; });
    out.results.total = mine.length;
    const r0 = mine.slice().sort(function (a, b) { return String(a.created || '') < String(b.created || '') ? -1 : 1; }).slice(-1)[0] || null;
    out.results.last = r0 ? {
      id: r0.id !== undefined ? String(r0.id) : null,
      title: r0.title !== undefined ? String(r0.title) : null,
      created: r0.created !== undefined && r0.created !== null ? String(r0.created) : null,
      period: r0.period !== undefined && r0.period !== null ? String(r0.period) : null,
      artifacts: Array.isArray(r0.artifacts) ? r0.artifacts.map(String) : [],
      sentChannel: r0.sent_channel !== undefined ? String(r0.sent_channel) : 'none',
      sentTo: r0.sent_to !== undefined && r0.sent_to !== null ? String(r0.sent_to) : '',
      sentAt: r0.sent_at !== undefined && r0.sent_at !== null ? String(r0.sent_at) : null,
      sentStatus: r0.sent_status !== undefined ? String(r0.sent_status) : 'не отправлялось',
    } : null;
  }

  // --- снимки ---
  const roots = [
    { root: SNAPSHOTS_DIR, kind: 'общие снимки' },
  ];
  if (isDir(CLIENTS_DIR)) {
    try {
      fs.readdirSync(CLIENTS_DIR).filter(function (n) { return isDir(path.join(CLIENTS_DIR, n)) && n.indexOf('_') !== 0; }).sort()
        .forEach(function (cid) { roots.push({ root: path.join(CLIENTS_DIR, cid, 'snapshots'), kind: 'снимки клиента ' + cid }); });
    } catch (e) { /* ignore */ }
  }
  out.snapshots.roots = roots.map(function (r) { return r.root; });
  const snapItems = out.snapshots.items;
  roots.forEach(function (r) {
    const before = snapItems.length;
    scanSnapshotRoot(r.root, r.kind, snapItems);
    out.snapshots.byRoot.push({ root: r.root, kind: r.kind, exists: isDir(r.root), count: snapItems.length - before });
  });
  const dated = snapItems.filter(function (s) { return s.date !== null; })
    .sort(function (a, b) { return a.date < b.date ? -1 : 1; });
  out.snapshots.count = snapItems.length;
  out.snapshots.dated = dated.map(function (s) { return s.date; });
  out.snapshots.last = snapItems.slice().sort(function (a, b) {
    const ad = a.date || '', bd = b.date || '';
    if (ad !== bd) return ad < bd ? -1 : 1;
    return (a.mtimeMs || 0) < (b.mtimeMs || 0) ? -1 : 1;
  }).slice(-1)[0] || null;

  // --- вердикт: работа сделана / не сделана / ещё не запускался ---
  const lastRun = out.runs.last;
  const lastSnap = out.snapshots.last;
  const snapLabel = lastSnap ? (lastSnap.date || lastSnap.name) : null;

  out.sources = [
    { id: 'runs', label: 'Журнал прогонов', path: RUNS_FILE, exists: out.runs.exists, items: out.runs.total, note: out.runs.exists ? ('успешно ' + out.runs.ok + ', ошибок ' + out.runs.failed) : 'файла нет' },
    { id: 'results', label: 'Результаты работы агента', path: RESULTS_FILE, exists: out.results.exists, items: out.results.total, note: out.results.total ? 'последний: ' + (out.results.last && out.results.last.created ? out.results.last.created : '—') : 'записей по Агенту 1 нет' },
    { id: 'snapshots', label: 'Снимки лотов (даты)', path: SNAPSHOTS_DIR, exists: isDir(SNAPSHOTS_DIR), items: out.snapshots.count, note: snapLabel ? ('последний ' + snapLabel + (lastSnap && lastSnap.lots !== null ? ', лотов ' + lastSnap.lots : '')) : 'снимков нет' },
  ];

  if (!out.runs.exists && out.snapshots.count === 0 && out.results.total === 0) {
    out.state = 'never';
    out.done = false;
    out.verdict = 'Ещё не запускался';
    out.reason = 'Ни журнала прогонов, ни снимков, ни результатов: проверены ' + out.sources.map(function (s) { return s.path; }).join('; ') + '.';
    return out;
  }
  if (out.runs.total === 0) {
    out.state = 'never';
    out.done = false;
    out.verdict = 'Ещё не запускался';
    out.reason = 'В registry/runs.jsonl нет ни одной записи по Агенту 1'
      + (out.snapshots.count ? ', но снимки лотов есть (последний ' + snapLabel + ')' : '')
      + (out.results.total ? ', и есть результаты в registry/results.yaml' : '')
      + ' — прогон не журналировался.';
    out.sourceOfTruth = out.snapshots.count ? '01-competitor-watch/data/**/snapshots/*' : (out.results.total ? 'registry/results.yaml' : null);
    out.evidence = [
      { label: 'Прогоны', value: 'нет записей в registry/runs.jsonl' },
      { label: 'Дата снимка', value: snapLabel ? String(snapLabel) : 'снимков нет' },
      { label: 'Результат', value: out.results.total ? ('записей результатов: ' + out.results.total) : 'результатов нет' },
    ];
    return out;
  }

  out.done = String(lastRun.status) === 'ok';
  out.state = out.done ? 'done' : 'failed';
  out.sourceOfTruth = 'registry/runs.jsonl';
  out.verdict = out.done ? 'Работа сделана' : 'Работа не сделана';
  const when = lastRun.ts ? String(lastRun.ts).replace('T', ' ').slice(0, 19) : 'время не указано';
  const art = lastRun.artifact ? String(lastRun.artifact).split(/[\\/]/).pop() : null;
  out.reason = out.done
    ? ('Последний прогон ' + when + ' — результат ok' + (lastRun.kind ? ' (' + lastRun.kind + ')' : '') + (art ? ', артефакт ' + art : '') + '.')
    : ('Последний прогон ' + when + ' — результат ' + String(lastRun.status || 'неизвестен') + (lastRun.error ? ': ' + lastRun.error : '') + '.');
  out.evidence = [
    { label: 'Дата снимка', value: snapLabel ? (String(snapLabel) + (lastSnap && lastSnap.lots !== null ? ' (' + lastSnap.lots + ' лотов)' : '')) : 'снимков нет' },
    { label: 'Время прогона', value: when },
    { label: 'Результат', value: String(lastRun.status || '—') },
    { label: 'Источник данных', value: 'registry/runs.jsonl' + (art ? ' · артефакт ' + art : '') },
  ];
  if (!out.done && out.runs.lastOk) {
    out.evidence.push({ label: 'Последний успешный', value: String(out.runs.lastOk.ts || '').replace('T', ' ').slice(0, 19) });
  }
  return out;
}

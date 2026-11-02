#!/usr/bin/env node
// Local server for the "Центр управления агентами" dashboard.
//   node marketing-agents/dashboard/serve.mjs
//
// Serves public/ and exposes a small JSON API:
//   GET  /api/health              - liveness
//   GET  /api/state               - every aggregated document in one payload
//   GET  /api/state?collect=1     - re-run the collector first
//   POST /api/collect             - re-run the collector
//   GET  /api/agents              - registry agents as they are on disk right now
//   POST /api/agents/:id/toggle   - flip (or set) 'enabled' in registry/agents.yaml
//
// The toggle is the ONLY write this project does outside dashboard/: it rewrites
// registry/agents.yaml atomically (temp file + rename) after making a
// .bak-<timestamp> copy. Everything else is read-only.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PUBLIC_DIR, DATA_DIR, REGISTRY_DIR, DASHBOARD_DIR, PROJECT_DIR, WORKSPACE_ROOT } from './collector/lib/paths.mjs';
import { parseYaml, setListItemFlag, setYamlScalar, setYamlList, setListItemField, setListItemArray } from './collector/lib/yaml.mjs';
import { collect } from './collector/collect.mjs';

const AGENTS_FILE = path.join(REGISTRY_DIR, 'agents.yaml');
const SOURCES_FILE = path.join(REGISTRY_DIR, 'sources.yaml');
const ACCESS_KEY_FILE = path.join(DASHBOARD_DIR, 'config', 'access.key');
const SETTINGS_FILE = path.join(PROJECT_DIR, '00-admin', 'config', 'settings.yaml');
const PROFILE_DIR = process.env.DSH_PROFILE_DIR && process.env.DSH_PROFILE_DIR.trim() !== ''
  ? process.env.DSH_PROFILE_DIR
  : path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', 'profiles', 'desktop');
const PROFILE_MANIFEST = path.join(PROFILE_DIR, 'package.json');
const ROUTER_FILE = path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', 'dsh-delegate-router.json');
const PROFILE_CHECKER = path.join(PROJECT_DIR, 'install', 'check-profile-bundles.mjs');

  // --- ДЕЙСТВИЯ ПАНЕЛИ: только из белого списка, ничего произвольного ---
const CW_DIR = path.join(PROJECT_DIR, '01-competitor-watch');
const CW_SCRIPTS = path.join(CW_DIR, 'scripts');
const SNAPSHOTS_DIR = path.join(CW_DIR, 'data', 'snapshots');
const REPORTS_DIR = path.join(CW_DIR, 'reports');
const COLLECT_SCRIPT = path.join(DASHBOARD_DIR, 'collector', 'collect.mjs');
const PYTHON = process.env.DSH_PYTHON || path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe');

// --- каркас сервиса: файлы модели данных ---
const CLIENTS_FILE = path.join(REGISTRY_DIR, 'clients.yaml');
const SERVICES_FILE = path.join(REGISTRY_DIR, 'services.yaml');
const SUBS_FILE = path.join(REGISTRY_DIR, 'subscriptions.yaml');
const INVOICES_FILE = path.join(REGISTRY_DIR, 'invoices.yaml');
const RUNS_FILE = path.join(REGISTRY_DIR, 'runs.jsonl');
const RESULTS_FILE = path.join(REGISTRY_DIR, 'results.yaml');
const AD_CHANNELS_FILE = path.join(REGISTRY_DIR, 'ad-channels.yaml');
const AD_BUDGETS_FILE = path.join(REGISTRY_DIR, 'ad-budgets.yaml');
const CASHBACK_FILE = path.join(REGISTRY_DIR, 'cashback.yaml');
const OPERATORS_FILE = path.join(REGISTRY_DIR, 'operators.yaml');
const AGENT_SETTINGS_DIR = path.join(REGISTRY_DIR, 'agent-settings');
const AGENT_SETTINGS_FILE = path.join(REGISTRY_DIR, 'agents.yaml');

// Схема тонких настроек: что и как разрешено править из панели.
// t: bool | num | int | str | list | enum; для num/int — min/max; для enum — values.
const AGENT_SETTINGS_SCHEMA = {
  schedule: {
    enabled: { t: 'bool' }, only_on_new_data: { t: 'bool' },
    time: { t: 'time' }, timezone: { t: 'str' },
    frequency: { t: 'enum', values: ['daily', 'weekly', 'monthly', 'on-demand'] },
    days: { t: 'list', ints: true, min: 1, max: 7 },
  },
  model: {
    name: { t: 'str' }, on_limit: { t: 'enum', values: ['pause', 'stop', 'warn'] },
    limit_rub: { t: 'num', min: 0, max: 10000000 }, limit_tokens: { t: 'int', min: 0, max: 1000000000 },
  },
  priority: {
    level: { t: 'enum', values: ['low', 'normal', 'high'] },
    max_parallel: { t: 'int', min: 1, max: 5 }, timeout_sec: { t: 'int', min: 30, max: 86400 }, retries: { t: 'int', min: 0, max: 5 },
  },
  report: {
    language: { t: 'enum', values: ['ru', 'en'] }, branding: { t: 'bool' },
    formats: { t: 'list', values: ['md', 'xlsx', 'csv', 'pdf'] },
    sections: { t: 'list' },
  },
  delivery: {
    auto_send: { t: 'bool' }, copy_to: { t: 'str' }, addresses: { t: 'list' },
    channels: { t: 'list', values: ['telegram', 'email', 'vk', 'link'] },
  },
  alerts: {
    when: { t: 'list', values: ['never', 'fail', 'low_data', 'always'] },
    price_threshold_pct: { t: 'num', min: 0, max: 100 }, quiet_hours: { t: 'str' },
  },
  limits: {
    skip_weekends: { t: 'bool' }, stop_switch: { t: 'bool' },
    min_interval_hours: { t: 'num', min: 0, max: 8760 },
  },
  agent1: {
    price_threshold_pct: { t: 'num', min: 0, max: 100 }, min_lots: { t: 'int', min: 0, max: 100000 },
    collect_mode: { t: 'enum', values: ['http', 'browser'] },
    compare_depth_weeks: { t: 'int', min: 1, max: 52 },
    projects: { t: 'list' }, promo_words: { t: 'list' },
  },
  // ЖК для наблюдения — трёхуровневый путь agent1.watch.<поле>
  'agent1.watch': {
    name: { t: 'str' }, address: { t: 'str' }, url: { t: 'str' }, lat: { t: 'str' }, lon: { t: 'str' },
    radius_km: { t: 'num', min: 1, max: 100 },
    klass: { t: 'list' },
    price_min_per_m2: { t: 'int', min: 0, max: 10000000 }, price_max_per_m2: { t: 'int', min: 0, max: 10000000 },
    sources: { t: 'list', values: ['cian', 'avito', 'yandex-realty', 'domclick', 'web-search'] },
    max_candidates: { t: 'int', min: 1, max: 200 },
  },
  // Режим сбора по источнику: http | browser | off (выключен).
  'agent1.source_modes': {
    cian: { t: 'enum', values: ['http', 'browser', 'off'] },
    avito: { t: 'enum', values: ['http', 'browser', 'off'] },
    'yandex-realty': { t: 'enum', values: ['http', 'browser', 'off'] },
    domclick: { t: 'enum', values: ['http', 'browser', 'off'] },
    'developer-sites': { t: 'enum', values: ['http', 'browser', 'off'] },
  },
  source_agent: {
    rate_limit_per_min: { t: 'int', min: 1, max: 600 }, pause_ms: { t: 'int', min: 0, max: 60000 },
    max_pages: { t: 'int', min: 1, max: 100 }, timeout_sec: { t: 'int', min: 5, max: 600 },
    stop_on_block: { t: 'bool' }, use_browser: { t: 'bool' },
  },
};
const CLIENT_REPORTS_DIR = path.join(CW_DIR, 'reports', 'clients');

// Что разрешено править из панели в каждом файле.
// token — простое значение без пробелов и кавычек (статусы, тарифы, расписание);
// scalar — строка, которую пишем в кавычках (имена, контакты, адреса).
const SERVICE_EDIT = {
  clients: { file: CLIENTS_FILE, listKey: 'clients', fields: { status: 'token', plan: 'token', contact: 'scalar', note: 'scalar', name: 'scalar', services: 'array', objects: 'array' } },
  services: { file: SERVICES_FILE, listKey: 'services', fields: { enabled: 'flag', status: 'token', price_rub: 'number', cost_rub: 'number', schedule: 'scalar', agent: 'token' } },
  subscriptions: { file: SUBS_FILE, listKey: 'subscriptions', fields: { status: 'token', end: 'scalar', price_rub: 'number', invoiced: 'flag', plan: 'token' } },
  invoices: { file: INVOICES_FILE, listKey: 'invoices', fields: { status: 'token', amount_rub: 'number', file: 'scalar', issued: 'scalar' } },
  // sent_channel и sent_status — простые токены без пробелов: пишем их БЕЗ кавычек,
  // иначе обратное переключение не совпадёт с исходным файлом побайтово.
  results: { file: RESULTS_FILE, listKey: 'results', fields: { sent_channel: 'token', sent_to: 'scalar', sent_at: 'scalar', sent_status: 'token' } },
};

function appendRunLine(entry) {
  fs.appendFileSync(RUNS_FILE, JSON.stringify(entry) + '\n', 'utf8');
  return entry;
}

function readYamlFile(file) {
  try { return parseYaml(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

// Дописать новый блок в конец списка YAML (для «добавить клиента» и «выставить счёт»).
function appendListBlock(text, listKey, blockLines) {
  const eol = text.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  let keyIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (new RegExp('^' + listKey + '\\s*:\\s*$').test(lines[i])) { keyIdx = i; break; }
  }
  if (keyIdx < 0) return { ok: false, reason: 'не найден список ' + listKey };
  let itemIndent = '  ';
  let last = keyIdx;
  for (let i = keyIdx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '') { if (last === i - 1) { last = i; continue; } else break; }
    const ind = l.match(/^ */)[0].length;
    if (ind === 0) break;
    if (/^\s*-/.test(l)) itemIndent = l.match(/^ */)[0];
    last = i;
  }
  const block = blockLines.map(function (l) { return itemIndent + l; });
  const out = lines.slice(0, last + 1).concat(block, lines.slice(last + 1));
  return { ok: true, changed: true, text: out.join(eol), line: last + 2 };
}

function nextId(prefix, existing, pad) {
  let max = 0;
  existing.forEach(function (x) {
    if (!x || x.id === undefined) return;
    const m = new RegExp('^' + prefix + '-(\\d+)$').exec(String(x.id));
    if (m) max = Math.max(max, Number(m[1]));
  });
  return prefix + '-' + String(max + 1).padStart(pad || 3, '0');
}

function findService(id) {
  const doc = readYamlFile(SERVICES_FILE);
  const list = doc && Array.isArray(doc.services) ? doc.services : [];
  return list.filter(function (s) { return s && String(s.id) === String(id); })[0] || null;
}

function snapshotDates() {
  if (!fs.existsSync(SNAPSHOTS_DIR)) return [];
  return fs.readdirSync(SNAPSHOTS_DIR).filter(function (n) { return /^\d{4}-\d{2}-\d{2}$/.test(n); }).sort();
}

function runProcess(exe, args, cwd, timeoutMs) {
  try {
    const out = execFileSync(exe, args, { cwd: cwd, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
    return { ok: true, exitCode: 0, output: String(out || '') };
  } catch (e) {
    const out = (e && e.stdout ? String(e.stdout) : '') + (e && e.stderr ? String(e.stderr) : '');
    const timedOut = !!(e && (e.killed || e.signal));
    return { ok: false, exitCode: e && e.status !== undefined && e.status !== null ? e.status : null, output: out || String(e && e.message ? e.message : e), timedOut: timedOut };
  }
}

function newestReport() {
  if (!fs.existsSync(REPORTS_DIR)) return null;
  let best = null;
  for (const n of fs.readdirSync(REPORTS_DIR)) {
    const full = path.join(REPORTS_DIR, n);
    let st = null;
    try { st = fs.statSync(full); } catch (e) { continue; }
    if (!st.isFile()) continue;
    if (!/\.(md|xlsx|csv|pdf)$/i.test(n)) continue;
    if (!best || st.mtimeMs > best.mtimeMs) best = { name: n, path: full, mtimeMs: st.mtimeMs, bytes: st.size };
  }
  return best;
}


// Критические пакеты: панель НЕ имеет права их выключать.
function protectReason(name) {
  if (!name) return null;
  if (String(name).indexOf('@deepseek-ai/') === 0) return 'встроенный бандл DeepSeek — приходит с приложением, выключение ломает запуск DSH';
  if (/locale/i.test(String(name))) return 'языковой пакет: выключение вернёт интерфейс на китайский';
  return null;
}

// Правка массива dsh.profile.bundles в package.json профиля — построчно,
// чтобы не переформатировать остальной файл.
function editBundlesArray(text, nextBundles) {
  const eol = text.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/"bundles"\s*:\s*\[/.test(lines[i])) { start = i; break; }
  }
  if (start < 0) return { ok: false, reason: 'в package.json не найден массив dsh.profile.bundles' };
  let end = -1;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\]/.test(lines[i])) { end = i; break; }
  }
  if (end < 0) return { ok: false, reason: 'не найден конец массива bundles' };
  const itemIndent = (end > start + 1 && lines[start + 1].match(/^\s*/)) ? lines[start + 1].match(/^\s*/)[0] : '        ';
  const rendered = nextBundles.map(function (n, idx) {
    return itemIndent + '"' + n + '"' + (idx < nextBundles.length - 1 ? ',' : '');
  });
  const out = lines.slice(0, start + 1).concat(rendered, lines.slice(end));
  return { ok: true, changed: true, text: out.join(eol), line: start + 1 };
}

// Где пакет стоял в списке бандлов раньше: ищем по копиям .bak-* (свежие первыми).
// Так повторное включение возвращает пакет на прежнее место, и файл остаётся
// байт-в-байт таким же, как до выключения.
function originalBundleIndex(pkg) {
  const dir = path.dirname(PROFILE_MANIFEST);
  const base = path.basename(PROFILE_MANIFEST) + '.bak-';
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return null; }
  const backups = names.filter(function (n) { return n.indexOf(base) === 0; })
    .map(function (n) {
      const full = path.join(dir, n);
      let mtime = 0;
      try { mtime = fs.statSync(full).mtimeMs; } catch (e) { mtime = 0; }
      return { file: full, mtime: mtime };
    })
    .sort(function (a, b) { return b.mtime - a.mtime; });
  for (const b of backups) {
    try {
      const m = JSON.parse(fs.readFileSync(b.file, 'utf8'));
      const arr = m && m.dsh && m.dsh.profile && Array.isArray(m.dsh.profile.bundles) ? m.dsh.profile.bundles.map(String) : [];
      const i = arr.indexOf(pkg);
      if (i >= 0) return i;
    } catch (e) { /* битая копия — идём дальше */ }
  }
  return null;
}

// Проверка профиля после правки. Возвращает {ok, output}.
function checkProfile() {
  try {
    const out = execFileSync(process.execPath, [PROFILE_CHECKER, PROFILE_DIR], { encoding: 'utf8', timeout: 60000 });
    return { ok: true, output: String(out || '') };
  } catch (e) {
    const out = (e && (e.stdout || e.stderr)) ? String(e.stdout || '') + String(e.stderr || '') : String(e && e.message ? e.message : e);
    return { ok: false, output: out };
  }
}
const PRICES_FILE = path.join(REGISTRY_DIR, 'prices.yaml');

// БЕЛЫЙ СПИСОК правок: снаружи можно менять только эти параметры и ничем другим.
const ALLOWED_SETTINGS_SCALARS = {
  'thresholds.price_change_pct': { type: 'number', min: 0, max: 100 },
  'thresholds.price_change_abs_rub': { type: 'number', min: 0, max: 100000000 },
  'thresholds.lot_count_change_abs': { type: 'number', min: 0, max: 100000 },
  'thresholds.min_lots_for_stats': { type: 'number', min: 0, max: 100000 },
  'period.days': { type: 'number', min: 1, max: 365 },
  'period.compare_mode': { type: 'enum', values: ['week_over_week', 'previous_snapshot'] },
  'units.price_round_to_rub': { type: 'number', min: 1, max: 100000000 },
  'units.pct_decimals': { type: 'number', min: 0, max: 6 },
  'quality.warn_if_lots_below': { type: 'number', min: 0, max: 100000 }
};
const ALLOWED_SETTINGS_LISTS = { 'output.formats': ['md', 'xlsx', 'csv'] };
const ALLOWED_SETTINGS_BOOLS = ['delivery.telegram.enabled', 'delivery.email.enabled'];
const ALLOWED_AGENT_FIELDS = { model: 'scalar', schedule: 'scalar', projects: 'array', groups: 'array' };
const ALLOWED_PRICE_MODEL_FIELDS = ['rub_per_1m_in', 'rub_per_1m_out', 'rub_per_1m_cache_read'];

function validateValue(spec, value) {
  if (!spec) return 'параметр не разрешён к правке';
  if (spec.type === 'number') {
    const n = Number(value);
    if (!isFinite(n)) return 'нужно число';
    if (spec.min !== undefined && n < spec.min) return 'минимум ' + spec.min;
    if (spec.max !== undefined && n > spec.max) return 'максимум ' + spec.max;
    return null;
  }
  if (spec.type === 'enum') {
    if (spec.values.indexOf(String(value)) === -1) return 'допустимые значения: ' + spec.values.join(', ');
    return null;
  }
  return null;
}

// Общая обёртка: правка -> бэкап -> атомарная запись -> при ошибке откат.
function applyAtomicEdit(file, label, mutate) {
  if (!fs.existsSync(file)) return { ok: false, code: 500, message: 'файл не найден: ' + file };
  const original = fs.readFileSync(file, 'utf8');
  let res;
  try { res = mutate(original); }
  catch (e) { return { ok: false, code: 400, message: 'не удалось применить правку: ' + e.message }; }
  if (!res.ok) return { ok: false, code: 400, message: 'не найдено в файле (' + (res.reason || 'нет такого пути') + ')' };
  if (!res.changed) return { ok: true, changed: false, message: 'значение уже такое', previous: res.previous, file: file };
  let backupFile = file + '.bak-' + stamp();
  let n = 2;
  while (fs.existsSync(backupFile)) { backupFile = file + '.bak-' + stamp() + '-' + n; n++; }
  fs.copyFileSync(file, backupFile);
  const tmpFile = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmpFile, res.text, 'utf8');
  try { fs.renameSync(tmpFile, file); }
  catch (e) {
    try { fs.unlinkSync(tmpFile); } catch (e2) { /* ignore */ }
    try { fs.copyFileSync(backupFile, file); } catch (e3) { /* ignore */ }
    return { ok: false, code: 500, message: 'не удалось записать ' + label + ', файл восстановлен из копии: ' + e.message };
  }
  return { ok: true, changed: true, previous: res.previous, line: res.line, backup: path.basename(backupFile), file: file, label: label };
}

// --- ключ доступа -----------------------------------------------------------
// Локальные запросы (127.0.0.1) пускаются без ключа, как и раньше. Любой другой
// адрес обязан предъявить ключ: ?key=..., заголовок X-Dashboard-Key или cookie.
// Ключ создаётся один раз и лежит в dashboard/config/access.key.
function loadAccessKey() {
  try {
    if (fs.existsSync(ACCESS_KEY_FILE)) {
      const k = fs.readFileSync(ACCESS_KEY_FILE, 'utf8').trim();
      if (k !== '') return k;
    }
    const k = crypto.randomBytes(24).toString('hex');
    fs.mkdirSync(path.dirname(ACCESS_KEY_FILE), { recursive: true });
    fs.writeFileSync(ACCESS_KEY_FILE, k + '\n', 'utf8');
    return k;
  } catch (e) {
    console.error('Не удалось подготовить ключ доступа: ' + e.message);
    return null;
  }
}
const ACCESS_KEY = loadAccessKey();

function isLocalRequest(req) {
  const addr = (req.socket && req.socket.remoteAddress) ? String(req.socket.remoteAddress) : '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}
function keyFromRequest(req, url) {
  const q = url.searchParams.get('key');
  if (q) return q;
  const h = req.headers['x-dashboard-key'];
  if (h) return String(h);
  const cookie = req.headers.cookie || '';
  const m = /(?:^|;\s*)dash_key=([^;]+)/.exec(cookie);
  return m ? decodeURIComponent(m[1]) : null;
}
function keyOk(req, url) {
  if (!ACCESS_KEY) return true;           // ключ не смог создаться — не запираем панель
  const given = keyFromRequest(req, url);
  if (!given) return false;
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(ACCESS_KEY));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
function keyPage(res) {
  const html = '<!doctype html><html lang="ru"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1"><title>Нужен ключ доступа</title>' +
    '<style>body{background:#0b0f16;color:#e8eef7;font:15px/1.6 "Segoe UI",Roboto,Arial,sans-serif;padding:32px;max-width:640px;margin:0 auto}' +
    'code{background:#202a3c;border-radius:5px;padding:2px 6px;font-family:ui-monospace,Consolas,monospace;font-size:13px}' +
    'h1{font-size:20px}.m{color:#8d9bb0;font-size:13.5px}</style></head><body>' +
    '<h1>Нужен ключ доступа</h1>' +
    '<p>Эта панель управляет агентами, поэтому открывается по ключу.</p>' +
    '<p>Откройте адрес с ключом один раз — дальше он сохранится в браузере:<br>' +
    '<code>http://&lt;адрес&gt;:8787/?key=ВАШ_КЛЮЧ</code></p>' +
    '<p class="m">Ключ лежит в файле <code>marketing-agents/dashboard/config/access.key</code> ' +
    'и печатается в консоли при запуске сервера.</p>' +
    '<p class="m">На этом же компьютере панель открывается без ключа: <code>http://127.0.0.1:8787</code></p>' +
    '</body></html>';
  res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}
const HOST = process.env.DASHBOARD_HOST || '127.0.0.1';
const PORT = Number(process.env.DASHBOARD_PORT || process.env.PORT || 8787);

// Вопросы клиентов (кабинет): реестр вопросов и лимит частоты.
const QUESTIONS_FILE = path.join(REGISTRY_DIR, 'client-questions.json');
const RATE = {};

const DATA_FILES = ['meta.json', 'agents.json', 'tasks.json', 'projects.json', 'sessions.json', 'usage.json', 'prices.json', 'integrations.json', 'sources.json', 'analytics.json', 'settings.json', 'alerts.json', 'service.json', 'nav.json', 'analytics2.json', 'ads.json', 'agent-tabs.json', 'agent-settings.json', 'candidates.json', 'competitor-report.json'];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

// ВЕРСИЯ ИНТЕРФЕЙСА: короткий хеш по файлам public/ (имя+размер+mtime) и время самой свежей правки.
// Нужна, чтобы пользователь ВСЕГДА видел, какая версия открыта: старая версия из кэша выглядит
// ровно как «переключатели не работают», хотя код в репозитории уже исправлен.
const UI_VERSION = (function () {
  try {
    const dir = path.dirname(DATA_DIR);
    const files = fs.readdirSync(dir).filter(function (n) { return /\.(js|css|html)$/.test(n); }).sort();
    let h = 0, newest = 0;
    files.forEach(function (n) {
      const st = fs.statSync(path.join(dir, n));
      const s = n + ':' + st.size + ':' + Math.round(st.mtimeMs);
      for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
      if (st.mtimeMs > newest) newest = st.mtimeMs;
    });
    return { version: 'v-' + Math.abs(h).toString(36).slice(0, 8), builtAt: newest ? new Date(newest).toISOString() : null, files: files.length };
  } catch (e) { return { version: 'v-unknown', builtAt: null, files: 0 }; }
})();

function readState() {
  const state = { ok: true, errors: [] };
  state.uiVersion = UI_VERSION;
  for (const name of DATA_FILES) {
    const key = name.replace(/\.json$/, '');
    try { state[key] = JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8')); }
    catch (e) { state[key] = null; state.errors.push(name + ': ' + e.message); }
  }
  if (state.errors.length === 0) delete state.errors;
  return state;
}

function readAgentsFromDisk() {
  const text = fs.readFileSync(AGENTS_FILE, 'utf8');
  const doc = parseYaml(text);
  const list = Array.isArray(doc.agents) ? doc.agents : [];
  return list.filter(function (a) { return a && a.id !== undefined; }).map(function (a) {
    return { id: String(a.id), name: a.name !== undefined ? String(a.name) : String(a.id), enabled: a.enabled === true, status: a.status !== undefined ? String(a.status) : null, model: a.model !== undefined ? String(a.model) : null };
  });
}

// Метка времени для копий. Миллисекунды обязательны: без них две правки в одну
// секунду получают одинаковое имя, и копия безопасности перезаписывает исходную.
function stamp() {
  const d = new Date();
  function p(n) { return String(n).padStart(2, '0'); }
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + '-' + String(d.getMilliseconds()).padStart(3, '0');
}

// Flip or set 'enabled' for one agent. Atomic: temp file + rename, with a backup copy.
// Одна и та же операция для agents.yaml и sources.yaml: меняем РОВНО одно поле
// enabled в блоке нужного id, атомарно (temp + rename) и с копией .bak-<timestamp>.
function toggleEnabledIn(file, listKey, kind, what, id, desired) {
  if (!fs.existsSync(file)) return { ok: false, code: 500, message: kind + ' не найден: ' + file };
  const original = fs.readFileSync(file, 'utf8');
  let want = desired;
  if (want === null || want === undefined) {
    const doc = parseYaml(original);
    const list = Array.isArray(doc[listKey]) ? doc[listKey] : [];
    const found = list.filter(function (a) { return a && String(a.id) === id; })[0];
    if (!found) return { ok: false, code: 404, message: what + ' не найден в ' + kind + ': ' + id };
    want = !(found.enabled === true);
  }
  const res = setListItemFlag(original, { idField: 'id', idValue: id, flag: 'enabled', value: want });
  if (!res.ok) return { ok: false, code: 404, message: 'блок ' + what + ' не найден в ' + kind + ': ' + id };
  if (!res.changed) {
    return { ok: true, changed: false, id: id, enabled: want, backup: null, message: 'уже ' + (want ? 'включён' : 'выключен') };
  }
  let backupFile = file + '.bak-' + stamp();
  let n = 2;
  while (fs.existsSync(backupFile)) { backupFile = file + '.bak-' + stamp() + '-' + n; n++; }
  fs.copyFileSync(file, backupFile);
  const tmpFile = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmpFile, res.text, 'utf8');
  try {
    fs.renameSync(tmpFile, file);
  } catch (e) {
    try { fs.unlinkSync(tmpFile); } catch (e2) { /* ignore */ }
    return { ok: false, code: 500, message: 'не удалось перезаписать ' + kind + ': ' + e.message };
  }
  return { ok: true, changed: true, id: id, enabled: want, previous: res.previous, line: res.line, backup: path.basename(backupFile), file: file };
}

function toggleAgent(id, desired) {
  return toggleEnabledIn(AGENTS_FILE, 'agents', 'registry/agents.yaml', 'агент', id, desired);
}

function toggleSource(id, desired) {
  return toggleEnabledIn(SOURCES_FILE, 'sources', 'registry/sources.yaml', 'источник', id, desired);
}

function sendJson(res, code, payload) {
  const body = JSON.stringify(payload, null, 1);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body, 'utf8') });
  res.end(body);
}

function readBody(req) {
  return new Promise(function (resolve) {
    let data = '';
    let tooBig = false;
    req.on('data', function (chunk) {
      data += chunk;
      if (data.length > 1e6) { tooBig = true; req.destroy(); }
    });
    req.on('end', function () {
      if (tooBig) return resolve(null);
      if (data.trim() === '') return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { resolve(null); }
    });
    req.on('error', function () { resolve(null); });
  });
}

function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath);
  if (rel === '/' || rel === '') rel = '/index.html';
  const target = path.resolve(PUBLIC_DIR, '.' + rel);
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 — выход за пределы public/');
    return;
  }
  fs.stat(target, function (err, st) {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 — не найдено: ' + rel);
      return;
    }
    const ext = path.extname(target).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    const headers = { 'Content-Type': type, 'Content-Length': st.size };
    // НИКАКОГО кэша для HTML/JS/CSS: иначе после правки пользователь видит старую версию
  // и считает, что ничего не исправлено (баг T76 — «переключатели опять не работают»).
  headers['Cache-Control'] = 'no-store, no-cache, must-revalidate';
  headers['Pragma'] = 'no-cache';
  headers['Expires'] = '0';
    res.writeHead(200, headers);
    fs.createReadStream(target).pipe(res);
  });
}

const server = http.createServer(function (req, res) {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const p = url.pathname;
  const method = req.method || 'GET';

  // Проверка доступа: локально — всегда, снаружи — только с ключом.
  if (!isLocalRequest(req) && !keyOk(req, url)) {
    if (p.startsWith('/api/')) return sendJson(res, 401, { ok: false, message: 'нужен ключ доступа', hint: 'добавьте ?key=... к адресу' });
    return keyPage(res);
  }
  if (keyFromRequest(req, url) && keyOk(req, url) && url.searchParams.get('key')) {
    res.setHeader('Set-Cookie', 'dash_key=' + encodeURIComponent(String(url.searchParams.get('key'))) + '; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly');
  }

  if (p === '/api/health') {
    return sendJson(res, 200, { ok: true, service: 'agent-control-center', port: PORT, dataDir: DATA_DIR, registry: AGENTS_FILE, now: new Date().toISOString() });
  }

  if (p === '/api/state' && method === 'GET') {
    if (url.searchParams.get('collect') === '1') {
      try { collect({}); } catch (e) { return sendJson(res, 500, { ok: false, message: 'сборщик упал: ' + e.message }); }
    }
    return sendJson(res, 200, readState());
  }

  if (p === '/api/collect' && (method === 'POST' || method === 'GET')) {
    try {
      const meta = collect({});
      return sendJson(res, 200, { ok: true, meta: meta });
    } catch (e) {
      return sendJson(res, 500, { ok: false, message: 'сборщик упал: ' + e.message, stack: String(e.stack || '') });
    }
  }

  if (p === '/api/agents' && method === 'GET') {
    try { return sendJson(res, 200, { ok: true, file: AGENTS_FILE, agents: readAgentsFromDisk() }); }
    catch (e) { return sendJson(res, 500, { ok: false, message: e.message }); }
  }

  const toggleMatch = /^\/api\/agents\/([^/]+)\/toggle$/.exec(p);
  if (toggleMatch && method === 'POST') {
    const id = decodeURIComponent(toggleMatch[1]);
    return readBody(req).then(function (body) {
      let desired = null;
      if (body && typeof body.enabled === 'boolean') desired = body.enabled;
      let result;
      try { result = toggleAgent(id, desired); }
      catch (e) { return sendJson(res, 500, { ok: false, message: 'ошибка правки реестра: ' + e.message }); }
      if (!result.ok) return sendJson(res, result.code || 500, result);
      let meta = null;
      try { meta = collect({}); } catch (e) { /* state refresh is best-effort */ }
      const agents = (function () { try { return readAgentsFromDisk(); } catch (e) { return []; } })();
      return sendJson(res, 200, Object.assign({}, result, {
        agents: agents,
        generatedAt: meta ? meta.generatedAt : null,
        note: 'enabled записан в registry/agents.yaml атомарно; копия: ' + (result.backup || 'не потребовалась'),
      }));
    });
  }

  // Групповое переключение: один проход по файлу, одна атомарная запись, один бэкап.
  if (p === '/api/bulk/toggle' && method === 'POST') {
    return readBody(req).then(function (body) {
      const target = body && body.target === 'sources' ? 'sources' : 'agents';
      const file = target === 'sources' ? SOURCES_FILE : AGENTS_FILE;
      const kind = target === 'sources' ? 'registry/sources.yaml' : 'registry/agents.yaml';
      const what = target === 'sources' ? 'источник' : 'агент';
      if (typeof (body && body.enabled) !== 'boolean') return sendJson(res, 400, { ok: false, message: 'нужно поле enabled (true/false)' });
      const want = body.enabled;
      if (!fs.existsSync(file)) return sendJson(res, 500, { ok: false, message: kind + ' не найден' });
      const original = fs.readFileSync(file, 'utf8');
      const doc = parseYaml(original);
      const listKey = target === 'sources' ? 'sources' : 'agents';
      const list = Array.isArray(doc[listKey]) ? doc[listKey] : [];
      let ids = body.ids;
      if (!Array.isArray(ids) || ids.length === 0 || ids === 'all') {
        ids = list.filter(function (x) { return x && x.id !== undefined; }).map(function (x) { return String(x.id); });
      }
      let text = original;
      const changed = [];
      const already = [];
      const missing = [];
      for (const rawId of ids) {
        const id = String(rawId);
        const res2 = setListItemFlag(text, { idField: 'id', idValue: id, flag: 'enabled', value: want });
        if (!res2.ok) { missing.push(id); continue; }
        if (res2.changed) { changed.push(id); text = res2.text; } else { already.push(id); }
      }
      if (changed.length === 0) {
        return sendJson(res, 200, { ok: true, changed: false, enabled: want, changedIds: [], already: already, missing: missing, backup: null, message: 'уже в нужном состоянии' });
      }
      let backupFile = file + '.bak-' + stamp();
      let n = 2;
      while (fs.existsSync(backupFile)) { backupFile = file + '.bak-' + stamp() + '-' + n; n++; }
      fs.copyFileSync(file, backupFile);
      const tmpFile = file + '.tmp-' + process.pid;
      fs.writeFileSync(tmpFile, text, 'utf8');
      try { fs.renameSync(tmpFile, file); }
      catch (e) {
        try { fs.unlinkSync(tmpFile); } catch (e2) { /* ignore */ }
        return sendJson(res, 500, { ok: false, message: 'не удалось перезаписать ' + kind + ': ' + e.message });
      }
      let meta = null;
      try { meta = collect({}); } catch (e) { /* best effort */ }
      return sendJson(res, 200, {
        ok: true, changed: true, enabled: want, changedIds: changed, already: already, missing: missing,
        backup: path.basename(backupFile), file: file, generatedAt: meta ? meta.generatedAt : null,
        note: 'записано ' + changed.length + ' переключений в ' + kind + ' одной атомарной правкой; копия: ' + path.basename(backupFile),
      });
    });
  }

  // --- правка полей модели сервиса (клиенты/услуги/подписки/счета) ---
  if (p === '/api/service/edit' && method === 'POST') {
    return readBody(req).then(function (body) {
      const kind = String((body && body.kind) || '');
      const cfg = SERVICE_EDIT[kind];
      if (!cfg) return sendJson(res, 400, { ok: false, message: 'неизвестный раздел: ' + kind });
      const id = String((body && body.id) || '');
      const field = String((body && body.field) || '');
      const mode = cfg.fields[field];
      if (!mode) return sendJson(res, 400, { ok: false, message: 'поле не разрешено к правке: ' + field });
      let value = body.value;
      if (mode === 'number') {
        const n = Number(value);
        if (!isFinite(n) || n < 0 || n > 100000000) return sendJson(res, 400, { ok: false, message: 'нужно неотрицательное число' });
        value = n;
      } else if (mode === 'flag') {
        if (typeof value !== 'boolean') return sendJson(res, 400, { ok: false, message: 'нужно true или false' });
      } else if (mode === 'array') {
        value = Array.isArray(value) ? value.map(String).filter(function (v) { return v !== ''; }) : [];
      } else {
        value = String(value === undefined || value === null ? '' : value).trim();
        const emptyAllowed = ['file', 'issued', 'sent_at', 'sent_to'];
        if (value === '' && emptyAllowed.indexOf(field) === -1) return sendJson(res, 400, { ok: false, message: 'значение не может быть пустым' });
        if (value === '' ) value = 'null';
      }
      const target = kind + ':' + id + '.' + field;
      const result = applyAtomicEdit(cfg.file, path.basename(cfg.file), function (text) {
        if (mode === 'array') return setListItemArray(text, { idField: 'id', idValue: id, field: field, values: value, quoted: false });
        if (mode === 'flag') return setListItemFlag(text, { idField: 'id', idValue: id, flag: field, value: value });
        const raw = (mode === 'number' || mode === 'token');
        return setListItemField(text, { idField: 'id', idValue: id, field: field, value: (raw ? value : '"' + value + '"') });
      });
      if (!result.ok) return sendJson(res, result.code || 400, result);
      let meta = null;
      try { meta = collect({}); } catch (e) { /* best effort */ }
      return sendJson(res, 200, Object.assign({}, result, { target: target, generatedAt: meta ? meta.generatedAt : null }));
    });
  }

  // --- ПОДБОР КОНКУРЕНТОВ (движок делает data-engine, задача T57) ---
  // Честная заглушка: панель НЕ выдумывает кандидатов. Пока движок не сформировал файлы
  // в 01-competitor-watch/data/candidates/, здесь так и написано.
  if (p === '/api/agent1/discover' && method === 'POST') {
    return readBody(req).then(function (body) {
      const project = String((body && body.project) || '');
      const candDir = path.join(PROJECT_DIR, '01-competitor-watch', 'data', 'candidates');
      const found = fs.existsSync(candDir)
        ? fs.readdirSync(candDir).filter(function (n) { return /\.json$/.test(n); })
        : [];
      const own = found.filter(function (n) { return !project || n.indexOf(project) >= 0; });
      if (own.length === 0) {
        return sendJson(res, 501, {
          ok: false, stub: true,
          message: 'Поиск конкурентов появится после подключения движка (задача T57, исполнитель data-engine). Панель не показывает выдуманных кандидатов: сейчас в 01-competitor-watch/data/candidates/ нет ни одного файла.',
          checked: { dir: candDir, dirExists: fs.existsSync(candDir), files: found.length },
        });
      }
      return sendJson(res, 200, { ok: true, stub: false, message: 'Найдены ранее сохранённые кандидаты: файлов ' + own.length + '.', files: own });
    });
  }

  // --- РЕШЕНИЕ ПО КАНДИДАТУ: «Добавить в конкуренты» или «Отклонить» ---
  if (p === '/api/agent1/candidate' && method === 'POST') {
    return readBody(req).then(function (body) {
      const project = String((body && body.project) || '');
      const name = String((body && body.name) || '');
      const action = String((body && body.action) || '');
      const clientId = String((body && body.client) || 'client-svet');
      if (!name) return sendJson(res, 400, { ok: false, message: 'не указано название кандидата' });
      if (['approve', 'reject'].indexOf(action) === -1) return sendJson(res, 400, { ok: false, message: 'действие: approve или reject' });
      if (!/^[a-z0-9-]{3,60}$/.test(clientId)) return sendJson(res, 400, { ok: false, message: 'неверный id клиента' });

      const candDir = path.join(PROJECT_DIR, '01-competitor-watch', 'data', 'candidates');
      // Файл движка — это <project-id>.json. Файлы решений (*.decisions.json) и копии (*.bak-*)
      // исключаем: иначе сортировка подставляла файл решений и кандидат «не находился».
      const files = fs.existsSync(candDir)
        ? fs.readdirSync(candDir).filter(function (n) { return /\.json$/.test(n) && !/\.decisions\.json$/.test(n); })
        : [];
      const target = files.filter(function (n) { return project ? n.indexOf(project) >= 0 : true; })[0];
      if (!target) return sendJson(res, 404, { ok: false, message: 'нет файла кандидатов — сначала нужен результат поиска от движка' });
      const candFile = path.join(candDir, target);

      // ПРАВИЛО РАЗДЕЛЕНИЯ ФАЙЛОВ (Lead, 01.11.2026): файл кандидатов принадлежит движку,
      // панель его НЕ трогает. Решения пишем в отдельный <project-id>.decisions.json.
      const projectId = target.replace(/\.json$/, '');
      const decFile = path.join(candDir, projectId + '.decisions.json');
      // ключ кандидата: id движка, если он есть; иначе «название | застройщик»
      const engineDoc = (function () {
        try { return JSON.parse(fs.readFileSync(candFile, 'utf8')); } catch (e) { return null; }
      })();
      const engineList = engineDoc ? (Array.isArray(engineDoc) ? engineDoc : (engineDoc.candidates || [])) : [];
      const item = engineList.filter(function (c) { return String(c.name) === name; })[0];
      if (!item) return sendJson(res, 404, { ok: false, message: 'кандидат не найден в файле движка: ' + name });
      function keyOf(c) {
        if (c && c.id !== undefined && c.id !== null && String(c.id) !== '') return String(c.id);
        return String(c.name || '') + ' | ' + String(c.developer === undefined || c.developer === null ? '' : c.developer);
      }
      const candKey = keyOf(item);
      // Файла решений может ещё не быть — панель создаёт его сама (это ЕЁ зона записи).
      if (!fs.existsSync(decFile)) {
        try { fs.writeFileSync(decFile, '{}\n', 'utf8'); } catch (e) { return sendJson(res, 500, { ok: false, message: 'не удалось создать файл решений: ' + e.message }); }
      }
      const decisions = applyAtomicEdit(decFile, projectId + '.decisions.json', function (text) {
        let doc = {};
        if (text && text.trim() !== '') {
          try { doc = JSON.parse(text); } catch (e) { return { ok: false, reason: 'json-parse', message: e.message }; }
        }
        if (!doc || typeof doc !== 'object' || Array.isArray(doc)) doc = {};
        doc[candKey] = { status: action === 'approve' ? 'approved' : 'rejected', at: new Date().toISOString(), name: String(name), source: 'panel' };
        return { ok: true, changed: true, text: JSON.stringify(doc, null, 2) + '\n' };
      });
      if (!decisions.ok) return sendJson(res, decisions.code || 400, decisions);

      if (action === 'approve') {
        const confDir = path.join(PROJECT_DIR, '01-competitor-watch', 'config', 'clients');
        const confFile = path.join(confDir, clientId + '.yaml');
        if (!fs.existsSync(confDir)) {
          fs.mkdirSync(confDir, { recursive: true });
        }
        const exists = fs.existsSync(confFile);
        const seed = exists ? null : ('# Клиентский конфиг Агента 1: подтверждённые конкуренты.\n# Файл создан панелью при первом добавлении кандидата.\nversion: 1\nclient: ' + clientId + '\nupdated: "' + new Date().toISOString().slice(0, 10) + '"\n\ncompetitors:\n');
        const block = ['  - { id: ' + String(name).toLowerCase().replace(/[^a-z0-9а-я]+/gi, '-').slice(0, 40) + ', name: "' + name.replace(/"/g, '') + '", developer: "' + String(item.developer || '').replace(/"/g, '') + '", distance_km: ' + (item.distance_km === undefined || item.distance_km === null ? 'null' : item.distance_km) + ', source: "автоподбор", added: "' + new Date().toISOString().slice(0, 10) + '" }'];
        if (!exists) fs.writeFileSync(confFile, seed, 'utf8');
        const add = applyAtomicEdit(confFile, clientId + '.yaml', function (text) {
          if (/competitors:\s*\n(\s*#|\s*$)/.test(text) || /competitors:\s*$/.test(text.trim()) || text.indexOf('competitors:') < 0) {
            return appendListBlock(text.indexOf('competitors:') >= 0 ? text : text + '\ncompetitors:\n', 'competitors', block);
          }
          return appendListBlock(text, 'competitors', block);
        });
        if (!add.ok) return sendJson(res, add.code || 400, add);
        try { collect({}); } catch (e) { /* best effort: пересобираем, чтобы статусы сразу попали в панель */ }
        return sendJson(res, 200, Object.assign({}, decisions, { added: add.changed, clientFile: confFile, candidateKey: candKey, decisionsFile: decFile, target: 'конкурент «' + name + '» добавлен клиенту ' + clientId + ' · решение записано в ' + projectId + '.decisions.json по ключу «' + candKey + '»' }));
      }
      try { collect({}); } catch (e) { /* best effort */ }
      return sendJson(res, 200, Object.assign({}, decisions, { candidateKey: candKey, decisionsFile: decFile, target: 'кандидат «' + name + '» отклонён · решение записано в ' + projectId + '.decisions.json по ключу «' + candKey + '»' }));
    });
  }

  // --- ТОНКИЕ НАСТРОЙКИ АГЕНТА: правка одного поля с копией и обратимостью ---
  if (p === '/api/agent-settings/set' && method === 'POST') {
    return readBody(req).then(function (body) {
      const agent = String((body && body.agent) || '');
      const group = String((body && body.group) || '');
      const field = String((body && body.field) || '');
      let value = body ? body.value : undefined;
      if (!/^[a-z0-9-]{3,40}$/.test(agent)) return sendJson(res, 400, { ok: false, message: 'неверный id агента' });
      // Карта доменов конкурентов: ключи динамические (домены), поэтому правило задаём не списком,
      // а проверкой самого имени поля. Значение — канонический ключ проекта.
      let grp = AGENT_SETTINGS_SCHEMA[group];
      if (!grp && group === 'agent1.competitor_domains') grp = { __dynamicDomain: true };
      if (!grp) return sendJson(res, 400, { ok: false, message: 'неизвестная группа настроек: ' + group });
      const rule = grp.__dynamicDomain
        ? (/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(field) ? { t: 'str' } : null)
        : grp[field];
      if (!rule) return sendJson(res, 400, { ok: false, message: 'поле не разрешено к правке: ' + group + '.' + field });
      const file = path.join(AGENT_SETTINGS_DIR, agent + '.yaml');
      if (!fs.existsSync(file)) return sendJson(res, 404, { ok: false, message: 'нет файла настроек для агента ' + agent });
      let doc = null;
      try { doc = parseYaml(fs.readFileSync(file, 'utf8')); } catch (e) { /* ignore */ }
      if (doc && String(doc.status || 'active') === 'stub') {
        return sendJson(res, 400, { ok: false, message: 'агент «' + agent + '» ещё не реализован: настройки появятся вместе с агентом, сохранять нельзя' });
      }
      // валидация по типу
      let writeValue = value;
      let human = null;
      if (rule.t === 'bool') {
        if (typeof value !== 'boolean') return sendJson(res, 400, { ok: false, message: 'нужно true или false' });
        human = value ? 'да' : 'нет';
      } else if (rule.t === 'num' || rule.t === 'int') {
        const n = Number(value);
        if (!isFinite(n)) return sendJson(res, 400, { ok: false, message: 'нужно число' });
        if (rule.t === 'int' && Math.round(n) !== n) return sendJson(res, 400, { ok: false, message: 'нужно целое число' });
        if (n < rule.min || n > rule.max) return sendJson(res, 400, { ok: false, message: 'допустимо от ' + rule.min + ' до ' + rule.max });
        writeValue = n; human = String(n);
      } else if (rule.t === 'enum') {
        const v = String(value);
        if (rule.values.indexOf(v) === -1) return sendJson(res, 400, { ok: false, message: 'допустимые значения: ' + rule.values.join(', ') });
        // Перечисления пишем БЕЗ кавычек: в файлах они записаны как frequency: weekly.
        // С кавычками обратное переключение не возвращало файл байт-в-байт.
        writeValue = v; human = v;
      } else if (rule.t === 'time') {
        const v = String(value);
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) return sendJson(res, 400, { ok: false, message: 'время в формате ЧЧ:ММ' });
        writeValue = '"' + v + '"'; human = v;
      } else if (rule.t === 'list') {
        const arr = Array.isArray(value) ? value.map(String).filter(function (v) { return v !== ''; }) : [];
        if (rule.values) {
          const bad = arr.filter(function (v) { return rule.values.indexOf(v) === -1; });
          if (bad.length) return sendJson(res, 400, { ok: false, message: 'недопустимые значения: ' + bad.join(', ') });
        }
        if (rule.ints) {
          const bad = arr.filter(function (v) { const n = Number(v); return !isFinite(n) || n < rule.min || n > rule.max; });
          if (bad.length) return sendJson(res, 400, { ok: false, message: 'дни недели: числа от ' + rule.min + ' до ' + rule.max });
        }
        writeValue = arr; human = arr.join(', ') || 'пусто';
      } else {
        const v = String(value === undefined || value === null ? '' : value).trim();
        if (v.length > 200) return sendJson(res, 400, { ok: false, message: 'слишком длинное значение' });
        writeValue = '"' + v.replace(/"/g, '') + '"'; human = v || 'пусто';
      }
      const pathArr = group.split('.').concat([field]);
      const result = applyAtomicEdit(file, agent + '.yaml', function (text) {
        // Динамический домен: если ключа ещё нет — дописываем пару в конец карты.
        if (grp.__dynamicDomain && setYamlScalar(text, pathArr, writeValue).ok === false) {
          return appendListBlock(text, 'competitor_domains', ['  ' + field + ': ' + String(value).replace(/"/g, '')]);
        }
        return rule.t === 'list' ? setYamlList(text, pathArr, writeValue) : setYamlScalar(text, pathArr, writeValue);
      });
      if (!result.ok) return sendJson(res, result.code || 400, result);
      return sendJson(res, 200, Object.assign({}, result, { target: 'настройка ' + agent + ' · ' + group + '.' + field + ' = ' + human, agent: agent, group: group, field: field }));
    });
  }

  // --- раздел «Реклама и кэшбэк»: пополнения, расходы, ставки, начисления, выплаты, режим ---
  if (p === '/api/ads/act' && method === 'POST') {
    return readBody(req).then(function (body) {
      const kind = String((body && body.kind) || '');
      const client = String((body && body.client) || '');
      const channel = String((body && body.channel) || '');
      const amount = Number(body && body.amount);
      const today = new Date().toISOString().slice(0, 10);
      const stampId = Date.now().toString(36);

      function fail(code, message) { return sendJson(res, code, { ok: false, message: message }); }
      function done(result, extra) {
        let meta = null;
        try { meta = collect({}); } catch (e) { /* best effort */ }
        return sendJson(res, 200, Object.assign({}, result, extra || {}, { generatedAt: meta ? meta.generatedAt : null }));
      }

      if (kind === 'topup' || kind === 'spend') {
        if (!client || !channel) return fail(400, 'нужны клиент и канал');
        if (!isFinite(amount) || amount <= 0 || amount > 100000000) return fail(400, 'нужна положительная сумма');
        const date = String((body && body.date) || today);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return fail(400, 'дата в формате ГГГГ-ММ-ДД');
        const prefix = kind === 'topup' ? 'top' : 'sp';
        const doc = readYamlFile(AD_BUDGETS_FILE);
        const list = doc && Array.isArray(doc[kind === 'topup' ? 'topups' : 'spends']) ? doc[kind === 'topup' ? 'topups' : 'spends'] : [];
        const id = prefix + '-' + String(list.length + 1).padStart(3, '0') + '-' + stampId.slice(-3);
        const by = String((body && body.by) || (kind === 'topup' ? 'внесено из панели' : 'внесено из панели'));
        const period = String((body && body.period) || '');
        const block = kind === 'topup'
          ? ['- { id: ' + id + ', client: ' + client + ', channel: ' + channel + ', date: "' + date + '", amount_rub: ' + amount + ', by: "' + by.replace(/"/g, '') + '" }']
          : ['- { id: ' + id + ', client: ' + client + ', channel: ' + channel + ', date: "' + date + '", amount_rub: ' + amount + ', period: "' + (period || date).replace(/"/g, '') + '" }'];
        const result = applyAtomicEdit(AD_BUDGETS_FILE, 'ad-budgets.yaml', function (text) { return appendListBlock(text, kind === 'topup' ? 'topups' : 'spends', block); });
        if (!result.ok) return sendJson(res, result.code || 400, result);
        return done(result, { id: id, target: (kind === 'topup' ? 'пополнение ' : 'расход ') + amount + ' ₽ по каналу ' + channel + ' для ' + client });
      }

      if (kind === 'rate') {
        const rate = Number(body && body.rate_pct);
        const fixed = Number((body && body.fixed_rub) || 0);
        if (!channel) return fail(400, 'нужен канал');
        if (!isFinite(rate) || rate < 0 || rate > 100) return fail(400, 'ставка от 0 до 100 %');
        if (!isFinite(fixed) || fixed < 0) return fail(400, 'фикс не может быть отрицательным');
        const reason = String((body && body.reason) || 'изменено из панели').replace(/"/g, '');
        const id = 'rate-' + stampId;
        const block = ['- { id: ' + id + ', client: ' + (client || 'null') + ', channel: ' + channel + ', rate_pct: ' + rate + ', fixed_rub: ' + fixed + ', since: "' + today + '", reason: "' + reason + '" }'];
        const result = applyAtomicEdit(AD_BUDGETS_FILE, 'ad-budgets.yaml', function (text) { return appendListBlock(text, 'rates', block); });
        if (!result.ok) return sendJson(res, result.code || 400, result);
        return done(result, { id: id, target: 'ставка ' + rate + '%' + (fixed ? ' + ' + fixed + ' ₽' : '') + ' для ' + (client || 'всех клиентов') + ' по каналу ' + channel });
      }

      if (kind === 'accrue') {
        const base = Number(body && body.base_rub);
        const rate = Number(body && body.rate_pct);
        const fixed = Number((body && body.fixed_rub) || 0);
        if (!client || !channel) return fail(400, 'нужны клиент и канал');
        if (!isFinite(base) || base < 0) return fail(400, 'база должна быть неотрицательной');
        if (!isFinite(rate) || rate < 0 || rate > 100) return fail(400, 'ставка от 0 до 100 %');
        const computed = Math.round((base * rate / 100 + fixed) * 100) / 100;
        const period = String((body && body.period) || today.slice(0, 7));
        const id = 'acc-' + stampId;
        const block = ['- { id: ' + id + ', client: ' + client + ', channel: ' + channel + ', period: "' + period + '", base_rub: ' + base + ', rate_pct: ' + rate + ', fixed_rub: ' + fixed + ', amount_rub: ' + computed + ', status: начислено, doc: null }'];
        const result = applyAtomicEdit(CASHBACK_FILE, 'cashback.yaml', function (text) { return appendListBlock(text, 'accruals', block); });
        if (!result.ok) return sendJson(res, result.code || 400, result);
        return done(result, { id: id, amountRub: computed, formula: base + ' × ' + rate + '%' + (fixed ? ' + ' + fixed + ' ₽' : '') + ' = ' + computed + ' ₽', target: 'начислено ' + computed + ' ₽ клиенту ' + client });
      }

      if (kind === 'payout') {
        if (!client) return fail(400, 'нужен клиент');
        if (!isFinite(amount) || amount <= 0) return fail(400, 'нужна положительная сумма');
        const date = String((body && body.date) || today);
        const method = String((body && body.method) || 'СБП').replace(/"/g, '');
        const id = 'pay-' + stampId;
        const block = ['- { id: ' + id + ', client: ' + client + ', date: "' + date + '", amount_rub: ' + amount + ', method: "' + method + '", status: выплачено, doc: null }'];
        const result = applyAtomicEdit(CASHBACK_FILE, 'cashback.yaml', function (text) { return appendListBlock(text, 'payouts', block); });
        if (!result.ok) return sendJson(res, result.code || 400, result);
        return done(result, { id: id, target: 'выплата ' + amount + ' ₽ клиенту ' + client });
      }

      if (kind === 'mode') {
        const mode = String((body && body.mode) || '');
        if (['client-pays', 'through-service'].indexOf(mode) === -1) return fail(400, 'режим: client-pays или through-service');
        const reason = String((body && body.reason) || 'изменено из панели').replace(/"/g, '');
        const block = ['- { client: ' + client + ', channel: null, mode: ' + mode + ', since: "' + today + '", reason: "' + reason + '" }'];
        const result = applyAtomicEdit(AD_BUDGETS_FILE, 'ad-budgets.yaml', function (text) { return appendListBlock(text, 'modes', block); });
        if (!result.ok) return sendJson(res, result.code || 400, result);
        return done(result, { target: 'режим клиента ' + client + ': ' + (mode === 'client-pays' ? 'клиент платит площадке сам' : 'бюджет через сервис (нужно ИП/ООО)') });
      }

      // --- кэшбэк ОПЕРАТОРУ (третий уровень: платформа -> оператор) ---
      if (kind === 'op-accrue') {
        const operator = String((body && body.operator) || '');
        const base = Number(body && body.base_rub);
        const rate = Number(body && body.rate_pct);
        if (!operator) return fail(400, 'нужен оператор');
        if (!isFinite(base) || base < 0) return fail(400, 'база (оборот оператора) должна быть неотрицательной');
        if (!isFinite(rate) || rate < 0 || rate > 100) return fail(400, 'ставка от 0 до 100 %');
        const computed = Math.round(base * rate / 100 * 100) / 100;
        const period = String((body && body.period) || today.slice(0, 7));
        const id = 'opacc-' + stampId;
        const block = ['- { id: ' + id + ', operator: ' + operator + ', period: "' + period + '", base_rub: ' + base + ', rate_pct: ' + rate + ', amount_rub: ' + computed + ', status: начислено }'];
        const result = applyAtomicEdit(CASHBACK_FILE, 'cashback.yaml', function (text) { return appendListBlock(text, 'operator_accruals', block); });
        if (!result.ok) return sendJson(res, result.code || 400, result);
        return done(result, { id: id, amountRub: computed, formula: base + ' × ' + rate + '% = ' + computed + ' ₽', target: 'начислено оператору ' + operator + ': ' + computed + ' ₽' });
      }

      if (kind === 'op-payout') {
        const operator = String((body && body.operator) || '');
        if (!operator) return fail(400, 'нужен оператор');
        if (!isFinite(amount) || amount <= 0) return fail(400, 'нужна положительная сумма');
        const date = String((body && body.date) || today);
        const method = String((body && body.method) || 'СБП').replace(/"/g, '');
        const id = 'oppay-' + stampId;
        const block = ['- { id: ' + id + ', operator: ' + operator + ', date: "' + date + '", amount_rub: ' + amount + ', method: "' + method + '", status: выплачено, doc: null }'];
        const result = applyAtomicEdit(CASHBACK_FILE, 'cashback.yaml', function (text) { return appendListBlock(text, 'operator_payouts', block); });
        if (!result.ok) return sendJson(res, result.code || 400, result);
        return done(result, { id: id, target: 'выплата ' + amount + ' ₽ оператору ' + operator });
      }

      if (kind === 'op-rate') {
        const operator = String((body && body.operator) || '');
        const rate = Number(body && body.rate_pct);
        if (!operator) return fail(400, 'нужен оператор');
        if (!isFinite(rate) || rate < 0 || rate > 100) return fail(400, 'ставка от 0 до 100 %');
        const result = applyAtomicEdit(OPERATORS_FILE, 'operators.yaml', function (text) {
          return setListItemField(text, { idField: 'id', idValue: operator, field: 'cashback_pct', value: rate });
        });
        if (!result.ok) return sendJson(res, result.code || 400, result);
        return done(result, { target: 'ставка кэшбэка оператора ' + operator + ' = ' + rate + '%' });
      }

      if (kind === 'ipo') {
        if (typeof (body && body.value) !== 'boolean') return fail(400, 'нужно true или false');
        const result = applyAtomicEdit(OPERATORS_FILE, 'operators.yaml', function (text) {
          return setYamlScalar(text, ['settings', 'ipo_registered'], body.value);
        });
        if (!result.ok) return sendJson(res, result.code || 400, result);
        return done(result, { target: 'ИП оформлен: ' + (body.value ? 'да' : 'нет') });
      }

      return fail(400, 'неизвестное действие: ' + kind);
    });
  }

  // --- выгрузка расходов в CSV ---
  if (p === '/api/ads/export' && method === 'GET') {
    const doc = collect({});
    let ads = null;
    try { ads = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'ads.json'), 'utf8')); } catch (e) { /* ignore */ }
    if (!ads) return sendJson(res, 500, { ok: false, message: 'нет данных раздела «Реклама и кэшбэк»' });
    const what = String((url && url.searchParams.get('what')) || 'spends');
    let head = [];
    let rows = [];
    if (what === 'channels') {
      head = ['Канал', 'Расход', 'Остаток', 'Ставка %', 'Кэшбэк', 'Способ получения'];
      rows = ads.channelRows.map(function (c) { return [c.name, c.spend, c.balance, c.ratePct, c.cashback, c.sourceLabel]; });
    } else if (what === 'clients') {
      head = ['Клиент', 'Бюджет', 'Прогнано', 'Остаток', 'Кэшбэк', 'Режим'];
      rows = ads.clientRows.map(function (c) { return [c.name, c.topup, c.spend, c.balance, c.cashback, c.modeLabel]; });
    } else if (what === 'accruals') {
      head = ['Клиент', 'Канал', 'Период', 'База', 'Ставка %', 'Сумма', 'Статус'];
      rows = ads.accruals.map(function (a) { return [a.clientName, a.channelName, a.period, a.baseRub, a.ratePct, a.amountRub, a.statusLabel]; });
    } else if (what === 'act') {
      // ЕДИНЫЙ АКТ на клиента за период по всем площадкам — «один общий акт вместо десятка».
      const clientId = String((url && url.searchParams.get('client')) || '');
      const period = String((url && url.searchParams.get('period')) || '');
      const cl = (ads.clientRows || []).filter(function (c) { return c.id === clientId; })[0];
      if (!cl) { res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, message: 'клиент не найден: ' + clientId })); return; }
      head = ['Акт', 'Клиент', 'Период', 'Площадка', 'Расход', 'Возврат', 'Кэшбэк оператору', 'Комиссия', 'Режим'];
      const rowsByChannel = ads.channelRows.filter(function (c) { return (c.clients || 0) > 0; });
      const chSpends = {};
      ads.spends.filter(function (s) { return s.client === clientId; }).forEach(function (s) { chSpends[s.channel] = (chSpends[s.channel] || 0) + s.amountRub; });
      const actNo = 'АКТ-' + (period || ads.today.slice(0, 7)) + '-' + clientId;
      rows = Object.keys(chSpends).map(function (chId) {
        const ch = (ads.channels || []).filter(function (c) { return c.id === chId; })[0] || {};
        const ret = ads.returns.filter(function (r) { return r.client === clientId && r.channel === chId; }).reduce(function (a, r) { return a + r.amountRub; }, 0);
        return [actNo, cl.name, period || ads.today.slice(0, 7), ch.name || chId, chSpends[chId], ret, '', '', cl.modeLabel];
      });
      rows.push([actNo, cl.name, period || ads.today.slice(0, 7), 'ИТОГО', cl.spend, cl.returnRub, cl.cashbackDueRub, cl.commissionRub, cl.modeLabel]);
    } else if (what === 'operators') {
      head = ['Оператор', 'Оборот', 'Комиссия платформы', 'Кэшбэк оператора', 'К выплате', 'Ставка %', 'Клиентов', 'Статус', 'Договор'];
      rows = ads.operatorRows.map(function (o) { return [o.name, o.turnover, o.commission, o.cashback, o.due, o.ratePct, o.clientsCount, o.statusLabel, o.contract || '']; });
    } else if (what === 'platform') {
      head = ['Показатель', 'Сумма, ₽', 'Пояснение'];
      const p = ads.platform;
      rows = [
        ['Оборот — НЕ доход платформы', p.turnoverRub, 'чужие деньги, прошедшие через платформу'],
        ['Комиссия платформы (доход)', p.commissionRub, 'оборот × ' + p.commissionPct + '%'],
        ['Кэшбэк операторов', p.operatorsCashbackRub, 'вознаграждение операторам'],
        ['Маржа платформы', p.marginRub, 'комиссия − кэшбэк операторов'],
        ['К выплате операторам', p.operatorsDueRub, 'начислено − выплачено']
      ];
    } else {
      head = ['Дата', 'Клиент', 'Канал', 'Сумма', 'Период'];
      rows = ads.spends.map(function (s) { return [s.date, s.client, s.channel, s.amountRub, s.period || '']; });
    }
    function cell(v) { const s = String(v === null || v === undefined ? '' : v); return /[",;\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
    const csv = [head.join(';')].concat(rows.map(function (r) { return r.map(cell).join(';'); })).join('\r\n') + '\r\n';
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="ads-' + what + '.csv"',
      'Cache-Control': 'no-store',
    });
    res.end('\uFEFF' + csv);
    return;
  }

  // --- добавить клиента ---
  if (p === '/api/service/add-client' && method === 'POST') {
    return readBody(req).then(function (body) {
      const name = String((body && body.name) || '').trim();
      if (name.length < 2) return sendJson(res, 400, { ok: false, message: 'нужно название клиента' });
      const contact = String((body && body.contact) || '').trim();
      const plan = String((body && body.plan) || 'start');
      if (['start', 'business', 'premium'].indexOf(plan) === -1) return sendJson(res, 400, { ok: false, message: 'недопустимый тариф' });
      const slug = String((body && body.id) || '').trim() || ('client-' + Date.now().toString(36));
      if (!/^[a-z0-9][a-z0-9-]{2,40}$/.test(slug)) return sendJson(res, 400, { ok: false, message: 'id клиента: латиница, цифры и дефисы, от 3 символов' });
      const doc = readYamlFile(CLIENTS_FILE);
      const list = doc && Array.isArray(doc.clients) ? doc.clients : [];
      if (list.some(function (c) { return c && String(c.id) === slug; })) return sendJson(res, 400, { ok: false, message: 'клиент с таким id уже есть' });
      const today = new Date().toISOString().slice(0, 10);
      const block = [
        '- id: ' + slug,
        '  name: "' + name.replace(/"/g, '') + '"',
        '  contact: "' + (contact || 'заполните контакт').replace(/"/g, '') + '"',
        '  status: lead',
        '  plan: ' + plan,
        '  since: "' + today + '"',
        '  objects: []',
        '  services: []',
        '  note: "Добавлен из панели ' + today + '."'
      ];
      const result = applyAtomicEdit(CLIENTS_FILE, 'clients.yaml', function (text) { return appendListBlock(text, 'clients', block); });
      if (!result.ok) return sendJson(res, result.code || 400, result);
      let meta = null;
      try { meta = collect({}); } catch (e) { /* best effort */ }
      return sendJson(res, 200, Object.assign({}, result, { id: slug, target: 'новый клиент ' + name, generatedAt: meta ? meta.generatedAt : null }));
    });
  }

  // --- выставить счёт за период ---
  if (p === '/api/service/invoice' && method === 'POST') {
    return readBody(req).then(function (body) {
      const clientId = String((body && body.client) || '');
      const period = String((body && body.period) || new Date().toISOString().slice(0, 7));
      const subs = readYamlFile(SUBS_FILE);
      const subsList = subs && Array.isArray(subs.subscriptions) ? subs.subscriptions : [];
      const mine = subsList.filter(function (s) { return s && String(s.client) === clientId; });
      if (mine.length === 0) return sendJson(res, 400, { ok: false, message: 'у клиента нет подписок — счёт выставлять не за что' });
      const amount = mine.reduce(function (acc, s) { return acc + (Number(s.price_rub) || 0); }, 0);
      const doc = readYamlFile(INVOICES_FILE);
      const list = doc && Array.isArray(doc.invoices) ? doc.invoices : [];
      const id = 'inv-' + period + '-' + String(list.length + 1).padStart(3, '0');
      if (list.some(function (i) { return i && String(i.id) === id; })) return sendJson(res, 400, { ok: false, message: 'счёт с таким номером уже есть: ' + id });
      const today = new Date().toISOString().slice(0, 10);
      const block = [
        '- id: ' + id,
        '  client: ' + clientId,
        '  period: "' + period + '"',
        '  amount_rub: ' + amount,
        '  status: issued',
        '  issued: "' + today + '"',
        '  file: null'
      ];
      const result = applyAtomicEdit(INVOICES_FILE, 'invoices.yaml', function (text) { return appendListBlock(text, 'invoices', block); });
      if (!result.ok) return sendJson(res, result.code || 400, result);
      let meta = null;
      try { meta = collect({}); } catch (e) { /* best effort */ }
      return sendJson(res, 200, Object.assign({}, result, { id: id, amountRub: amount, target: 'счёт ' + id + ' на ' + amount + ' ₽', generatedAt: meta ? meta.generatedAt : null }));
    });
  }

  // --- запуск услуги клиенту: прогон + запись в runs.jsonl + артефакт ---
  if (p === '/api/service/run' && method === 'POST') {
    return readBody(req).then(function (body) {
      const serviceId = String((body && body.service) || '');
      const clientId = String((body && body.client) || '');
      const svc = findService(serviceId);
      if (!svc) return sendJson(res, 400, { ok: false, message: 'услуга не найдена: ' + serviceId });
      if (svc.enabled !== true) return sendJson(res, 400, { ok: false, message: 'услуга «' + svc.name + '» выключена или ещё не готова (status: ' + svc.status + '). Включите её в разделе «Услуги».' });
      const clients = readYamlFile(CLIENTS_FILE);
      const cl = (clients && Array.isArray(clients.clients) ? clients.clients : []).filter(function (c) { return c && String(c.id) === clientId; })[0];
      if (!cl) return sendJson(res, 400, { ok: false, message: 'клиент не найден: ' + clientId });

      const started = Date.now();
      const dates = snapshotDates();
      const curr = dates.length ? dates[dates.length - 1] : null;
      const prev = dates.length > 1 ? dates[dates.length - 2] : null;
      const runId = 'run-' + Date.now().toString(36);
      const ts = new Date().toISOString();
      const cost = Number(svc.cost_rub) || 0;

      if (!curr) {
        const entry = appendRunLine({ run_id: runId, ts: ts, service: serviceId, client: clientId, agent: svc.agent, status: 'failed', duration_ms: Date.now() - started, cost_rub: 0, artifact: null, error: 'нет снимков: сначала запустите сбор данных' });
        return sendJson(res, 400, { ok: false, message: entry.error, run: entry });
      }

      const args = [path.join(CW_SCRIPTS, 'build_weekly_report.py'), '--curr', curr];
      if (prev) args.push('--prev', prev);
      const proc = runProcess(PYTHON, args, PROJECT_DIR, 180000);
      const rep = newestReport();

      // артефакт в папке клиента
      let artifact = null;
      if (proc.ok && rep) {
        const dir = path.join(CLIENT_REPORTS_DIR, clientId);
        try {
          fs.mkdirSync(dir, { recursive: true });
          const ext = path.extname(rep.name);
          artifact = path.join(dir, curr + '-competitor-watch' + ext);
          fs.copyFileSync(rep.path, artifact);
        } catch (e) { artifact = null; }
      }

      const entry = appendRunLine({
        run_id: runId, ts: ts, service: serviceId, client: clientId, agent: svc.agent,
        status: proc.ok ? 'ok' : 'failed',
        duration_ms: Date.now() - started,
        cost_rub: proc.ok ? cost : 0,
        artifact: artifact,
        error: proc.ok ? null : (proc.output || 'ошибка движка').split('\n').slice(-3).join(' '),
      });
      let meta = null;
      try { meta = collect({}); } catch (e) { /* best effort */ }
      return sendJson(res, proc.ok ? 200 : 500, {
        ok: proc.ok, run: entry, generatedAt: meta ? meta.generatedAt : null,
        output: proc.output.split('\n').slice(-12).join('\n'),
        message: proc.ok
          ? ('Услуга «' + svc.name + '» выполнена для клиента «' + cl.name + '»: прогон ' + runId + ', себестоимость ' + cost + ' ₽.')
          : ('Прогон не удался, запись в журнал добавлена: ' + entry.error),
      });
    });
  }

  // --- запуск действий панели: только белый список ---
  // ВОПРОС АГЕНТУ из кабинета клиента (T78). Это интерфейсная фича: вопрос становится задачей
  // оператору, клиент видит статус «новая». Пишем атомарно (temp + rename) в реестр.
  if (p === '/api/client/question' && method === 'POST') {
    // readBody возвращает Promise — обработчик строим на .then, иначе ответ не уходит и запрос висит.
    return readBody(req).then(function (body) {
      const data = body || {};
      const comment = String(data.comment || '').trim();
      const topic = String(data.topic || '').trim();
      if (!comment) return sendJson(res, 400, { ok: false, message: 'пустой вопрос — опишите, что нужно' });
      if (comment.length > 4000) return sendJson(res, 400, { ok: false, message: 'слишком длинный вопрос (максимум 4000 символов)' });
      // Лимит частоты: не больше 5 вопросов за 10 минут с одной панели.
      const now = Date.now();
      RATE.question = (RATE.question || []).filter(function (t) { return now - t < 10 * 60 * 1000; });
      if (RATE.question.length >= 5) return sendJson(res, 429, { ok: false, message: 'слишком много вопросов подряд — попробуйте через 10 минут' });
      RATE.question.push(now);
      let list = [];
      try { if (fs.existsSync(QUESTIONS_FILE)) list = JSON.parse(fs.readFileSync(QUESTIONS_FILE, 'utf8')); } catch (e) { list = []; }
      if (!Array.isArray(list)) list = [];
      const rec = {
        id: 'q-' + now.toString(36) + '-' + Math.random().toString(36).slice(2, 6),
        at: new Date().toISOString(),
        status: 'new',
        name: String(data.name || '').slice(0, 200),
        contact: String(data.contact || '').slice(0, 200),
        topic: topic.slice(0, 300),
        comment: comment.slice(0, 4000),
        source: String(data.source || 'client-cabinet').slice(0, 60),
        page: String(data.page || '').slice(0, 200),
      };
      list.push(rec);
      try {
        const tmp = QUESTIONS_FILE + '.tmp-' + now;
        fs.writeFileSync(tmp, JSON.stringify(list, null, 2) + '\n', 'utf8');
        fs.renameSync(tmp, QUESTIONS_FILE);   // атомарная замена: сервер не отдаёт недописанный файл
      } catch (e) {
        return sendJson(res, 500, { ok: false, message: 'не удалось сохранить вопрос: ' + e.message });
      }
      return sendJson(res, 200, { ok: true, id: rec.id, status: 'new', message: 'вопрос передан оператору' });
    });
  }

  if (p === '/api/actions/run' && method === 'POST') {
    return readBody(req).then(function (body) {
      const action = String((body && body.action) || '');
      const started = Date.now();
      const dates = snapshotDates();
      const curr = dates.length ? dates[dates.length - 1] : null;
      const prev = dates.length > 1 ? dates[dates.length - 2] : null;

      if (action === 'collect') {
        const res2 = runProcess(process.execPath, [COLLECT_SCRIPT], PROJECT_DIR, 180000);
        let meta = null;
        try { meta = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'meta.json'), 'utf8')); } catch (e) { /* ignore */ }
        return sendJson(res, res2.ok ? 200 : 500, {
          ok: res2.ok, action: action, durationMs: Date.now() - started, exitCode: res2.exitCode,
          output: res2.output.split('\n').slice(-25).join('\n'),
          result: meta ? { sessions: meta.totals.sessions, tasks: meta.totals.tasks, rub: meta.totals.rub, generatedAt: meta.generatedAt } : null,
          message: res2.ok ? 'Данные пересобраны' : 'Сборщик завершился с ошибкой',
        });
      }

      if (action === 'report') {
        if (!curr) return sendJson(res, 400, { ok: false, message: 'нет снимков — сначала соберите данные' });
        const args = [path.join(CW_SCRIPTS, 'build_weekly_report.py'), '--curr', curr];
        if (prev) args.push('--prev', prev);
        const res2 = runProcess(PYTHON, args, PROJECT_DIR, 180000);
        const rep = newestReport();
        return sendJson(res, res2.ok ? 200 : 500, {
          ok: res2.ok, action: action, durationMs: Date.now() - started, exitCode: res2.exitCode,
          output: res2.output.split('\n').slice(-25).join('\n'),
          result: { curr: curr, prev: prev, report: rep },
          message: res2.ok ? ('Отчёт построен за ' + curr + (prev ? ' (сравнение с ' + prev + ')' : '')) : 'Построение отчёта завершилось с ошибкой',
        });
      }

      if (action === 'agent') {
        const agentId = String((body && body.agent) || 'agent-1-competitor-watch');
        if (agentId !== 'agent-1-competitor-watch') {
          return sendJson(res, 400, { ok: false, message: 'для агента «' + agentId + '» команда запуска пока не настроена: он в статусе «запланирован». Настроенный агент — «Агент 1 — Мониторинг конкурентов».' });
        }
        if (!curr) return sendJson(res, 400, { ok: false, message: 'нет снимков — сначала соберите данные' });
        const args = [path.join(CW_SCRIPTS, 'run_weekly.py'), '--date', curr, '--skip-sources'];
        if (prev) args.push('--prev', prev);
        const res2 = runProcess(PYTHON, args, PROJECT_DIR, 180000);
        const rep = newestReport();
        return sendJson(res, res2.ok ? 200 : 500, {
          ok: res2.ok, action: action, agent: agentId, durationMs: Date.now() - started, exitCode: res2.exitCode,
          output: res2.output.split('\n').slice(-25).join('\n'),
          result: { curr: curr, prev: prev, report: rep, skipSources: true },
          message: res2.ok
            ? ('Агент отработал цикл за ' + curr + ': проверка снимка, сравнение и отчёт. С сбором с площадок пропущен (--skip-sources) — он требует входа в Chrome.')
            : 'Цикл агента завершился с ошибкой',
        });
      }

      return sendJson(res, 400, { ok: false, message: 'неизвестное действие: ' + action });
    });
  }


// --- роутинг моделей delegate-router ---
  if (p === '/api/settings/routing' && method === 'POST') {
    return readBody(req).then(function (body) {
      const field = String((body && body.field) || '');
      if (field !== 'flashModel' && field !== 'proModel') return sendJson(res, 400, { ok: false, message: 'неизвестное поле роутинга: ' + field });
      const value = String((body && body.value) || '').trim();
      if (value === '') return sendJson(res, 400, { ok: false, message: 'модель не выбрана' });
      let prices = null;
      try { prices = parseYaml(fs.readFileSync(PRICES_FILE, 'utf8')); } catch (e) { prices = null; }
      const known = prices && prices.models && typeof prices.models === 'object' ? Object.keys(prices.models) : [];
      if (known.length > 0 && known.indexOf(value) === -1) return sendJson(res, 400, { ok: false, message: 'модель не найдена в registry/prices.yaml: ' + value });

      const dir = path.dirname(ROUTER_FILE);
      try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* ignore */ }
      const existed = fs.existsSync(ROUTER_FILE);
      let doc = {};
      if (existed) { try { doc = JSON.parse(fs.readFileSync(ROUTER_FILE, 'utf8')) || {}; } catch (e) { return sendJson(res, 400, { ok: false, message: 'файл роутинга повреждён: ' + e.message }); } }
      const previous = doc[field] === undefined ? null : String(doc[field]);
      if (previous === value) return sendJson(res, 200, { ok: true, changed: false, previous: previous, message: 'уже выбрана эта модель', target: 'роутинг: ' + field });
      doc[field] = value;
      let backup = null;
      if (existed) {
        let bf = ROUTER_FILE + '.bak-' + stamp();
        let n = 2;
        while (fs.existsSync(bf)) { bf = ROUTER_FILE + '.bak-' + stamp() + '-' + n; n++; }
        fs.copyFileSync(ROUTER_FILE, bf);
        backup = path.basename(bf);
      }
      const tmp = ROUTER_FILE + '.tmp-' + process.pid;
      fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8');
      try { fs.renameSync(tmp, ROUTER_FILE); }
      catch (e) {
        try { fs.unlinkSync(tmp); } catch (e2) { /* ignore */ }
        return sendJson(res, 500, { ok: false, message: 'не удалось записать конфиг роутинга: ' + e.message });
      }
      let meta = null;
      try { meta = collect({}); } catch (e) { /* best effort */ }
      return sendJson(res, 200, {
        ok: true, changed: true, previous: previous, backup: backup, created: !existed, file: ROUTER_FILE,
        target: 'роутинг: ' + field, generatedAt: meta ? meta.generatedAt : null,
        note: (existed ? 'обновлено' : 'файл создан') + ': ' + field + ' = ' + value + (backup ? '; копия ' + backup : ''),
      });
    });
  }

  // --- включение/выключение плагина в профиле ---
  if (p === '/api/settings/plugin' && method === 'POST') {
    return readBody(req).then(function (body) {
      const pkg = String((body && body.package) || '');
      const enabled = body && body.enabled === true;
      if (!pkg) return sendJson(res, 400, { ok: false, message: 'не указан пакет' });
      const guard = protectReason(pkg);
      if (guard) return sendJson(res, 400, { ok: false, message: 'этот пакет выключать нельзя: ' + guard, protected: true });
      if (!fs.existsSync(PROFILE_MANIFEST)) return sendJson(res, 500, { ok: false, message: 'не найден профиль DSH: ' + PROFILE_MANIFEST });
      const original = fs.readFileSync(PROFILE_MANIFEST, 'utf8');
      let manifest = null;
      try { manifest = JSON.parse(original); } catch (e) { return sendJson(res, 500, { ok: false, message: 'package.json профиля не разобран: ' + e.message }); }
      const bundles = manifest.dsh && manifest.dsh.profile && Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles.map(String) : [];
      const deps = manifest.dependencies && typeof manifest.dependencies === 'object' ? manifest.dependencies : {};
      if (!Object.prototype.hasOwnProperty.call(deps, pkg) && bundles.indexOf(pkg) === -1) {
        return sendJson(res, 400, { ok: false, message: 'пакет не объявлен в профиле: ' + pkg });
      }
      const has = bundles.indexOf(pkg) >= 0;
      if (has === enabled) return sendJson(res, 200, { ok: true, changed: false, message: enabled ? 'уже включён' : 'уже выключен', target: pkg });
      let next;
      if (enabled) {
        const at = originalBundleIndex(pkg);
        if (at !== null && at <= bundles.length) next = bundles.slice(0, at).concat([pkg], bundles.slice(at));
        else next = bundles.concat([pkg]);
      } else {
        next = bundles.filter(function (x) { return x !== pkg; });
      }
      if (next.length === 0) return sendJson(res, 400, { ok: false, message: 'нельзя оставить профиль без бандлов' });

      const edited = editBundlesArray(original, next);
      if (!edited.ok) return sendJson(res, 500, { ok: false, message: edited.reason });

      let backupFile = PROFILE_MANIFEST + '.bak-' + stamp();
      let bn = 2;
      while (fs.existsSync(backupFile)) { backupFile = PROFILE_MANIFEST + '.bak-' + stamp() + '-' + bn; bn++; }
      fs.copyFileSync(PROFILE_MANIFEST, backupFile);
      const tmpFile = PROFILE_MANIFEST + '.tmp-' + process.pid;
      fs.writeFileSync(tmpFile, edited.text, 'utf8');
      try { fs.renameSync(tmpFile, PROFILE_MANIFEST); }
      catch (e) {
        try { fs.unlinkSync(tmpFile); } catch (e2) { /* ignore */ }
        return sendJson(res, 500, { ok: false, message: 'не удалось записать package.json: ' + e.message });
      }

      // ОБЯЗАТЕЛЬНАЯ проверка профиля. Не прошла — откат из копии.
      const check = checkProfile();
      if (!check.ok) {
        try { fs.copyFileSync(backupFile, PROFILE_MANIFEST); } catch (e) { /* ignore */ }
        return sendJson(res, 400, {
          ok: false, rolledBack: true, backup: path.basename(backupFile),
          message: 'проверка профиля не прошла — изменения отменены, файл восстановлен из копии',
          checker: check.output.split('\n').slice(-12).join('\n'),
          target: pkg,
        });
      }
      let meta = null;
      try { meta = collect({}); } catch (e) { /* best effort */ }
      return sendJson(res, 200, {
        ok: true, changed: true, enabled: enabled, backup: path.basename(backupFile), file: PROFILE_MANIFEST,
        checkerOk: true, restartRequired: true, target: pkg,
        generatedAt: meta ? meta.generatedAt : null,
        note: (enabled ? 'включён' : 'выключен') + ' пакет ' + pkg + '; профиль проверен; копия ' + path.basename(backupFile) + '. НУЖЕН ПЕРЕЗАПУСК DSH.',
      });
    });
  }

  // --- откат: восстановить файл из копии, которую сделала конкретная правка ---
  if (p === '/api/settings/revert' && method === 'POST') {
    return readBody(req).then(function (body) {
      const which = String((body && body.file) || '');
      const backup = String((body && body.backup) || '');
      const files = {
        settings: SETTINGS_FILE, prices: PRICES_FILE, agents: AGENTS_FILE, sources: SOURCES_FILE,
        router: ROUTER_FILE, profile: PROFILE_MANIFEST,
        clients: CLIENTS_FILE, services: SERVICES_FILE, subscriptions: SUBS_FILE,
        invoices: INVOICES_FILE, results: RESULTS_FILE,
      };
      const target = files[which];
      if (!target) return sendJson(res, 400, { ok: false, message: 'неизвестный файл: ' + which });
      // Копия должна лежать рядом с файлом и называться <файл>.bak-<штамп> — без путей.
      if (backup.indexOf('/') >= 0 || backup.indexOf('\\') >= 0 || backup.indexOf('..') >= 0) {
        return sendJson(res, 400, { ok: false, message: 'недопустимое имя копии' });
      }
      const expectedPrefix = path.basename(target) + '.bak-';
      if (backup.indexOf(expectedPrefix) !== 0) {
        return sendJson(res, 400, { ok: false, message: 'копия не относится к этому файлу' });
      }
      const backupPath = path.join(path.dirname(target), backup);
      if (!fs.existsSync(backupPath)) return sendJson(res, 404, { ok: false, message: 'копия не найдена: ' + backup });
      if (!fs.existsSync(target)) return sendJson(res, 500, { ok: false, message: 'файл не найден: ' + target });
      // ВАЖНО: сначала читаем копию В ПАМЯТЬ, и только потом что-либо пишем.
      // Иначе копия безопасности с тем же именем (та же секунда) перезапишет
      // исходную копию, и «откат» вернёт то же изменённое состояние.
      let backupData;
      try { backupData = fs.readFileSync(backupPath); }
      catch (e) { return sendJson(res, 500, { ok: false, message: 'не удалось прочитать копию: ' + e.message }); }

      let safety = target + '.bak-' + stamp();
      let sn = 2;
      while (fs.existsSync(safety)) { safety = target + '.bak-' + stamp() + '-' + sn; sn++; }
      fs.copyFileSync(target, safety);

      const tmpRestore = target + '.tmp-' + process.pid;
      try {
        fs.writeFileSync(tmpRestore, backupData);
        fs.renameSync(tmpRestore, target);
      } catch (e) {
        try { fs.unlinkSync(tmpRestore); } catch (e2) { /* ignore */ }
        try { fs.copyFileSync(safety, target); } catch (e3) { /* ignore */ }
        return sendJson(res, 500, { ok: false, message: 'не удалось восстановить: ' + e.message });
      }
      let meta = null;
      try { meta = collect({}); } catch (e) { /* best effort */ }
      return sendJson(res, 200, {
        ok: true, changed: true, file: target, restoredFrom: backup, backup: path.basename(safety),
        target: 'возврат к состоянию до правки', generatedAt: meta ? meta.generatedAt : null,
        note: 'файл восстановлен из копии ' + backup + '; текущее состояние сохранено в ' + path.basename(safety),
      });
    });
  }

  // --- вкладка «Настройки»: правка любого разрешённого параметра ---
  if (p === '/api/settings/set' && method === 'POST') {
    return readBody(req).then(function (body) {
      if (!body || typeof body !== 'object') return sendJson(res, 400, { ok: false, message: 'нужно тело запроса' });
      const kind = String(body.kind || '');
      let result = null;
      let target = '';

      if (kind === 'settings-bool') {
        const key = Array.isArray(body.path) ? body.path.join('.') : String(body.path || '');
        if (ALLOWED_SETTINGS_BOOLS.indexOf(key) === -1) return sendJson(res, 400, { ok: false, message: 'переключатель не разрешён к правке: ' + key });
        const pathArr = key.split('.');
        target = 'доставка: ' + key;
        result = applyAtomicEdit(SETTINGS_FILE, 'settings.yaml', function (text) {
          return setYamlScalar(text, pathArr, body.value === true ? 'true' : 'false');
        });
      } else if (kind === 'settings-scalar' || kind === 'settings-list') {
        const key = Array.isArray(body.path) ? body.path.join('.') : String(body.path || '');
        if (kind === 'settings-scalar') {
          const spec = ALLOWED_SETTINGS_SCALARS[key];
          const err = validateValue(spec, body.value);
          if (err) return sendJson(res, 400, { ok: false, message: err });
          const pathArr = key.split('.');
          target = 'правила отчёта: ' + key;
          result = applyAtomicEdit(SETTINGS_FILE, 'settings.yaml', function (text) {
            return setYamlScalar(text, pathArr, body.value);
          });
        } else {
          const allowed = ALLOWED_SETTINGS_LISTS[key];
          if (!allowed) return sendJson(res, 400, { ok: false, message: 'список не разрешён к правке' });
          const values = Array.isArray(body.value) ? body.value.map(String) : [];
          if (values.length === 0) return sendJson(res, 400, { ok: false, message: 'нужен хотя бы один формат' });
          const bad = values.filter(function (v) { return allowed.indexOf(v) === -1; });
          if (bad.length > 0) return sendJson(res, 400, { ok: false, message: 'недопустимые значения: ' + bad.join(', ') });
          const pathArr = key.split('.');
          target = 'правила отчёта: ' + key;
          result = applyAtomicEdit(SETTINGS_FILE, 'settings.yaml', function (text) {
            return setYamlList(text, pathArr, values);
          });
        }
      } else if (kind === 'price-rate') {
        const n = Number(body.value);
        if (!isFinite(n) || n <= 0 || n > 100000) return sendJson(res, 400, { ok: false, message: 'курс должен быть положительным числом' });
        target = 'курс USD/RUB';
        result = applyAtomicEdit(PRICES_FILE, 'prices.yaml', function (text) {
          return setYamlScalar(text, ['rate', 'usd_rub'], n);
        });
      } else if (kind === 'price-model') {
        const id = String(body.id || '');
        const field = String(body.field || '');
        if (ALLOWED_PRICE_MODEL_FIELDS.indexOf(field) === -1) return sendJson(res, 400, { ok: false, message: 'поле цены не разрешено к правке' });
        if (!id) return sendJson(res, 400, { ok: false, message: 'не указана модель' });
        const n = body.value === null || body.value === '' ? null : Number(body.value);
        if (n !== null && (!isFinite(n) || n < 0 || n > 1000000)) return sendJson(res, 400, { ok: false, message: 'цена должна быть неотрицательным числом' });
        target = 'цена модели ' + id;
        result = applyAtomicEdit(PRICES_FILE, 'prices.yaml', function (text) {
          return setYamlScalar(text, ['models', id, field], n === null ? 'null' : n);
        });
      } else if (kind === 'agent-field') {
        const id = String(body.id || '');
        const field = String(body.field || '');
        const mode = ALLOWED_AGENT_FIELDS[field];
        if (!mode) return sendJson(res, 400, { ok: false, message: 'поле агента не разрешено к правке' });
        if (!id) return sendJson(res, 400, { ok: false, message: 'не указан агент' });
        target = 'агент ' + id + ': ' + field;
        if (mode === 'array') {
          const values = Array.isArray(body.value) ? body.value.map(String).filter(function (v) { return v !== ''; }) : [];
          result = applyAtomicEdit(AGENTS_FILE, 'agents.yaml', function (text) {
            return setListItemArray(text, { idField: 'id', idValue: id, field: field, values: values, quoted: field === 'groups' });
          });
        } else {
          const value = String(body.value === undefined || body.value === null ? '' : body.value).trim();
          if (value === '') return sendJson(res, 400, { ok: false, message: 'значение не может быть пустым' });
          result = applyAtomicEdit(AGENTS_FILE, 'agents.yaml', function (text) {
            return setListItemField(text, { idField: 'id', idValue: id, field: field, value: '"' + value + '"' });
          });
        }
      } else {
        return sendJson(res, 400, { ok: false, message: 'неизвестный тип правки: ' + kind });
      }

      if (!result.ok) return sendJson(res, result.code || 400, result);
      let meta = null;
      try { meta = collect({}); } catch (e) { /* best effort */ }
      return sendJson(res, 200, Object.assign({}, result, {
        target: target,
        generatedAt: meta ? meta.generatedAt : null,
        note: result.changed ? ('изменено: ' + target + '; копия ' + result.backup) : 'значение уже такое',
      }));
    });
  }

  const sourceToggleMatch = /^\/api\/sources\/([^/]+)\/toggle$/.exec(p);
  if (sourceToggleMatch && method === 'POST') {
    const id = decodeURIComponent(sourceToggleMatch[1]);
    return readBody(req).then(function (body) {
      let desired = null;
      if (body && typeof body.enabled === 'boolean') desired = body.enabled;
      let result;
      try { result = toggleSource(id, desired); }
      catch (e) { return sendJson(res, 500, { ok: false, message: 'ошибка правки реестра источников: ' + e.message }); }
      if (!result.ok) return sendJson(res, result.code || 500, result);
      let meta = null;
      try { meta = collect({}); } catch (e) { /* обновление состояния — best effort */ }
      let sources = [];
      try {
        const doc = parseYaml(fs.readFileSync(SOURCES_FILE, 'utf8'));
        sources = (Array.isArray(doc.sources) ? doc.sources : []).filter(function (s) { return s && s.id !== undefined; })
          .map(function (s) { return { id: String(s.id), name: s.name !== undefined ? String(s.name) : String(s.id), enabled: s.enabled === true, status: s.status !== undefined ? String(s.status) : null }; });
      } catch (e) { /* ignore */ }
      return sendJson(res, 200, Object.assign({}, result, {
        sources: sources,
        generatedAt: meta ? meta.generatedAt : null,
        note: 'enabled записан в registry/sources.yaml атомарно; копия: ' + (result.backup || 'не потребовалась'),
      }));
    });
  }

  if (p.startsWith('/api/')) {
    return sendJson(res, 404, { ok: false, message: 'неизвестный метод API: ' + method + ' ' + p });
  }

  return serveStatic(req, res, p);
});

// Панель не должна падать из-за одной ошибки в обработчике: логируем и живём дальше.
process.on('uncaughtException', function (e) {
  console.error('[uncaughtException] ' + (e && e.stack ? e.stack : e));
});
process.on('unhandledRejection', function (e) {
  console.error('[unhandledRejection] ' + (e && e.stack ? e.stack : e));
});

server.on('error', function (e) {
  if (e.code === 'EADDRINUSE') {
    console.error('Порт ' + PORT + ' уже занят. Запустите с другим портом:  $env:DASHBOARD_PORT=8788; node dashboard/serve.mjs');
  } else {
    console.error('Ошибка сервера: ' + e.message);
  }
  process.exit(1);
});

server.listen(PORT, HOST, function () {
  console.log('Центр управления агентами: http://' + HOST + ':' + PORT);
  console.log('  статика:   ' + PUBLIC_DIR);
  console.log('  данные:    ' + DATA_DIR);
  console.log('  реестр:    ' + AGENTS_FILE + '  (тумблер агентов пишет сюда с бэкапом .bak-<timestamp>)');
  console.log('  источники: ' + SOURCES_FILE + '  (тумблер источников пишет сюда с бэкапом)');
  if (ACCESS_KEY) {
    console.log('');
    console.log('  Доступ: локально (127.0.0.1) — без ключа.');
    console.log('  Снаружи нужен ключ, он лежит в ' + ACCESS_KEY_FILE);
    console.log('  Ссылка с ключом:  http://<ваш-адрес>:' + PORT + '/?key=' + ACCESS_KEY);
  }
  console.log('  Ctrl+C — остановить.');
});

export { server, toggleAgent, toggleSource, ACCESS_KEY };

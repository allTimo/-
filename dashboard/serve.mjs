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
//   POST /api/vault/export        - write dashboard notes into the Obsidian vault (subfolder only)
//
// Кабинеты Яндекс.Директа (Агент 2) — токены только в 00-admin/config/direct-accounts.local.json
// (вне репозитория, правило *.local), наружу — маска из последних 4 символов:
//   GET  /api/direct/accounts         - OAuth-настройки (маска client_id) + кабинеты
//   POST /api/direct/oauth            - {"clientId"} сохранить client_id приложения
//   POST /api/direct/accounts         - {"token","login","sandbox"} проверить живым
//                                       запросом к API v5 и только при успехе сохранить
//   POST /api/direct/accounts/check   - {"id"} перепроверить кабинет
//   POST /api/direct/accounts/delete  - {"id"} удалить кабинет
//
// Two writes leave dashboard/: (1) the agent/source toggle rewrites
// registry/agents.yaml atomically (temp file + rename) after making a
// .bak-<timestamp> copy; (2) the Obsidian export writes notes INSIDE the vault,
// but only into its «выгрузка-панели» subfolder and also after a .bak copy.
// Плюс (3) API кабинетов Яндекс.Директа пишет токены в
// 00-admin/config/direct-accounts.local.json — файл вне репозитория (*.local).
// Everything else is read-only.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PUBLIC_DIR, DATA_DIR, REGISTRY_DIR, DASHBOARD_DIR, PROJECT_DIR, WORKSPACE_ROOT } from './collector/lib/paths.mjs';
import { parseYaml, parseScalar, setListItemFlag, setYamlScalar, setYamlList, setListItemField, setListItemArray, insertChildBlock } from './collector/lib/yaml.mjs';
import { collect } from './collector/collect.mjs';
// Кабинеты Яндекс.Директа (Агент 2): хранилище токенов вне репозитория + маскирование.
import {
  ACCOUNTS_FILE,
  readStore, publicOauth, publicAccount, saveClientId,
  findAccount, upsertVerifiedAccount, updateAccountCheck, deleteAccount, maskToken,
} from './lib/direct-accounts.mjs';

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
const CW_CANDIDATES_DIR = path.join(CW_DIR, 'data', 'candidates');
// КЛИЕНТСКИЕ КОНФИГИ — ИСТИНА списка конкурентов (контракт v2, §5.1). Пишет только панель,
// атомарно с копией .bak. Переопределяется лишь для автотестов: e2e add/remove идёт
// на КОПИИ конфига, реальный client-*.yaml при проверке не меняется.
const CW_CLIENTS_DIR = process.env.DASHBOARD_CW_CLIENTS_DIR && process.env.DASHBOARD_CW_CLIENTS_DIR.trim() !== ''
  ? process.env.DASHBOARD_CW_CLIENTS_DIR
  : path.join(CW_DIR, 'config', 'clients');
const COLLECT_SCRIPT = path.join(DASHBOARD_DIR, 'collector', 'collect.mjs');
// --- выгрузка в Obsidian: модуль-исполнитель (его создаёт отдельный агент) ---
// Маршрут POST /api/vault/export зовёт exportVault({ dryRun }) — ВТОРОЕ (после тумблера
// агентов) исключение из правила «пишем только внутри dashboard/»: заметки ложатся
// в подпапку «выгрузка-панели» внутри vault, перед перезаписью модуль кладёт .bak.
// Файл может ещё не существовать — поэтому импорт динамический и с проверкой:
// панель обязана ответить понятной ошибкой, а не упасть при старте.
const EXPORT_VAULT_FILE = path.join(DASHBOARD_DIR, 'collector', 'export-vault.mjs');
const PYTHON = process.env.DSH_PYTHON || path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe');
// Python ДВИЖКА Агента 1: рабочий интерпретатор — проектный venv (там есть PyYAML,
// без него движок не читает YAML-настройки). Порядок: DSH_PYTHON (тесты/переопределение)
// → проектный venv → рантайм DSH. Так панель не «теряет» движок из-за не того Python.
const CW_VENV_PYTHON = path.join(PROJECT_DIR, 'connectors', 'ru-marketplace-mcp', '.venv', 'Scripts', 'python.exe');
const CW_PYTHON = process.env.DSH_PYTHON || (fs.existsSync(CW_VENV_PYTHON) ? CW_VENV_PYTHON : PYTHON);

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
const AGENT_SETTINGS_DIR = process.env.DASHBOARD_AGENT_SETTINGS_DIR && process.env.DASHBOARD_AGENT_SETTINGS_DIR.trim() !== ''
  ? process.env.DASHBOARD_AGENT_SETTINGS_DIR
  : path.join(REGISTRY_DIR, 'agent-settings');
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
    // Сколько лотов показывать в топах изменений (контракт, группа 3).
    top_deals_count: { t: 'int', min: 1, max: 20 },
    projects: { t: 'list' }, promo_words: { t: 'list' },
  },
  // ЖК для наблюдения — трёхуровневый путь agent1.watch.<поле>.
  // query — единственное поле, которое видно в карточке («название проекта или сайт»);
  // остальные остаются в файле как значения по умолчанию и прячутся под «дополнительно».
  'agent1.watch': {
    query: { t: 'str' },
    name: { t: 'str' }, address: { t: 'str' }, url: { t: 'str' }, lat: { t: 'str' }, lon: { t: 'str' },
    radius_km: { t: 'num', min: 1, max: 100 },
    klass: { t: 'list', values: ['комфорт', 'бизнес', 'премиум', 'элит'] },
    price_min_per_m2: { t: 'int', min: 0, max: 10000000 }, price_max_per_m2: { t: 'int', min: 0, max: 10000000 },
    sources: { t: 'list', values: ['cian', 'avito', 'yandex-realty', 'domclick', 'web-search'] },
    max_candidates: { t: 'int', min: 1, max: 200 },
  },
  // ЧТО АНАЛИЗИРОВАТЬ (Агент 1): маркетинговый срез лотов.
  // РОВНО контракт docs/agent-1-marketing-settings-contract.md, группа 2.
  // Список обязан совпадать с SELECTION_FIELDS в collector/lib/agent-settings.mjs
  // и с проверкой контракта в verify-data.mjs.
  'agent1.selection': {
    room_types: { t: 'list', values: ['0', '1', '2', '3', '4', '5+'] },
    area_min_m2: { t: 'num', min: 0, max: 400 },
    area_max_m2: { t: 'num', min: 0, max: 400 },
    price_min_rub: { t: 'int', min: 0, max: 1000000000 },
    price_max_rub: { t: 'int', min: 0, max: 1000000000 },
    exclude_first_floor: { t: 'bool' },
    exclude_last_floor: { t: 'bool' },
    finishes: { t: 'list', values: ['без отделки', 'white box', 'чистовая', 'с мебелью', 'unknown'] },
    only_active: { t: 'bool' },
    promo_only: { t: 'bool' },
    price_metric: { t: 'enum', values: ['median', 'mean', 'min_max'] },
    outlier_guard: { t: 'bool' },
    outlier_same_price_min_lots: { t: 'int', min: 2, max: 50 },
    outlier_ppm2_min: { t: 'int', min: 0, max: 10000000 },
    outlier_ppm2_max: { t: 'int', min: 0, max: 10000000 },
  },
  // ТУМБЛЕРЫ АНАЛИТИКИ Агента 1 (WP1/WP2): восемь переключателей, только bool.
  // Список обязан совпадать с ANALYTICS_FIELDS в collector/lib/agent-settings.mjs.
  'agent1.analytics': {
    enabled: { t: 'bool' }, lots_all_on_sale: { t: 'bool' }, price_dynamics: { t: 'bool' },
    promos: { t: 'bool' }, new_promos_only: { t: 'bool' }, dedup_promos: { t: 'bool' },
    developers_sites: { t: 'bool' }, forecast: { t: 'bool' },
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
// Значения по умолчанию для блока, которого может ещё не быть в YAML.
// Нужны, когда панель знает параметр раньше файла (тумблеры аналитики WP1):
// сохранение тумблера не должно падать, а обязано создать блок.
// ВНИМАНИЕ: список ключей совпадает с ANALYTICS_FIELDS в collector/lib/agent-settings.mjs
// и с 'agent1.analytics' в AGENT_SETTINGS_SCHEMA выше.
const SETTINGS_BLOCK_DEFAULTS = {
  'agent1.analytics': [
    'enabled: true',
    'lots_all_on_sale: true',
    'price_dynamics: true',
    'promos: true',
    'new_promos_only: true',
    'dedup_promos: true',
    'developers_sites: true',
    'forecast: true',
  ],
  // «Что анализировать»: если блока нет в YAML, панель не падает, а создаёт его
  // со значениями по умолчанию из контракта (docs/agent-1-marketing-settings-contract.md, группа 2).
  // Список обязан совпадать с SELECTION_FIELDS/SELECTION_DEFAULTS в collector/lib/agent-settings.mjs.
  'agent1.selection': [
    'room_types: ["0", "1", "2", "3", "4", "5+"]',
    'area_min_m2: 0',
    'area_max_m2: 0',
    'price_min_rub: 0',
    'price_max_rub: 0',
    'exclude_first_floor: false',
    'exclude_last_floor: false',
    'finishes: ["без отделки", "white box", "чистовая", "с мебелью", "unknown"]',
    'only_active: true',
    'promo_only: false',
    'price_metric: median',
    'outlier_guard: true',
    'outlier_same_price_min_lots: 5',
    'outlier_ppm2_min: 150000',
    'outlier_ppm2_max: 800000',
  ],
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

// Прогон, запущенный из панели (POST /api/actions/run): без записи в журнал
// запуск не виден в истории прогонов и на стенде агентов.
// Себестоимость панельного запуска не измеряется — cost_rub: null (ноль вместо
// «нет данных» писать запрещено правилом честности данных).
function appendDashboardRun(started, proc, artifact, meta) {
  const m = meta || {};
  const errText = String(proc.output || '').split('\n').slice(-3).join(' ').trim();
  return appendRunLine({
    run_id: 'dash-' + crypto.randomBytes(4).toString('hex'),
    ts: new Date().toISOString(),
    service: m.service || 'competitor-watch',
    client: null,
    agent: m.agent || 'agent-1-competitor-watch',
    status: proc.ok ? 'ok' : 'failed',
    duration_ms: Date.now() - started,
    cost_rub: null,
    cost_source: 'none',
    trigger: 'dashboard',
    artifact: artifact || null,
    error: m.error !== undefined ? (m.error || null) : (proc.ok ? null : (errText || 'ошибка движка')),
  });
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

// Отказ именно на ЗАПУСКЕ процесса: песочница DSH не даёт дочернему процессу
// piped stdio, и execFileSync с захватом вывода в трубу падает с EPERM
// («spawnSync <exe> EPERM»), даже когда сам интерпретатор на месте.
// Отличаем от «процесс запустился и упал»: во втором случае есть status.
function spawnDenied(e) {
  return !!(e && (e.code === 'EPERM' || e.code === 'EACCES') && (e.status === undefined || e.status === null));
}

function readFileQuiet(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (e) { return ''; }
}

// Захват вывода дочернего процесса БЕЗ обязательной трубы.
// Сначала обычный заход (труба, как было). Если песочница запретила трубу —
// ровно одна повторная попытка с выводом в ВРЕМЕННЫЙ ФАЙЛ. Повтор безопасен:
// EPERM на запуске означает, что дочерний процесс не стартовал, поэтому
// побочных эффектов не будет (важно для «Собрать данные» и отчёта).
// Пятый аргумент env (необязательный) — переменные окружения дочернего процесса:
// нужен проверке кабинета Директа (YANDEX_DIRECT_TOKEN и т.п.). Старые вызовы
// без него работают как раньше (окружение панели по умолчанию).
function execCapture(exe, args, cwd, timeoutMs, env) {
  const childEnv = env && typeof env === 'object' ? env : undefined;
  try {
    const out = execFileSync(exe, args, { cwd: cwd, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true, env: childEnv });
    return { ok: true, exitCode: 0, output: String(out || ''), via: 'pipe' };
  } catch (e) {
    if (!spawnDenied(e)) {
      const out = (e && e.stdout ? String(e.stdout) : '') + (e && e.stderr ? String(e.stderr) : '');
      return { ok: false, exitCode: e && e.status !== undefined && e.status !== null ? e.status : null, output: out || String(e && e.message ? e.message : e), timedOut: !!(e && (e.killed || e.signal)), via: 'pipe' };
    }
  }
  const outFile = path.join(os.tmpdir(), 'dsh-panel-out-' + process.pid + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8) + '.log');
  let fd = null;
  let res = null;
  try {
    fd = fs.openSync(outFile, 'w');
    try {
      execFileSync(exe, args, { cwd: cwd, stdio: ['ignore', fd, fd], timeout: timeoutMs, windowsHide: true, env: childEnv });
      res = { ok: true, exitCode: 0, timedOut: false, via: 'file' };
    } catch (e2) {
      res = {
        ok: false,
        exitCode: e2 && e2.status !== undefined && e2.status !== null ? e2.status : null,
        timedOut: !!(e2 && (e2.killed || e2.signal)),
        via: spawnDenied(e2) ? 'spawn-denied' : 'file',
        error: e2 && e2.message ? String(e2.message) : '',
      };
    }
  } catch (e3) {
    return { ok: false, exitCode: null, output: String(e3 && e3.message ? e3.message : e3), timedOut: false, via: 'temp-file' };
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (e) { /* ignore */ } }
  }
  const text = readFileQuiet(outFile);
  try { fs.rmSync(outFile, { force: true }); } catch (e) { /* ignore */ }
  res.output = text || (res.ok ? '' : (res.error || 'дочерний процесс не оставил вывода'));
  delete res.error;
  return res;
}

function runProcess(exe, args, cwd, timeoutMs, env) {
  return execCapture(exe, args, cwd, timeoutMs, env);
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
// Идёт через execCapture: в песочнице DSH обычная труба запрещена (EPERM),
// а проверка профиля обязана работать и здесь.
function checkProfile() {
  const r = execCapture(process.execPath, [PROFILE_CHECKER, PROFILE_DIR], undefined, 60000);
  return { ok: r.ok, output: String(r.output || '') };
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

// ===========================================================================
// АГЕНТ 1: истинный список конкурентов, подбор, отправка отчёта (контракт v2, §5)
// ===========================================================================

function panelLocalDate() {
  const d = new Date();
  function p(n) { return String(n).padStart(2, '0'); }
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function clientConfigFile(clientId) {
  return path.join(CW_CLIENTS_DIR, clientId + '.yaml');
}

function panelSlug(s) {
  const t = String(s === undefined || s === null ? '' : s).toLowerCase()
    .replace(/[^a-z0-9а-яё]+/gi, '-').replace(/^-+|-+$/g, '');
  return t || '';
}

function panelNormName(s) {
  return String(s === undefined || s === null ? '' : s).toLowerCase()
    .replace(/[«»"'`]/g, '').replace(/\s+/g, ' ').trim();
}

// Сколько записей в clients-конфиге: считаем по разобранному YAML (истина для ответа).
function countCompetitorsInText(text) {
  try {
    const doc = parseYaml(text);
    return doc && Array.isArray(doc.competitors) ? doc.competitors.filter(function (c) { return c && typeof c === 'object'; }).length : 0;
  } catch (e) { return null; }
}

// Границы секции competitors: от ключа верхнего уровня до последней строки, реально
// принадлежащей секции (элемент списка или его вложенное поле/комментарий с отступом
// глубже секции). Комментарии уровня файла после списка в секцию НЕ входят — иначе
// удаление последней записи уносило бы хвост конфига вместе с ним.
function competitorsSection(lines) {
  let start = -1, indent = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)competitors\s*:\s*(#.*)?$/.exec(lines[i]);
    if (m) { start = i; indent = m[1].length; break; }
  }
  if (start < 0) return null;
  let lastOwned = start;
  for (let i = lines.length - 1; i > start; i--) {
    const line = lines[i];
    if (line.trim() === '') continue;
    if (line.match(/^ */)[0].length > indent) { lastOwned = i; break; }
  }
  return { start: start, end: lastOwned + 1, indent: indent };
}

// Ключ записи (id и название) прямо из её строк — запись может быть и инлайн-объектом, и блоком.
function competitorRecordKeys(blockLines) {
  const out = { id: null, name: null, nameKey: null };
  const first = String(blockLines[0] || '');
  const body = first.replace(/^\s*-\s*/, '');
  let rec = null;
  if (body.trim().charAt(0) === '{') {
    rec = parseScalar(body.trim());
  } else {
    // Дефис заменяем на пробелы ТОЙ ЖЕ ширины: иначе продолжение записи (поля ниже дефиса)
    // оказывается глубже её первой строки и разбор видит только name (теряет id и поля).
    const shifted = blockLines.map(function (l, i) {
      if (i !== 0) return l;
      return l.replace(/^(\s*)-( +|$)/, '$1 $2');
    });
    try { rec = parseYaml(shifted.join('\n')); } catch (e) { rec = null; }
  }
  if (rec && typeof rec === 'object' && !Array.isArray(rec)) {
    if (rec.id !== undefined && rec.id !== null && String(rec.id) !== '') out.id = String(rec.id);
    const nm = rec.name !== undefined && rec.name !== null ? String(rec.name) : (rec.project !== undefined && rec.project !== null ? String(rec.project) : '');
    if (nm !== '') { out.name = nm; out.nameKey = panelNormName(nm); }
  }
  if (!out.name) {
    // запасной путь: имя вытаскиваем регуляркой, если YAML-разбор не сложился
    const m = /(?:^|[{\s,])name\s*:\s*("([^"]*)"|'([^']*)'|[^,}\n]+)/.exec(first);
    if (m) { const v = (m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : m[1])).trim(); out.name = v; out.nameKey = panelNormName(v); }
  }
  return out;
}

// Удаление РОВНО одной записи из competitors: по стабильному ключу (id, иначе имя).
// Чужие записи и остальной файл не трогаем; неоднозначный ключ → отказ, а не догадка.
function removeCompetitorFromText(text, opts) {
  const eol = text.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const sec = competitorsSection(lines);
  if (!sec) return { ok: false, reason: 'нет секции competitors:' };
  const starts = [];
  for (let i = sec.start + 1; i < sec.end; i++) {
    if (/^\s*-\s/.test(lines[i]) || /^\s*-\s*$/.test(lines[i])) starts.push(i);
  }
  if (!starts.length) return { ok: false, reason: 'в секции competitors: нет ни одной записи' };
  const wantId = opts.id !== undefined && opts.id !== null && String(opts.id) !== '' ? String(opts.id) : '';
  const wantName = opts.name ? panelNormName(opts.name) : '';
  if (!wantId && !wantName) return { ok: false, reason: 'нужен id или имя записи' };
  const hits = [];
  starts.forEach(function (start, idx) {
    const end = idx + 1 < starts.length ? starts[idx + 1] : sec.end;
    const rec = competitorRecordKeys(lines.slice(start, end));
    const slug = panelSlug(rec.name);
    const idHit = wantId && (rec.id === wantId || (!rec.id && slug && slug === wantId));
    const nameHit = wantName && rec.nameKey === wantName;
    if (wantId && !wantName) { if (idHit) hits.push({ start: start, end: end, rec: rec }); return; }
    if (!wantId && wantName) { if (nameHit) hits.push({ start: start, end: end, rec: rec }); return; }
    if (idHit || nameHit) hits.push({ start: start, end: end, rec: rec });
  });
  if (!hits.length) return { ok: false, reason: 'запись не найдена — ' + (wantId ? 'id «' + wantId + '»' : '') + (wantId && wantName ? ' и ' : '') + (wantName ? 'имя «' + opts.name + '»' : '') };
  if (hits.length > 1) return { ok: false, reason: 'по этому ключу найдено записей: ' + hits.length + ' — уточните id, чтобы не удалить чужую' };
  const hit = hits[0];
  // с записью убираем и её комментарий-заголовок (сплошные #-строки прямо над ней);
  // пустые строки-разделители остаются на месте
  let from = hit.start;
  while (from - 1 > sec.start && /^\s*#/.test(lines[from - 1])) from--;
  let to = hit.end;
  // хвост блока: пустые строки и комментарии уровня ФАЙЛА (не глубже секции) остаются —
  // их нельзя уносить вместе с записью
  while (to > hit.start) {
    const l = lines[to - 1];
    if (l.trim() === '') { to--; continue; }
    if (/^\s*#/.test(l) && l.match(/^ */)[0].length <= sec.indent) { to--; continue; }
    break;
  }
  const out = lines.slice(0, from).concat(lines.slice(to));
  return { ok: true, changed: true, text: out.join(eol), previous: { id: hit.rec.id, name: hit.rec.name }, removed: { id: hit.rec.id, name: hit.rec.name } };
}

// Дописать запись в конец списка competitors — сразу после последней записи секции,
// не задевая комментарии и остальной файл.
// ВАЖНО (баг данных, подтверждён Lead 04.11.2026): отступ берём у САМОГО ВЕРХНЕГО
// (канонического) элемента списка, а не у последнего. В client-svet.yaml запись
// «ЖК Нарвин» вложена на 4 пробела; старый appendListBlock подхватывал её отступ
// и писал новые записи так же — строгий YAML (PyYAML) падал на всём файле,
// а движок молча не видел вложенную запись.
function appendCompetitorBlock(text, blockLine) {
  const eol = text.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const sec = competitorsSection(lines);
  if (!sec) return { ok: false, reason: 'нет секции competitors:' };
  let itemIndent = null;
  let lastOwn = sec.start;
  for (let i = sec.start + 1; i < sec.end; i++) {
    const l = lines[i];
    if (l.trim() === '' || /^\s*#/.test(l)) continue;
    if (/^\s*-\s/.test(l) || /^\s*-\s*$/.test(l)) {
      const ind = l.match(/^ */)[0];
      if (itemIndent === null || ind.length < itemIndent.length) itemIndent = ind;
    }
    lastOwn = i;
  }
  if (itemIndent === null) itemIndent = '  ';
  const block = String(blockLine).replace(/\s+$/, '');
  const out = lines.slice(0, lastOwn + 1).concat([itemIndent + block], lines.slice(lastOwn + 1));
  return { ok: true, changed: true, text: out.join(eol), line: lastOwn + 2 };
}

// Записи секции, вложенные глубже канонического отступа: строгий YAML их не разберёт
// или молча отбросит, а движок такую запись в анализ не возьмёт. Возвращаем имена —
// чтобы панель сказала об этом словами, а не молчала.
function competitorIndentIssues(text) {
  const lines = String(text).split(/\r?\n/);
  const sec = competitorsSection(lines);
  if (!sec) return { total: 0, broken: 0, names: [] };
  const starts = [];
  for (let i = sec.start + 1; i < sec.end; i++) {
    if (/^\s*-\s/.test(lines[i]) || /^\s*-\s*$/.test(lines[i])) starts.push({ i: i, indent: lines[i].match(/^ */)[0].length });
  }
  if (!starts.length) return { total: 0, broken: 0, names: [] };
  const canonical = Math.min.apply(null, starts.map(function (s) { return s.indent; }));
  const names = [];
  starts.forEach(function (s, idx) {
    if (s.indent === canonical) return;
    const end = idx + 1 < starts.length ? starts[idx + 1].i : sec.end;
    const rec = competitorRecordKeys(lines.slice(s.i, end));
    if (rec && (rec.name || rec.id)) names.push(rec.name || rec.id);
  });
  return { total: starts.length, broken: names.length, names: names };
}

function readJsonQuiet(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

function tailLines(text, count) {
  return String(text || '').split('\n').filter(function (l, i, a) { return i < a.length - 1 || l !== ''; }).slice(-count).join('\n');
}

// Файлы кандидатов движка: <project-id>.json, без решений (*.decisions.json) и копий (*.bak-*).
function candidateFilesMap() {
  const map = {};
  if (!fs.existsSync(CW_CANDIDATES_DIR)) return map;
  let names = [];
  try { names = fs.readdirSync(CW_CANDIDATES_DIR); } catch (e) { return map; }
  names.forEach(function (n) {
    if (!/\.json$/.test(n) || /\.decisions\.json$/.test(n) || /\.bak-/.test(n)) return;
    try { map[n] = fs.statSync(path.join(CW_CANDIDATES_DIR, n)).mtimeMs; } catch (e) { /* ignore */ }
  });
  return map;
}

// Файл кандидатов, который обновил именно этот прогон: сначала по проекту, потом самый свежий.
function pickChangedCandidate(before, after, project) {
  const changed = Object.keys(after).filter(function (n) { return before[n] === undefined || after[n] > before[n]; });
  if (!changed.length) return null;
  const preferred = project ? changed.filter(function (n) { return n.indexOf(project) >= 0; })[0] : null;
  const name = preferred || changed.sort(function (a, b) { return after[b] - after[a]; })[0];
  return { name: name, file: path.join(CW_CANDIDATES_DIR, name), fresh: true };
}

function clientReportsDir(clientId) {
  return path.join(CLIENT_REPORTS_DIR, clientId);
}

function emailCachesMap(clientId) {
  const dir = path.join(clientReportsDir(clientId), '.cache');
  const map = {};
  if (!fs.existsSync(dir)) return map;
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return map; }
  names.forEach(function (n) {
    if (!/^email-.*\.json$/.test(n)) return;
    try { map[n] = fs.statSync(path.join(dir, n)).mtimeMs; } catch (e) { /* ignore */ }
  });
  return map;
}

function pickChangedEmailCache(clientId, before) {
  const dir = path.join(clientReportsDir(clientId), '.cache');
  const after = emailCachesMap(clientId);
  const names = Object.keys(after);
  if (!names.length) return null;
  const changed = names.filter(function (n) { return before[n] === undefined || after[n] > before[n]; });
  const pick = (changed.length ? changed : names).sort(function (a, b) { return after[b] - after[a]; })[0];
  const doc = readJsonQuiet(path.join(dir, pick));
  return { name: pick, file: path.join(dir, pick), doc: doc, fresh: changed.length > 0 };
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

// Группы настроек, после правки которых панель обязана пересобрать данные,
// чтобы тумблер/поле сразу показывали новое значение (как тумблер агента).
const REFRESH_AFTER_WRITE = ['agent1.analytics', 'agent1.watch', 'agent1.selection'];

// Разрешение метки файла настроек из панели в реальный путь.
// Поддерживаются именованные файлы (agents, sources, …) и тонкие настройки агента
// вида 'agent-settings/<agent-id>'. Путь всегда остаётся внутри своей папки.
function resolveSettingsTarget(which) {
  const named = {
    settings: SETTINGS_FILE, prices: PRICES_FILE, agents: AGENTS_FILE, sources: SOURCES_FILE,
    router: ROUTER_FILE, profile: PROFILE_MANIFEST,
    clients: CLIENTS_FILE, services: SERVICES_FILE, subscriptions: SUBS_FILE,
    invoices: INVOICES_FILE, results: RESULTS_FILE,
  };
  if (named[which]) return named[which];
  const m = /^agent-settings\/([a-z0-9-]{3,40})$/.exec(which);
  if (m) return path.join(AGENT_SETTINGS_DIR, m[1] + '.yaml');
  return null;
}

function sha256Of(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
  catch (e) { return null; }
}

function backupsOf(file) {
  const dir = path.dirname(file);
  const base = path.basename(file) + '.bak-';
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return []; }
  return names.filter(function (n) { return n.indexOf(base) === 0; })
    .map(function (n) {
      const full = path.join(dir, n);
      let st = null;
      try { st = fs.statSync(full); } catch (e) { st = null; }
      return { name: n, mtimeMs: st ? st.mtimeMs : null, bytes: st ? st.size : null, sha256: sha256Of(full) };
    })
    .sort(function (a, b) { return (b.mtimeMs || 0) - (a.mtimeMs || 0); });
}

// СУХОЙ ПРОГОН ДЕЙСТВИЙ ДВИЖКА (только для автотестов интерфейса).
// Зачем: ux-check.mjs нажимает «Сформировать отчёт за неделю», а это запускает
// Python-движок Агента 1 и пишет в 01-competitor-watch/reports — вне зоны записи
// панели. С DASHBOARD_ACTIONS_DRY_RUN=1 сервер отвечает так же, как при успехе,
// но НИЧЕГО не запускает. По умолчанию режим выключен, поведение не меняется.
const ACTIONS_DRY_RUN = process.env.DASHBOARD_ACTIONS_DRY_RUN === '1';

function dryRunAnswer(action, curr, prev) {
  return {
    ok: true, action: action, dryRun: true, durationMs: 0, exitCode: 0,
    output: 'сухой прогон: движок не запускался (DASHBOARD_ACTIONS_DRY_RUN=1)',
    result: { curr: curr, prev: prev, report: null },
    message: action === 'report'
      ? ('Отчёт построен за ' + curr + ' (сравнение с ' + (prev || '—') + ') — сухой прогон, движок не запускался')
      : ('Агент отработал цикл за ' + curr + ' — сухой прогон, движок не запускался'),
  };
}

// Вопросы клиентов (кабинет): реестр вопросов и лимит частоты.
const QUESTIONS_FILE = path.join(REGISTRY_DIR, 'client-questions.json');
const RATE = {};

const DATA_FILES = ['meta.json', 'agents.json', 'tasks.json', 'projects.json', 'sessions.json', 'usage.json', 'prices.json', 'integrations.json', 'sources.json', 'analytics.json', 'settings.json', 'alerts.json', 'service.json', 'nav.json', 'analytics2.json', 'ads.json', 'agent-tabs.json', 'agent-settings.json', 'candidates.json', 'competitor-report.json', 'agent1-status.json', 'competitor-analytics.json', 'agent-runs.json'];

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

// --- Кабинеты Яндекс.Директа (Агент 2): живая проверка токена -----------------
// Проверка идёт дочерним процессом CLI скилла, а токен передаётся ТОЛЬКО через
// окружение: в аргументах командной строки секрет не мелькает (его было бы видно
// в списке процессов). Таймаут 60 с — Директ иногда отвечает заметно медленнее,
// чем локальные команды.
const DIRECT_CHECK_TIMEOUT_MS = 60000;

// Секрет не должен утечь даже в текст ошибки: если он там случайно оказался,
// подменяем на ту же маску, что уходит в ответ API (и, значит, в логи не попадёт).
function scrubSecret(text, secret) {
  const s = String(text === undefined || text === null ? '' : text);
  const needle = secret ? String(secret) : '';
  if (needle === '') return s;
  return s.split(needle).join(maskToken(needle));
}

function verifyDirectAccount(token, login, sandbox) {
  const env = Object.assign({}, process.env, {
    YANDEX_DIRECT_TOKEN: String(token || ''),
    YANDEX_DIRECT_CLIENT_LOGIN: login ? String(login) : '',
    YANDEX_DIRECT_SANDBOX: sandbox ? '1' : '0',
  });
  const proc = runProcess(PYTHON, ['-m', 'skills.direct_api', '--check', '--json'], PROJECT_DIR, DIRECT_CHECK_TIMEOUT_MS, env);
  const output = String(proc.output || '');
  let report = null;
  // CLI печатает один JSON-объект; предупреждения рантайма идут в stderr — берём
  // последнюю строку stdout/stderr, начинающуюся с '{'.
  const jsonLines = output.split('\n').map(function (l) { return l.trim(); }).filter(function (l) { return l.charAt(0) === '{'; });
  if (jsonLines.length) { try { report = JSON.parse(jsonLines[jsonLines.length - 1]); } catch (e) { report = null; } }

  const status = report && report.status ? String(report.status) : 'error';
  const fallback = proc.timedOut
    ? ('проверка не ответила за ' + Math.round(DIRECT_CHECK_TIMEOUT_MS / 1000) + ' с (таймаут)')
    : ('проверка не вернула разборчивый JSON (код ' + proc.exitCode + '): ' + output.split('\n').slice(-2).join(' ').slice(0, 300));
  return {
    ok: status === 'ok',
    status: status,
    // skipped_no_key при заданном токене — тоже ошибка проверки: message отдаём как есть.
    message: scrubSecret(report && report.message ? String(report.message) : fallback, token),
    exitCode: proc.exitCode,
    sandbox: report && report.sandbox !== undefined ? !!report.sandbox : !!sandbox,
    clientLogin: report && report.clientLogin ? String(report.clientLogin) : (login ? String(login) : ''),
    campaigns: report && typeof report.campaigns === 'number' ? report.campaigns : null,
  };
}

// Провал проверки -> поле status для API: 401/403 и «токен недействителен» — это
// invalid, всё остальное (сеть, таймаут, поломка CLI) — error.
function directFailureStatus(status, message) {
  const text = String(status || '') + ' ' + String(message || '');
  return /HTTP\s*40[13]|Unauthorized|Forbidden|invalid[_ -]?oauth|invalid[_ -]?token|недействител/i.test(text) ? 'invalid' : 'error';
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

  // --- ПОДБОР КОНКУРЕНТОВ ПО РАДИУСУ (контракт v2, §5.2): панель РЕАЛЬНО запускает движок ---
  // Панель не выдумывает кандидатов: итог — это честный ответ прогона (ran, exitCode) плюс
  // summary/limitations ИЗ ФАЙЛА кандидатов, который записал движок. Проект/радиус/класс
  // движок берёт из agent1.watch того же файла настроек, что правит панель.
  if (p === '/api/agent1/discover' && method === 'POST') {
    return readBody(req).then(function (body) {
      const started = Date.now();
      const project = String((body && body.project) || '').trim();
      if (project && !/^[a-z0-9][a-z0-9._-]{0,60}$/i.test(project)) {
        return sendJson(res, 400, { ok: false, ran: false, exitCode: null, message: 'неверный id проекта' });
      }
      const settingsFile = path.join(AGENT_SETTINGS_DIR, 'agent-1-competitor-watch.yaml');
      const scriptFile = path.join(CW_SCRIPTS, 'discover_competitors.py');
      if (!fs.existsSync(scriptFile)) {
        return sendJson(res, 501, { ok: false, ran: false, exitCode: null, message: 'движок подбора не найден: ' + scriptFile });
      }
      if (!fs.existsSync(settingsFile)) {
        return sendJson(res, 404, { ok: false, ran: false, exitCode: null, message: 'нет файла настроек Агента 1 (agent1.watch): ' + settingsFile });
      }
      if (ACTIONS_DRY_RUN) {
        return sendJson(res, 200, {
          ok: true, action: 'discover', dryRun: true, ran: false, exitCode: 0, durationMs: Date.now() - started,
          message: 'Сухой прогон (DASHBOARD_ACTIONS_DRY_RUN=1): движок discover_competitors.py не запускался, файлы не изменялись. Кандидатов панель не выдумывает.',
          summary: null, limitations: [], candidates: null, stdoutTail: '', summaryFrom: null,
        });
      }
      const args = [scriptFile, '--settings-file', settingsFile, '--json'];
      if (project) args.push('--project', project);
      const before = candidateFilesMap();
      const proc = runProcess(CW_PYTHON, args, PROJECT_DIR, 300000);
      const after = candidateFilesMap();
      const picked = pickChangedCandidate(before, after, project);
      const doc = picked ? readJsonQuiet(picked.file) : null;
      const summary = doc && doc.summary && typeof doc.summary === 'object' ? doc.summary : null;
      const limitations = doc && Array.isArray(doc.limitations) ? doc.limitations : [];
      const visible = doc && Array.isArray(doc.candidates) ? doc.candidates.length : null;
      const ran = proc.via !== 'spawn-denied' && proc.via !== 'temp-file';
      let message;
      if (!proc.ok && proc.timedOut) {
        message = 'Движок подбора не успел за 300 с и был остановлен. Кандидатов панель не выдумывает: см. вывод движка ниже.';
      } else if (!proc.ok && proc.via === 'spawn-denied') {
        message = 'Не удалось запустить Python движка (' + CW_PYTHON + '): песочница запретила запуск. Подбор не выполнялся.';
      } else if (!proc.ok) {
        message = 'Движок подбора завершился с кодом ' + String(proc.exitCode) + '. Кандидатов панель не выдумывает: см. вывод движка ниже.';
      } else if (!summary) {
        message = 'Движок отработал (код 0), но файла кандидатов в ' + CW_CANDIDATES_DIR + ' прогон не обновил — итога подбора нет, панель кандидатов не выдумывает.';
      } else {
        message = 'Подбор выполнен: кандидатов в радиусе ' + summary.radius_km + ' км — ' + summary.in_radius + ' из ' + summary.total
          + ' найденных' + (picked ? ' (файл ' + picked.name + ')' : '') + '.';
      }
      return sendJson(res, proc.ok ? 200 : 500, {
        ok: proc.ok, action: 'discover', dryRun: false, ran: ran, exitCode: proc.exitCode,
        timedOut: !!proc.timedOut, durationMs: Date.now() - started,
        message: message, summary: summary, limitations: limitations,
        candidates: visible, summaryFrom: picked ? picked.name : null,
        project: doc && doc.project_id ? doc.project_id : (project || null),
        stdoutTail: tailLines(proc.output, 25),
      });
    });
  }

  // --- ИСТИННЫЙ СПИСОК КОНКУРЕНТОВ (контракт v2, §5.1/§5.2): ручное добавление и удаление ---
  // Пишем ТОЛЬКО клиентский конфиг 01-competitor-watch/config/clients/<client>.yaml → competitors[].
  // Атомарно (temp + rename) с копией .bak-<timestamp>; удаление — по стабильному ключу
  // (id, иначе имя), ровно одной записи: чужие записи не трогаем.
  if (p === '/api/agent1/competitor-list' && method === 'POST') {
    return readBody(req).then(function (body) {
      const clientId = String((body && body.client) || '');
      const action = String((body && body.action) || '');
      if (!/^[a-z0-9-]{3,60}$/.test(clientId)) return sendJson(res, 400, { ok: false, message: 'неверный id клиента' });
      if (action !== 'add' && action !== 'remove') return sendJson(res, 400, { ok: false, message: 'действие: add или remove' });
      const confFile = clientConfigFile(clientId);
      if (!fs.existsSync(confFile)) return sendJson(res, 404, { ok: false, message: 'нет клиентского конфига: ' + confFile });
      const original = fs.readFileSync(confFile, 'utf8');

      if (action === 'remove') {
        const id = String((body && body.id) || '').trim();
        const name = String((body && body.name) || '').trim();
        if (!id && !name) return sendJson(res, 400, { ok: false, message: 'нужен id или имя удаляемой записи' });
        const result = applyAtomicEdit(confFile, clientId + '.yaml', function (text) {
          return removeCompetitorFromText(text, { id: id, name: name });
        });
        if (!result.ok) return sendJson(res, result.code || 400, { ok: false, message: 'удалить не удалось: ' + result.message, client: clientId });
        const text = fs.readFileSync(confFile, 'utf8');
        const count = countCompetitorsInText(text);
        const issues = competitorIndentIssues(text);
        return sendJson(res, 200, {
          ok: true, action: 'remove', client: clientId, clientFile: confFile, backup: result.backup,
          removed: result.previous, competitorsCount: count,
          competitorsInFile: issues.total, brokenIndentCount: issues.broken, brokenIndentNames: issues.names,
          message: 'Запись убрана из истинного списка конкурентов (в ближайшем прогоне в анализ не попадёт)'
            + (result.changed === false ? ' — но менять не пришлось' : '')
            + (issues.broken ? '. ВНИМАНИЕ: в конфиге осталась запись с битым отступом (' + issues.names.join(', ') + ') — движок её не видит, нужна правка конфига (решает Lead).' : '') + '.',
        });
      }

      const name = String((body && body.name) || '').trim();
      if (!name) return sendJson(res, 400, { ok: false, message: 'укажите название конкурента' });
      if (name.length > 200) return sendJson(res, 400, { ok: false, message: 'слишком длинное название (максимум 200 символов)' });
      let developer = String((body && body.developer) || '').trim();
      const klass = String((body && (body.klass !== undefined ? body.klass : body['class'])) || '').trim();
      const site = String((body && body.site) || '').trim();
      if (developer.length > 200 || klass.length > 60 || site.length > 500) return sendJson(res, 400, { ok: false, message: 'слишком длинное значение поля' });
      if (site !== '' && !/^https?:\/\/\S+$/i.test(site)) return sendJson(res, 400, { ok: false, message: 'сайт должен начинаться с http:// или https:// (или оставьте пустым)' });
      let id = String((body && body.id) || '').trim();
      if (id !== '' && !/^[a-z0-9а-яё][a-z0-9а-яё-]{0,59}$/i.test(id)) return sendJson(res, 400, { ok: false, message: 'id записи: латиница/цифры/дефис, до 60 символов' });
      if (!id) id = panelSlug(name);
      if (!id) return sendJson(res, 400, { ok: false, message: 'из названия не получился id — укажите id явно' });
      const srcPlatforms = (body && body.platforms && typeof body.platforms === 'object' && !Array.isArray(body.platforms)) ? body.platforms : {};
      const platforms = { cian: '', avito: '', yandex_realty: '', domclick: '' };
      let badPlatform = null;
      Object.keys(srcPlatforms).forEach(function (k) {
        const key = String(k).toLowerCase().replace(/-/g, '_');
        const v = String(srcPlatforms[k] === undefined || srcPlatforms[k] === null ? '' : srcPlatforms[k]).trim();
        if (v !== '' && !/^https?:\/\/\S+$/i.test(v)) { badPlatform = key; return; }
        platforms[key] = v;
      });
      if (badPlatform) return sendJson(res, 400, { ok: false, message: 'ссылка площадки ' + badPlatform + ' должна начинаться с http:// или https://' });

      // Дубль не создаём: совпадение по id, по нормализованному имени или по слагу имени.
      const dup = (function () {
        const list = (function () { try { const d = parseYaml(original); return d && Array.isArray(d.competitors) ? d.competitors : []; } catch (e) { return []; } })();
        return list.filter(function (c) {
          if (!c || typeof c !== 'object') return false;
          const cid = c.id !== undefined && c.id !== null ? String(c.id) : '';
          const cnm = c.name !== undefined && c.name !== null ? String(c.name) : '';
          return (cid !== '' && cid === id) || panelNormName(cnm) === panelNormName(name) || (panelSlug(cnm) === id);
        })[0] || null;
      })();
      if (dup) {
        return sendJson(res, 409, {
          ok: false, message: 'такой конкурент уже в истинном списке («' + (dup.name || dup.id) + '») — дубль не добавляю',
          competitorsCount: countCompetitorsInText(original),
        });
      }

      const clean = function (s) { return String(s).replace(/["\\]/g, '').replace(/\s+/g, ' ').trim(); };
      const block = '- { id: ' + clean(id) + ', name: "' + clean(name) + '", developer: "' + clean(developer)
        + '", class: "' + clean(klass) + '", site: "' + clean(site)
        + '", platforms: { cian: "' + clean(platforms.cian) + '", avito: "' + clean(platforms.avito)
        + '", yandex_realty: "' + clean(platforms.yandex_realty) + '", domclick: "' + clean(platforms.domclick)
        + '" }, source: "вручную", added: "' + panelLocalDate() + '" }';
      const result = applyAtomicEdit(confFile, clientId + '.yaml', function (text) {
        // ПРОВЕРКА ПЕРЕД ЗАПИСЬЮ: элемент competitors[] обязан встать отдельной записью
        // канонического отступа (2 пробела) и быть видимым парсеру. Иначе правку не применяем —
        // именно так однажды появилась запись с отступом 4, которую роняли оба парсера.
        const beforeIssues = competitorIndentIssues(text);
        const beforeVisible = countCompetitorsInText(text);
        const appended = appendCompetitorBlock(text, block);
        if (!appended.ok) return appended;
        const afterIssues = competitorIndentIssues(appended.text);
        const afterVisible = countCompetitorsInText(appended.text);
        if (afterIssues.total !== beforeIssues.total + 1) {
          return { ok: false, reason: 'новая запись не встала отдельным элементом списка competitors' };
        }
        if (afterIssues.broken > beforeIssues.broken) {
          return { ok: false, reason: 'новая запись оказалась вложенной глубже списка (битый отступ) — правку не применяю' };
        }
        if (beforeIssues.broken === 0 && (afterVisible === null || beforeVisible === null || afterVisible !== beforeVisible + 1)) {
          return { ok: false, reason: 'парсер не видит новую запись после добавления — правку не применяю' };
        }
        return appended;
      });
      if (!result.ok) return sendJson(res, result.code || 400, { ok: false, message: 'добавить не удалось: ' + result.message, client: clientId });
      const text = fs.readFileSync(confFile, 'utf8');
      const count = countCompetitorsInText(text);
      const issues = competitorIndentIssues(text);
      const hasSource = site !== '' || Object.keys(platforms).some(function (k) { return platforms[k] !== ''; });
      return sendJson(res, 200, {
        ok: true, action: 'add', client: clientId, clientFile: confFile, backup: result.backup,
        added: { id: id, name: name }, hasSource: hasSource, competitorsCount: count,
        competitorsInFile: issues.total, brokenIndentCount: issues.broken, brokenIndentNames: issues.names,
        message: 'Конкурент «' + name + '» добавлен в истинный список'
          + (hasSource ? ' — в ближайшем прогоне попадёт в анализ.' : '. ВНИМАНИЕ: без сайта и без ссылок площадок — без источника, в анализ не попадает.')
          + (issues.broken ? ' В конфиге есть запись с битым отступом (' + issues.names.join(', ') + ') — движок её не видит, нужна правка конфига (решает Lead).' : ''),
      });
    });
  }

  // --- ЯВНАЯ ОТПРАВКА ОТЧЁТА (контракт v2, §5.2/§5.4) — только по кнопке «Отправить сейчас» ---
  // Ни один другой маршрут панели почту не отправляет: сохранение настроек и «Обновить данные»
  // (collect.mjs / build_weekly_report.py / run_weekly.py) движок с почтой не зовут. Здесь
  // движок запускается в режиме on-request с --send-only: письмо уходит по ПОСЛЕДНЕМУ готовому
  // отчёту, без повторного сбора данных. Факт отправки панель берёт из машиной строки EMAIL_RESULT
  // и из файла reports/clients/<client>/.cache/email-<дата>.json — своих «успехов» не выдумывает.
  if (p === '/api/agent1/send-report' && method === 'POST') {
    return readBody(req).then(function (body) {
      const started = Date.now();
      const clientId = String((body && body.client) || 'client-svet');
      if (!/^[a-z0-9-]{3,60}$/.test(clientId)) return sendJson(res, 400, { ok: false, ran: false, sent: [], message: 'неверный id клиента' });
      const confFile = clientConfigFile(clientId);
      const scriptFile = path.join(CW_SCRIPTS, 'collect_clients.py');
      if (!fs.existsSync(scriptFile)) return sendJson(res, 501, { ok: false, ran: false, sent: [], message: 'движок отправки не найден: ' + scriptFile });
      if (!fs.existsSync(confFile)) return sendJson(res, 404, { ok: false, ran: false, sent: [], message: 'нет клиентского конфига: ' + confFile });
      if (ACTIONS_DRY_RUN) {
        return sendJson(res, 200, {
          ok: true, action: 'send-report', dryRun: true, ran: false, exitCode: 0, durationMs: Date.now() - started,
          sent: [], records: [], emailFile: null, emailFileFresh: false, stdoutTail: '',
          message: 'Сухой прогон (DASHBOARD_ACTIONS_DRY_RUN=1): движок не запускался, письмо не отправлялось.',
        });
      }
      const before = emailCachesMap(clientId);
      const args = [scriptFile, '--client', clientId, '--email-mode', 'on-request', '--send-only'];
      const proc = runProcess(CW_PYTHON, args, PROJECT_DIR, 300000);
      const tail = proc.output || '';
      let parsed = null;
      const m = /EMAIL_RESULT\s+(\{.*\})\s*$/m.exec(tail);
      if (m) { try { parsed = JSON.parse(m[1]); } catch (e) { parsed = null; } }
      const cache = pickChangedEmailCache(clientId, before);
      const records = parsed && Array.isArray(parsed.records) ? parsed.records
        : (cache && cache.doc && Array.isArray(cache.doc.records) ? cache.doc.records : []);
      const sent = (parsed && Array.isArray(parsed.sent) && parsed.sent.length)
        ? parsed.sent.map(String)
        : records.filter(function (r) { return r && String(r.status) === 'sent'; }).map(function (r) { return String(r.to); }).filter(Boolean);
      let message;
      const lastLine = tailLines(tail, 1).trim();
      if (!proc.ok && proc.exitCode === 2 && /(--email-mode|--send-only|unrecognized arguments)/.test(tail)) {
        message = 'Письмо НЕ отправлено: движок ещё не поддерживает режим on-request (--email-mode/--send-only). Нужна правка движка Агента 1.';
      } else if (!proc.ok && proc.timedOut) {
        message = 'Письмо НЕ отправлено: движок не успел ответить за 300 с.';
      } else if (!proc.ok) {
        message = 'Письмо НЕ отправлено: движок завершился с кодом ' + String(proc.exitCode) + (lastLine ? ' — ' + lastLine : '. См. вывод ниже.');
      } else if (sent.length) {
        message = 'Отчёт отправлен: ' + sent.join(', ') + '.';
      } else {
        const reasons = records.filter(function (r) { return r && r.reason; }).map(function (r) { return String(r.reason); });
        message = 'Письмо НЕ отправлено: ' + (parsed && parsed.message ? String(parsed.message)
          : (reasons[0] || (records.length ? 'движок не подтвердил отправку' : 'движок не создал записей отправки (канал email или автоотправка выключены)')));
      }
      return sendJson(res, 200, {
        ok: proc.ok && sent.length > 0, action: 'send-report', ran: true, exitCode: proc.exitCode,
        timedOut: !!proc.timedOut, durationMs: Date.now() - started, client: clientId,
        sent: sent, records: records, emailFile: cache ? cache.name : null, emailFileFresh: cache ? cache.fresh : false,
        message: message, stdoutTail: tailLines(tail, 15),
      });
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
        if (!fs.existsSync(CW_CLIENTS_DIR)) {
          fs.mkdirSync(CW_CLIENTS_DIR, { recursive: true });
        }
        const confFile = clientConfigFile(clientId);
        const exists = fs.existsSync(confFile);
        const today = panelLocalDate();
        const seed = exists ? null : ('# Клиентский конфиг Агента 1: подтверждённые конкуренты.\n# Файл создан панелью при первом добавлении кандидата.\nversion: 1\nclient: ' + clientId + '\nupdated: "' + today + '"\n\ncompetitors:\n');
        // Формат записи — контракт v2 §5.1: у записи есть id, class и site/platforms.
        // Без site/platforms движок не сможет взять её в анализ (запись «без источника»),
        // поэтому ссылки площадок переносим из sources[] кандидата движка.
        const platforms = { cian: '', avito: '', yandex_realty: '', domclick: '' };
        (Array.isArray(item.sources) ? item.sources : []).forEach(function (s) {
          const key = String((s && (s.platform || s.source)) || '').toLowerCase().replace(/-/g, '_');
          const url = String((s && (s.url || s.link)) || '').trim();
          if (key && url) platforms[key] = url;
        });
        const candId = String(item.id === undefined || item.id === null ? '' : item.id).trim() || panelSlug(String(name));
        const clean = function (v) { return String(v === undefined || v === null ? '' : v).replace(/["\\]/g, '').replace(/\s+/g, ' ').trim(); };
        const block = '- { id: ' + clean(candId) + ', name: "' + clean(name) + '", developer: "' + clean(item.developer || '')
          + '", class: "' + clean(item['class'] || item.klass || '') + '", site: "' + clean(item.site || item.url || '')
          + '", platforms: { cian: "' + clean(platforms.cian) + '", avito: "' + clean(platforms.avito)
          + '", yandex_realty: "' + clean(platforms.yandex_realty) + '", domclick: "' + clean(platforms.domclick)
          + '" }, source: "автоподбор", distance_km: ' + (item.distance_km === undefined || item.distance_km === null ? 'null' : item.distance_km)
          + ', added: "' + today + '" }';
        if (!exists) fs.writeFileSync(confFile, seed, 'utf8');
        // Дубль не создаём: повторное «Добавить в анализ» по тому же кандидату список не раздувает.
        const already = (function () {
          try {
            const d = parseYaml(fs.readFileSync(confFile, 'utf8'));
            const list = d && Array.isArray(d.competitors) ? d.competitors : [];
            return list.filter(function (c) {
              return c && typeof c === 'object'
                && (String(c.id === undefined || c.id === null ? '' : c.id) === candId || panelNormName(c.name) === panelNormName(String(name)));
            })[0] || null;
          } catch (e) { return null; }
        })();
        if (already) {
          try { collect({}); } catch (e) { /* best effort */ }
          return sendJson(res, 200, Object.assign({}, decisions, {
            added: false, alreadyInList: true, clientFile: confFile, candidateKey: candKey, decisionsFile: decFile,
            target: 'конкурент «' + name + '» уже в истинном списке клиента ' + clientId + ' — повторно не добавляю · решение записано в ' + projectId + '.decisions.json по ключу «' + candKey + '»',
          }));
        }
        const add = applyAtomicEdit(confFile, clientId + '.yaml', function (text) {
          return appendCompetitorBlock(text, block);
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
      const blockDefaults = SETTINGS_BLOCK_DEFAULTS[group] || null;
      const result = applyAtomicEdit(file, agent + '.yaml', function (text) {
        // Динамический домен: если ключа ещё нет — дописываем пару в конец карты.
        if (grp.__dynamicDomain && setYamlScalar(text, pathArr, writeValue).ok === false) {
          return appendListBlock(text, 'competitor_domains', ['  ' + field + ': ' + String(value).replace(/"/g, '')]);
        }
        const direct = rule.t === 'list' ? setYamlList(text, pathArr, writeValue) : setYamlScalar(text, pathArr, writeValue);
        if (direct.ok || !blockDefaults || pathArr.length < 3) return direct;
        // Родительского блока ещё нет в файле (новый параметр пришёл из панели раньше,
        // чем из конфига). Дописываем блок с умолчаниями и повторяем правку — иначе
        // тумблер молча не сохранился бы.
        const withBlock = insertChildBlock(text, pathArr.slice(0, pathArr.length - 2), pathArr[pathArr.length - 2], blockDefaults);
        if (!withBlock.ok) return direct;
        return rule.t === 'list' ? setYamlList(withBlock.text, pathArr, writeValue) : setYamlScalar(withBlock.text, pathArr, writeValue);
      });
      if (!result.ok) return sendJson(res, result.code || 400, result);
      // Тумблеры и поле ввода Агента 1 обязаны показывать новое состояние сразу —
      // как тумблер самого агента: тот после правки реестра пересобирает данные.
      if (REFRESH_AFTER_WRITE.indexOf(group) >= 0) {
        try { collect({}); } catch (e) { /* пересборка best-effort */ }
      }
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
        if (ACTIONS_DRY_RUN) return sendJson(res, 200, dryRunAnswer('report', curr, prev));
        const args = [path.join(CW_SCRIPTS, 'build_weekly_report.py'), '--curr', curr];
        if (prev) args.push('--prev', prev);
        const res2 = runProcess(PYTHON, args, PROJECT_DIR, 180000);
        const rep = newestReport();
        const run = appendDashboardRun(started, res2, rep ? rep.path : null);
        return sendJson(res, res2.ok ? 200 : 500, {
          ok: res2.ok, action: action, durationMs: Date.now() - started, exitCode: res2.exitCode,
          output: res2.output.split('\n').slice(-25).join('\n'),
          result: { curr: curr, prev: prev, report: rep },
          run: run,
          message: res2.ok ? ('Отчёт построен за ' + curr + (prev ? ' (сравнение с ' + prev + ')' : '')) : 'Построение отчёта завершилось с ошибкой',
        });
      }

      if (action === 'agent') {
        const agentId = String((body && body.agent) || 'agent-1-competitor-watch');
        if (agentId !== 'agent-1-competitor-watch') {
          return sendJson(res, 400, { ok: false, message: 'для агента «' + agentId + '» команда запуска пока не настроена: он в статусе «запланирован». Настроенный агент — «Агент 1 — Мониторинг конкурентов».' });
        }
        if (!curr) return sendJson(res, 400, { ok: false, message: 'нет снимков — сначала соберите данные' });
        if (ACTIONS_DRY_RUN) return sendJson(res, 200, dryRunAnswer('agent', curr, prev));
        const args = [path.join(CW_SCRIPTS, 'run_weekly.py'), '--date', curr, '--skip-sources'];
        if (prev) args.push('--prev', prev);
        const res2 = runProcess(PYTHON, args, PROJECT_DIR, 180000);
        const rep = newestReport();
        const run = appendDashboardRun(started, res2, rep ? rep.path : null);
        return sendJson(res, res2.ok ? 200 : 500, {
          ok: res2.ok, action: action, agent: agentId, durationMs: Date.now() - started, exitCode: res2.exitCode,
          output: res2.output.split('\n').slice(-25).join('\n'),
          result: { curr: curr, prev: prev, report: rep, skipSources: true },
          run: run,
          message: res2.ok
            ? ('Агент отработал цикл за ' + curr + ': проверка снимка, сравнение и отчёт. С сбором с площадок пропущен (--skip-sources) — он требует входа в Chrome.')
            : 'Цикл агента завершился с ошибкой',
        });
      }

      // Агент 2 «Яндекс Директ»: панель проверяет доступ к API v5 и ничего не меняет
      // в аккаунте (только чтение). Токен берётся из marketing-agents/.env.
      if (action === 'agent2') {
        const agentId = String((body && body.agent) || 'agent-2-direct-semantics');
        if (ACTIONS_DRY_RUN) return sendJson(res, 200, dryRunAnswer('agent2', curr, prev));
        const res2 = runProcess(PYTHON, ['-m', 'skills.direct_api', '--check', '--json'], PROJECT_DIR, 90000);
        // CLI печатает один JSON-объект; предупреждения рантайма идут в stderr.
        let check = null;
        try {
          const lines = String(res2.output || '').split('\n').map(function (l) { return l.trim(); }).filter(function (l) { return l.charAt(0) === '{'; });
          check = lines.length ? JSON.parse(lines[lines.length - 1]) : null;
        } catch (e) { check = null; }
        const ok = res2.ok && check !== null && String(check.status) !== 'error';
        const status = check && check.status ? String(check.status) : (res2.ok ? 'unknown' : 'error');
        const campaigns = check && check.campaigns !== undefined ? check.campaigns : null;
        const metrika = check && check.metrika ? check.metrika : null;
        const metrikaNote = metrika
          ? (String(metrika.status) === 'ok'
            ? ' · Метрика доступна' + (metrika.counter && metrika.counter.name ? ' (счётчик «' + metrika.counter.name + '»)' : '')
            : ' · Метрика: ' + String(metrika.message || metrika.status))
          : '';
        const message = !check
          ? ('Проверка не вернула разборчивый ответ (код ' + res2.exitCode + '): ' + String(res2.output || '').split('\n').slice(-2).join(' ').slice(0, 300))
          : (status === 'ok'
            ? ('Доступ к API Директа есть: кампаний ' + (campaigns === null ? 'нет данных' : campaigns) + (check.sandbox ? ' (песочница)' : ''))
            : String(check.message || ('статус проверки: ' + status)));
        const run = appendDashboardRun(started, { ok: ok, output: res2.output }, null, {
          agent: agentId, service: 'direct-api',
          error: status === 'ok' ? null : message,
        });
        return sendJson(res, ok ? 200 : 500, {
          ok: ok, action: action, agent: agentId, durationMs: Date.now() - started, exitCode: res2.exitCode,
          output: res2.output.split('\n').slice(-25).join('\n'),
          result: { status: status, sandbox: check ? !!check.sandbox : null, campaigns: campaigns, metrika: metrika },
          run: run,
          message: message + metrikaNote,
        });
      }

      // Отчёт Метрики по регламенту metrika-cross-analytics: только чтение,
      // счётчик берётся из marketing-agents/.env (YANDEX_METRICA_COUNTER_ID).
      if (action === 'agent2-metrika') {
        const agentId = String((body && body.agent) || 'agent-2-direct-semantics');
        if (ACTIONS_DRY_RUN) return sendJson(res, 200, dryRunAnswer('agent2-metrika', curr, prev));
        const to = new Date().toISOString().slice(0, 10);
        const from = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);
        const res2 = runProcess(PYTHON, ['-m', 'skills.direct_api', '--metrika-report', '--from', from, '--to', to, '--json'], PROJECT_DIR, 90000);
        let report = null;
        try {
          const lines = String(res2.output || '').split('\n').map(function (l) { return l.trim(); }).filter(function (l) { return l.charAt(0) === '{'; });
          report = lines.length ? JSON.parse(lines[lines.length - 1]) : null;
        } catch (e) { report = null; }
        const ok = res2.ok && report !== null && report.ok === true;
        const run = appendDashboardRun(started, { ok: ok, output: res2.output }, null, { agent: agentId, service: 'metrika' });
        const totals = report && report.totals ? report.totals : null;
        const message = !report
          ? ('Отчёт Метрики не собрался (код ' + res2.exitCode + '): ' + String(res2.output || '').split('\n').slice(-2).join(' ').slice(0, 300))
          : (report.ok
            ? ('Отчёт Метрики за ' + (report.period ? report.period[0] + '..' + report.period[1] : 'период неизвестен') +
               ': трафик ' + (report.has_data ? 'есть' : 'данных нет') +
               (totals ? ', визиты ' + Math.round(Number(totals[0] || 0)) + ', пользователи ' + Math.round(Number(totals[1] || 0)) : '') +
               ', целей ' + ((report.goals || []).length))
            : String(report.message || 'ошибка отчёта'));
        return sendJson(res, ok ? 200 : 500, {
          ok: ok, action: action, agent: agentId, durationMs: Date.now() - started, exitCode: res2.exitCode,
          output: res2.output.split('\n').slice(-25).join('\n'),
          result: {
            status: report && report.ok ? 'ok' : 'error',
            period: report ? report.period : null,
            hasData: report ? !!report.has_data : null,
            totals: totals,
            goals: report ? (report.goals || []).length : null,
            rows: report ? (report.rows || []).length : null,
          },
          run: run,
          message: message,
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
      const target = resolveSettingsTarget(which);
      if (!target) return sendJson(res, 400, { ok: false, message: 'неизвестный файл: ' + which });
      if (!fs.existsSync(target)) return sendJson(res, 404, { ok: false, message: 'файл не найден: ' + target });
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
        sha256: sha256Of(target), sha256Restored: sha256Of(backupPath),
        target: 'возврат к состоянию до правки', generatedAt: meta ? meta.generatedAt : null,
        note: 'файл восстановлен из копии ' + backup + '; текущее состояние сохранено в ' + path.basename(safety)
          + '. SHA-256 файла теперь совпадает с SHA-256 копии — откат проверяем.',
      });
    });
  }

  // --- СПИСОК КОПИЙ для кнопки «Вернуть как было» ---
  // Нужен и тонким настройкам агентов: раньше маршрута не было, и откат тумблеров
  // не работал. Отдаём SHA-256 текущего файла и каждой копии — обратимость проверяема.
  if (p === '/api/settings/backups' && method === 'GET') {
    const which = String(url.searchParams.get('file') || '');
    const target = resolveSettingsTarget(which);
    if (!target) return sendJson(res, 400, { ok: false, message: 'неизвестный файл: ' + which });
    if (!fs.existsSync(target)) return sendJson(res, 404, { ok: false, message: 'файл не найден: ' + target });
    return sendJson(res, 200, {
      ok: true, file: target, label: which,
      current: { sha256: sha256Of(target), bytes: fs.statSync(target).size },
      backups: backupsOf(target),
      note: 'Копии делает панель при каждой правке (.bak-<timestamp>). Возврат — POST /api/settings/revert с именем копии.',
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

  // --- выгрузка в Obsidian (POST /api/vault/export) ---
  // Второе исключение из «пишем только в dashboard/»: заметки уходят в vault,
  // но строго в подпапку «выгрузка-панели», и только через модуль
  // collector/export-vault.mjs — он же делает .bak перед перезаписью.
  // dryRun:true ничего не пишет, только считает план.
  // scope:'panel' (по умолчанию) — заметки панели; scope:'full' — плюс разделы
  // «Скилы» и «База знаний». Любое другое значение — 400.
  // Контракт модуля: exportVault({ dryRun, scope }) -> { ok, vaultPath, scope, written[], updated[], skipped[], errors[] }.
  if (p === '/api/vault/export' && method === 'POST') {
    return readBody(req).then(async function (body) {
      if (body === null) return sendJson(res, 400, { ok: false, message: 'тело запроса не разобрано: нужен JSON вида {"dryRun":false}' });
      const dryRun = !!(body && body.dryRun === true);
      const rawScope = body && body.scope !== undefined && body.scope !== null && String(body.scope).trim() !== ''
        ? body.scope : 'panel';
      const scope = typeof rawScope === 'string' ? rawScope.trim() : rawScope;
      if (scope !== 'panel' && scope !== 'full') {
        return sendJson(res, 400, {
          ok: false,
          dryRun: dryRun,
          scope: scope,
          message: 'неизвестный scope: ' + JSON.stringify(rawScope) + ' (допустимо: panel | full)',
        });
      }
      if (!fs.existsSync(EXPORT_VAULT_FILE)) {
        return sendJson(res, 500, { ok: false, dryRun: dryRun, scope: scope, message: 'модуль экспорта не найден: ' + EXPORT_VAULT_FILE });
      }
      let mod = null;
      try {
        // ?v=<mtime> — чтобы после появления/правки модуля панель подхватила новую версию без перезапуска.
        const stamp = String(fs.statSync(EXPORT_VAULT_FILE).mtimeMs);
        mod = await import(pathToFileURL(EXPORT_VAULT_FILE).href + '?v=' + stamp);
      } catch (e) {
        return sendJson(res, 500, { ok: false, dryRun: dryRun, scope: scope, message: 'модуль экспорта не загрузился: ' + (e && e.message ? e.message : String(e)) });
      }
      if (!mod || typeof mod.exportVault !== 'function') {
        return sendJson(res, 500, { ok: false, dryRun: dryRun, scope: scope, message: 'модуль экспорта не экспортирует функцию exportVault: ' + EXPORT_VAULT_FILE });
      }
      let out = null;
      try {
        out = await mod.exportVault({ dryRun: dryRun, scope: scope });
      } catch (e) {
        return sendJson(res, 500, { ok: false, dryRun: dryRun, scope: scope, message: 'экспорт упал: ' + (e && e.message ? e.message : String(e)), stack: String(e && e.stack ? e.stack : '') });
      }
      const r = (out && typeof out === 'object') ? out : {};
      const list = function (v) { return Array.isArray(v) ? v : []; };
      const errors = list(r.errors);
      const payload = {
        ok: r.ok !== false,
        dryRun: dryRun,
        scope: r.scope !== undefined ? String(r.scope) : scope,
        vaultPath: r.vaultPath !== undefined ? r.vaultPath : null,
        written: list(r.written),
        updated: list(r.updated),
        skipped: list(r.skipped),
        errors: errors,
        message: r.message !== undefined ? String(r.message)
          : (r.ok === false ? (errors.length ? String(errors[0]) : 'экспорт завершился с ошибкой') : (dryRun ? 'проверка без записи: план выгрузки' : 'выгрузка завершена')),
      };
      return sendJson(res, payload.ok ? 200 : 500, payload);
    });
  }

  // --- кабинеты Яндекс.Директа (Агент 2) ---
  // Токен живёт только в ACCOUNTS_FILE (00-admin/config/direct-accounts.local.json,
  // вне репозитория). В ответах — маска из последних 4 символов; в консоль панели
  // токен не печатается ни при успехе, ни при ошибке.

  if (p === '/api/direct/accounts' && method === 'GET') {
    let store = null;
    try { store = readStore(); }
    catch (e) { return sendJson(res, 500, { ok: false, message: 'хранилище кабинетов не прочитано: ' + e.message, file: ACCOUNTS_FILE }); }
    return sendJson(res, 200, {
      ok: true,
      oauth: publicOauth(store),
      accounts: store.accounts.map(publicAccount),
    });
  }

  if (p === '/api/direct/oauth' && method === 'POST') {
    return readBody(req).then(function (body) {
      if (body === null) return sendJson(res, 400, { ok: false, message: 'тело запроса не разобрано: нужен JSON вида {"clientId":"..."}' });
      const clientId = String((body && body.clientId) || '').trim();
      if (clientId === '') return sendJson(res, 400, { ok: false, message: 'нужен clientId — идентификатор приложения из кабинета OAuth Яндекса' });
      if (!/^[A-Za-z0-9._-]{4,128}$/.test(clientId)) return sendJson(res, 400, { ok: false, message: 'clientId: латиница, цифры, точка, дефис или подчёркивание, от 4 символов' });
      let store = null;
      try { store = saveClientId(clientId); }
      catch (e) { return sendJson(res, 500, { ok: false, message: 'clientId не сохранён: ' + e.message, file: ACCOUNTS_FILE }); }
      return sendJson(res, 200, { ok: true, oauth: publicOauth(store) });
    });
  }

  // Привязка кабинета: сначала ЖИВАЯ проверка доступа к API v5, запись — только
  // после успеха. Токен в ответе и в логах не появляется — ни целиком, ни в тексте ошибки.
  if (p === '/api/direct/accounts' && method === 'POST') {
    return readBody(req).then(function (body) {
      if (body === null) return sendJson(res, 400, { ok: false, message: 'тело запроса не разобрано: нужен JSON вида {"token":"...","login":"","sandbox":false}' });
      const token = String((body && body.token) || '').trim();
      if (token === '') return sendJson(res, 400, { ok: false, message: 'нужен OAuth-токен кабинета (поле token)' });
      const login = String((body && body.login) || '').trim();
      const sandbox = !!(body && body.sandbox === true);
      const check = verifyDirectAccount(token, login, sandbox);
      if (!check.ok) {
        return sendJson(res, 502, { ok: false, status: directFailureStatus(check.status, check.message), message: check.message });
      }
      let saved = null;
      try {
        saved = upsertVerifiedAccount({
          token: token,
          login: login || check.clientLogin || '',
          sandbox: check.sandbox,
          campaigns: check.campaigns,
        });
      } catch (e) { return sendJson(res, 500, { ok: false, message: 'кабинет проверен, но не сохранился: ' + e.message, file: ACCOUNTS_FILE }); }
      return sendJson(res, 200, { ok: true, account: publicAccount(saved.account), message: check.message });
    });
  }

  if (p === '/api/direct/accounts/check' && method === 'POST') {
    return readBody(req).then(function (body) {
      if (body === null) return sendJson(res, 400, { ok: false, message: 'тело запроса не разобрано: нужен JSON вида {"id":"direct-1"}' });
      const id = String((body && body.id) || '').trim();
      if (id === '') return sendJson(res, 400, { ok: false, message: 'нужен id кабинета' });
      let store = null;
      try { store = readStore(); }
      catch (e) { return sendJson(res, 500, { ok: false, message: 'хранилище кабинетов не прочитано: ' + e.message, file: ACCOUNTS_FILE }); }
      const account = findAccount(store, id);
      if (!account) return sendJson(res, 404, { ok: false, message: 'кабинет не найден: ' + id });
      const check = verifyDirectAccount(account.token, account.login, account.sandbox);
      let updated = null;
      try {
        updated = updateAccountCheck(id, {
          // Статусы кабинета: ok | invalid | unchecked. Любой провал проверки — invalid,
          // причина видна в message (401, сеть и таймаут отличаются текстом).
          status: check.ok ? 'ok' : 'invalid',
          campaigns: check.ok ? check.campaigns : null,
        });
      } catch (e) { return sendJson(res, 500, { ok: false, message: 'результат проверки не записан: ' + e.message, file: ACCOUNTS_FILE }); }
      if (!updated) return sendJson(res, 404, { ok: false, message: 'кабинет не найден: ' + id });
      // Контракт: перепроверка обновляет запись и возвращает её (200). Провал виден
      // в account.status = 'invalid' и в message/checkStatus, а не в HTTP-коде.
      return sendJson(res, 200, { ok: true, account: publicAccount(updated), checkStatus: check.status, message: check.message });
    });
  }

  if (p === '/api/direct/accounts/delete' && method === 'POST') {
    return readBody(req).then(function (body) {
      if (body === null) return sendJson(res, 400, { ok: false, message: 'тело запроса не разобрано: нужен JSON вида {"id":"direct-1"}' });
      const id = String((body && body.id) || '').trim();
      if (id === '') return sendJson(res, 400, { ok: false, message: 'нужен id кабинета' });
      let removed = false;
      try { removed = deleteAccount(id); }
      catch (e) { return sendJson(res, 500, { ok: false, message: 'кабинет не удалён: ' + e.message, file: ACCOUNTS_FILE }); }
      if (!removed) return sendJson(res, 404, { ok: false, message: 'кабинет не найден: ' + id });
      return sendJson(res, 200, { ok: true, removed: id });
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

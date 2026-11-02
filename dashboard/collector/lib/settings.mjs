// Вкладка «Настройки»: реестр ВСЕХ управляемых параметров системы.
// Для каждого пункта: текущее значение, что произойдёт при изменении,
// когда меняли (по копиям .bak-*) и предыдущее значение для кнопки «вернуть как было».
import fs from 'node:fs';
import path from 'node:path';
import { parseYaml } from './yaml.mjs';
import { PROJECT_DIR, REGISTRY_DIR } from './paths.mjs';

const SETTINGS_FILE = path.join(PROJECT_DIR, '00-admin', 'config', 'settings.yaml');
const PRICES_FILE = path.join(REGISTRY_DIR, 'prices.yaml');
const AGENTS_FILE = path.join(REGISTRY_DIR, 'agents.yaml');
const SOURCES_FILE = path.join(REGISTRY_DIR, 'sources.yaml');

// --- что можно менять в правилах отчёта ---
const REPORT_ITEMS = [
  { id: 'thresholds.price_change_pct', path: ['thresholds', 'price_change_pct'], kind: 'number', step: '0.1', min: 0, max: 100, label: 'Порог изменения цены, %', what: 'Изменение цены меньше этого значения считается шумом и в отчёт не выносится.' },
  { id: 'thresholds.price_change_abs_rub', path: ['thresholds', 'price_change_abs_rub'], kind: 'number', step: '1000', min: 0, label: 'Порог изменения цены, ₽', what: '0 — порог по абсолютной сумме не применяется. Иначе изменение меньше этой суммы игнорируется.' },
  { id: 'thresholds.lot_count_change_abs', path: ['thresholds', 'lot_count_change_abs'], kind: 'number', step: '1', min: 0, label: 'Порог по числу лотов', what: 'Приход или уход меньшего числа лотов по проекту не выносится в «Главное за неделю».' },
  { id: 'thresholds.min_lots_for_stats', path: ['thresholds', 'min_lots_for_stats'], kind: 'number', step: '1', min: 0, label: 'Минимум лотов для статистики', what: 'Проект с меньшим числом лотов не попадает в медианные таблицы отчёта.' },
  { id: 'period.days', path: ['period', 'days'], kind: 'number', step: '1', min: 1, max: 365, label: 'Период сравнения, дней', what: 'С каким снимком сравнивать текущий: ровно N дней назад (справочное значение для движка).' },
  { id: 'period.compare_mode', path: ['period', 'compare_mode'], kind: 'select', options: [['week_over_week', 'Снимок N дней назад'], ['previous_snapshot', 'Предыдущий снимок по дате']], label: 'Режим сравнения', what: '«Снимок N дней назад» — строго по периоду. «Предыдущий снимок» — если сбор был пропущен, сравнит с тем, что есть.' },
  { id: 'units.price_round_to_rub', path: ['units', 'price_round_to_rub'], kind: 'number', step: '100', min: 1, label: 'Округление денег в отчёте, ₽', what: 'До какого шага округлять суммы в отчёте. 1000 — до тысяч рублей.' },
  { id: 'units.pct_decimals', path: ['units', 'pct_decimals'], kind: 'number', step: '1', min: 0, max: 6, label: 'Знаков после запятой в процентах', what: 'Сколько знаков показывать в процентах отчёта. 2 — как «0,53 %».' },
  { id: 'quality.warn_if_lots_below', path: ['quality', 'warn_if_lots_below'], kind: 'number', step: '1', min: 0, label: 'Предупреждать, если лотов меньше', what: 'Если в снимке меньше этого числа лотов — в отчёт попадёт предупреждение о неполных данных.' },
  { id: 'output.formats', path: ['output', 'formats'], kind: 'list', options: [['md', 'Markdown (.md)'], ['xlsx', 'Excel (.xlsx)'], ['csv', 'CSV (.csv)']], label: 'Форматы отчёта', what: 'В каких файлах готовить отчёт. md и xlsx — основные; csv — дополнительно.' }
];

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (e) { return null; }
}

function getPath(obj, p) {
  let cur = obj;
  for (const k of p) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = cur[k];
  }
  return cur;
}

function backupsFor(file) {
  const dir = path.dirname(file);
  const base = path.basename(file) + '.bak-';
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return []; }
  return names.filter(function (n) { return n.indexOf(base) === 0; })
    .map(function (n) {
      const full = path.join(dir, n);
      let mtime = 0;
      try { mtime = fs.statSync(full).mtimeMs; } catch (e) { mtime = 0; }
      return { name: n, file: full, mtime: mtime };
    })
    .sort(function (a, b) { return b.mtime - a.mtime; });
}

// Последнее изменение значения по пути — по копиям .bak-* (свежие сначала).
function lastChangeByPath(file, p, currentValue, cache) {
  const backups = cache[file] || (cache[file] = backupsFor(file));
  for (const b of backups) {
    let doc = null;
    try { doc = parseYaml(fs.readFileSync(b.file, 'utf8')); } catch (e) { continue; }
    const prev = getPath(doc, p);
    if (prev === undefined) continue;
    const a = Array.isArray(currentValue) ? currentValue.join(',') : String(currentValue);
    const c = Array.isArray(prev) ? prev.join(',') : String(prev);
    if (a !== c) return { at: b.mtime, previous: prev, now: currentValue, backup: b.name };
  }
  return null;
}

function lastChangeInList(file, listKey, id, field, currentValue, cache) {
  const backups = cache[file] || (cache[file] = backupsFor(file));
  for (const b of backups) {
    let doc = null;
    try { doc = parseYaml(fs.readFileSync(b.file, 'utf8')); } catch (e) { continue; }
    const list = Array.isArray(doc[listKey]) ? doc[listKey] : [];
    const item = list.filter(function (x) { return x && String(x.id) === String(id); })[0];
    if (!item) continue;
    const prev = item[field];
    if (prev === undefined) continue;
    const a = Array.isArray(currentValue) ? currentValue.join(',') : String(currentValue);
    const c = Array.isArray(prev) ? prev.join(',') : String(prev);
    if (a !== c) return { at: b.mtime, previous: prev, now: currentValue, backup: b.name };
  }
  return null;
}

export function buildSettingsDoc(ctx) {
  const warnings = [];
  const cache = {};
  const settingsText = readText(SETTINGS_FILE);
  const pricesText = readText(PRICES_FILE);
  const settingsDoc = settingsText ? (function () { try { return parseYaml(settingsText); } catch (e) { warnings.push('settings.yaml не разобран: ' + e.message); return null; } })() : null;
  const pricesDoc = pricesText ? (function () { try { return parseYaml(pricesText); } catch (e) { warnings.push('prices.yaml не разобран: ' + e.message); return null; } })() : null;
  if (!settingsText) warnings.push('Не найден файл правил: ' + SETTINGS_FILE);

  const reportItems = REPORT_ITEMS.map(function (it) {
    let value = settingsDoc ? getPath(settingsDoc, it.path) : null;
    if (value === undefined) value = null;
    return {
      id: it.id, label: it.label, kind: it.kind, value: value,
      options: it.options || null, step: it.step || null, min: it.min === undefined ? null : it.min, max: it.max === undefined ? null : it.max,
      what: it.what, file: 'settings', path: it.path,
      history: lastChangeByPath(SETTINGS_FILE, it.path, value, cache),
    };
  });

  // --- цены и курс ---
  const models = [];
  if (pricesDoc && pricesDoc.models && typeof pricesDoc.models === 'object') {
    for (const id of Object.keys(pricesDoc.models)) {
      const m = pricesDoc.models[id] || {};
      models.push({
        id: id,
        rubIn: m.rub_per_1m_in === undefined ? null : m.rub_per_1m_in,
        rubOut: m.rub_per_1m_out === undefined ? null : m.rub_per_1m_out,
        rubCacheRead: m.rub_per_1m_cache_read === undefined ? null : m.rub_per_1m_cache_read,
        acceptsImages: m.accepts_images === undefined ? null : m.accepts_images,
        historyIn: lastChangeByPath(PRICES_FILE, ['models', id, 'rub_per_1m_in'], m.rub_per_1m_in, cache),
        historyOut: lastChangeByPath(PRICES_FILE, ['models', id, 'rub_per_1m_out'], m.rub_per_1m_out, cache),
      });
    }
  }
  const rate = pricesDoc && pricesDoc.rate && typeof pricesDoc.rate === 'object' ? pricesDoc.rate : null;
  const rateValue = rate ? rate.usd_rub : null;

  const prices = {
    title: 'Цены моделей и курс валюты',
    note: 'Единственный источник цен — registry/prices.yaml. Правка меняет только число, комментарии и остальные строки сохраняются.',
    file: PRICES_FILE,
    rate: {
      id: 'rate.usd_rub', label: 'Курс доллара, ₽ за 1 $', kind: 'number', step: '0.01', min: 1,
      value: rateValue === undefined ? null : rateValue, path: ['rate', 'usd_rub'], file: 'prices',
      what: 'По этому курсу рубли считаются из долларовых ставок. Если курс неверный — весь расход в рублях будет неверным.',
      history: lastChangeByPath(PRICES_FILE, ['rate', 'usd_rub'], rateValue, cache),
    },
    models: models,
  };

  // --- агенты ---
  const modelOptions = models.filter(function (m) { return m.rubIn !== null || m.rubOut !== null; })
    .map(function (m) { return { id: m.id, rubIn: m.rubIn, rubOut: m.rubOut }; });
  const agentsDoc = ctx && ctx.agentsDoc ? ctx.agentsDoc : null;
  const agentRows = (agentsDoc && agentsDoc.agents ? agentsDoc.agents : []).map(function (a) {
    return {
      id: a.id, name: a.name, enabled: a.enabled, status: a.status,
      model: a.model, schedule: a.schedule,
      projects: a.projects || [], groups: a.groups || [],
      modelOptions: modelOptions,
      history: {
        enabled: lastChangeInList(AGENTS_FILE, 'agents', a.id, 'enabled', a.enabled, cache),
        model: lastChangeInList(AGENTS_FILE, 'agents', a.id, 'model', a.model, cache),
        schedule: lastChangeInList(AGENTS_FILE, 'agents', a.id, 'schedule', a.schedule, cache),
      },
    };
  });

  // --- источники ---
  const sourcesDoc = ctx && ctx.sourcesDoc ? ctx.sourcesDoc : null;
  const sourceRows = (sourcesDoc && sourcesDoc.sources ? sourcesDoc.sources : []).map(function (s) {
    return {
      id: s.id, name: s.name, enabled: s.enabled, status: s.status, kind: s.kind,
      lots: s.stats ? s.stats.lots : 0,
      history: { enabled: lastChangeInList(SOURCES_FILE, 'sources', s.id, 'enabled', s.enabled, cache) },
    };
  });

  const routing = buildRouting(settingsDoc, modelOptions, cache);
  const plugins = buildPlugins(cache);
  const delivery = buildDelivery(settingsDoc, cache);

  return {
    generatedAtMs: Date.now(),
    routing: routing,
    plugins: plugins,
    delivery: delivery,
    files: {
      settings: SETTINGS_FILE, prices: PRICES_FILE, agents: AGENTS_FILE, sources: SOURCES_FILE,
      settingsExists: !!settingsText, pricesExists: !!pricesText,
    },
    report: { title: 'Правила отчёта', note: 'Правка атомарная: меняется только значение, комментарии и порядок строк сохраняются. Файл: 00-admin/config/settings.yaml', items: reportItems },
    prices: prices,
    agents: { title: 'Агенты', note: 'Включение, модель, расписание, проект и группы задач. Модели показаны с ценой за 1 млн токенов.', rows: agentRows },
    sources: { title: 'Источники мониторинга', note: 'Выключенный источник пропускается сбором (движок T18).', rows: sourceRows },
    warnings: warnings,
  };
}
// --- Роутинг моделей: конфиг dsh-delegate-router -------------------------
const ROUTER_FILE = path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', 'dsh-delegate-router.json');

// --- Критические пакеты профиля: их выключать НЕЛЬЗЯ ---------------------
// Языковой пакет dsh-locale-ru подключён через file:.plugin-sources/dsh-locale-ru:
// выключишь его из bundles — интерфейс вернётся на китайский. Встроенные бандлы
// DeepSeek (@deepseek-ai/*) вообще приходят с приложением, без них DSH не стартует.
export function protectReason(name) {
  if (!name) return null;
  if (name.indexOf('@deepseek-ai/') === 0) return 'встроенный бандл DeepSeek — приходит с приложением, выключение ломает запуск DSH';
  if (/locale/i.test(name)) return 'языковой пакет: выключение вернёт интерфейс на китайский (подключён через file:.plugin-sources)';
  return null;
}

export function isProtected(name) { return protectReason(name) !== null; }

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

export function loadProfileForSettings() {
  const profileDir = process.env.DSH_PROFILE_DIR && process.env.DSH_PROFILE_DIR.trim() !== ''
    ? process.env.DSH_PROFILE_DIR
    : path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', 'profiles', 'desktop');
  const manifestPath = path.join(profileDir, 'package.json');
  const manifest = fs.existsSync(manifestPath) ? readJsonSafe(manifestPath) : null;
  const bundles = manifest && manifest.dsh && manifest.dsh.profile && Array.isArray(manifest.dsh.profile.bundles)
    ? manifest.dsh.profile.bundles.map(String) : [];
  const deps = manifest && manifest.dependencies && typeof manifest.dependencies === 'object' ? manifest.dependencies : {};
  return { profileDir: profileDir, manifestPath: manifestPath, exists: !!manifest, bundles: bundles, dependencies: deps };
}

export function buildRouting(settingsDoc, modelOptions, cache) {
  let doc = null;
  let exists = fs.existsSync(ROUTER_FILE);
  if (exists) doc = readJsonSafe(ROUTER_FILE);
  function item(key, label, what) {
    const value = doc && doc[key] !== undefined ? String(doc[key]) : null;
    return {
      id: key, label: label, kind: 'select', value: value,
      options: modelOptions.map(function (m) { return [m.id, m.id + (m.rubIn === null || m.rubIn === undefined ? ' — цена неизвестна' : ' — ' + m.rubIn + ' ₽ за 1 млн вход')]; }),
      what: what, file: 'router', path: [key],
      history: exists ? lastChangeByPath(ROUTER_FILE, [key], value, cache) : null,
    };
  }
  return {
    title: 'Роутинг моделей (delegate-router)',
    note: exists
      ? 'Файл конфигурации найден. Лёгкие задачи уходят на дешёвую модель, сложные — на сильную.'
      : 'Файла конфигурации ещё нет — он создастся при первом сохранении: ' + ROUTER_FILE,
    file: ROUTER_FILE, exists: exists,
    items: [
      item('flashModel', 'Дешёвая модель для лёгких задач', 'Подагенты и рутина пойдут на эту модель. Ошибётесь с выбором — рутина подорожает.'),
      item('proModel', 'Сильная модель для сложных задач', 'Сложный анализ и большие тексты пойдут на эту модель. Дешёвая модель здесь даст слабый результат.')
    ]
  };
}

export function buildPlugins(cache) {
  const prof = loadProfileForSettings();
  const rows = [];
  const names = {};
  for (const n of prof.bundles) names[n] = true;
  for (const n of Object.keys(prof.dependencies)) names[n] = true;
  for (const n of Object.keys(names).sort()) {
    const inBundles = prof.bundles.indexOf(n) >= 0;
    const reason = protectReason(n);
    rows.push({
      name: n,
      inBundles: inBundles,
      installed: Object.prototype.hasOwnProperty.call(prof.dependencies, n),
      declaredVersion: Object.prototype.hasOwnProperty.call(prof.dependencies, n) ? String(prof.dependencies[n]) : null,
      protected: reason !== null,
      protectReason: reason,
      inbox: n.indexOf('@deepseek-ai/') === 0,
      history: lastChangeByPath(prof.manifestPath, ['dsh', 'profile', 'bundles'], prof.bundles, cache),
    });
  }
  return {
    title: 'Плагины и интеграции профиля DSH',
    note: 'Включение и выключение пакетов в dsh.profile.bundles. Перед правкой делается копия, после правки профиль проверяется скриптом check-profile-bundles.mjs; если проверка не прошла — файл автоматически возвращается из копии.',
    manifest: prof.manifestPath,
    profileDir: prof.profileDir,
    rows: rows,
    protectedCount: rows.filter(function (r) { return r.protected; }).length,
    restartNote: 'После изменения списка плагинов НУЖЕН ПЕРЕЗАПУСК DeepSeek Harness: изменения подхватываются только при старте приложения.',
  };
}

export function buildDelivery(settingsDoc, cache) {
  const pathBase = ['delivery'];
  function boolItem(sub, label, what) {
    const p = pathBase.concat([sub, 'enabled']);
    const cur = settingsDoc ? getPath(settingsDoc, p) : null;
    return { id: p.join('.'), label: label, kind: 'bool', value: cur === true, file: 'settings', path: p, what: what, history: lastChangeByPath(SETTINGS_FILE, p, cur, cache) };
  }
  const sendMode = settingsDoc ? getPath(settingsDoc, ['delivery', 'send_mode']) : null;
  const tg = settingsDoc ? getPath(settingsDoc, ['delivery', 'telegram', 'target']) : null;
  const em = settingsDoc ? getPath(settingsDoc, ['delivery', 'email', 'to']) : null;
  return {
    title: 'Доставка и уведомления',
    note: 'Куда уходит отчёт. Автоматическая отправка в этой версии выключена: отчёт готовит агент, отправляете вы сами.',
    sendMode: sendMode,
    items: [
      boolItem('telegram', 'Отправка в Telegram', 'Включит отметку «отправлять в Telegram». Нужен токен бота и канал — без них отправка не сработает.'),
      boolItem('email', 'Отправка на почту', 'Включит отметку «отправлять на почту». Нужен адрес получателя и почтовый шлюз.')
    ],
    where: {
      sendMode: sendMode === 'manual' ? 'вручную (отчёт готовит агент)' : String(sendMode),
      telegram: (settingsDoc && getPath(settingsDoc, ['delivery', 'telegram', 'enabled']) === true) ? ('канал: ' + (tg || 'не указан')) : 'выключен',
      email: (settingsDoc && getPath(settingsDoc, ['delivery', 'email', 'enabled']) === true) ? ('адрес: ' + (em || 'не указан')) : 'выключена',
      formats: (settingsDoc ? getPath(settingsDoc, ['output', 'formats']) : null) || []
    }
  };
}

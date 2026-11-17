// Экспорт состояния панели в Obsidian-vault.
//
// ГРАНИЦЫ ЗАПИСИ (жёстко): модуль пишет ТОЛЬКО в
//     <vaultPath>/<domains_dir>/<Домен>/<export_subdir>/<файл>.md
// Любой путь вне этой зоны — ошибка, файл не пишется (см. resolveTarget).
// Существующие файлы перед перезаписью копируются в <имя>.bak-<YYYYMMDD-HHmmss>.
// Файл с неизменившимся содержимым не перезаписывается (skipped) — .bak не плодится.
//
// СЕКРЕТЫ И ПЕРСОНАЛЬНЫЕ ДАННЫЕ не экспортируются: источники читаются по белому
// списку полей, а готовый текст дополнительно проходит через scrub() (email, телефон,
// ключеподобные строки). Пути live-url.txt / last-url.txt не читаются вообще.
//
// Публичный контракт (используется serve.mjs):
//     export async function exportVault(opts = {}) -> { ok, vaultPath, scope, written, updated, skipped, errors }
//     opts: { vaultPath, configPath, dryRun, scope: 'panel' | 'full' }
//     scope по умолчанию 'panel' — прежний набор заметок панели;
//     scope 'full' — он же плюс разделы «Скилы» и «База знаний».
// Пути в written/updated/skipped — относительно корня vault, через «/».
//
// Прямой запуск:
//     node dashboard/collector/export-vault.mjs [--dry-run] [--scope panel|full] [--vault <путь>] [--config <файл>]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONFIG_DIR, DATA_DIR, PROJECT_DIR, REGISTRY_DIR } from './lib/paths.mjs';
import { parseYaml } from './lib/yaml.mjs';

const DEFAULT_CONFIG = path.join(CONFIG_DIR, 'vault.yaml');
const MAX_NOTE_CHARS = 7000;
const DEFAULT_DOMAINS_DIR = '20-Домены';
const DEFAULT_SUBDIR = 'выгрузка-панели';

// domain (латиницей, идёт в фронтматтер) -> русская папка домена
const DOMAIN_DIRS = {
  agents: 'Агенты',
  auth: 'Авторизация',
  billing: 'Оплата',
  transactions: 'Расходы',
  dashboard: 'Панель',
  reporting: 'Отчёты',
  infra: 'Инфраструктура',
  connectors: 'Коннекторы',
  // Разделы базы, которые добавляются только в режиме scope=full.
  skills: 'Скилы',
  kb: 'База знаний',
};

// Никогда не читаем: адреса туннелей и прочие «живые» ссылки.
const DENY_BASENAMES = new Set(['live-url.txt', 'last-url.txt', 'last-url.txt']);
const DENY_RE = /(^|[\\/])(live-url|last-url)(\.|$)/i;

const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const PHONE_RE = /(?:\+7|\b8)[\s(.-]*\d{3}[\s).-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}\b/g;
const KEYLIKE_RE = /\b(?:sk|pk|rk|tok|token|key|secret)-[A-Za-z0-9_-]{12,}\b/gi;
const HIDDEN = '[скрыто: персональные данные]';

// ---------------------------------------------------------------- утилиты

const nf = new Intl.NumberFormat('ru-RU');

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? nf.format(v) : (v === null || v === undefined || v === '' ? '—' : String(v));
}

function rub(v) {
  return typeof v === 'number' && Number.isFinite(v) ? nf.format(Math.round(v * 100) / 100) + ' ₽' : '—';
}

function pct(v) {
  return typeof v === 'number' && Number.isFinite(v) ? (Math.round(v * 1000) / 10) + '%' : '—';
}

function bool(v) {
  return v === true ? 'да' : v === false ? 'нет' : '—';
}

function esc(v) {
  return String(v === null || v === undefined ? '' : v).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

function clip(s, n) {
  const t = String(s || '');
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

function list(v) {
  return Array.isArray(v) && v.length ? v.join(', ') : '—';
}

function scrub(s) {
  return String(s)
    .replace(EMAIL_RE, '[email скрыт]')
    .replace(PHONE_RE, '[телефон скрыт]')
    .replace(KEYLIKE_RE, '[значение скрыто]');
}

function dig(obj, ...keys) {
  let v = obj;
  for (const k of keys) {
    if (v === null || v === undefined) return undefined;
    v = v[k];
  }
  return v;
}

function table(headers, rows, maxRows = 40) {
  const out = ['| ' + headers.join(' | ') + ' |', '|' + headers.map(() => '---').join('|') + '|'];
  for (const r of rows.slice(0, maxRows)) out.push('| ' + r.map(esc).join(' | ') + ' |');
  if (rows.length > maxRows) out.push('', '… ещё ' + (rows.length - maxRows) + ' строк(и) — полный список в источнике.');
  return out.join('\n');
}

function kv(rows) {
  return table(['Показатель', 'Значение'], rows);
}

function stamp(date) {
  const p = (n) => String(n).padStart(2, '0');
  return date.getFullYear() + '-' + p(date.getMonth() + 1) + '-' + p(date.getDate()) +
    ' ' + p(date.getHours()) + ':' + p(date.getMinutes());
}

function bakStamp(date) {
  const p = (n) => String(n).padStart(2, '0');
  return '' + date.getFullYear() + p(date.getMonth() + 1) + p(date.getDate()) +
    '-' + p(date.getHours()) + p(date.getMinutes()) + p(date.getSeconds());
}

// ---------------------------------------------------------------- источники

function insideProject(abs) {
  const rel = path.relative(PROJECT_DIR, abs);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function relOf(abs) {
  return path.relative(PROJECT_DIR, abs).split(path.sep).join('/');
}

function sourceInfo(rel) {
  const abs = path.resolve(PROJECT_DIR, rel);
  const denied = DENY_BASENAMES.has(path.basename(abs).toLowerCase()) || DENY_RE.test(abs);
  const ok = !denied && insideProject(abs) && fs.existsSync(abs) && fs.statSync(abs).isFile();
  return { rel, abs, ok, denied };
}

function makeReader() {
  const cache = new Map();
  const missing = new Set();

  function readText(rel) {
    const info = sourceInfo(rel);
    if (!info.ok) {
      if (!cache.has(rel)) missing.add(rel);
      return null;
    }
    if (!cache.has(rel)) {
      try {
        cache.set(rel, fs.readFileSync(info.abs, 'utf8'));
      } catch (e) {
        missing.add(rel);
        cache.set(rel, null);
      }
    }
    return cache.get(rel);
  }

  function yaml(rel) {
    const t = readText(rel);
    if (t === null) return null;
    try {
      return parseYaml(t);
    } catch (e) {
      missing.add(rel);
      return null;
    }
  }

  function json(rel) {
    const t = readText(rel);
    if (t === null) return null;
    try {
      return JSON.parse(t);
    } catch (e) {
      missing.add(rel);
      return null;
    }
  }

  function dataJson(name) {
    return json('dashboard/public/data/' + name);
  }

  return { readText, yaml, json, dataJson, missing };
}

// ---------------------------------------------------------------- заметки

function note(domain, file, title, sources, sections) {
  return {
    domain,
    file,
    title,
    sources: sources.slice(),
    sections: sections.filter((s) => s && s.body && String(s.body).trim() !== ''),
  };
}

// scope='panel' (по умолчанию) — ровно прежний набор заметок панели.
// scope='full' — он же плюс разделы «Скилы» и «База знаний».
function buildNotes(ctx, scope) {
  const notes = [];
  const failed = [];
  const fns = scope === 'full' ? NOTES.concat(FULL_NOTES) : NOTES;
  for (const fn of fns) {
    try {
      const n = fn(ctx);
      if (n) notes.push(n);
    } catch (e) {
      failed.push((fn.name || 'заметка') + ': ' + e.message);
    }
  }
  return { notes, failed };
}

// --- Агенты -----------------------------------------------------------------

function noteAgents(ctx) {
  const y = ctx.yaml('registry/agents.yaml');
  const j = ctx.dataJson('agents.json');
  const agents = (y && y.agents) || (j && j.agents) || [];
  const summary = (j && j.summary) || {};
  const metrics = {};
  for (const a of (j && j.agents) || []) metrics[a.id] = a.metrics || {};

  const rows = agents.map((a) => {
    const m = metrics[a.id] || {};
    return [
      a.id,
      a.name,
      bool(a.enabled),
      a.status || '—',
      a.schedule || '—',
      list(a.groups),
      list(a.projects) === '—' ? 'все' : list(a.projects),
      a.model || '—',
      num(dig(m, 'tasks', 'total')),
      num(dig(m, 'tasks', 'byStatus', 'done') === undefined ? dig(m, 'tasks', 'done') : dig(m, 'tasks', 'byStatus', 'done')),
      num(dig(m, 'tasks', 'byStatus', 'new')),
      num(m.sessions),
      num(dig(m, 'tokens', 'totalTokens')),
      dig(m, 'rub') === undefined ? '—' : rub(dig(m, 'rub')),
    ];
  });

  const roles = agents.map((a) => '**' + esc(a.id) + '** — ' + scrub(clip(a.role, 400)) +
    (a.model_hint ? '\n  - модель: ' + scrub(clip(a.model_hint, 200)) : '') +
    '\n  - вход: ' + esc(list(a.inputs)) + '\n  - выход: ' + esc(list(a.outputs)) +
    (a.runbook ? '\n  - регламент: `' + esc(a.runbook) + '`' : '')).join('\n');

  return note('agents', 'агенты-состояние.md', 'Агенты — состояние реестра', [
    'registry/agents.yaml', 'dashboard/public/data/agents.json',
  ], [
    {
      h: 'Сводка',
      body: kv([
        ['Всего агентов', num(summary.total !== undefined ? summary.total : agents.length)],
        ['Включено', num(summary.enabled)],
        ['Выключено', num(summary.disabled)],
        ['Статус active', num(summary.active)],
        ['Статус planned', num(summary.planned)],
        ['Участников панели (всего / активных)', num(summary.membersTotal) + ' / ' + num(summary.membersActive)],
        ['Реестр обновлён', (y && y.updated) || '—'],
      ]),
    },
    {
      h: 'Таблица агентов',
      body: table(
        ['id', 'имя', 'вкл', 'статус', 'расписание', 'группы', 'проекты', 'модель', 'задач', 'готово', 'новых', 'сессий', 'токенов', '₽'],
        rows, 30),
    },
    { h: 'Роли и связи', body: roles || '_нет данных_' },
  ]);
}

function noteAgentSettings(ctx) {
  const s = ctx.dataJson('agent-settings.json');
  const tabs = ctx.dataJson('agent-tabs.json');
  const byAgent = (s && s.byAgent) || {};
  const rows = Object.keys(byAgent).map((id) => {
    const a = byAgent[id] || {};
    return [id, dig(a, 'model', 'name') || a.model || '—', num(dig(a, 'model', 'limit_tokens')), a.file || a.fileName || '—', a.stub ? 'да' : '—'];
  });
  const tabRows = ((tabs && tabs.tabs) || []).map((t) => [t.id || '—', t.label || '—', t.count === undefined ? '—' : num(t.count)]);

  return note('agents', 'агенты-настройки.md', 'Агенты — настройки и вкладки', [
    'dashboard/public/data/agent-settings.json', 'dashboard/public/data/agent-tabs.json',
  ], [
    { h: 'Сводка', body: kv([
      ['Файлов настроек', num(dig(s, 'counts', 'files'))],
      ['Агентов с настройками', num(dig(s, 'counts', 'agents'))],
      ['Заготовок', num(dig(s, 'counts', 'stub'))],
      ['Каталог', '`' + esc(dig(s, 'dir') || '—') + '`'],
      ['Раздел вкладок', esc(dig(tabs, 'section', 'label'))],
    ]) },
    { h: 'Настройки по агентам', body: table(['агент', 'модель', 'лимит токенов', 'файл', 'заглушка'], rows, 25) },
    { h: 'Вкладки', body: table(['id', 'название', 'элементов'], tabRows, 20) },
  ]);
}

// --- Авторизация ------------------------------------------------------------

function noteAuth(ctx) {
  const st = ctx.dataJson('settings.json');
  const it = ctx.dataJson('integrations.json');
  const routing = (st && st.routing) || {};
  const delivery = (st && st.delivery) || {};
  const plugins = (st && st.plugins) || {};
  const files = (st && st.files) || {};

  const routingRows = ((routing.items) || []).map((i) => [i.label || i.id, String(i.kind || ''), clip(scrub(String(i.value)), 80)]);
  const deliveryRows = ((delivery.items) || []).map((i) => [i.label || i.id, String(i.kind || ''), clip(scrub(String(i.value)), 60)]);
  const profile = (it && it.profile) || {};
  const keyNames = profile.credentialsKeyNames;

  return note('auth', 'доступы-профиль.md', 'Авторизация — профиль, роутинг, доставка', [
    'dashboard/public/data/settings.json', 'dashboard/public/data/integrations.json',
  ], [
    { h: 'Профиль и учётные данные', body: kv([
      ['Каталог профиля', '`' + esc(profile.dir || '—') + '`'],
      ['Профиль найден', bool(profile.exists)],
      ['Пакетов', num(profile.bundlesCount)],
      ['Зависимостей', num(profile.dependenciesCount)],
      ['Файл учётных данных есть', bool(profile.credentialsExists)],
      ['Ключей в файле учётных данных', Array.isArray(keyNames) ? num(keyNames.length) : '—'],
      ['_Имена и значения ключей не экспортируются_', ''],
    ]) },
    { h: 'Роутинг моделей', body: (routing.note ? '> ' + scrub(routing.note) + '\n\n' : '') +
      table(['параметр', 'тип', 'значение'], routingRows, 20) },
    { h: 'Доставка и уведомления', body: (delivery.note ? '> ' + scrub(delivery.note) + '\n\n' : '') +
      'Режим отправки: **' + esc(delivery.sendMode || '—') + '**\n\n' +
      table(['параметр', 'тип', 'значение'], deliveryRows, 20) },
    { h: 'Защищённые плагины', body: kv([
      ['Всего плагинов', num(((plugins.rows) || []).length)],
      ['Защищённых', num(plugins.protectedCount)],
      ['Манифест', '`' + esc(plugins.manifest || '—') + '`'],
    ]) + '\n\n' + (plugins.restartNote ? '> ' + scrub(plugins.restartNote) : '') },
    { h: 'Файлы конфигурации', body: table(['что', 'путь', 'есть'], [
      ['settings', files.settings, bool(files.settingsExists)],
      ['prices', files.prices, bool(files.pricesExists)],
      ['agents', files.agents, undefined],
      ['sources', files.sources, undefined],
    ].map((r) => [r[0], '`' + esc(r[1] || '—') + '`', r[2] === undefined ? '—' : r[2]]), 10) },
  ]);
}

// --- Оплата -----------------------------------------------------------------

function noteClients(ctx) {
  const y = ctx.yaml('registry/clients.yaml');
  const svc = ctx.dataJson('service.json');
  const clients = (y && y.clients) || [];
  const live = {};
  for (const c of (svc && svc.clients) || []) live[c.id] = c;

  const rows = clients.map((c) => {
    const l = live[c.id] || {};
    return [c.id, c.name, c.operator_id || '—', c.status || '—', c.plan || '—', c.since || '—',
      list(c.services), num(l.mrrRub), num(l.debtRub), num(l.subscriptions), num(l.runs)];
  });

  return note('billing', 'клиенты-состояние.md', 'Оплата — клиенты', [
    'registry/clients.yaml', 'dashboard/public/data/service.json',
  ], [
    { h: 'Сводка', body: kv([
      ['Клиентов в реестре', num(clients.length)],
      ['Активных', num(dig(svc, 'counts', 'active'))],
      ['Всего', num(dig(svc, 'counts', 'clients'))],
      ['_Контакты клиентов (телефоны, e-mail) не экспортируются_', ''],
    ]) },
    { h: 'Клиенты', body: table(
      ['id', 'имя', 'оператор', 'статус', 'тариф', 'с', 'услуги', 'MRR ₽', 'долг ₽', 'подписок', 'прогонов'],
      rows, 30) },
  ]);
}

function noteServices(ctx) {
  const y = ctx.yaml('registry/services.yaml');
  const svc = ctx.dataJson('service.json');
  const services = (y && y.services) || [];
  const econ = {};
  for (const s of dig(svc, 'economy', 'byService') || []) econ[s.id] = s;

  const rows = services.map((s) => {
    const e = econ[s.id] || {};
    return [s.id, s.name, s.agent || '—', s.status || '—', bool(s.enabled), rub(s.price_rub), rub(s.cost_rub),
      num(e.subscribers), rub(e.mrrRub), s.schedule || '—'];
  });

  return note('billing', 'услуги-каталог.md', 'Оплата — каталог услуг', [
    'registry/services.yaml', 'dashboard/public/data/service.json',
  ], [
    { h: 'Сводка', body: kv([
      ['Услуг', num(dig(svc, 'counts', 'services'))],
      ['Включено', num(dig(svc, 'counts', 'servicesEnabled'))],
      ['Доход по подпискам', rub(dig(svc, 'economy', 'revenueRub'))],
      ['Себестоимость прогонов (факт)', rub(dig(svc, 'economy', 'actualCostRub'))],
      ['Маржа', rub(dig(svc, 'economy', 'marginRub')) + ' (' + pct(dig(svc, 'economy', 'marginPct')) + ')'],
    ]) },
    { h: 'Услуги', body: table(['id', 'название', 'агент', 'статус', 'вкл', 'цена', 'себестоимость', 'подписчиков', 'MRR', 'расписание'], rows, 20) },
    { h: 'Что входит', body: services.map((s) => '**' + esc(s.id) + '** — ' + scrub(s.what || '') +
      '\n  - артефакты: ' + esc(list(s.artifacts))).join('\n') || '_нет данных_' },
  ]);
}

function noteSubscriptions(ctx) {
  const y = ctx.yaml('registry/subscriptions.yaml');
  const svc = ctx.dataJson('service.json');
  const subs = (y && y.subscriptions) || [];
  const rows = subs.map((s) => [s.id, s.client, s.service, s.plan || '—', s.period || '—', s.start || '—', s.end || '—',
    s.status || '—', rub(s.price_rub), bool(s.invoiced)]);
  const liveRows = ((svc && svc.subscriptions) || []).map((s) => [s.id, s.client, s.service, s.status || '—',
    s.statusLabel || '—', s.end || '—', rub(s.priceRub)]);

  return note('billing', 'подписки-состояние.md', 'Оплата — подписки', [
    'registry/subscriptions.yaml', 'dashboard/public/data/service.json',
  ], [
    { h: 'Сводка', body: kv([
      ['Подписок', num(dig(svc, 'counts', 'subscriptions'))],
      ['Активных', num(dig(svc, 'counts', 'subsActive'))],
      ['Истекают', num(dig(svc, 'counts', 'expiring'))],
      ['Просрочено', num(dig(svc, 'counts', 'overdue'))],
      ['Долг по подпискам', rub(dig(svc, 'economy', 'debtRub'))],
    ]) },
    { h: 'Из реестра', body: table(['id', 'клиент', 'услуга', 'тариф', 'период', 'начало', 'конец', 'статус', 'цена', 'счёт'], rows, 40) },
    { h: 'Из агрегата панели', body: table(['id', 'клиент', 'услуга', 'статус', 'подпись', 'конец', 'цена'], liveRows, 40) },
  ]);
}

function noteInvoices(ctx) {
  const y = ctx.yaml('registry/invoices.yaml');
  const svc = ctx.dataJson('service.json');
  const inv = (y && (y.invoices || y.items)) || [];
  const rows = (Array.isArray(inv) ? inv : []).map((i) => [i.id, i.client, i.period || '—', rub(i.amount_rub || i.amountRub),
    i.status || '—', i.issued || '—', i.file ? '`' + i.file + '`' : '—']);
  const liveRows = ((svc && svc.invoices) || []).map((i) => [i.id, i.clientName || i.client, i.period || '—',
    rub(i.amountRub), i.statusLabel || i.status || '—', i.issued || '—']);

  return note('billing', 'счета-состояние.md', 'Оплата — счета', [
    'registry/invoices.yaml', 'dashboard/public/data/service.json',
  ], [
    { h: 'Сводка', body: kv([
      ['Счетов', num(dig(svc, 'counts', 'invoices'))],
      ['Не оплачено', num(dig(svc, 'counts', 'unpaid'))],
      ['Долг', rub(dig(svc, 'economy', 'debtRub'))],
    ]) },
    { h: 'Реестр счетов', body: table(['id', 'клиент', 'период', 'сумма', 'статус', 'выставлен', 'файл'], rows, 30) },
    { h: 'Из агрегата панели', body: table(['id', 'клиент', 'период', 'сумма', 'статус', 'выставлен'], liveRows, 30) },
  ]);
}

function noteOperators(ctx) {
  const y = ctx.yaml('registry/operators.yaml');
  const ads = ctx.dataJson('ads.json');
  const ops = (y && y.operators) || [];
  const rows = ops.map((o) => [o.id, HIDDEN, num(o.cashback_pct), o.status || '—', o.contract || '—']);
  const accruals = ((ads && ads.operatorAccruals) || []).map((a) => [a.id, a.operator, a.period || '—', rub(a.base_rub), num(a.rate_pct), rub(a.amount_rub), a.status || '—']);
  const payouts = ((ads && ads.operatorPayouts) || []).map((p) => [p.id, p.operator, p.date || '—', rub(p.amount_rub), p.method || '—', p.status || '—']);

  return note('billing', 'операторы-кэшбэк.md', 'Оплата — операторы и их кэшбэк', [
    'registry/operators.yaml', 'dashboard/public/data/ads.json',
  ], [
    { h: 'Как читать', body: '> Имена и контакты операторов — персональные данные: в выгрузку они не попадают, ' +
      'идентификация идёт по `id`. Ставки и суммы экспортируются полностью.' },
    { h: 'Сводка', body: kv([
      ['Комиссия платформы', num(dig(ads, 'platform', 'commissionPct')) + '%'],
      ['Оборот', rub(dig(ads, 'platform', 'turnoverRub'))],
      ['Комиссия платформы, ₽', rub(dig(ads, 'platform', 'commissionRub'))],
      ['Кэшбэк операторам начислен', rub(dig(ads, 'platform', 'operatorsCashbackRub'))],
      ['Кэшбэк операторам выплачен', rub(dig(ads, 'platform', 'operatorsPaidRub'))],
      ['ИП оформлен', bool(dig(ads, 'platform', 'ipoRegistered'))],
    ]) + '\n\n' + (dig(ads, 'platform', 'legalNote') ? '> ' + scrub(dig(ads, 'platform', 'legalNote')) : '') },
    { h: 'Операторы', body: table(['id', 'имя', 'кэшбэк %', 'статус', 'договор'], rows, 30) },
    { h: 'Начисления операторам', body: table(['id', 'оператор', 'период', 'база', 'ставка %', 'сумма', 'статус'], accruals, 30) },
    { h: 'Выплаты операторам', body: table(['id', 'оператор', 'дата', 'сумма', 'способ', 'статус'], payouts, 30) },
  ]);
}

// --- Расходы ----------------------------------------------------------------

function noteBudgets(ctx) {
  const y = ctx.yaml('registry/ad-budgets.yaml');
  const ads = ctx.dataJson('ads.json');
  const t = (ads && ads.totals) || {};
  const topups = ((y && y.topups) || []).map((r) => [r.id, r.client, r.channel, r.date || '—', rub(r.amount_rub), scrub(r.by || '—')]);
  const spends = ((y && y.spends) || []).map((r) => [r.id, r.client, r.channel, r.date || '—', r.period || '—', rub(r.amount_rub)]);
  const returns = ((y && y.returns) || []).map((r) => [r.id, r.client, r.channel, r.period || '—', rub(r.amount_rub), scrub(r.note || '—')]);
  const modes = ((y && y.modes) || []).map((m) => [m.client, m.channel || 'все каналы', m.mode || '—']);

  return note('transactions', 'бюджеты-движение.md', 'Расходы — бюджеты, пополнения, возвраты', [
    'registry/ad-budgets.yaml', 'dashboard/public/data/ads.json',
  ], [
    { h: 'Сводка', body: kv([
      ['Пополнено', rub(t.topupRub)],
      ['Израсходовано', rub(t.spendRub)],
      ['Остаток', rub(t.balanceRub)],
      ['Кэшбэк начислен', rub(t.cashbackRub)],
      ['Кэшбэк выплачен', rub(t.paidRub)],
      ['Кэшбэк к выплате', rub(t.dueRub)],
      ['Средняя ставка', pct((t.avgRatePct || 0) / 100)],
      ['Клиентов / каналов', num(t.clients) + ' / ' + num(t.channels)],
      ['Низкий баланс', num(t.lowBalance)],
      ['Режим «через сервис»', num(t.throughService)],
    ]) },
    { h: 'Пополнения', body: table(['id', 'клиент', 'канал', 'дата', 'сумма', 'кто'], topups, 40) },
    { h: 'Расходы', body: table(['id', 'клиент', 'канал', 'дата', 'период', 'сумма'], spends, 60) },
    { h: 'Возвраты площадок', body: table(['id', 'клиент', 'канал', 'период', 'сумма', 'комментарий'], returns, 40) },
    { h: 'Режим работы с клиентом', body: table(['клиент', 'канал', 'режим'], modes, 30) },
  ]);
}

function noteChannels(ctx) {
  const y = ctx.yaml('registry/ad-channels.yaml');
  const ads = ctx.dataJson('ads.json');
  const ch = (y && y.channels) || [];
  const rows = ch.map((c) => [c.id, c.name, c.status || '—', c.source || '—', num(c.rate_pct), bool(c.agreement), num(c.return_pct), scrub(c.note || '—')]);
  const live = ((ads && ads.channelRows) || []).map((c) => [c.id || c.channel, c.name || '', c.status || '—',
    c.spendRub === undefined ? '—' : rub(c.spendRub), c.topupRub === undefined ? '—' : rub(c.topupRub),
    c.balanceRub === undefined ? '—' : rub(c.balanceRub), c.ratePct === undefined ? '—' : num(c.ratePct)]);

  return note('transactions', 'каналы-ставки.md', 'Расходы — каналы и ставки', [
    'registry/ad-channels.yaml', 'dashboard/public/data/ads.json',
  ], [
    { h: 'Настройки', body: kv([
      ['Ставка по умолчанию', num(dig(y, 'settings', 'default_rate_pct')) + '%'],
      ['Порог низкого баланса', rub(dig(y, 'settings', 'low_balance_threshold_rub'))],
      ['Округление', esc(dig(y, 'settings', 'rounding') || '—')],
      ['UPT', scrub(clip(dig(y, 'settings', 'utp') || '—', 400))],
    ]) },
    { h: 'Каналы реестра', body: table(['id', 'название', 'статус', 'источник', 'ставка %', 'договор', 'возврат %', 'комментарий'], rows, 30) },
    { h: 'Каналы из агрегата', body: table(['id', 'название', 'статус', 'расход', 'пополнение', 'остаток', 'ставка %'], live, 30) },
  ]);
}

function noteCashback(ctx) {
  const y = ctx.yaml('registry/cashback.yaml');
  const ads = ctx.dataJson('ads.json');
  const accruals = ((y && y.accruals) || []).map((a) => [a.id, a.client, a.channel, a.period || '—', rub(a.base_rub), num(a.rate_pct), rub(a.amount_rub), a.status || '—']);
  const payouts = ((y && y.payouts) || []).map((p) => [p.id, p.client, p.date || '—', rub(p.amount_rub), scrub(p.method || '—'), p.status || '—', p.doc || '—']);
  const aSum = ((y && y.accruals) || []).reduce((s, a) => s + (Number(a.amount_rub) || 0), 0);
  const pSum = ((y && y.payouts) || []).reduce((s, p) => s + (Number(p.amount_rub) || 0), 0);

  return note('transactions', 'кэшбэк-выплаты.md', 'Расходы — кэшбэк клиентам', [
    'registry/cashback.yaml', 'dashboard/public/data/ads.json',
  ], [
    { h: 'Сводка', body: kv([
      ['Начислений', num(((y && y.accruals) || []).length)],
      ['Начислено, ₽', rub(aSum)],
      ['Выплат', num(((y && y.payouts) || []).length)],
      ['Выплачено, ₽', rub(pSum)],
      ['Всего начислено (агрегат)', rub(dig(ads, 'totals', 'cashbackRub'))],
      ['К выплате (агрегат)', rub(dig(ads, 'totals', 'dueRub'))],
    ]) },
    { h: 'Начисления', body: table(['id', 'клиент', 'канал', 'период', 'база', 'ставка %', 'сумма', 'статус'], accruals, 40) },
    { h: 'Выплаты', body: table(['id', 'клиент', 'дата', 'сумма', 'способ', 'статус', 'документ'], payouts, 40) },
  ]);
}

// --- Панель -----------------------------------------------------------------

function noteDashboard(ctx) {
  const m = ctx.dataJson('meta.json');
  const t = (m && m.totals) || {};
  const sources = (m && m.sources) || [];
  const srcRows = (Array.isArray(sources) ? sources : []).map((s) => [s.id || s.name || s.file, s.ok === undefined ? '—' : bool(s.ok), s.count === undefined ? '—' : num(s.count)]);

  return note('dashboard', 'панель-обзор.md', 'Панель — обзор состояния', [
    'dashboard/public/data/meta.json',
  ], [
    { h: 'Сборка данных', body: kv([
      ['Собрано', m && m.generatedAt ? String(m.generatedAt) : '—'],
      ['Длительность сборки, мс', num(m && m.durationMs)],
      ['День', (m && m.today) || '—'],
      ['Рабочая папка', '`' + esc((m && m.workspaceRoot) || '—') + '`'],
      ['Проект', '`' + esc((m && m.projectDir) || '—') + '`'],
      ['Файлов-источников', num(srcRows.length)],
    ]) },
    { h: 'Итоги', body: table(['показатель', 'значение'], Object.keys(t).map((k) => [k, typeof t[k] === 'number' ? num(t[k]) : esc(t[k])]), 60) },
    { h: 'Источники сборки', body: table(['источник', 'ок', 'записей'], srcRows, 40) },
    { h: 'Предупреждения сборки', body: ((m && m.warnings) || []).length
      ? ((m.warnings) || []).map((w) => '- ' + scrub(typeof w === 'string' ? w : JSON.stringify(w))).join('\n')
      : '_нет_' },
  ]);
}

function noteDashboardNav(ctx) {
  const nav = ctx.dataJson('nav.json');
  const tabs = ctx.dataJson('agent-tabs.json');
  const st = ctx.dataJson('settings.json');
  const groups = ((nav && nav.groups) || []).map((g) => [g.id || g.label, g.label || '—', list((g.items || []).map((i) => i.id || i.label)), num((g.items || []).length)]);
  const rows = ((st && st.agents && st.agents.rows) || []).map((r) => [r.id, r.name, bool(r.enabled), r.model || '—', list(r.groups)]);

  return note('dashboard', 'панель-разделы.md', 'Панель — навигация и разделы', [
    'dashboard/public/data/nav.json', 'dashboard/public/data/agent-tabs.json', 'dashboard/public/data/settings.json',
  ], [
    { h: 'Меню', body: kv([
      ['Файл меню', '`' + esc((nav && nav.file) || '—') + '`'],
      ['Существует', bool(nav && nav.exists)],
      ['Групп', num(nav && nav.total)],
    ]) },
    { h: 'Группы меню', body: table(['id', 'название', 'элементы', 'шт'], groups, 30) },
    { h: 'Вкладки агентов', body: table(['id', 'название', 'элементов'], ((tabs && tabs.tabs) || []).map((t) => [t.id, t.label, num(t.count)]), 20) },
    { h: 'Строки раздела «Агенты»', body: table(['id', 'имя', 'вкл', 'модель', 'группы'], rows, 30) },
  ]);
}

function noteDashboardAlerts(ctx) {
  const a = ctx.dataJson('alerts.json');
  const rows = ((a && a.alerts) || []).map((x) => [x.level || '—', x.title || x.id, scrub(clip(x.what || x.meaning || '', 220))]);

  return note('dashboard', 'панель-предупреждения.md', 'Панель — предупреждения', [
    'dashboard/public/data/alerts.json',
  ], [
    { h: 'Счётчики', body: kv([
      ['Всего', num(dig(a, 'counts', 'total'))],
      ['Критичных', num(dig(a, 'counts', 'critical'))],
      ['Предупреждений', num(dig(a, 'counts', 'warning'))],
      ['Информационных', num(dig(a, 'counts', 'info'))],
      ['Порог устаревания, дней', num(dig(a, 'thresholds', 'staleDays'))],
      ['Порог всплеска', num(dig(a, 'thresholds', 'spikeFactor'))],
      ['Последний снимок', esc((a && a.lastSnapshot) || '—')],
    ]) },
    { h: 'Список', body: rows.length ? table(['уровень', 'заголовок', 'что случилось'], rows, 40) : '_нет_' },
  ]);
}

// --- Отчёты -----------------------------------------------------------------

function noteAnalytics(ctx) {
  const a = ctx.dataJson('analytics.json');
  const f = (a && a.funnel) || {};
  const weeks = ((a && a.weeks) || []).map((w) => [w.week, num(w.lots), num(w.tokens), rub(w.rub), num(w.tasksCreated), num(w.tasksDone)]);
  const agents = ((a && a.agents) || []).map((x) => [x.id, x.name, bool(x.enabled), x.status || '—',
    num(dig(x, 'tasks', 'total')), num(dig(x, 'tasks', 'done')), num(dig(x, 'tokens', 'totalTokens')), x.rub === undefined ? '—' : rub(x.rub)]);
  const sources = ((a && a.sources) || []).map((s) => [s.id || s.name, bool(s.enabled), num(s.lots)]);

  return note('reporting', 'аналитика-сводка.md', 'Отчёты — аналитика, воронка', [
    'dashboard/public/data/analytics.json',
  ], [
    { h: 'Воронка', body: kv([
      ['Агентов (включено)', num(f.agents) + ' (' + num(f.agentsEnabled) + ')'],
      ['Задач всего', num(f.tasks)],
      ['В работе', num(f.tasksInProgress)],
      ['Готово', num(f.tasksDone)],
      ['Без исполнителя', num(f.tasksUnassigned)],
      ['Источников (включено)', num(f.sources) + ' (' + num(f.sourcesEnabled) + ')'],
      ['Лотов собрано', num(f.lots)],
      ['Токенов', num(f.tokens)],
      ['Расход, ₽', rub(f.rub) + (f.rubComplete === false ? ' (неполный: часть моделей без цены)' : '')],
    ]) },
    { h: 'Недели', body: table(['неделя', 'лотов', 'токенов', 'расход ₽', 'задач создано', 'задач готово'], weeks, 30) },
    { h: 'По агентам', body: table(['id', 'имя', 'вкл', 'статус', 'задач', 'готово', 'токенов', 'расход ₽'], agents, 30) },
    { h: 'По источникам', body: table(['источник', 'вкл', 'лотов'], sources, 30) },
    { h: 'Замечания', body: ((a && a.notes) || []).map((n) => '- ' + scrub(typeof n === 'string' ? n : JSON.stringify(n))).join('\n') || '_нет_' },
  ]);
}

function noteAnalytics2(ctx) {
  const a = ctx.dataJson('analytics2.json');
  const metrics = (a && a.metrics) || {};
  const mRows = Object.keys(metrics).map((k) => {
    const v = metrics[k] || {};
    const raw = v.value;
    const unit = v.unit || '';
    return [v.label || k, unit === '₽' ? rub(raw) : unit === '%' ? pct(raw) : num(raw), unit, scrub(clip(v.hint || '', 160))];
  });
  const counts = (a && a.counts) || {};
  const tops = (a && a.tops) || {};

  return note('reporting', 'аналитика-детали.md', 'Отчёты — аналитика, метрики и срезы', [
    'dashboard/public/data/analytics2.json',
  ], [
    { h: 'Метрики', body: table(['показатель', 'значение', 'ед.', 'пояснение'], mRows, 30) },
    { h: 'Счётчики', body: table(['показатель', 'значение'], Object.keys(counts).map((k) => [k, typeof counts[k] === 'number' ? num(counts[k]) : esc(counts[k])]), 40) },
    { h: 'Топы', body: Object.keys(tops).length
      ? Object.keys(tops).map((k) => '**' + esc(k) + '**: ' + scrub(clip(JSON.stringify(tops[k]), 600))).join('\n')
      : '_нет_' },
    { h: 'Предупреждения', body: ((a && a.warnings) || []).map((w) => '- ' + scrub(typeof w === 'string' ? w : JSON.stringify(w))).join('\n') || '_нет_' },
  ]);
}

function noteUsage(ctx) {
  const u = ctx.dataJson('usage.json');
  const t = (u && u.totals) || {};
  const byModel = ((u && u.byModel) || []).map((m) => [m.model || m.key, m.provider || '—', num(dig(m, 'tokens', 'inputTokens')), num(dig(m, 'tokens', 'outputTokens')),
    num(dig(m, 'tokens', 'cacheReadTokens')), num(dig(m, 'tokens', 'totalTokens')), m.usd === undefined ? '—' : num(m.usd), m.rub === undefined ? '—' : rub(m.rub), bool(m.priceKnown)]);
  const byAgent = ((u && u.byAgent) || []).map((a) => [a.name || a.key || a.agent || a.id, num(dig(a, 'tokens', 'totalTokens')),
    num(a.sessions), a.usd === undefined ? '—' : num(a.usd), a.rub === undefined ? '—' : rub(a.rub)]);
  const byDay = ((u && u.byDay) || []).map((d) => [d.day || d.date || d.key, num(dig(d, 'tokens', 'totalTokens')), d.rub === undefined ? '—' : rub(d.rub)]);

  return note('reporting', 'использование-токены.md', 'Отчёты — использование моделей и токенов', [
    'dashboard/public/data/usage.json',
  ], [
    { h: 'Итоги', body: kv([
      ['Валюта', esc(u && u.currency)],
      ['Входных токенов', num(dig(t, 'tokens', 'inputTokens'))],
      ['Выходных токенов', num(dig(t, 'tokens', 'outputTokens'))],
      ['Чтение кэша', num(dig(t, 'tokens', 'cacheReadTokens'))],
      ['Всего токенов', num(dig(t, 'tokens', 'totalTokens'))],
      ['Стоимость, $', num(t.usd)],
      ['Стоимость, ₽', rub(t.rub) + (t.rubComplete === false ? ' (неполная)' : '')],
      ['Моделей с ценой', num(u && u.pricedModelCount)],
    ]) },
    { h: 'По моделям', body: table(['модель', 'провайдер', 'вход', 'выход', 'кэш', 'всего', '$', '₽', 'цена известна'], byModel, 15) },
    { h: 'По исполнителям', body: table(['исполнитель', 'токенов', 'сессий', '$', '₽'], byAgent, 15) },
    { h: 'По дням', body: table(['день', 'токенов', '₽'], byDay, 20) },
    { h: 'Пик и кэш', body: kv([
      ['Пиковых токенов', num(dig(u, 'peak', 'peakTokens', 'totalTokens'))],
      ['День пика', esc(dig(u, 'peak', 'day') || '—')],
      ['Кэш: чтение', num(dig(u, 'cache', 'cacheReadTokens'))],
      ['Модели без цены', list(u && u.unknownPriceModels)],
    ]) },
  ]);
}

function noteTasks(ctx) {
  const j = ctx.dataJson('tasks.json');
  const counts = (j && j.counts) || {};
  const owners = ((j && j.owners) || []).map((o) => [o.name, num(o.count)]);
  const registryTasks = [];
  const tasksAbs = path.join(REGISTRY_DIR, 'tasks');
  if (fs.existsSync(tasksAbs)) {
    for (const f of fs.readdirSync(tasksAbs).sort()) {
      if (!/\.ya?ml$/i.test(f)) continue;
      const data = ctx.yaml('registry/tasks/' + f);
      if (Array.isArray(data)) for (const t of data) registryTasks.push(Object.assign({ __file: f }, t));
    }
  }
  const regRows = registryTasks.slice(0, 25).map((t) => [t.id, clip(scrub(t.subject), 90), t.group || '—', t.category || '—', t.owner || '—', t.status || '—', t.due || '—', t.__file]);

  return note('reporting', 'задачи-состояние.md', 'Отчёты — задачи', [
    'registry/tasks/', 'dashboard/public/data/tasks.json',
  ], [
    { h: 'Сводка', body: kv([
      ['Всего задач', num(counts.total)],
      ['new', num(dig(counts, 'byStatus', 'new'))],
      ['in_progress', num(dig(counts, 'byStatus', 'in_progress'))],
      ['done', num(dig(counts, 'byStatus', 'done'))],
      ['Просрочено', num(counts.overdue)],
      ['Без исполнителя', num(counts.unassigned)],
      ['Из реестра', num(dig(counts, 'byOrigin', 'registry'))],
      ['Из логов DSH', num(dig(counts, 'byOrigin', 'dsh'))],
    ]) },
    { h: 'Исполнители', body: table(['исполнитель', 'задач'], owners, 25) },
    { h: 'Задачи из реестра', body: regRows.length
      ? table(['id', 'тема', 'группа', 'категория', 'исполнитель', 'статус', 'срок', 'файл'], regRows, 30)
      : '_нет файлов registry/tasks/*.yaml_' },
  ]);
}

function noteProjects(ctx) {
  const j = ctx.dataJson('projects.json');
  const y = ctx.yaml('registry/projects.yaml');
  const rows = ((j && j.projects) || []).map((p) => [p.id, p.name, p.developer || '—', p.klass || p.class || '—', p.status || '—',
    list(p.agents), num(dig(p, 'metrics', 'tasks', 'total')), num(dig(p, 'metrics', 'tokens', 'totalTokens'))]);
  const sessionRows = ((j && j.sessionProjects) || []).slice(0, 15).map((p) => [p.key || p.id || p.projectKey, num(p.sessions), num(dig(p, 'tokens', 'totalTokens'))]);

  return note('reporting', 'проекты-отчёты.md', 'Отчёты — проекты', [
    'registry/projects.yaml', 'dashboard/public/data/projects.json',
  ], [
    { h: 'Реестр', body: kv([
      ['Проектов', num(((y && y.projects) || []).length)],
      ['Обновлён', esc((y && y.updated) || '—')],
    ]) },
    { h: 'Проекты', body: table(['id', 'название', 'застройщик', 'класс', 'статус', 'агенты', 'задач', 'токенов'], rows, 25) },
    { h: 'Проекты сессий', body: table(['проект', 'сессий', 'токенов'], sessionRows, 20) },
  ]);
}

function noteCompetitorReport(ctx) {
  const c = ctx.dataJson('competitor-report.json');
  const counts = (c && c.counts) || {};
  const clients = Array.isArray(c && c.clients) ? c.clients : [];
  const cat = Array.isArray(c && c.catalogue) ? c.catalogue : [];
  const rows = clients.slice(0, 20).map((x) => [x.id || x.name, x.profile || x.profileFound ? bool(x.profileFound) : '—', num(x.snapshots)]);

  return note('reporting', 'отчёт-конкуренты.md', 'Отчёты — мониторинг конкурентов', [
    'dashboard/public/data/competitor-report.json',
  ], [
    { h: 'Сводка', body: kv([
      ['Каталог', '`' + esc((c && c.dir) || '—') + '`'],
      ['Найден', bool(c && c.exists)],
      ['Клиентов', num(clients.length)],
      ['Профилей найдено', num(c && c.profilesFound)],
      ['Позиций каталога', num(cat.length)],
      ['Причина пустоты', esc((c && c.emptyReason) || '—')],
      ['Счётчики', scrub(clip(JSON.stringify(counts), 500))],
    ]) },
    { h: 'Клиенты', body: rows.length ? table(['клиент', 'профиль', 'снимков'], rows, 25) : '_нет данных_' },
  ]);
}

// --- Инфраструктура ---------------------------------------------------------

function noteService(ctx) {
  const s = ctx.dataJson('service.json');
  const runs = ((s && s.runs) || []).slice(0, 20).map((r) => [r.id, r.service || r.serviceId || '—', r.client || '—', r.status || '—', r.date || r.startedAt || '—', r.costRub === undefined ? '—' : rub(r.costRub)]);
  const results = ((s && s.results) || []).slice(0, 20).map((r) => [r.id, r.client || '—', r.service || '—', r.status || '—', r.sent === undefined ? '—' : bool(r.sent)]);

  return note('infra', 'сервис-прогоны.md', 'Инфраструктура — прогоны сервиса', [
    'dashboard/public/data/service.json',
  ], [
    { h: 'Экономика', body: kv([
      ['Доход', rub(dig(s, 'economy', 'revenueRub'))],
      ['Плановая себестоимость', rub(dig(s, 'economy', 'plannedCostRub'))],
      ['Фактическая себестоимость', rub(dig(s, 'economy', 'actualCostRub'))],
      ['Маржа', rub(dig(s, 'economy', 'marginRub')) + ' (' + pct(dig(s, 'economy', 'marginPct')) + ')'],
      ['Долг клиентов', rub(dig(s, 'economy', 'debtRub'))],
      ['Клиентов', num(dig(s, 'economy', 'clientsActive')) + ' активных из ' + num(dig(s, 'economy', 'clientsTotal'))],
    ]) },
    { h: 'Счётчики', body: table(['показатель', 'значение'], Object.keys((s && s.counts) || {}).map((k) => [k, num(s.counts[k])]), 40) },
    { h: 'Прогоны', body: runs.length ? table(['id', 'услуга', 'клиент', 'статус', 'дата', 'себестоимость'], runs, 25) : '_нет данных_' },
    { h: 'Результаты', body: results.length ? table(['id', 'клиент', 'услуга', 'статус', 'отправлен'], results, 25) : '_нет данных_' },
    { h: 'Файлы', body: table(['что', 'файл'], Object.keys((s && s.files) || {}).map((k) => [k, '`' + esc(s.files[k]) + '`']), 20) },
    { h: 'Предупреждения', body: ((s && s.warnings) || []).map((w) => '- ' + scrub(typeof w === 'string' ? w : JSON.stringify(w))).join('\n') || '_нет_' },
  ]);
}

function noteSessions(ctx) {
  const s = ctx.dataJson('sessions.json');
  const sessions = (s && s.sessions) || [];
  const byAgent = {};
  const byProject = {};
  let minTs = null;
  let maxTs = null;
  for (const x of sessions) {
    const a = x.agentName || '—';
    byAgent[a] = (byAgent[a] || 0) + 1;
    const p = x.projectLabel || x.projectKey || '—';
    byProject[p] = (byProject[p] || 0) + 1;
    for (const ts of [x.createdAt, x.lastAt, x.firstTime]) {
      if (typeof ts !== 'number') continue;
      if (minTs === null || ts < minTs) minTs = ts;
      if (maxTs === null || ts > maxTs) maxTs = ts;
    }
  }
  const fmtTs = (ts) => (typeof ts === 'number' ? new Date(ts).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '—');
  const agentRows = Object.keys(byAgent).sort((a, b) => byAgent[b] - byAgent[a]).map((k) => [k, num(byAgent[k])]);
  const projRows = Object.keys(byProject).sort((a, b) => byProject[b] - byProject[a]).map((k) => [k, num(byProject[k])]);

  return note('infra', 'сессии-сводка.md', 'Инфраструктура — сводка сессий', [
    'dashboard/public/data/sessions.json',
  ], [
    { h: 'Как читать', body: '> Заголовки сессий, рабочие каталоги и тексты диалогов не экспортируются: ' +
      'выгрузка содержит только агрегаты по количеству.' },
    { h: 'Сводка', body: kv([
      ['Сессий', num(sessions.length || (s && s.count))],
      ['Первая', fmtTs(minTs)],
      ['Последняя', fmtTs(maxTs)],
      ['Исполнителей', num(agentRows.length)],
      ['Проектов', num(projRows.length)],
    ]) },
    { h: 'По исполнителям', body: table(['исполнитель', 'сессий'], agentRows, 20) },
    { h: 'По проектам', body: table(['проект', 'сессий'], projRows, 20) },
  ]);
}

// --- Коннекторы -------------------------------------------------------------

function noteIntegrations(ctx) {
  const it = ctx.dataJson('integrations.json');
  const rows = ((it && it.integrations) || []).map((i) => [i.id, i.name, i.kind || '—', i.statusHint || '—', bool(i.needsKey),
    bool(i.keyPresent), i.keyVia || '—', i.installed === undefined ? '—' : bool(i.installed), scrub(clip(i.purpose || '', 110))]);

  return note('connectors', 'интеграции-каталог.md', 'Коннекторы — каталог интеграций', [
    'dashboard/public/data/integrations.json', 'registry/integrations-catalog.yaml',
  ], [
    { h: 'Сводка', body: kv([
      ['Всего', num(dig(it, 'summary', 'total'))],
      ['Подключено', num(dig(it, 'summary', 'connected'))],
      ['Требуют внимания', num(dig(it, 'summary', 'attention'))],
      ['Доступно', num(dig(it, 'summary', 'available'))],
      ['Установлено и выключено', num(dig(it, 'summary', 'installedDisabled'))],
      ['Нет ключей у', list(dig(it, 'summary', 'keysMissing'))],
      ['Каталог', '`' + esc((it && it.catalogFile) || '—') + '`'],
      ['_Значения ключей и токенов не экспортируются_', ''],
    ]) },
    { h: 'Интеграции', body: table(['id', 'название', 'тип', 'статус', 'нужен ключ', 'ключ есть', 'откуда', 'установлено', 'назначение'], rows, 30) },
    { h: 'Предупреждения', body: ((it && it.warnings) || []).map((w) => '- ' + scrub(typeof w === 'string' ? w : JSON.stringify(w))).join('\n') || '_нет_' },
  ]);
}

function noteSources(ctx) {
  const y = ctx.yaml('registry/sources.yaml');
  const j = ctx.dataJson('sources.json');
  const live = {};
  for (const s of (j && j.sources) || []) live[s.id] = s;
  const sourceList = Array.isArray(y && y.sources) ? y.sources : (Array.isArray(y) ? y : []);
  const rows = sourceList.map((s) => {
    const l = live[s.id] || {};
    return [s.id, s.name || l.name, bool(s.enabled), s.kind || l.kind || '—', s.auth || l.auth || '—',
      l.status || s.status || '—', num(l.lots), num(l.snapshots)];
  });
  const weeks = ((j && j.byWeek) || []).map((w) => [w.week || w.id, num(w.lots), num(w.snapshots)]);

  return note('connectors', 'источники-мониторинг.md', 'Коннекторы — источники мониторинга', [
    'registry/sources.yaml', 'dashboard/public/data/sources.json',
  ], [
    { h: 'Сводка', body: kv([
      ['Всего источников', num(dig(j, 'summary', 'total'))],
      ['Включено', num(dig(j, 'summary', 'enabled'))],
      ['Выключено', num(dig(j, 'summary', 'disabled'))],
      ['С данными', num(dig(j, 'summary', 'withData'))],
      ['Без данных', num(dig(j, 'summary', 'withoutData'))],
      ['Лотов', num(dig(j, 'summary', 'totalLots'))],
      ['Снимков', num(dig(j, 'summary', 'snapshots'))],
      ['Лидер', esc(dig(j, 'summary', 'topSource', 'name')) + ' (' + num(dig(j, 'summary', 'topSource', 'lots')) + ' лотов)'],
    ]) },
    { h: 'Источники', body: table(['id', 'название', 'вкл', 'тип', 'авторизация', 'статус', 'лотов', 'снимков'], rows, 30) },
    { h: 'По неделям', body: weeks.length ? table(['неделя', 'лотов', 'снимков'], weeks, 20) : '_нет данных_' },
    { h: 'Предупреждения', body: ((j && j.warnings) || []).map((w) => '- ' + scrub(typeof w === 'string' ? w : JSON.stringify(w))).join('\n') || '_нет_' },
  ]);
}

// --- Скилы и база знаний (только scope=full) --------------------------------
//
// Эти заметки пишутся в те же домены-папки 20-Домены/<Домен>/выгрузка-панели/
// (зона записи не расширяется: resolveTarget и domains_dir — единственный корень).
// Источник, которого нет, даёт «данных нет» и строку в skipped, а не ноль.

// Простой разбор frontmatter «--- ... ---»: строки «ключ: значение», списки в [..].
function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text || ''));
  if (!m) return {};
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const mm = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!mm) continue;
    let v = mm[2].trim();
    if (v.startsWith('[') && v.endsWith(']')) {
      v = v.slice(1, -1).split(',').map((x) => x.trim()).filter(Boolean);
    }
    out[mm[1]] = v;
  }
  return out;
}

// Заголовки разделов (## и ###) — для оглавления заметки.
function headingsOf(text) {
  return (String(text || '').match(/^#{2,3} .+$/gm) || []).map((h) => h.replace(/\s+$/, ''));
}

// Список файлов каталога проекта: только имена и размеры, содержимое не читается.
function listDir(rel) {
  const abs = path.resolve(PROJECT_DIR, rel);
  if (!insideProject(abs) || !fs.existsSync(abs)) return null;
  let stat = null;
  try { stat = fs.statSync(abs); } catch (e) { return null; }
  if (!stat.isDirectory()) return null;
  try {
    return fs.readdirSync(abs, { withFileTypes: true }).map((e) => {
      let size = null;
      if (e.isFile()) {
        try { size = fs.statSync(path.join(abs, e.name)).size; } catch (err) { size = null; }
      }
      return { name: e.name, kind: e.isDirectory() ? 'каталог' : 'файл', size };
    }).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  } catch (e) {
    return null;
  }
}

function noteSkills(ctx) {
  const reg = ctx.json('skills/registry/skills_registry.json');
  const readme = ctx.readText('skills/README.md');
  const skills = Array.isArray(reg && reg.skills) ? reg.skills : [];
  const hasReg = reg !== null && Array.isArray(reg.skills);
  const groups = Object.keys((reg && reg.groups) || {});
  const withKeys = skills.filter((s) => Array.isArray(s.required_env) && s.required_env.length > 0);

  const rows = skills.map((s) => [s.name, s.title, s.group || '—', s.kind || '—', bool(s.enabled),
    list(s.required_env), clip(scrub(String(s.free_tier || '—')), 70)]);
  const keyRows = skills.map((s) => [s.name, list(s.required_env), list(s.optional_env)]);
  const limitRows = skills.map((s) => [s.name, clip(scrub(String(s.limits || 'данных нет')), 220)]);
  const verifyRows = skills.map((s) => [s.name, clip(scrub(String(s.verified || 'данных нет')), 180)]);

  return note('skills', 'скилы-реестр.md', 'Скилы — реестр и рантайм', [
    'skills/README.md', 'skills/registry/skills_registry.json',
  ], [
    { h: 'Сводка', body: kv([
      ['Версия реестра', hasReg ? num(reg.version) : 'данных нет'],
      ['Реестр обновлён', hasReg ? String(reg.updated || '—') : 'данных нет'],
      ['Скиллов', hasReg ? num(skills.length) : 'данных нет'],
      ['Включено', hasReg ? num(skills.filter((s) => s.enabled === true).length) : 'данных нет'],
      ['Выключено', hasReg ? num(skills.filter((s) => s.enabled === false).length) : 'данных нет'],
      ['Групп', hasReg ? num(groups.length) : 'данных нет'],
      ['С обязательными ключами', hasReg ? num(withKeys.length) : 'данных нет'],
      ['README', readme === null ? 'данных нет: файл не найден' : num(readme.split(/\r?\n/).length) + ' строк'],
    ]) },
    { h: 'Группы', body: groups.length ? table(['группа', 'назначение'], groups.map((g) => [g, reg.groups[g]]), 20) : '_данных нет_' },
    { h: 'Реестр скиллов', body: skills.length ? table(['скилл', 'название', 'группа', 'тип', 'вкл', 'обязательные ключи', 'бесплатный тариф'], rows, 30) : '_данных нет_' },
    { h: 'Ключи окружения', body: keyRows.length ? table(['скилл', 'обязательные', 'необязательные'], keyRows, 30) : '_данных нет_' },
    { h: 'Ограничения', body: limitRows.length ? table(['скилл', 'чего скилл не даёт / лимиты'], limitRows, 30) : '_данных нет_' },
    { h: 'Проверено фактически', body: verifyRows.length ? table(['скилл', 'проверка'], verifyRows, 30) : '_данных нет_' },
    { h: 'Рантайм и правила', body: readme === null ? '_данных нет: skills/README.md не найден_' :
      '> Выжимка из `skills/README.md`; полный текст — в источнике.' + '\n\n' +
      table(['правило', 'как работает'], [
        ['Контракт скилла', '`fetch(query, **kwargs) -> list[dict]`; наружу исключение не выходит'],
        ['Нет ключа окружения', 'статус `skipped_no_key`, предупреждение в лог, пустой список'],
        ['Сервис не развёрнут', 'статус `not_deployed` и пояснение, что сделать'],
        ['Ошибка сети/разбора', 'статус `error`, предупреждение в лог, пустой список'],
        ['Таймаут запроса', 'не больше 10 с (`clamp_timeout`); операторские режимы — до 600 с'],
        ['Журнал прогонов', '`skills/logs/skill-runs.jsonl`: скилл, запрос, статус, время, число записей'],
        ['Защита от ложного успеха', 'запись без содержательных полей отбрасывается: статус `empty`, а не `ok`'],
        ['Честность данных', 'отсутствующее значение — `None`, а не `0` и не `""`'],
        ['Зависимости', 'только стандартная библиотека Python 3.12'],
        ['Добавление скилла', 'модуль + запись в реестре + тесты + согласование с пользователем'],
      ]) },
  ]);
}

const SKILL_CARDS = [
  'skills/competitor-watch/SKILL.md',
  'skills/direct-keywords/SKILL.md',
  'skills/newbuild-ru-glossary/SKILL.md',
];

function noteSkillCards(ctx) {
  const rows = [];
  const details = [];
  let found = 0;

  for (const rel of SKILL_CARDS) {
    const t = ctx.readText(rel);
    if (t === null) {
      rows.push([rel, 'данных нет: файл не найден', '—', '—']);
      continue;
    }
    found += 1;
    const fm = parseFrontmatter(t);
    const heads = headingsOf(t);
    rows.push([fm.name || path.basename(path.dirname(rel)), clip(scrub(String(fm.description || '—')), 130),
      num(heads.length), num(t.split(/\r?\n/).length)]);
    details.push('**' + esc(fm.name || rel) + '** — `' + esc(rel) + '`\n' +
      (heads.length ? heads.map((h) => '  - ' + esc(h)).join('\n') : '  - разделов нет'));
  }

  return note('skills', 'скилы-карточки.md', 'Скилы — карточки SKILL.md', SKILL_CARDS.slice(), [
    { h: 'Как читать', body: '> Карточки скиллов: назначение из frontmatter и оглавление разделов. ' +
      'Описания не дублируются целиком — первоисточник в файлах `SKILL.md`.' },
    { h: 'Сводка', body: kv([
      ['Карточек в списке', num(SKILL_CARDS.length)],
      ['Прочитано', num(found)],
      ['Файлов нет', num(SKILL_CARDS.length - found)],
    ]) },
    { h: 'Карточки', body: table(['скилл', 'назначение', 'разделов', 'строк'], rows, 20) },
    { h: 'Оглавление', body: details.length ? details.join('\n\n') : '_данных нет_' },
  ]);
}

const KB_DOC = 'docs/projects/svet-project-base.md';

function noteKnowledgeBase(ctx) {
  const t = ctx.readText(KB_DOC);
  const fm = t === null ? null : parseFrontmatter(t);
  const heads = t === null ? [] : headingsOf(t);
  const ref = listDir('docs/reference');
  const refRows = (ref || []).map((f) => [f.name, f.kind, f.size === null ? '—' : num(f.size) + ' Б']);

  return note('kb', 'база-знаний-проекты.md', 'База знаний — проекты и справочники', [KB_DOC, 'docs/reference/'], [
    { h: 'Сводка', body: kv([
      ['Проект', fm ? String(fm.project || '—') : 'данных нет: файл не найден'],
      ['Застройщик', fm ? String(fm.developer || '—') : 'данных нет'],
      ['Клиент', fm ? String(fm.client || '—') : 'данных нет'],
      ['Тип заметки', fm ? String(fm.type || '—') : 'данных нет'],
      ['Источник данных', fm ? String(fm.source || '—') : 'данных нет'],
      ['Дата источника', fm ? String(fm.source_date || '—') : 'данных нет'],
      ['Обновлено в источнике', fm ? String(fm.updated || '—') : 'данных нет'],
      ['Разделов в документе', t === null ? 'данных нет' : num(heads.length)],
      ['Строк в документе', t === null ? 'данных нет' : num(t.split(/\r?\n/).length)],
    ]) },
    { h: 'Разделы документа', body: heads.length ? heads.map((h) => '- ' + esc(h)).join('\n') : '_данных нет_' },
    { h: 'Справочные материалы (docs/reference)', body: refRows.length
      ? table(['файл', 'тип', 'размер'], refRows, 30)
      : '_данных нет: каталог docs/reference не найден или пуст_' },
    { h: 'Теги источника', body: fm && Array.isArray(fm.tags) && fm.tags.length ? list(fm.tags) : '_данных нет_' },
  ]);
}

const GLOSSARY_DOC = 'skills/newbuild-ru-glossary/SKILL.md';

function noteGlossary(ctx) {
  const t = ctx.readText(GLOSSARY_DOC);
  const fm = t === null ? null : parseFrontmatter(t);
  const heads = t === null ? [] : headingsOf(t);
  const sections = t === null ? [] : String(t).split(/^## /m).slice(1).map((chunk) => {
    const lines = chunk.split(/\r?\n/);
    const title = lines[0].trim();
    const lead = lines.slice(1).find((l) => l.trim() !== '') || '';
    return [title, clip(scrub(lead.replace(/^[*>\s-]+/, '')), 180)];
  });

  return note('kb', 'глоссарий-новостроек.md', 'База знаний — глоссарий новостроек', [GLOSSARY_DOC], [
    { h: 'Сводка', body: kv([
      ['Скилл', fm ? String(fm.name || '—') : 'данных нет: файл не найден'],
      ['Разделов', t === null ? 'данных нет' : num(heads.length)],
      ['Строк', t === null ? 'данных нет' : num(t.split(/\r?\n/).length)],
    ]) },
    { h: 'Назначение', body: fm && fm.description ? scrub(String(fm.description)) : '_данных нет_' },
    { h: 'Разделы и первые строки', body: sections.length
      ? table(['раздел', 'о чём'], sections, 30)
      : '_данных нет_' },
  ]);
}

// Новые заметки подключаются только при scope=full; по умолчанию набор не меняется.
const FULL_NOTES = [noteSkills, noteSkillCards, noteKnowledgeBase, noteGlossary];

const NOTES = [
  noteAgents, noteAgentSettings,
  noteAuth,
  noteClients, noteServices, noteSubscriptions, noteInvoices, noteOperators,
  noteBudgets, noteChannels, noteCashback,
  noteDashboard, noteDashboardNav, noteDashboardAlerts,
  noteAnalytics, noteAnalytics2, noteUsage, noteTasks, noteProjects, noteCompetitorReport,
  noteService, noteSessions,
  noteIntegrations, noteSources,
];

// ---------------------------------------------------------------- рендер

function stripFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  return m ? m[1] : '';
}

function readCreated(abs) {
  try {
    const fm = stripFrontmatter(fs.readFileSync(abs, 'utf8'));
    const m = /^created:\s*(.+)$/m.exec(fm);
    return m ? m[1].trim() : null;
  } catch (e) {
    return null;
  }
}

function renderNote(n, sections, meta) {
  const fm = [
    '---',
    'type: spec',
    'domain: ' + n.domain,
    'status: active',
    'created: ' + meta.created,
    'updated: ' + meta.updated,
    'tags: [dashboard-export]',
    'source: dashboard',
    '---',
  ].join('\n');

  const parts = [fm, '', '# ' + meta.title, ''];
  parts.push('> Автоматическая выгрузка панели. Папка «' + meta.subdir + '» перезаписывается целиком —' +
    ' ручные заметки держите вне неё.');
  if (meta.total > 1) {
    parts.push('', 'Часть ' + meta.part + ' из ' + meta.total + '.');
  }
  for (const s of sections) parts.push('', '## ' + s.h, '', String(s.body).trim());
  parts.push('', '## Источник', '');
  for (const src of n.sources) {
    const abs = path.resolve(PROJECT_DIR, src);
    const ok = src.endsWith('/')
      ? fs.existsSync(abs)
      : (insideProject(abs) && fs.existsSync(abs));
    parts.push('- `' + src + '`' + (ok ? '' : ' — файла нет'));
  }
  parts.push('', '_Сформировано: ' + meta.updated + '. Правки в этой папке будут перезаписаны при следующем экспорте._');
  return scrub(parts.join('\n'));
}

function splitSections(sections, budget) {
  const groups = [];
  let cur = [];
  let curLen = 0;
  const size = (s) => String(s.body).length + String(s.h).length + 8;

  const pushCur = () => { if (cur.length) { groups.push(cur); cur = []; curLen = 0; } };

  for (const s of sections) {
    const sLen = size(s);
    if (sLen <= budget) {
      if (curLen + sLen <= budget) { cur.push(s); curLen += sLen; continue; }
      pushCur();
      cur = [s];
      curLen = sLen;
      continue;
    }
    pushCur();
    const lines = String(s.body).split('\n');
    let chunk = [];
    let len = 0;
    for (const line of lines) {
      if (len + line.length + 1 > budget && chunk.length) {
        groups.push([{ h: s.h, body: chunk.join('\n') }]);
        chunk = [];
        len = 0;
      }
      chunk.push(line);
      len += line.length + 1;
    }
    if (chunk.length) { cur = [{ h: s.h, body: chunk.join('\n') }]; curLen = len; }
  }
  pushCur();
  return groups.length ? groups : [[]];
}

// Раскладка заметки по файлам: сколько частей и как они называются.
// Считается заранее (с датой-заглушкой той же длины, что и настоящая), чтобы
// при записи уже знать имя файла и прочитать из него сохранённый created.
function computeLayout(n, subdir) {
  const stub = { created: '2000-01-01 00:00', updated: '2000-01-01 00:00', subdir, title: n.title };
  let budget = Math.max(1200, MAX_NOTE_CHARS - 1100);
  let groups = splitSections(n.sections, budget);

  const titleOf = (i, total) => (total > 1 ? n.title + ' (часть ' + (i + 1) + ' из ' + total + ')' : n.title);
  const fileOf = (i) => (i === 0 ? n.file : n.file.replace(/\.md$/, '-часть-' + (i + 1) + '.md'));

  for (let attempt = 0; attempt < 6; attempt++) {
    const total = groups.length;
    const texts = groups.map((secs, i) => renderNote(n, secs, Object.assign({}, stub, {
      title: titleOf(i, total), part: i + 1, total,
    })));
    if (Math.max(...texts.map((t) => t.length)) <= MAX_NOTE_CHARS) break;
    budget = Math.floor(budget * 0.7);
    groups = splitSections(n.sections, budget);
  }

  return {
    groups,
    files: groups.map((_, i) => fileOf(i)),
    titleOf,
    total: groups.length,
  };
}

function renderPart(n, layout, index, created, subdir) {
  const total = layout.total;
  return renderNote(n, layout.groups[index], {
    created,
    updated: stamp(new Date()),
    subdir,
    title: layout.titleOf(index, total),
    part: index + 1,
    total,
  });
}

// ---------------------------------------------------------------- запись

function assertSegment(seg, what) {
  const s = String(seg || '');
  if (s === '' || s === '.' || s === '..' || /[\\/:*?"<>|\u0000-\u001f]/.test(s)) {
    throw new Error('недопустимый ' + what + ': ' + JSON.stringify(seg));
  }
  return s;
}

// Единственное место, где вычисляется путь записи. Всё, что вышло за
// <vault>/<domains_dir>/<Домен>/<export_subdir>/, отвергается.
function resolveTarget(vaultPath, domainsDir, subdir, domain, file) {
  const ru = DOMAIN_DIRS[domain];
  if (!ru) throw new Error('неизвестный домен: ' + domain);
  assertSegment(domainsDir, 'каталог доменов');
  assertSegment(subdir, 'подкаталог выгрузки');
  assertSegment(file, 'имя файла');

  const root = path.resolve(vaultPath, domainsDir);
  const abs = path.resolve(root, ru, subdir, file);
  const relToRoot = path.relative(root, abs);
  const parts = relToRoot.split(path.sep);

  if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) {
    throw new Error('путь вне зоны выгрузки: ' + abs);
  }
  if (parts.length !== 3 || parts[0] !== ru || parts[1] !== subdir || parts[2] !== file) {
    throw new Error('путь не соответствует шаблону <Домен>/<подкаталог>/<файл>: ' + abs);
  }
  const relToVault = path.relative(path.resolve(vaultPath), abs).split(path.sep).join('/');
  if (relToVault.startsWith('..')) throw new Error('путь вне vault: ' + abs);
  return { abs, dir: path.dirname(abs), rel: relToVault };
}

function makeBackup(abs) {
  const dir = path.dirname(abs);
  const base = path.basename(abs);
  const ts = bakStamp(new Date());
  let candidate = path.join(dir, base + '.bak-' + ts);
  let n = 1;
  while (fs.existsSync(candidate)) {
    n += 1;
    candidate = path.join(dir, base + '.bak-' + ts + '-' + n);
  }
  fs.copyFileSync(abs, candidate);
  return path.basename(candidate);
}

function atomicWrite(abs, content) {
  const dir = path.dirname(abs);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, '.' + path.basename(abs) + '.tmp-' + process.pid + '-' + Date.now());
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, abs);
}

// Служебные строки, которые меняются от запуска к запуску и не являются содержимым:
// без их вырезания каждый прогон считался бы «изменением» и плодил .bak.
function normalizeForCompare(text) {
  return String(text)
    .replace(/^updated:.*$/m, 'updated:')
    .replace(/_Сформировано: [^_]*_/g, '_Сформировано: _');
}

function writeTarget(abs, content, dryRun) {
  const exists = fs.existsSync(abs);
  if (exists) {
    let prev = null;
    try { prev = fs.readFileSync(abs, 'utf8'); } catch (e) { prev = null; }
    if (prev !== null && normalizeForCompare(prev) === normalizeForCompare(content)) {
      return { status: 'skipped' };
    }
    if (!dryRun) {
      makeBackup(abs);
      atomicWrite(abs, content);
    }
    return { status: 'updated' };
  }
  if (!dryRun) atomicWrite(abs, content);
  return { status: 'written' };
}

// ---------------------------------------------------------------- конфиг

export function loadVaultConfig(configPath) {
  const abs = path.resolve(configPath || DEFAULT_CONFIG);
  if (!fs.existsSync(abs)) {
    return { ok: false, file: abs, errors: ['конфиг не найден: ' + abs + ' (скопируйте vault.example.yaml в vault.yaml)'] };
  }
  let raw;
  try {
    raw = fs.readFileSync(abs, 'utf8');
  } catch (e) {
    return { ok: false, file: abs, errors: ['не читается конфиг ' + abs + ': ' + e.message] };
  }
  let data;
  try {
    data = parseYaml(raw) || {};
  } catch (e) {
    return { ok: false, file: abs, errors: ['не разбирается YAML ' + abs + ': ' + e.message] };
  }
  return { ok: true, file: abs, data };
}

// ---------------------------------------------------------------- публичный API

// Допустимые режимы выгрузки: 'panel' — только заметки панели (поведение 1:1),
// 'full' — заметки панели плюс разделы «Скилы» и «База знаний».
export const SCOPES = ['panel', 'full'];

export async function exportVault(opts = {}) {
  const result = { ok: false, vaultPath: '', scope: 'panel', written: [], updated: [], skipped: [], errors: [] };

  const scope = opts.scope === undefined || opts.scope === null || opts.scope === '' ? 'panel' : String(opts.scope);
  if (!SCOPES.includes(scope)) {
    result.scope = scope;
    result.errors.push('неизвестный scope: ' + JSON.stringify(opts.scope) + ' (допустимо: ' + SCOPES.join(' | ') + ')');
    return result;
  }
  result.scope = scope;

  const cfg = loadVaultConfig(opts.configPath);
  if (!cfg.ok) {
    result.errors.push(...cfg.errors);
    return result;
  }
  const c = cfg.data || {};
  const domainsDir = String(c.domains_dir || DEFAULT_DOMAINS_DIR);
  const subdir = String(c.export_subdir || DEFAULT_SUBDIR);
  const dryRun = opts.dryRun === true;
  const explicitVault = opts.vaultPath !== undefined && opts.vaultPath !== null && String(opts.vaultPath).trim() !== '';
  const configuredVault = c.vault_path === undefined || c.vault_path === null ? '' : String(c.vault_path).trim();

  if (!explicitVault && c.enabled === false) {
    result.ok = true;
    result.skipped.push('экспорт выключен в конфиге: enabled: false');
    return result;
  }

  const vaultRaw = explicitVault ? String(opts.vaultPath).trim() : configuredVault;
  if (vaultRaw === '') {
    result.errors.push('не задан vault_path: укажите его в ' + cfg.file + ' или передайте opts.vaultPath');
    return result;
  }
  const vaultPath = path.resolve(vaultRaw);
  result.vaultPath = vaultPath;

  if (!fs.existsSync(vaultPath)) {
    result.errors.push('корень vault не найден: ' + vaultPath + ' (модуль сам его не создаёт)');
    return result;
  }
  let stat = null;
  try { stat = fs.statSync(vaultPath); } catch (e) { stat = null; }
  if (!stat || !stat.isDirectory()) {
    result.errors.push('vault_path не каталог: ' + vaultPath);
    return result;
  }

  const ctx = makeReader();
  const built = buildNotes(ctx, scope);
  for (const f of built.failed) result.errors.push('сборка заметки: ' + f);

  for (const n of built.notes) {
    try {
      const layout = computeLayout(n, subdir);
      for (let i = 0; i < layout.files.length; i++) {
        const target = resolveTarget(vaultPath, domainsDir, subdir, n.domain, layout.files[i]);
        const created = readCreated(target.abs) || stamp(new Date());
        const text = renderPart(n, layout, i, created, subdir);
        const res = writeTarget(target.abs, text, dryRun);
        if (res.status === 'written') result.written.push(target.rel);
        else if (res.status === 'updated') result.updated.push(target.rel);
        else result.skipped.push(target.rel);
      }
    } catch (e) {
      result.errors.push('заметка ' + n.domain + '/' + n.file + ': ' + e.message);
    }
  }

  for (const miss of ctx.missing) result.skipped.push('источник не найден: ' + miss);

  result.ok = result.errors.length === 0;
  return result;
}

// ---------------------------------------------------------------- CLI

function parseArgs(argv) {
  const out = { dryRun: false, vaultPath: undefined, configPath: undefined, scope: undefined, quiet: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run' || a === '-n') out.dryRun = true;
    else if (a === '--vault') out.vaultPath = argv[++i];
    else if (a.startsWith('--vault=')) out.vaultPath = a.slice(8);
    else if (a === '--config') out.configPath = argv[++i];
    else if (a.startsWith('--config=')) out.configPath = a.slice(9);
    else if (a === '--scope') out.scope = argv[++i];
    else if (a.startsWith('--scope=')) out.scope = a.slice(8);
    else if (a === '--quiet' || a === '-q') out.quiet = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function isMain() {
  try {
    const self = fileURLToPath(import.meta.url);
    const arg = process.argv[1] ? path.resolve(process.argv[1]) : '';
    return arg !== '' && path.resolve(self) === arg;
  } catch (e) {
    return false;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write([
      'Экспорт состояния панели в Obsidian-vault.',
      '',
      '  node dashboard/collector/export-vault.mjs [--dry-run] [--scope panel|full] [--vault <путь>] [--config <файл>]',
      '',
      '  --dry-run, -n   только посчитать, ничего не писать',
      '  --scope <режим> panel (по умолчанию) — заметки панели;',
      '                  full — плюс разделы «Скилы» и «База знаний»',
      '  --vault <путь>  переопределить vault_path из конфига',
      '  --config <файл> путь к конфигу (по умолчанию dashboard/config/vault.yaml)',
      '  --quiet, -q     короткая сводка',
      '',
    ].join('\n'));
    return;
  }

  const res = await exportVault({ dryRun: args.dryRun, vaultPath: args.vaultPath, configPath: args.configPath, scope: args.scope });
  const mode = args.dryRun ? ' (dry-run: ничего не записано)' : '';
  process.stdout.write('Vault: ' + (res.vaultPath || '—') + ' | scope: ' + res.scope + mode + '\n');
  process.stdout.write('новых: ' + res.written.length + ' | обновлено: ' + res.updated.length +
    ' | без изменений/пропущено: ' + res.skipped.length + ' | ошибок: ' + res.errors.length + '\n');
  if (!args.quiet) {
    for (const f of res.written) process.stdout.write('  + ' + f + '\n');
    for (const f of res.updated) process.stdout.write('  ~ ' + f + ' (.bak рядом)\n');
    for (const s of res.skipped) if (!s.startsWith('источник не найден')) process.stdout.write('  = ' + s + '\n');
  }
  for (const e of res.errors) process.stdout.write('  ! ' + e + '\n');
  process.exitCode = res.ok ? 0 : 1;
}

if (isMain()) {
  main().catch((e) => {
    process.stderr.write('Ошибка экспорта: ' + (e && e.stack ? e.stack : e) + '\n');
    process.exitCode = 1;
  });
}

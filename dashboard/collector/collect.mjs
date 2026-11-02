#!/usr/bin/env node
// Dashboard collector: reads DSH session logs + projection cache + registry,
// writes public/data/*.json. No external dependencies.
//
//   node marketing-agents/dashboard/collector/collect.mjs
//
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DATA_DIR, SESSIONS_ROOT, PROJCACHE_ROOT, REGISTRY_DIR, TASKS_DIR,
  WORKSPACE_ROOT, PROJECT_DIR, DASHBOARD_DIR, CONFIG_DIR, ensureDir,
} from './lib/paths.mjs';
import { loadAgents, loadProjects, loadRegistryTasks } from './lib/registry.mjs';
import { loadPrices } from './lib/pricing.mjs';
import { readAllSessions } from './lib/sessions.mjs';
import { buildTasks } from './lib/tasks.mjs';
import { buildAll, loadLinks, loadTaskOwners } from './lib/aggregate.mjs';
import { loadProfile } from './lib/profile.mjs';
import { loadCatalog, buildIntegrationsDoc, loadFullCatalog } from './lib/integrations.mjs';
import { loadSourcesConfig, loadSourceAliases, scanSnapshots, loadSourceRuns, buildSourcesDoc } from './lib/sources.mjs';
import { scanHistory } from './lib/history.mjs';
import { loadSourceAgents } from './lib/source-agents.mjs';
import { buildSettingsDoc } from './lib/settings.mjs';
import { buildAlertsDoc } from './lib/alerts.mjs';
import { loadNav } from './lib/nav.mjs';
import { buildAnalytics2Doc } from './lib/analytics2.mjs';
import { buildAdsDoc } from './lib/ads.mjs';
import { loadAgentTabs } from './lib/agent-tabs.mjs';
import { loadAgentSettings } from './lib/agent-settings.mjs';
import { loadCandidates } from './lib/candidates.mjs';
import { loadCompetitorReport } from './lib/competitor-report.mjs';
import { buildServiceDoc } from './lib/service.mjs';
import { buildAnalyticsDoc } from './lib/analytics.mjs';

function dedupeWarnings(list) {
  const seen = {};
  const out = [];
  for (const w of list) {
    const msg = typeof w === 'string' ? w : w.message;
    if (seen[msg]) continue;
    seen[msg] = true;
    out.push(typeof w === 'string' ? { level: 'warn', message: w } : w);
  }
  return out.slice(0, 300);
}

export function collect(options) {
  const opts = options || {};
  const started = Date.now();
  const warnings = [];
  const dataDir = opts.dataDir || DATA_DIR;
  ensureDir(dataDir);

  const agentsReg = loadAgents(warnings);
  const projectsReg = loadProjects(warnings);
  const tasksReg = loadRegistryTasks(warnings);
  const prices = loadPrices();
  for (const w of prices.warnings) warnings.push(w);
  const links = loadLinks(warnings);
  const taskOwners = loadTaskOwners(warnings);

  // Вкладка «Интеграции API»: факты о профиле DSH + каталог того, что можно подключить.
  const profile = loadProfile();
  for (const w of profile.warnings) warnings.push(w);
  const catalog = loadCatalog(warnings);
  const navDoc = loadNav(warnings);

  const fullCatalog = loadFullCatalog(warnings);
  const integrationsDoc = buildIntegrationsDoc({ profile: profile, catalog: catalog, fullCatalog: fullCatalog });
  for (const w of integrationsDoc.warnings) warnings.push(w);

  // Вкладка «Источники мониторинга»: реестр источников + статистика по снимкам.
  const sourcesConfig = loadSourcesConfig(warnings);
  const sourceAliases = loadSourceAliases(warnings);
  const sourceAgents = loadSourceAgents(warnings);
  const snapshotScan = scanSnapshots(warnings, sourceAliases.map);
  const runLog = loadSourceRuns(warnings);
  const sourcesDoc = buildSourcesDoc({ config: sourcesConfig, scan: snapshotScan, runLog: runLog });
  for (const w of sourcesDoc.warnings) warnings.push(w);

  // История переключений тумблеров — по копиям .bak-<timestamp>, которые делает дашборд.
  const history = scanHistory(warnings);

  const sessionsData = readAllSessions({ sessionsRoot: SESSIONS_ROOT, warnings: warnings, prices: prices });

  const today = new Date().toISOString().slice(0, 10);
  const tasksDoc = buildTasks({
    tasksReg: tasksReg, teamTasks: sessionsData.teamTasks, agentsReg: agentsReg,
    links: links, today: today, taskOwners: taskOwners,
  });

  const built = buildAll({
    sessionsData: sessionsData, prices: prices, links: links, warnings: warnings,
    agentsReg: agentsReg, projectsReg: projectsReg, tasksReg: tasksReg,
    allTasks: tasksDoc.tasks, workspaceRoot: WORKSPACE_ROOT,
  });

  // Каркас сервиса: клиенты, подписки, услуги, очередь прогонов, счета, экономика.
  const serviceDoc = buildServiceDoc({
    today: today,
    objects: (projectsReg.projects || []).map(function (p) { return { id: p.id, name: p.name }; }),
  });
  for (const w of serviceDoc.warnings) warnings.push(w);

  // Тонкие настройки агентов: файл на каждого агента. Читаем раньше списка источников,
  // потому что список файлов данных ссылается на количество настроек.
  const agentSettingsDoc = loadAgentSettings(warnings);
  const competitorReportDoc = loadCompetitorReport(warnings);
  const candidatesDoc = loadCandidates(warnings);

  const sources = [
    { id: 'sessions', label: 'Логи сессий DSH (multi-frame zstd + JSONL)', path: SESSIONS_ROOT, exists: fs.existsSync(SESSIONS_ROOT), items: sessionsData.sessions.length, note: 'events: ' + sessionsData.sessions.reduce(function (s, x) { return s + x.events; }, 0) },
    { id: 'projcache', label: 'Проекция сессий (tokenUsage, agentTeam)', path: PROJCACHE_ROOT, exists: fs.existsSync(PROJCACHE_ROOT), items: sessionsData.sessions.filter(function (s) { return s.projcache !== null; }).length, note: 'контрольные суммы токенов' },
    { id: 'agents', label: 'Реестр агентов', path: agentsReg.file, exists: fs.existsSync(agentsReg.file), items: agentsReg.agents.length, note: 'updated: ' + String(agentsReg.updated) },
    { id: 'projects', label: 'Реестр проектов', path: projectsReg.file, exists: fs.existsSync(projectsReg.file), items: projectsReg.projects.length, note: '' },
    { id: 'tasks', label: 'Реестр задач registry/tasks/*.yaml', path: TASKS_DIR, exists: tasksReg.exists, items: tasksReg.tasks.length, note: tasksReg.files.length + ' файл(ов)' },
    { id: 'prices', label: 'Цены моделей', path: prices.path || path.join(REGISTRY_DIR, 'prices.yaml'), exists: prices.found, items: prices.modelCount, note: prices.found ? ('источник: ' + prices.source) : 'файла нет — расход в рублях недоступен' },
    { id: 'links', label: 'Связь агентов реестра и исполнителей DSH', path: links.file, exists: links.exists, items: Object.keys(links.map).length, note: '' },
    { id: 'task-owners', label: 'Владельцы задач из логов (в логе исполнитель не пишется)', path: taskOwners.file, exists: taskOwners.exists, items: Object.keys(taskOwners.map).length, note: taskOwners.exists ? 'ручной снимок общей доски' : 'файла нет — исполнители задач из логов неизвестны' },
    { id: 'profile', label: 'Профиль DSH (что реально подключено)', path: profile.manifestPath, exists: profile.exists, items: profile.bundles.length, note: 'бандлов: ' + profile.bundles.length + ', сообщества: ' + profile.communityBundles.length },
    { id: 'integrations', label: 'Каталог интеграций', path: catalog.file, exists: catalog.exists, items: catalog.integrations.length, note: 'что можно подключить' },
    { id: 'sources', label: 'Реестр источников мониторинга', path: sourcesConfig.file, exists: sourcesConfig.exists, items: sourcesConfig.sources.length, note: 'включено: ' + sourcesDoc.summary.enabled },
    { id: 'snapshots', label: 'Снимки конкурентов (статистика по источникам)', path: snapshotScan.roots.join('; '), exists: snapshotScan.roots.length > 0, items: snapshotScan.snapshots.length, note: 'лотов: ' + snapshotScan.totalLots + ' в ' + snapshotScan.snapshots.length + ' снимках' },
    { id: 'source-runs', label: 'Журнал запусков источников', path: runLog.file || 'data/source-runs.jsonl', exists: runLog.exists, items: runLog.count, note: runLog.exists ? 'запусков: ' + runLog.count : 'журнал пока пуст (появится после T18)' },
    { id: 'agent-tabs', label: 'Вкладки раздела «Агенты»', path: 'config/agents-tabs.yaml', exists: true, items: 4, note: 'правится одним файлом' },
    { id: 'competitor-report', label: 'Отчёт Агента 1 по конкурентам', path: '01-competitor-watch/data/clients/<client>/competitor-profiles/*.json', exists: competitorReportDoc.exists, items: competitorReportDoc.profilesFound, note: competitorReportDoc.profilesFound ? ('профилей ' + competitorReportDoc.profilesFound + ', лотов ' + competitorReportDoc.counts.lots) : 'движок ещё не сформировал профили' },
    { id: 'candidates', label: 'Кандидаты в конкуренты (автоподбор)', path: '01-competitor-watch/data/candidates/*.json', exists: candidatesDoc.exists, items: candidatesDoc.counts.total, note: candidatesDoc.exists ? 'найдено ' + candidatesDoc.counts.total : 'движок поиска ещё не сформировал список' },
    { id: 'agent-settings', label: 'Тонкие настройки агентов', path: 'registry/agent-settings/*.yaml', exists: agentSettingsDoc.exists, items: agentSettingsDoc.counts.files || 0, note: 'файл на каждого агента, отдельно правится' },
    { id: 'ads', label: 'Реклама и кэшбэк', path: 'public/data/ads.json', exists: true, items: 5, note: 'каналов 5, записей бюджета и кэшбэка' },
    { id: 'analytics2', label: 'Аналитика: серии, срезы, метрики', path: 'public/data/analytics2.json', exists: true, items: 28, note: 'графиков 6, срезов 9' },
    { id: 'nav', label: 'Структура левого меню', path: navDoc.file, exists: navDoc.exists, items: navDoc.total || 0, note: navDoc.exists ? 'правится одним файлом' : 'используется встроенная схема' },
    { id: 'clients', label: 'Клиенты сервиса', path: serviceDoc.files.clients, exists: fs.existsSync(serviceDoc.files.clients), items: serviceDoc.counts.clients, note: 'активных: ' + serviceDoc.counts.active },
    { id: 'services', label: 'Каталог услуг', path: serviceDoc.files.services, exists: fs.existsSync(serviceDoc.files.services), items: serviceDoc.counts.services, note: 'включено: ' + serviceDoc.counts.servicesEnabled },
    { id: 'subscriptions', label: 'Подписки', path: serviceDoc.files.subscriptions, exists: fs.existsSync(serviceDoc.files.subscriptions), items: serviceDoc.counts.subscriptions, note: 'активных: ' + serviceDoc.counts.subsActive + ', просрочено: ' + serviceDoc.counts.overdue },
    { id: 'runs', label: 'Журнал прогонов', path: serviceDoc.files.runs, exists: fs.existsSync(serviceDoc.files.runs), items: serviceDoc.counts.runs, note: 'успешно: ' + serviceDoc.counts.runsOk + ', ошибок: ' + serviceDoc.counts.runsFailed },
    { id: 'invoices', label: 'Счета', path: serviceDoc.files.invoices, exists: fs.existsSync(serviceDoc.files.invoices), items: serviceDoc.counts.invoices, note: 'не оплачено: ' + serviceDoc.counts.unpaid },
    { id: 'history', label: 'История переключений тумблеров (копии .bak-*)', path: REGISTRY_DIR, exists: (history.backups.agents.count + history.backups.sources.count) > 0, items: history.backups.agents.count + history.backups.sources.count, note: 'агенты: ' + history.backups.agents.count + ', источники: ' + history.backups.sources.count },
  ];

  const usage = built.usage;

  // Сквозная аналитика: воронка агент -> задачи -> результат -> расход.
  const analyticsDoc = buildAnalyticsDoc({
    agentsDoc: built.agents,
    tasksDoc: tasksDoc,
    usage: usage,
    sourcesDoc: sourcesDoc,
    projectsDoc: built.projects,
    links: links,
    sourceAgents: sourceAgents.map,
    generatedAtMs: started,
  });
  for (const w of analyticsDoc.warnings) warnings.push(w);

  // Вкладка «Настройки»: реестр управляемых параметров + история из .bak-*.
  const settingsDoc = buildSettingsDoc({ agentsDoc: built.agents, sourcesDoc: sourcesDoc });
  for (const w of settingsDoc.warnings) warnings.push(w);

  // Тревоги на «Обзоре».
  const alertsDoc = buildAlertsDoc({ today: today, sourcesDoc: sourcesDoc, tasksDoc: tasksDoc, usage: usage, agentsDoc: built.agents });

  // Аналитика-2: серии, столбцы, доли, воронка, тепловая карта, срезы, метрики, топы.
  const analytics2Doc = buildAnalytics2Doc({
    today: today, usage: usage, tasksDoc: tasksDoc, sourcesDoc: sourcesDoc,
    service: serviceDoc, agents: built.agents,
  });
  for (const w of analytics2Doc.warnings) warnings.push(w);

  // Реклама и кэшбэк: бюджеты каналов и вознаграждение за ведение.
  const adsDoc = buildAdsDoc({ today: today, clients: serviceDoc.clients });
  for (const w of adsDoc.warnings) warnings.push(w);

  // Вкладки раздела «Агенты» (Исполнители / Источники / место под будущие категории).
  const agentTabsDoc = loadAgentTabs(warnings);


  const totals = {
    sessions: built.sessions.count,
    events: sessionsData.sessions.reduce(function (s, x) { return s + x.events; }, 0),
    agents: built.agents.agents.length,
    agentsEnabled: built.agents.summary.enabled,
    members: built.agents.members.length,
    tasks: tasksDoc.counts.total,
    projects: built.projects.projects.length,
    alerts: alertsDoc.counts.total,
    clients: serviceDoc.counts.clients,
    services: serviceDoc.counts.services,
    subscriptions: serviceDoc.counts.subscriptions,
    runs: serviceDoc.counts.runs,
    revenueRub: serviceDoc.economy.revenueRub,
    marginRub: serviceDoc.economy.marginRub,
    alertsCritical: alertsDoc.counts.critical,
    integrations: integrationsDoc.summary.total,
    integrationsConnected: integrationsDoc.summary.connected,
    sources: sourcesDoc.summary.total,
    sourcesEnabled: sourcesDoc.summary.enabled,
    lots: sourcesDoc.summary.totalLots,
    tokens: usage.totals.tokens,
    usd: usage.totals.usd,
    rub: usage.totals.rub,
    rubComplete: usage.totals.rubComplete,
  };

  const docs = {
    'prices.json': buildPricesDoc(prices),
    'integrations.json': integrationsDoc,
    'sources.json': sourcesDoc,
    'analytics.json': analyticsDoc,
    'settings.json': settingsDoc,
    'alerts.json': alertsDoc,
    'service.json': serviceDoc,
    'nav.json': navDoc,
    'analytics2.json': analytics2Doc,
    'ads.json': adsDoc,
    'agent-tabs.json': agentTabsDoc,
    'agent-settings.json': agentSettingsDoc,
    'candidates.json': candidatesDoc,
    'competitor-report.json': competitorReportDoc,
    'agents.json': built.agents,
    'tasks.json': tasksDoc,
    'projects.json': built.projects,
    'sessions.json': built.sessions,
    'usage.json': usage,
  };

  // Atomic write: the server may read these files at any moment, so never let it
  // observe a half-written document.
  function writeAtomic(file, text) {
    const tmp = file + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, text, 'utf8');
    try { fs.renameSync(tmp, file); }
    catch (e) {
      try { fs.unlinkSync(tmp); } catch (e2) { /* ignore */ }
      throw e;
    }
  }

  const written = [];
  for (const name of Object.keys(docs)) {
    const file = path.join(dataDir, name);
    const text = JSON.stringify(docs[name], null, 1);
    writeAtomic(file, text);
    written.push({ name: name, path: file, bytes: Buffer.byteLength(text, 'utf8') });
  }

  const meta = {
    generatedAt: new Date(started).toISOString(),
    generatedAtMs: started,
    durationMs: Date.now() - started,
    today: today,
    workspaceRoot: WORKSPACE_ROOT,
    projectDir: PROJECT_DIR,
    dashboardDir: DASHBOARD_DIR,
    configDir: CONFIG_DIR,
    dataDir: dataDir,
    sources: sources,
    totals: totals,
    pricing: {
      source: prices.source, path: prices.path, found: prices.found,
      schema: prices.schema, fetchedAt: prices.fetchedAt, priceKind: prices.priceKind,
      usdRub: prices.usdRub, usdRubNote: prices.usdRubNote, modelCount: prices.modelCount,
      unknownModels: usage.unknownPriceModels,
      cachePriceAssumedFor: prices.cachePriceAssumedFor,
    },
    history: history,
    warnings: dedupeWarnings(warnings),
    files: written,
    dataFiles: written.map(function (w) { return w.name; }),
  };
  const metaFile = path.join(dataDir, 'meta.json');
  const metaText = JSON.stringify(meta, null, 1);
  writeAtomic(metaFile, metaText);
  meta.files.push({ name: 'meta.json', path: metaFile, bytes: Buffer.byteLength(metaText, 'utf8') });

  return meta;
}

function buildPricesDoc(prices) {
  const list = Object.keys(prices.models).map(function (id) {
    const m = prices.models[id];
    return {
      id: id,
      rubIn: m.inRub, rubOut: m.outRub,
      rubCacheRead: m.cachePricePublished ? m.cacheRub : null,
      usdIn: m.inUsd, usdOut: m.outUsd,
      usdCacheRead: m.cachePricePublished ? m.cacheUsd : null,
      cachePricePublished: m.cachePricePublished,
      acceptsImages: m.acceptsImages,
      contextTokens: m.contextTokens,
      typicalTurnRub: m.typicalTurnRub,
      source: m.source,
      note: m.note,
    };
  }).sort(function (a, b) { return (a.id < b.id ? -1 : 1); });
  return {
    schema: prices.schema, source: prices.source, path: prices.path, found: prices.found,
    fetchedAt: prices.fetchedAt, priceKind: prices.priceKind,
    currencyOfSource: prices.currencyOfSource, priceUnit: prices.priceUnit,
    rate: { usdRub: prices.usdRub, date: prices.rateDate, source: prices.rateSource },
    models: list,
    recommendations: prices.recommendations,
    cachePriceAssumedFor: prices.cachePriceAssumedFor,
    note: prices.cardNote,
  };
}

function fmt(n) {
  if (n === null || n === undefined) return '—';
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

function run() {
  const meta = collect({});
  const t = meta.totals;
  console.log('Дашборд: данные собраны за ' + meta.durationMs + ' мс');
  console.log('  сессий:      ' + t.sessions + '  (событий: ' + fmt(t.events) + ')');
  console.log('  агентов:     ' + t.agents + ' в реестре, включено ' + t.agentsEnabled + '; исполнителей DSH: ' + t.members);
  console.log('  задач:       ' + t.tasks);
  console.log('  проектов:    ' + t.projects);
  console.log('  токенов:     ' + fmt(t.tokens.totalTokens) + '  (вход ' + fmt(t.tokens.inputTokens) + ', выход ' + fmt(t.tokens.outputTokens) + ', кэш ' + fmt(t.tokens.cacheReadTokens) + ')');
  console.log('  расход:      $' + (t.usd === null ? '—' : t.usd) + '  /  ' + (t.rub === null ? 'цена неизвестна' : fmt(t.rub) + ' ₽'));
  console.log('  цены:        ' + meta.pricing.source + (meta.pricing.path ? ' (' + meta.pricing.path + ')' : '') + (meta.pricing.usdRub ? ', курс ' + meta.pricing.usdRub + ' ₽/$' : ''));
  if (meta.warnings.length > 0) {
    console.log('  предупреждений: ' + meta.warnings.length);
    for (const w of meta.warnings.slice(0, 12)) console.log('    - ' + w.message);
  }
  console.log('  данные:      ' + meta.dataDir);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try { run(); }
  catch (e) { console.error('Сборщик упал: ' + (e && e.stack ? e.stack : e)); process.exit(1); }
}

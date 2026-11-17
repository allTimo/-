// СТЕНД АГЕНТОВ (шаг 1B, 09.11.2026): по каждому агенту — история прогонов,
// длительность и стоимость. Источник один: registry/runs.jsonl
// (поля записи: run_id, ts, service, client, agent, status, duration_ms, cost_rub, artifact, error).
//
// Принцип честности: нет прогонов — пишем «прогонов нет» и readiness.reason,
// а не нули; нет длительности или цены в записи — не подставляем 0, а считаем null.
import fs from 'node:fs';
import path from 'node:path';
import { REGISTRY_DIR } from './paths.mjs';

const RUNS_FILE = path.join(REGISTRY_DIR, 'runs.jsonl');
const RECENT_LIMIT = 8;

// null/пустая строка — это «значения нет», а не ноль: Number(null) === 0 дал бы ложный ноль.
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

export function loadRuns(warnings) {
  if (!fs.existsSync(RUNS_FILE)) {
    warnings.push('runs.jsonl: файл не найден — ' + RUNS_FILE);
    return [];
  }
  const out = [];
  let bad = 0;
  for (const line of fs.readFileSync(RUNS_FILE, 'utf8').split(/\r?\n/)) {
    if (line.trim() === '') continue;
    try {
      const o = JSON.parse(line);
      if (o && typeof o === 'object') out.push(o); else bad++;
    } catch (e) { bad++; }
  }
  if (bad > 0) warnings.push('runs.jsonl: ' + bad + ' строк не разобрались');
  out.sort(function (a, b) { return String(a.ts) < String(b.ts) ? -1 : 1; });
  return out;
}

function summarize(runs) {
  const ok = runs.filter(function (r) { return r.status === 'ok'; }).length;
  const failed = runs.filter(function (r) { return r.status === 'failed' || r.status === 'error'; }).length;
  const durations = [];
  const costs = [];
  runs.forEach(function (r) {
    const d = num(r.duration_ms); if (d !== null && d > 0) durations.push(d);
    const c = num(r.cost_rub); if (c !== null) costs.push(c);
  });
  const last = runs.length ? runs[runs.length - 1] : null;

  // Длительность: средняя/мин/макс только по прогонам, где она есть.
  const dur = durations.length ? {
    count: durations.length,
    avgMs: Math.round(durations.reduce(function (a, b) { return a + b; }, 0) / durations.length),
    minMs: Math.min.apply(null, durations),
    maxMs: Math.max.apply(null, durations),
    lastMs: last && num(last.duration_ms) !== null ? num(last.duration_ms) : null,
  } : { count: 0, avgMs: null, minMs: null, maxMs: null, lastMs: null };

  const cost = costs.length ? {
    count: costs.length,
    totalRub: Math.round(costs.reduce(function (a, b) { return a + b; }, 0) * 1000) / 1000,
    lastRub: last && num(last.cost_rub) !== null ? num(last.cost_rub) : null,
  } : { count: 0, totalRub: null, lastRub: null };
  // Записи без измеренной стоимости (например, запуски из панели: cost_rub null, cost_source none).
  const withoutCost = runs.length - costs.length;
  const withoutDuration = runs.length - durations.length;

  // Разрез по клиентам: стенд запускается «по клиенту», поэтому видно, на ком агент работал.
  const byClient = {};
  runs.forEach(function (r) {
    const id = r.client ? String(r.client) : '(без клиента)';
    if (!byClient[id]) byClient[id] = { client: id, runs: 0, ok: 0, lastTs: null, lastStatus: null };
    const c = byClient[id];
    c.runs++;
    if (r.status === 'ok') c.ok++;
    c.lastTs = r.ts || c.lastTs;
    c.lastStatus = r.status || c.lastStatus;
  });

  return {
    runs: {
      total: runs.length, ok: ok, failed: failed, other: runs.length - ok - failed,
      lastTs: last ? (last.ts || null) : null,
      lastStatus: last ? (last.status || null) : null,
      lastClient: last ? (last.client || null) : null,
      lastArtifact: last ? (last.artifact || null) : null,
      lastError: last ? (last.error || null) : null,
    },
    duration: dur,
    cost: cost,
    withoutCost: withoutCost,
    withoutDuration: withoutDuration,
    byClient: Object.keys(byClient).sort().map(function (k) { return byClient[k]; }),
    recent: runs.slice(-RECENT_LIMIT).reverse().map(function (r) {
      return {
        runId: r.run_id || null, ts: r.ts || null, client: r.client || null,
        status: r.status || null, durationMs: num(r.duration_ms), costRub: num(r.cost_rub),
        costSource: r.cost_source !== undefined ? String(r.cost_source) : null,
        trigger: r.trigger !== undefined ? String(r.trigger) : null,
        artifact: r.artifact || null, error: r.error || null, service: r.service || null,
      };
    }),
  };
}

// Готовность агента к прогону. Никаких догадок: правило — агент считается готовым,
// только если по нему уже есть хотя бы один прогон в журнале ИЛИ он помечен активным в реестре.
// Для запланированных агентов причина берётся из статуса реестра и плана (если он есть).
function readiness(agent, runs) {
  const hasRuns = runs.length > 0;
  const status = agent.status ? String(agent.status) : 'unknown';
  if (hasRuns) return { ready: true, reason: null, kind: 'has-runs' };
  if (status === 'active') {
    return { ready: true, reason: 'прогонов в журнале ещё нет, но агент включён в реестре', kind: 'active-no-runs' };
  }
  return {
    ready: false,
    kind: status === 'planned' ? 'planned' : status,
    reason: status === 'planned'
      ? 'движок не подключён: агент в статусе «запланирован» (registry/agents.yaml). Прогонов в журнале нет.'
      : 'движок не подключён: статус агента «' + status + '». Прогонов в журнале нет.',
  };
}

export function buildAgentRunsDoc(ctx) {
  const warnings = [];
  const runs = loadRuns(warnings);
  const agents = (ctx && ctx.agentsDoc && Array.isArray(ctx.agentsDoc.agents)) ? ctx.agentsDoc.agents : [];

  const rows = agents.map(function (a) {
    const id = String(a.id);
    const mine = runs.filter(function (r) { return String(r.agent || '') === id; });
    const s = summarize(mine);
    const r = readiness(a, mine);
    return {
      id: id,
      name: a.name !== undefined ? String(a.name) : id,
      status: a.status !== undefined ? String(a.status) : null,
      enabled: a.enabled === true,
      schedule: a.schedule !== undefined ? String(a.schedule) : null,
      model: a.model !== undefined ? String(a.model) : null,
      role: a.role !== undefined ? String(a.role) : null,
      projects: Array.isArray(a.projects) ? a.projects.map(String) : [],
      groups: Array.isArray(a.groups) ? a.groups.map(String) : [],
      ready: r.ready,
      readinessKind: r.kind,
      readinessReason: r.reason,
      runs: s.runs,
      duration: s.duration,
      cost: s.cost,
      withoutCost: s.withoutCost,
      withoutDuration: s.withoutDuration,
      byClient: s.byClient,
      recent: s.recent,
    };
  });

  // Прогоны, которые не удалось отнести ни к одному агенту из реестра:
  // пустое поле agent или неизвестный id. Показываем это ОДИН раз на разделе, а не в каждой карточке.
  const knownIds = {};
  agents.forEach(function (a) { knownIds[String(a.id)] = true; });
  const unattributed = runs.filter(function (r) {
    const id = String(r.agent || '');
    return id === '' || !knownIds[id];
  }).length;

  const withRuns = rows.filter(function (x) { return x.runs.total > 0; });
  const durations = runs.map(function (r) { return num(r.duration_ms); }).filter(function (v) { return v !== null && v > 0; });
  const costs = runs.map(function (r) { return num(r.cost_rub); }).filter(function (v) { return v !== null; });

  return {
    generatedAtMs: Date.now(),
    today: ctx && ctx.today ? ctx.today : null,
    file: RUNS_FILE,
    exists: fs.existsSync(RUNS_FILE),
    note: 'Источник — registry/runs.jsonl: длительность (duration_ms) и стоимость (cost_rub) каждого прогона. ' +
      'Где поля нет, там честно «данных нет», а не ноль.',
    agents: rows,
    totals: {
      agents: rows.length,
      agentsReady: rows.filter(function (x) { return x.ready; }).length,
      agentsWithRuns: withRuns.length,
      runs: runs.length,
      unattributed: unattributed,
      runsWithDuration: durations.length,
      runsWithCost: costs.length,
      avgDurationMs: durations.length ? Math.round(durations.reduce(function (a, b) { return a + b; }, 0) / durations.length) : null,
      costRub: costs.length ? Math.round(costs.reduce(function (a, b) { return a + b; }, 0) * 1000) / 1000 : null,
    },
    warnings: warnings,
  };
}

export { RUNS_FILE };

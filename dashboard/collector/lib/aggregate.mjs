// Turns parsed sessions + registry into the JSON documents the UI consumes.
import fs from 'node:fs';
import path from 'node:path';
import { costOf } from './pricing.mjs';
import { parseYaml } from './yaml.mjs';
import { CONFIG_DIR, WORKSPACE_ROOT } from './paths.mjs';

const STATUS_MAP = {
  pending: 'new',
  new: 'new',
  todo: 'new',
  in_progress: 'in_progress',
  'in-progress': 'in_progress',
  active: 'in_progress',
  completed: 'done',
  complete: 'done',
  done: 'done',
  closed: 'done',
  blocked: 'blocked',
  unassigned: 'unassigned',
};

export function normalizeStatus(s) {
  const key = String(s === null || s === undefined ? '' : s).toLowerCase();
  return STATUS_MAP[key] || 'new';
}

function round2(n) { return n === null || n === undefined ? null : Math.round(n * 100) / 100; }
function round4(n) { return n === null || n === undefined ? null : Math.round(n * 10000) / 10000; }

export function loadLinks(warnings) {
  const file = path.join(CONFIG_DIR, 'links.yaml');
  const map = {};
  const system = [];
  if (!fs.existsSync(file)) {
    warnings.push('dashboard/config/links.yaml не найден — расход по агентам реестра не связан с исполнителями DSH');
    return { file: file, map: map, system: system, exists: false };
  }
  let doc;
  try { doc = parseYaml(fs.readFileSync(file, 'utf8')); }
  catch (e) { warnings.push('links.yaml: ошибка разбора — ' + e.message); return { file: file, map: map, system: system, exists: true }; }
  const block = doc && doc.links && typeof doc.links === 'object' ? doc.links : doc;
  for (const key of Object.keys(block || {})) {
    const v = block[key];
    if (Array.isArray(v)) map[key] = v.map(String);
    else if (v && typeof v === 'object' && Array.isArray(v.members)) map[key] = v.members.map(String);
    else if (typeof v === 'string') map[key] = [v];
  }
  if (doc && Array.isArray(doc.system)) for (const n of doc.system) system.push(String(n));
  return { file: file, map: map, system: system, exists: true };
}

// The DSH session log does not record a task owner, so we allow an explicit map.
export function loadTaskOwners(warnings) {
  const file = path.join(CONFIG_DIR, 'task-owners.yaml');
  const map = {};
  if (!fs.existsSync(file)) return { file: file, map: map, exists: false };
  let doc;
  try { doc = parseYaml(fs.readFileSync(file, 'utf8')); }
  catch (e) { warnings.push('task-owners.yaml: ошибка разбора — ' + e.message); return { file: file, map: map, exists: true }; }
  const block = doc && doc.owners && typeof doc.owners === 'object' ? doc.owners : (doc || {});
  for (const k of Object.keys(block)) {
    const v = block[k];
    if (typeof v === 'string') map[k] = { owner: v, group: null, category: null };
    else if (v && typeof v === 'object') {
      map[k] = {
        owner: v.owner !== undefined && v.owner !== null ? String(v.owner) : null,
        group: v.group !== undefined && v.group !== null ? String(v.group) : null,
        category: v.category !== undefined && v.category !== null ? String(v.category) : null,
      };
    }
  }
  return { file: file, map: map, exists: true };
}

function projectLabelFor(session, workspaceRoot) {
  const cwd = session.cwd ? String(session.cwd) : '';
  if (cwd && workspaceRoot && cwd.toLowerCase() === String(workspaceRoot).toLowerCase()) {
    return { key: 'marketing-agents', label: 'marketing-agents (наш проект)' };
  }
  const parts = cwd.split(/[\\/]+/).filter(Boolean);
  const tail = parts.length >= 2 ? parts.slice(-2).join('/') : (parts[0] || 'неизвестно');
  return { key: cwd || 'unknown', label: tail };
}

function topTools(toolUsage, limit) {
  return Object.keys(toolUsage)
    .map(function (k) { return { name: k, count: toolUsage[k] }; })
    .sort(function (a, b) { return b.count - a.count; })
    .slice(0, limit);
}

export function buildAll(ctx) {
  const sessionsData = ctx.sessionsData;
  const prices = ctx.prices;
  const links = ctx.links;
  const warnings = ctx.warnings;
  const agentsReg = ctx.agentsReg;
  const projectsReg = ctx.projectsReg;
  const tasksReg = ctx.tasksReg;
  const workspaceRoot = ctx.workspaceRoot || WORKSPACE_ROOT;

  const unpricedModels = {};
  const allModels = {};
  const allDays = {};
  const sessionsOut = [];

  function modelCost(modelKey, provider, model, tokens, tokensPeak) {
    const c = costOf(prices, model, tokens, tokensPeak);
    const known = c.priceKnown;
    if (!allModels[modelKey]) {
      allModels[modelKey] = { model: model, provider: provider, tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 }, usd: 0, rub: 0, priceKnown: known, sessions: 0 };
    }
    const m = allModels[modelKey];
    m.tokens.inputTokens += tokens.inputTokens || 0;
    m.tokens.outputTokens += tokens.outputTokens || 0;
    m.tokens.cacheReadTokens += tokens.cacheReadTokens || 0;
    m.tokens.cacheWriteTokens += tokens.cacheWriteTokens || 0;
    m.tokens.totalTokens += tokens.totalTokens || 0;
    if (known) {
      m.usd += c.usd || 0;
      if (c.rub !== null) m.rub += c.rub;
      else m.rub = null;
    } else if (tokens.totalTokens > 0) {
      unpricedModels[modelKey] = true;
      m.rub = null;
    }
    return c;
  }

  // ---- per session ----
  for (const s of sessionsData.sessions) {
    const pl = projectLabelFor(s, workspaceRoot);
    const models = [];
    let usd = 0;
    let rub = 0;
    let anyPriced = false;
    let allPriced = true;
    for (const mk of Object.keys(s.tokensByModel)) {
      const entry = s.tokensByModel[mk];
      const c = modelCost(mk, entry.provider, entry.model, entry.tokens, entry.tokensPeak);
      models.push({ key: mk, model: entry.model, provider: entry.provider, tokens: entry.tokens, usd: round4(c.usd), rub: c.rub === null ? null : round2(c.rub), priceKnown: c.priceKnown });
      if (c.priceKnown) { anyPriced = true; usd += c.usd || 0; if (c.rub !== null) rub += c.rub; else allPriced = false; }
      else if (entry.tokens.totalTokens > 0) allPriced = false;
    }
    models.sort(function (a, b) { return b.tokens.totalTokens - a.tokens.totalTokens; });
    const primary = models.length > 0 ? models[0] : null;

    // daily buckets
    for (const dk of Object.keys(s.tokensByDay)) {
      const day = s.tokensByDay[dk];
      if (!allDays[dk]) allDays[dk] = { date: dk, tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 }, peakTokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalTokens: 0 }, usd: 0, rub: 0, rubComplete: true, anyPriced: false, byModel: {}, sessions: {} };
      const d = allDays[dk];
      d.tokens.inputTokens += day.inputTokens || 0;
      d.tokens.outputTokens += day.outputTokens || 0;
      d.tokens.cacheReadTokens += day.cacheReadTokens || 0;
      d.tokens.cacheWriteTokens += day.cacheWriteTokens || 0;
      d.tokens.totalTokens += day.totalTokens || 0;
      if (day.tokensPeak) {
        d.peakTokens.inputTokens += day.tokensPeak.inputTokens || 0;
        d.peakTokens.outputTokens += day.tokensPeak.outputTokens || 0;
        d.peakTokens.cacheReadTokens += day.tokensPeak.cacheReadTokens || 0;
        d.peakTokens.totalTokens += day.tokensPeak.totalTokens || 0;
      }
      d.sessions[s.id] = true;
      const bm = day.byModel || {};
      for (const mk of Object.keys(bm)) {
        const e = bm[mk];
        const c = costOf(prices, e.model, e.tokens, e.tokensPeak);
        if (c.priceKnown) { d.anyPriced = true; d.usd += c.usd || 0; if (c.rub !== null) d.rub += c.rub; else d.rubComplete = false; }
        else d.rubComplete = false;
        if (!d.byModel[mk]) d.byModel[mk] = { model: e.model, provider: e.provider, tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 }, usd: 0, rub: 0, priceKnown: c.priceKnown };
        const dm = d.byModel[mk];
        dm.tokens.inputTokens += e.tokens.inputTokens || 0;
        dm.tokens.outputTokens += e.tokens.outputTokens || 0;
        dm.tokens.cacheReadTokens += e.tokens.cacheReadTokens || 0;
        dm.tokens.totalTokens += e.tokens.totalTokens || 0;
        if (c.priceKnown) { dm.usd += c.usd || 0; if (c.rub !== null) dm.rub += c.rub; }
      }
    }

    sessionsOut.push({
      id: s.id,
      title: s.title,
      agentName: s.agentName,
      member: s.memberRecord ? { name: s.memberRecord.name, description: s.memberRecord.description, phase: s.memberRecord.phase } : null,
      descriptor: s.descriptor,
      projectKey: pl.key,
      projectLabel: pl.label,
      cwd: s.cwd,
      createdAt: s.createdAt,
      firstTime: s.firstTime,
      lastTime: s.lastTime,
      origin: s.origin,
      delegationDepth: s.delegationDepth,
      parentSession: s.parentSession,
      agentPreset: s.agentPreset,
      isSubagent: s.origin === 'subagent',
      model: primary ? primary.model : null,
      provider: primary ? primary.provider : null,
      models: models,
      tokens: s.tokens,
      usd: anyPriced ? round4(usd) : null,
      rub: anyPriced ? round2(rub) : null,
      rubComplete: allPriced,
      priceKnown: anyPriced,
      events: s.events,
      steps: s.steps,
      turns: s.turns,
      toolCalls: s.toolCalls,
      toolErrors: s.toolErrors,
      userMessages: s.userMessages,
      assistantMessages: s.assistantMessages,
      badLines: s.badLines,
      badFrames: s.badFrames,
      projcacheTokens: s.projcache ? s.projcache.tokens : null,
      projcacheDelta: s.projcacheDelta === undefined ? null : round4(s.projcacheDelta),
      topTools: topTools(s.toolUsage, 8),
      sizeBytes: s.sizeBytes,
    });
  }
  sessionsOut.sort(function (a, b) { return (b.lastTime || 0) - (a.lastTime || 0); });

  // ---- agent buckets (by session agentName) ----
  const byAgent = {};
  for (const s of sessionsOut) {
    const name = s.agentName || 'неизвестно';
    if (!byAgent[name]) byAgent[name] = { name: name, tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 }, usd: 0, rub: 0, rubComplete: true, anyPriced: false, sessions: 0, sessionIds: [], lastActivityAt: 0, firstActivityAt: null, projects: {}, kinds: {} };
    const a = byAgent[name];
    a.tokens.inputTokens += s.tokens.inputTokens || 0;
    a.tokens.outputTokens += s.tokens.outputTokens || 0;
    a.tokens.cacheReadTokens += s.tokens.cacheReadTokens || 0;
    a.tokens.cacheWriteTokens += s.tokens.cacheWriteTokens || 0;
    a.tokens.totalTokens += s.tokens.totalTokens || 0;
    if (s.priceKnown && s.usd !== null) { a.anyPriced = true; a.usd += s.usd; a.rub += s.rub || 0; if (s.rubComplete === false) a.rubComplete = false; }
    else if (s.tokens.totalTokens > 0) a.rubComplete = false;
    a.sessions++;
    a.sessionIds.push(s.id);
    if ((s.lastTime || 0) > a.lastActivityAt) a.lastActivityAt = s.lastTime || 0;
    if (s.firstTime && (a.firstActivityAt === null || s.firstTime < a.firstActivityAt)) a.firstActivityAt = s.firstTime;
    a.projects[s.projectLabel] = (a.projects[s.projectLabel] || 0) + 1;
    a.kinds[s.origin] = (a.kinds[s.origin] || 0) + 1;
  }

  // ---- agents.json ----
  const membersOut = sessionsData.members.map(function (m) {
    const bucket = byAgent[m.name] || null;
    const ms = sessionsOut.filter(function (s) { return s.agentName === m.name; });
    const isSystem = (links.system || []).indexOf(m.name) >= 0;
    let registryAgentId = null;
    for (const id of Object.keys(links.map)) {
      if (links.map[id].indexOf(m.name) >= 0) { registryAgentId = id; break; }
    }
    return {
      id: m.id,
      kind: isSystem ? 'system' : (registryAgentId ? 'product' : 'other'),
      registryAgentId: registryAgentId,
      name: m.name,
      description: m.description,
      provider: m.provider,
      context: m.context,
      phase: m.phase,
      teamId: m.teamId,
      sessions: ms.length,
      tokens: bucket ? bucket.tokens : { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 },
      usd: bucket ? round4(bucket.usd) : 0,
      rub: bucket && bucket.anyPriced ? round2(bucket.rub) : null,
      rubComplete: bucket ? bucket.rubComplete : true,
      lastActivityAt: bucket ? bucket.lastActivityAt : null,
      sessionIds: bucket ? bucket.sessionIds : [],
    };
  });
  membersOut.sort(function (a, b) { return b.tokens.totalTokens - a.tokens.totalTokens; });

  const agentsOut = agentsReg.agents.map(function (a) {
    const linkedNames = (links.map[a.id] || []).slice();
    const linked = membersOut.filter(function (m) { return linkedNames.indexOf(m.name) >= 0; });
    const linkedTokens = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 };
    let linkedUsd = 0;
    let linkedRub = 0;
    let rubComplete = true;
    let lastActivityAt = 0;
    let sessionCount = 0;
    for (const m of linked) {
      linkedTokens.inputTokens += m.tokens.inputTokens;
      linkedTokens.outputTokens += m.tokens.outputTokens;
      linkedTokens.cacheReadTokens += m.tokens.cacheReadTokens;
      linkedTokens.cacheWriteTokens += m.tokens.cacheWriteTokens;
      linkedTokens.totalTokens += m.tokens.totalTokens;
      linkedUsd += m.usd || 0;
      if (m.rub === null) rubComplete = false; else linkedRub += m.rub;
      if ((m.lastActivityAt || 0) > lastActivityAt) lastActivityAt = m.lastActivityAt || 0;
      sessionCount += m.sessions;
    }
    const myTasks = ctx.allTasks.filter(function (t) { return t.owner === a.id || (t.ownerName && linkedNames.indexOf(t.ownerName) >= 0); });
    const byStatus = {};
    for (const t of myTasks) byStatus[t.status] = (byStatus[t.status] || 0) + 1;
    return Object.assign({}, a, {
      linkedMembers: linked.map(function (m) { return m.name; }),
      linkConfigured: linkedNames.length > 0,
      metrics: {
        tasks: { total: myTasks.length, byStatus: byStatus },
        sessions: sessionCount,
        tokens: linkedTokens,
        usd: round4(linkedUsd),
        rub: linkedTokens.totalTokens > 0 ? round2(linkedRub) : null,
        rubComplete: rubComplete,
        lastActivityAt: lastActivityAt || null,
        priceKnown: linkedTokens.totalTokens > 0 ? linkedUsd > 0 : false,
      },
    });
  });

  const agentsSummary = {
    total: agentsOut.length,
    enabled: agentsOut.filter(function (a) { return a.enabled; }).length,
    disabled: agentsOut.filter(function (a) { return !a.enabled; }).length,
    active: agentsOut.filter(function (a) { return a.status === 'active'; }).length,
    planned: agentsOut.filter(function (a) { return a.status === 'planned'; }).length,
    membersTotal: membersOut.length,
    membersActive: membersOut.filter(function (m) { return m.phase === 'active'; }).length,
  };

  // ---- usage.json ----
  const dayList = Object.keys(allDays).sort().map(function (dk) {
    const d = allDays[dk];
    const byModel = Object.keys(d.byModel).map(function (mk) {
      const m = d.byModel[mk];
      return { key: mk, model: m.model, provider: m.provider, tokens: m.tokens, usd: round4(m.usd), rub: m.priceKnown ? round2(m.rub) : null, priceKnown: m.priceKnown };
    }).sort(function (a, b) { return b.tokens.totalTokens - a.tokens.totalTokens; });
    return {
      date: dk,
      tokens: d.tokens,
      peakTokens: d.peakTokens,
      usd: d.anyPriced ? round4(d.usd) : null,
      rub: d.anyPriced ? round2(d.rub) : null,
      rubComplete: d.rubComplete,
      sessions: Object.keys(d.sessions).length,
      byModel: byModel,
    };
  });

  const modelList = Object.keys(allModels).map(function (mk) {
    const m = allModels[mk];
    return { key: mk, model: m.model, provider: m.provider, tokens: m.tokens, usd: round4(m.usd), rub: m.priceKnown ? round2(m.rub) : null, priceKnown: m.priceKnown };
  }).sort(function (a, b) { return b.tokens.totalTokens - a.tokens.totalTokens; });

  const agentList = Object.keys(byAgent).map(function (k) {
    const a = byAgent[k];
    return { name: a.name, tokens: a.tokens, usd: a.anyPriced ? round4(a.usd) : null, rub: a.anyPriced ? round2(a.rub) : null, rubComplete: a.rubComplete, sessions: a.sessions, lastActivityAt: a.lastActivityAt, projects: a.projects, kinds: a.kinds };
  }).sort(function (a, b) { return b.tokens.totalTokens - a.tokens.totalTokens; });

  let totalIn = 0, totalOut = 0, totalCache = 0, totalAll = 0, totalUsd = 0, totalRub = 0;
  let rubComplete = true;
  for (const m of modelList) {
    totalIn += m.tokens.inputTokens;
    totalOut += m.tokens.outputTokens;
    totalCache += m.tokens.cacheReadTokens;
    totalAll += m.tokens.totalTokens;
    if (m.priceKnown) { totalUsd += m.usd || 0; if (m.rub === null) rubComplete = false; else totalRub += m.rub; }
    else if (m.tokens.totalTokens > 0) rubComplete = false;
  }

  const anyPricedAtAll = modelList.some(function (m) { return m.priceKnown; });
  const usage = {
    currency: {
      usdRub: prices && typeof prices.usdRub === 'number' ? prices.usdRub : null,
      source: prices ? prices.source : 'none',
      path: prices ? prices.path : null,
      note: prices ? prices.usdRubNote : null,
    },
    pricing: {
      schema: prices ? prices.schema : null,
      fetchedAt: prices ? prices.fetchedAt : null,
      priceKind: prices ? prices.priceKind : null,
      modelCount: prices ? prices.modelCount : 0,
      cachePriceAssumedFor: prices ? prices.cachePriceAssumedFor : [],
      cacheAssumptionNote: prices && prices.cachePriceAssumedFor && prices.cachePriceAssumedFor.length > 0
        ? 'Для части моделей не опубликована цена чтения из кэша — кэш посчитан по цене входа (оценка сверху).'
        : null,
    },
    totals: {
      tokens: { inputTokens: totalIn, outputTokens: totalOut, cacheReadTokens: totalCache, cacheWriteTokens: 0, totalTokens: totalAll },
      usd: anyPricedAtAll ? round4(totalUsd) : null,
      rub: anyPricedAtAll ? round2(totalRub) : null,
      rubComplete: rubComplete,
    },
    peak: {
      multiplier: prices && prices.peakMultiplier ? prices.peakMultiplier : 1,
      windowsUtc: prices ? prices.peakWindowsUtc : [],
      weekdays: prices ? prices.peakWeekdays : [],
      note: prices ? prices.peakNote : null,
      peakTokens: (function () {
        const acc = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalTokens: 0 };
        for (const d of dayList) {
          acc.inputTokens += d.peakTokens.inputTokens;
          acc.outputTokens += d.peakTokens.outputTokens;
          acc.cacheReadTokens += d.peakTokens.cacheReadTokens;
          acc.totalTokens += d.peakTokens.totalTokens;
        }
        return acc;
      })(),
    },
    cache: { cacheReadTokens: totalCache, share: totalAll > 0 ? round4(totalCache / totalAll) : 0 },
    byDay: dayList,
    byModel: modelList,
    byAgent: agentList,
    unknownPriceModels: Object.keys(unpricedModels),
    pricedModelCount: modelList.filter(function (m) { return m.priceKnown; }).length,
  };

  // ---- projects.json ----
  const sessionProjects = {};
  for (const s of sessionsOut) {
    if (!sessionProjects[s.projectKey]) sessionProjects[s.projectKey] = { key: s.projectKey, label: s.projectLabel, cwd: s.cwd, sessions: 0, tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 }, usd: 0, rub: 0, rubComplete: true, anyPriced: false, lastActivityAt: 0, agents: {} };
    const p = sessionProjects[s.projectKey];
    p.sessions++;
    p.tokens.inputTokens += s.tokens.inputTokens || 0;
    p.tokens.outputTokens += s.tokens.outputTokens || 0;
    p.tokens.cacheReadTokens += s.tokens.cacheReadTokens || 0;
    p.tokens.totalTokens += s.tokens.totalTokens || 0;
    if (s.priceKnown && s.usd !== null) { p.anyPriced = true; p.usd += s.usd; p.rub += s.rub || 0; if (s.rubComplete === false) p.rubComplete = false; }
    else if (s.tokens.totalTokens > 0) p.rubComplete = false;
    if ((s.lastTime || 0) > p.lastActivityAt) p.lastActivityAt = s.lastTime || 0;
    p.agents[s.agentName] = (p.agents[s.agentName] || 0) + 1;
  }
  const sessionProjectList = Object.keys(sessionProjects).map(function (k) {
    const p = sessionProjects[k];
    return { key: p.key, label: p.label, cwd: p.cwd, sessions: p.sessions, tokens: p.tokens, usd: p.anyPriced ? round4(p.usd) : null, rub: p.anyPriced ? round2(p.rub) : null, rubComplete: p.rubComplete, lastActivityAt: p.lastActivityAt, agents: Object.keys(p.agents) };
  }).sort(function (a, b) { return b.tokens.totalTokens - a.tokens.totalTokens; });

  const projectsOut = projectsReg.projects.map(function (p) {
    const agentIds = p.agents.slice();
    const linkedMembers = [];
    for (const id of agentIds) {
      const m = links.map[id];
      if (Array.isArray(m)) for (const x of m) linkedMembers.push(x);
    }
    const projectSessions = sessionsOut.filter(function (s) { return linkedMembers.indexOf(s.agentName) >= 0; });
    const tokens = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 };
    let usd = 0, rub = 0, complete = true, last = 0, anyPriced = false;
    for (const s of projectSessions) {
      tokens.inputTokens += s.tokens.inputTokens || 0;
      tokens.outputTokens += s.tokens.outputTokens || 0;
      tokens.cacheReadTokens += s.tokens.cacheReadTokens || 0;
      tokens.totalTokens += s.tokens.totalTokens || 0;
      if (s.priceKnown && s.usd !== null) { anyPriced = true; usd += s.usd; rub += s.rub || 0; if (s.rubComplete === false) complete = false; }
      else if (s.tokens.totalTokens > 0) complete = false;
      if ((s.lastTime || 0) > last) last = s.lastTime || 0;
    }
    const pTasks = ctx.allTasks.filter(function (t) { return t.project === p.id; });
    const byStatus = {};
    for (const t of pTasks) byStatus[t.status] = (byStatus[t.status] || 0) + 1;
    return Object.assign({}, p, {
      agentsDetail: agentIds.map(function (id) {
        const a = agentsOut.find(function (x) { return x.id === id; });
        return a ? { id: a.id, name: a.name, enabled: a.enabled, status: a.status, model: a.model } : { id: id, name: id, enabled: null, status: 'not-in-registry', model: null };
      }),
      linkedMembers: linkedMembers,
      metrics: {
        tasks: { total: pTasks.length, byStatus: byStatus },
        sessions: projectSessions.length,
        tokens: tokens,
        usd: anyPriced ? round4(usd) : null,
        rub: anyPriced ? round2(rub) : null,
        rubComplete: complete,
        lastActivityAt: last || null,
      },
    });
  });

  return {
    agents: { summary: agentsSummary, agents: agentsOut, members: membersOut, registryFile: agentsReg.file, registryUpdated: agentsReg.updated, links: { file: links.file, configured: Object.keys(links.map).length } },
    projects: { projects: projectsOut, sessionProjects: sessionProjectList, registryFile: projectsReg.file },
    sessions: { sessions: sessionsOut, count: sessionsOut.length },
    usage: usage,
  };
}

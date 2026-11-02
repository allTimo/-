// Вкладка «Аналитика»: сквозная связка агент -> задачи -> результат -> расход,
// связь с источниками, динамика по неделям и по проектам.
import { isoWeekOf } from './sources.mjs';

function emptyTokens() { return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalTokens: 0 }; }

export function buildAnalyticsDoc(ctx) {
  const agentsDoc = ctx.agentsDoc;
  const tasksDoc = ctx.tasksDoc;
  const usage = ctx.usage;
  const sourcesDoc = ctx.sourcesDoc;
  const projectsDoc = ctx.projectsDoc;
  const links = ctx.links;
  const warnings = [];

  // агент реестра -> имена исполнителей DSH
  const memberToAgent = {};
  for (const id of Object.keys(links.map)) {
    for (const name of links.map[id]) memberToAgent[name] = id;
  }

  const tasksByAgent = {};
  const tasksByProject = {};
  const tasksByWeekCreated = {};
  const tasksByWeekDone = {};
  for (const t of tasksDoc.tasks) {
    const owner = t.owner || (t.ownerName ? memberToAgent[t.ownerName] : null);
    if (owner) {
      if (!tasksByAgent[owner]) tasksByAgent[owner] = { total: 0, byStatus: {}, byGroup: {} };
      const a = tasksByAgent[owner];
      a.total++;
      a.byStatus[t.status] = (a.byStatus[t.status] || 0) + 1;
      a.byGroup[t.group] = (a.byGroup[t.group] || 0) + 1;
    }
    if (t.project) {
      if (!tasksByProject[t.project]) tasksByProject[t.project] = { total: 0, byStatus: {} };
      tasksByProject[t.project].total++;
      tasksByProject[t.project].byStatus[t.status] = (tasksByProject[t.project].byStatus[t.status] || 0) + 1;
    }
    if (t.createdMs) {
      const w = isoWeekOf(t.createdMs);
      tasksByWeekCreated[w] = (tasksByWeekCreated[w] || 0) + 1;
      if (t.status === 'done') tasksByWeekDone[w] = (tasksByWeekDone[w] || 0) + 1;
    }
  }

  // какие источники «кормит» какой агент: по группам агента и по совпадению
  // названий в списках inputs (registry/agents.yaml -> inputs).
  // Явные связи из dashboard/config/source-agents.yaml имеют приоритет; остальное
  // добираем догадкой по названиям во входах и группах агента.
  const explicit = ctx.sourceAgents || {};
  const sourcesByAgent = {};
  for (const a of agentsDoc.agents) {
    const names = [].concat(a.inputs || [], a.groups || []).join(' ').toLowerCase();
    const hit = {};
    for (const sid of Object.keys(explicit)) {
      if ((explicit[sid] || []).indexOf(a.id) >= 0) hit[sid] = 'config';
    }
    for (const s of sourcesDoc.sources) {
      const id = s.id.toLowerCase();
      const nm = String(s.name).toLowerCase();
      if (names.indexOf(id) >= 0 || names.indexOf(nm) >= 0) hit[s.id] = hit[s.id] || 'inputs';
    }
    sourcesByAgent[a.id] = Object.keys(hit);
  }

  // источники -> агенты, которые их используют (обратная связь)
  const agentsBySource = {};
  for (const sid of Object.keys(sourcesByAgent)) {
    for (const s of sourcesByAgent[sid]) {
      if (!agentsBySource[s]) agentsBySource[s] = [];
      agentsBySource[s].push(sid);
    }
  }

  // расход и токены по агенту (из usage.byAgent — там имена исполнителей)
  const usageByMember = {};
  for (const a of usage.byAgent) usageByMember[a.name] = a;

  const agents = agentsDoc.agents.map(function (a) {
    const t = tasksByAgent[a.id] || { total: 0, byStatus: {}, byGroup: {} };
    const tk = a.metrics.tokens || emptyTokens();
    return {
      id: a.id,
      name: a.name,
      enabled: a.enabled,
      status: a.status,
      model: a.model,
      groups: a.groups || [],
      tasks: {
        total: t.total,
        inProgress: t.byStatus.in_progress || 0,
        done: t.byStatus.done || 0,
        blocked: t.byStatus.blocked || 0,
        unassigned: t.byStatus.unassigned || 0,
        new: t.byStatus.new || 0,
        byGroup: t.byGroup,
      },
      tokens: tk,
      rub: a.metrics.rub,
      rubComplete: a.metrics.rubComplete !== false,
      usd: a.metrics.usd,
      sessions: a.metrics.sessions,
      lastActivityAt: a.metrics.lastActivityAt,
      linkedMembers: a.linkedMembers || [],
      sources: sourcesByAgent[a.id] || [],
      projects: (a.projects && a.projects.length) ? a.projects : projectsDoc.projects.map(function (p) { return p.id; }),
      priceKnown: a.metrics.priceKnown,
    };
  });

  const sources = sourcesDoc.sources.map(function (s) {
    const agentIds = agentsBySource[s.id] || [];
    let rub = 0;
    let tokens = 0;
    let any = false;
    let complete = true;
    for (const id of agentIds) {
      const a = agents.filter(function (x) { return x.id === id; })[0];
      if (!a) continue;
      any = true;
      tokens += a.tokens.totalTokens || 0;
      if (a.rub === null || a.rub === undefined) complete = false; else rub += a.rub;
      if (a.rubComplete === false) complete = false;
    }
    return {
      id: s.id,
      name: s.name,
      enabled: s.enabled,
      kind: s.kind,
      status: s.status,
      lots: s.stats.lots,
      snapshots: s.stats.snapshots,
      share: s.stats.share,
      lastDate: s.stats.lastDate,
      agents: agentIds,
      agentsTokens: tokens,
      agentsRub: any ? rub : null,
      agentsRubComplete: complete,
      costPerLot: (any && s.stats.lots > 0 && complete) ? rub / s.stats.lots : null,
    };
  });

  // недели: лоты + расход + задачи
  const weekMap = {};
  function week(w) {
    if (!weekMap[w]) weekMap[w] = { week: w, lots: 0, tokens: 0, rub: 0, rubComplete: true, tasksCreated: 0, tasksDone: 0 };
    return weekMap[w];
  }
  for (const w of sourcesDoc.byWeek) {
    const e = week(w.week);
    e.lots += w.lots;
  }
  for (const d of usage.byDay) {
    const e = week(isoWeekOf(d.date));
    e.tokens += d.tokens.totalTokens || 0;
    if (d.rub === null || d.rub === undefined) e.rubComplete = false; else e.rub += d.rub;
  }
  for (const w of Object.keys(tasksByWeekCreated)) week(w).tasksCreated += tasksByWeekCreated[w];
  for (const w of Object.keys(tasksByWeekDone)) week(w).tasksDone += tasksByWeekDone[w];
  const weeks = Object.keys(weekMap).map(function (k) { return weekMap[k]; }).sort(function (a, b) { return a.week < b.week ? -1 : 1; });

  const projects = projectsDoc.projects.map(function (p) {
    const t = tasksByProject[p.id] || { total: 0, byStatus: {} };
    return {
      id: p.id,
      name: p.name,
      agents: p.agents,
      tasks: { total: t.total, done: t.byStatus.done || 0, inProgress: t.byStatus.in_progress || 0 },
      tokens: p.metrics.tokens,
      rub: p.metrics.rub,
      rubComplete: p.metrics.rubComplete !== false,
    };
  });

  const funnel = {
    agents: agents.length,
    agentsEnabled: agents.filter(function (a) { return a.enabled; }).length,
    tasks: tasksDoc.counts.total,
    tasksInProgress: tasksDoc.counts.inProgress,
    tasksDone: tasksDoc.counts.done,
    tasksUnassigned: tasksDoc.counts.unassigned,
    sources: sourcesDoc.summary.total,
    sourcesEnabled: sourcesDoc.summary.enabled,
    lots: sourcesDoc.summary.totalLots,
    tokens: usage.totals.tokens.totalTokens,
    rub: usage.totals.rub,
    rubComplete: usage.totals.rubComplete,
  };

  if (tasksDoc.counts.total > 0 && Object.keys(tasksByAgent).length === 0) {
    warnings.push('Ни у одной задачи нет исполнителя из реестра — воронка «агент -> задачи» пустая');
  }

  return {
    generatedAtMs: ctx.generatedAtMs || Date.now(),
    funnel: funnel,
    agents: agents,
    sources: sources,
    weeks: weeks,
    days: usage.byDay.map(function (d) { return { d: d.date, tokens: d.tokens.totalTokens, rub: d.rub }; }),
    projects: projects,
    notes: [
      'Расход считается по событиям assistant/message в логах сессий и привязывается к исполнителю DSH, а затем к агенту реестра через dashboard/config/links.yaml.',
      'Расход по источнику — это сумма расхода агентов, которые его используют. Это не «цена за лот»: лоты и токены считаются разными механизмами.',
      'Задачи из логов DSH не имеют даты создания — для недельной динамики берётся время первого появления задачи в логе.',
      'Модель без цены в прайсе помечается «цена неизвестна», её токены считаются, а рубли — нет.'
    ],
    warnings: warnings,
  };
}

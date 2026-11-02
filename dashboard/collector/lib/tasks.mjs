// Unified task list: registry/tasks/*.yaml + team/task events from DSH logs,
// folded into a group -> category -> task tree for the UI.
import { normalizeStatus } from './aggregate.mjs';

const GROUP_ORDER = ['Мониторинг', 'Конкуренты', 'Директ', 'Семантика', 'Креативы', 'Аналитика', 'Сборка системы', 'Без группы'];

export function buildTasks(ctx) {
  const tasksReg = ctx.tasksReg;
  const teamTasks = ctx.teamTasks || [];
  const agentsReg = ctx.agentsReg;
  const links = ctx.links;
  const today = ctx.today || new Date().toISOString().slice(0, 10);

  const memberToAgent = {};
  for (const id of Object.keys(links.map)) {
    for (const name of links.map[id]) memberToAgent[name] = id;
  }
  const agentById = {};
  for (const a of agentsReg.agents) agentById[a.id] = a;

  const unified = [];

  for (const t of tasksReg.tasks) {
    const status = normalizeStatus(t.status);
    unified.push({
      id: t.id,
      subject: t.subject,
      group: t.group || 'Без группы',
      category: t.category || 'Без категории',
      owner: t.owner,
      ownerLabel: t.owner ? (agentById[t.owner] ? agentById[t.owner].name : t.owner) : null,
      status: status,
      statusRaw: t.status,
      project: t.project,
      due: t.due,
      overdue: !!(t.due && t.due < today && status !== 'done'),
      source: t.source,
      created: t.created,
      createdMs: t.created ? (Date.parse(String(t.created) + 'T12:00:00') || null) : null,
      quote: t.quote,
      origin: 'registry',
      originLabel: 'реестр',
      file: t.file,
      ownerUnknown: !t.owner,
      revision: null,
      description: null,
      writeScopes: [],
      blockedBy: [],
    });
  }

  const ownerMap = (ctx.taskOwners && ctx.taskOwners.map) ? ctx.taskOwners.map : {};
  for (const t of teamTasks) {
    const entry = ownerMap[t.id] || null;
    const ownerName = t.ownerName || (entry ? entry.owner : null);
    const agentId = ownerName ? memberToAgent[ownerName] : null;
    const agent = agentId ? agentById[agentId] : null;
    // Team tasks from the DSH log are build/operations tasks of the agent team.
    // An explicit group/category in dashboard/config/task-owners.yaml wins.
    const group = (entry && entry.group) ? entry.group : 'Сборка системы';
    const category = (entry && entry.category) ? entry.category : 'Задачи команды';
    const status = normalizeStatus(t.status);
    const firstLine = String(t.description || '').split('\n').filter(function (l) { return l.trim() !== ''; })[0] || '';
    unified.push({
      id: t.id,
      subject: t.subject,
      group: group,
      category: category,
      owner: agentId,
      ownerLabel: agent ? agent.name : null,
      ownerName: ownerName,
      status: status,
      statusRaw: t.status,
      project: agent && agent.projects && agent.projects.length === 1 ? agent.projects[0] : null,
      due: null,
      overdue: false,
      source: 'dsh-session',
      created: null,
      createdMs: t.firstAt || t.at || null,
      quote: null,
      origin: 'dsh',
      originLabel: 'лог DSH',
      file: null,
      ownerUnknown: !ownerName,
      revision: t.revision,
      description: String(t.description || '').slice(0, 1200),
      descriptionFirstLine: firstLine,
      writeScopes: t.writeScopes || [],
      blockedBy: t.blockedBy || [],
    });
  }

  unified.sort(function (a, b) {
    const ai = GROUP_ORDER.indexOf(a.group);
    const bi = GROUP_ORDER.indexOf(b.group);
    const ag = ai === -1 ? 99 : ai;
    const bg = bi === -1 ? 99 : bi;
    if (ag !== bg) return ag - bg;
    if (a.group !== b.group) return a.group < b.group ? -1 : 1;
    if (a.category !== b.category) return a.category < b.category ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  });

  const groupMap = {};
  for (const t of unified) {
    if (!groupMap[t.group]) groupMap[t.group] = { group: t.group, categories: {}, total: 0, byStatus: {} };
    const g = groupMap[t.group];
    if (!g.categories[t.category]) g.categories[t.category] = { category: t.category, tasks: [], byStatus: {}, total: 0 };
    const c = g.categories[t.category];
    c.tasks.push(t);
    c.total++;
    c.byStatus[t.status] = (c.byStatus[t.status] || 0) + 1;
    g.total++;
    g.byStatus[t.status] = (g.byStatus[t.status] || 0) + 1;
  }

  const tree = Object.keys(groupMap).map(function (k) {
    const g = groupMap[k];
    return {
      group: g.group,
      total: g.total,
      byStatus: g.byStatus,
      categories: Object.keys(g.categories).map(function (ck) { return g.categories[ck]; }).sort(function (a, b) { return a.category < b.category ? -1 : 1; }),
    };
  }).sort(function (a, b) {
    const ai = GROUP_ORDER.indexOf(a.group);
    const bi = GROUP_ORDER.indexOf(b.group);
    const ag = ai === -1 ? 99 : ai;
    const bg = bi === -1 ? 99 : bi;
    if (ag !== bg) return ag - bg;
    return a.group < b.group ? -1 : 1;
  });

  const byStatus = {};
  const byOrigin = {};
  const owners = {};
  for (const t of unified) {
    byStatus[t.status] = (byStatus[t.status] || 0) + 1;
    byOrigin[t.origin] = (byOrigin[t.origin] || 0) + 1;
    const o = t.ownerLabel || t.ownerName || 'без исполнителя';
    owners[o] = (owners[o] || 0) + 1;
  }

  // 'требует уточнения' is a registry concept: a task whose owner is genuinely unclear.
  // DSH log tasks carry no owner field at all, so they are reported separately instead.
  const unassigned = unified.filter(function (t) {
    if (t.origin === 'dsh') return false;
    return t.status === 'unassigned' || !t.owner;
  });

  return {
    tasks: unified,
    tree: tree,
    unassigned: unassigned,
    counts: {
      total: unified.length,
      byStatus: byStatus,
      byOrigin: byOrigin,
      overdue: unified.filter(function (t) { return t.overdue; }).length,
      unassigned: unassigned.length,
      ownerUnknown: unified.filter(function (t) { return t.ownerUnknown; }).length,
      inProgress: byStatus.in_progress || 0,
      done: byStatus.done || 0,
    },
    owners: Object.keys(owners).map(function (k) { return { name: k, count: owners[k] }; }).sort(function (a, b) { return b.count - a.count; }),
    sources: {
      registry: { dir: tasksReg.dir, exists: tasksReg.exists, files: tasksReg.files, count: tasksReg.tasks.length },
      dsh: { count: teamTasks.length, note: 'задачи из событий team/task в логах DSH-сессий' },
    },
  };
}

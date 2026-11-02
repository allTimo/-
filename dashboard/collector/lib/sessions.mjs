// Reads DSH session logs (multi-frame zstd + JSONL) and the session projection
// cache. Tolerates corrupt frames and truncated lines: nothing here may throw.
import fs from 'node:fs';
import path from 'node:path';
import { decompressSessionFile, parseJsonl } from './zstd-frames.mjs';
import { listSessionFiles, PROJCACHE_ROOT } from './paths.mjs';
import { isPeak } from './pricing.mjs';

function emptyTokens() {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 };
}

function addTokens(target, src) {
  target.inputTokens += Number(src.inputTokens || 0);
  target.outputTokens += Number(src.outputTokens || 0);
  target.cacheReadTokens += Number(src.cacheReadTokens || 0);
  target.cacheWriteTokens += Number(src.cacheWriteTokens || 0);
  target.totalTokens += Number(src.totalTokens || 0);
  return target;
}

export function dayKey(ms) {
  const d = new Date(Number(ms));
  if (isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

function modelKeyOf(provider, model) {
  if (!model) return 'unknown';
  if (provider && String(model).indexOf('/') === -1) return String(provider) + '/' + String(model);
  return String(model);
}

function toolResultFailed(data) {
  if (!data) return false;
  if (data.isError === true || data.error === true) return true;
  if (typeof data.error === 'string' && data.error !== '') return true;
  const r = data.result;
  if (r && typeof r === 'object' && r.isError === true) return true;
  return false;
}

export function parseSession(sessionId, file, projectKey, warnings, prices) {
  const rec = {
    id: sessionId,
    projectKey: projectKey,
    file: file,
    sizeBytes: 0,
    cwd: null,
    createdAt: null,
    parentSession: null,
    origin: 'root',
    delegationDepth: 0,
    agentPreset: null,
    title: null,
    events: 0,
    badLines: 0,
    frames: 0,
    badFrames: 0,
    firstTime: null,
    lastTime: null,
    turns: 0,
    steps: 0,
    toolCalls: 0,
    toolResults: 0,
    toolErrors: 0,
    userMessages: 0,
    assistantMessages: 0,
    tokens: emptyTokens(),
    tokensPeak: emptyTokens(),
    tokensByModel: {},
    tokensByDay: {},
    toolUsage: {},
    members: [],
    tasks: [],
    descriptor: null,
    modelSelection: null,
    projcache: null,
    agentName: null,
  };

  let decompressed;
  try {
    decompressed = decompressSessionFile(file);
  } catch (e) {
    warnings.push('session ' + sessionId + ': не удалось прочитать файл (' + e.message + ')');
    return rec;
  }
  rec.sizeBytes = decompressed.bytes;
  rec.frames = decompressed.frames;
  rec.badFrames = decompressed.badFrames;
  if (decompressed.badFrames > 0) {
    warnings.push('session ' + sessionId + ': ' + decompressed.badFrames + ' zstd-фреймов не распаковались (файл повреждён или ещё пишется)');
  }
  const parsed = parseJsonl(decompressed.text);
  rec.badLines = parsed.badLines;
  if (parsed.badLines > 0) {
    warnings.push('session ' + sessionId + ': ' + parsed.badLines + ' строк не разобрались как JSON — пропущены');
  }

  const membersById = {};
  for (const ev of parsed.events) {
    rec.events++;
    const t = ev.time !== undefined ? Number(ev.time) : null;
    if (t !== null && !isNaN(t)) {
      if (rec.firstTime === null || t < rec.firstTime) rec.firstTime = t;
      if (rec.lastTime === null || t > rec.lastTime) rec.lastTime = t;
    }
    const data = ev.data || {};
    switch (ev.type) {
      case 'session':
        rec.id = ev.id !== undefined ? String(ev.id) : rec.id;
        rec.cwd = ev.cwd !== undefined ? String(ev.cwd) : null;
        rec.createdAt = ev.createdAt !== undefined ? Number(ev.createdAt) : null;
        rec.parentSession = ev.parentSession !== undefined && ev.parentSession !== null ? String(ev.parentSession) : null;
        rec.origin = ev.origin !== undefined && ev.origin !== null ? String(ev.origin) : 'root';
        rec.delegationDepth = ev.delegationDepth !== undefined ? Number(ev.delegationDepth) : 0;
        rec.agentPreset = ev.agentPreset !== undefined && ev.agentPreset !== null ? String(ev.agentPreset) : null;
        break;
      case 'subagent/descriptor':
        rec.descriptor = {
          label: data.label !== undefined ? String(data.label) : null,
          mode: data.mode !== undefined ? String(data.mode) : null,
          provider: data.agentProvider !== undefined ? String(data.agentProvider) : null,
          model: data.agentModel !== undefined ? String(data.agentModel) : null,
        };
        break;
      case 'session/title':
        if (data.title !== undefined && data.title !== null) {
          rec.title = String(data.title);
          rec.titleSource = data.source && data.source.kind ? String(data.source.kind) : null;
        }
        break;
      case 'model/selection':
        rec.modelSelection = {
          provider: data.provider !== undefined ? String(data.provider) : null,
          model: data.model !== undefined ? String(data.model) : null,
        };
        break;
      case 'assistant/message': {
        rec.assistantMessages++;
        const usage = data.usage;
        const src = data.message && data.message.source ? data.message.source : {};
        const provider = src.provider !== undefined && src.provider !== null ? String(src.provider)
          : (rec.modelSelection ? rec.modelSelection.provider : null);
        const model = src.model !== undefined && src.model !== null ? String(src.model)
          : (rec.modelSelection ? rec.modelSelection.model : null);
        if (usage && typeof usage === 'object') {
          const tk = {
            inputTokens: Number(usage.inputTokens || 0),
            outputTokens: Number(usage.outputTokens || 0),
            cacheReadTokens: Number(usage.cacheReadTokens || 0),
            cacheWriteTokens: Number(usage.cacheWriteTokens || 0),
            totalTokens: Number(usage.totalTokens || 0),
          };
          if (tk.totalTokens === 0) tk.totalTokens = tk.inputTokens + tk.outputTokens + tk.cacheReadTokens;
          const peak = t !== null && isPeak(t, prices);
          addTokens(rec.tokens, tk);
          const mk = modelKeyOf(provider, model);
          if (!rec.tokensByModel[mk]) rec.tokensByModel[mk] = { provider: provider, model: model, tokens: emptyTokens(), tokensPeak: emptyTokens() };
          addTokens(rec.tokensByModel[mk].tokens, tk);
          if (peak) { addTokens(rec.tokensByModel[mk].tokensPeak, tk); addTokens(rec.tokensPeak, tk); }
          const dk = t !== null ? dayKey(t) : null;
          if (dk) {
            if (!rec.tokensByDay[dk]) rec.tokensByDay[dk] = Object.assign(emptyTokens(), { tokensPeak: emptyTokens() });
            addTokens(rec.tokensByDay[dk], tk);
            rec.tokensByDay[dk].byModel = rec.tokensByDay[dk].byModel || {};
            if (!rec.tokensByDay[dk].byModel[mk]) rec.tokensByDay[dk].byModel[mk] = { provider: provider, model: model, tokens: emptyTokens(), tokensPeak: emptyTokens() };
            addTokens(rec.tokensByDay[dk].byModel[mk].tokens, tk);
            if (peak) {
              addTokens(rec.tokensByDay[dk].byModel[mk].tokensPeak, tk);
              addTokens(rec.tokensByDay[dk].tokensPeak, tk);
            }
          }
        }
        break;
      }
      case 'user/message':
        rec.userMessages++;
        break;
      case 'tool/call': {
        rec.toolCalls++;
        const name = data.name !== undefined ? String(data.name) : 'unknown';
        rec.toolUsage[name] = (rec.toolUsage[name] || 0) + 1;
        break;
      }
      case 'tool/result':
        rec.toolResults++;
        if (toolResultFailed(data)) rec.toolErrors++;
        break;
      case 'step/start':
        rec.steps++;
        break;
      case 'turn/end':
        rec.turns++;
        break;
      case 'team/member': {
        const m = data.member;
        if (m && m.id) {
          membersById[String(m.id)] = {
            id: String(m.id),
            name: m.name !== undefined ? String(m.name) : null,
            description: m.description !== undefined ? String(m.description) : null,
            provider: m.provider !== undefined ? String(m.provider) : null,
            context: m.context !== undefined ? String(m.context) : null,
            phase: m.phase !== undefined ? String(m.phase) : null,
            teamId: data.teamId !== undefined ? String(data.teamId) : null,
          };
        }
        break;
      }
      case 'team/task': {
        const tk = data.task;
        if (tk && tk.id) {
          const existing = rec.tasks.find(function (x) { return x.id === String(tk.id); });
          const record = {
            id: String(tk.id),
            revision: tk.revision !== undefined ? Number(tk.revision) : 0,
            subject: tk.subject !== undefined ? String(tk.subject) : String(tk.id),
            description: tk.description !== undefined ? String(tk.description) : '',
            status: tk.status !== undefined ? String(tk.status) : 'unknown',
            ownerName: tk.ownerName !== undefined && tk.ownerName !== null ? String(tk.ownerName) : null,
            blockedBy: Array.isArray(tk.blockedBy) ? tk.blockedBy.map(String) : [],
            writeScopes: Array.isArray(tk.writeScopes) ? tk.writeScopes.map(String) : [],
            teamId: data.teamId !== undefined ? String(data.teamId) : null,
            at: t,
            firstAt: t,
          };
          if (existing) {
            if (record.revision >= existing.revision) {
              const keepFirst = existing.firstAt;
              Object.assign(existing, record);
              if (keepFirst && (!existing.firstAt || keepFirst < existing.firstAt)) existing.firstAt = keepFirst;
            }
          }
          else rec.tasks.push(record);
        }
        break;
      }
      default:
        break;
    }
  }
  rec.members = Object.keys(membersById).map(function (k) { return membersById[k]; });
  if (rec.tokens.totalTokens === 0) {
    rec.tokens.totalTokens = rec.tokens.inputTokens + rec.tokens.outputTokens + rec.tokens.cacheReadTokens;
  }
  return rec;
}

export function readProjcache(sessionId, warnings) {
  const file = path.join(PROJCACHE_ROOT, sessionId + '.json');
  if (!fs.existsSync(file)) return null;
  let doc;
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { warnings.push('projcache ' + sessionId + ': не удалось разобрать (' + e.message + ')'); return null; }
  const rows = doc && doc.record && doc.record.rows ? doc.record.rows : {};
  function val(key) { return rows[key] && rows[key].val !== undefined ? rows[key].val : null; }
  const tu = val('tokenUsage');
  const stats = val('sessionStats');
  const team = val('agentTeam');
  const ms = val('modelSelection');
  return {
    file: file,
    title: val('title'),
    tokens: tu && tu.totals ? {
      inputTokens: Number(tu.totals.uncachedInputTokens || 0),
      outputTokens: Number(tu.totals.outputTokens || 0),
      cacheReadTokens: Number(tu.totals.cacheReadTokens || 0),
      cacheWriteTokens: Number(tu.totals.cacheWriteTokens || 0),
      totalTokens: Number(tu.totals.uncachedInputTokens || 0) + Number(tu.totals.outputTokens || 0) + Number(tu.totals.cacheReadTokens || 0) + Number(tu.totals.cacheWriteTokens || 0),
    } : null,
    stats: stats || null,
    teamMembers: team && Array.isArray(team.members) ? team.members : [],
    modelSelection: ms && ms.lastUsed ? ms.lastUsed : null,
  };
}

export function readAllSessions(options) {
  const warnings = options.warnings;
  const sessionsRoot = options.sessionsRoot;
  const files = listSessionFiles(sessionsRoot);
  const sessions = [];
  for (const f of files) {
    const rec = parseSession(f.sessionId, f.file, f.projectKey, warnings, options.prices);
    rec.projcache = readProjcache(rec.id, warnings);
    if (rec.projcache && rec.projcache.title && !rec.title) rec.title = rec.projcache.title;
    if (rec.projcache && rec.projcache.tokens) {
      const a = rec.tokens;
      const b = rec.projcache.tokens;
      const diff = Math.abs(a.totalTokens - b.totalTokens);
      const base = Math.max(a.totalTokens, b.totalTokens);
      rec.projcacheDelta = base > 0 ? diff / base : 0;
    }
    sessions.push(rec);
  }

  // team/member events live in the parent (team lead) log; build child -> member index.
  const memberIndex = {};
  const allMembers = {};
  for (const s of sessions) {
    for (const m of s.members) {
      memberIndex[m.id] = m;
      const prev = allMembers[m.id];
      if (!prev || (prev.phase !== 'active' && m.phase === 'active')) allMembers[m.id] = m;
    }
    if (s.projcache && Array.isArray(s.projcache.teamMembers)) {
      for (const m of s.projcache.teamMembers) {
        if (!m || !m.id) continue;
        const rec = {
          id: String(m.id),
          name: m.name !== undefined ? String(m.name) : null,
          description: m.description !== undefined ? String(m.description) : null,
          provider: m.provider !== undefined ? String(m.provider) : null,
          context: m.context !== undefined ? String(m.context) : null,
          phase: m.phase !== undefined ? String(m.phase) : null,
          teamId: s.id,
        };
        if (!memberIndex[rec.id]) memberIndex[rec.id] = rec;
        if (!allMembers[rec.id]) allMembers[rec.id] = rec;
      }
    }
  }
  for (const s of sessions) {
    const m = memberIndex[s.id];
    if (m && m.name) s.agentName = m.name;
    else if (s.origin === 'subagent') s.agentName = 'субагент (разовый)';
    else s.agentName = 'lead';
    s.memberRecord = m || null;
  }

  // team tasks: keep the newest revision seen anywhere
  const tasksById = {};
  for (const s of sessions) {
    for (const t of s.tasks) {
      const prev = tasksById[t.id];
      if (!prev || t.revision >= prev.revision) tasksById[t.id] = t;
    }
  }

  return {
    files: files,
    sessions: sessions,
    memberIndex: memberIndex,
    members: Object.keys(allMembers).map(function (k) { return allMembers[k]; }),
    teamTasks: Object.keys(tasksById).map(function (k) { return tasksById[k]; }),
    warnings: warnings,
  };
}

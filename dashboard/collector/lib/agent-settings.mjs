// Тонкие настройки агентов: читаем registry/agent-settings/<agent-id>.yaml
import fs from 'node:fs';
import path from 'node:path';
import { parseYaml } from './yaml.mjs';
import { REGISTRY_DIR } from './paths.mjs';

const DIR = path.join(REGISTRY_DIR, 'agent-settings');

export function loadAgentSettings(warnings) {
  const out = { byAgent: {}, files: [], dir: DIR, exists: false, counts: {}, warnings: [] };
  if (!fs.existsSync(DIR)) {
    warnings.push('registry/agent-settings не найден — тонкие настройки агентов недоступны');
    return out;
  }
  out.exists = true;
  const names = fs.readdirSync(DIR).filter(function (n) { return /\.ya?ml$/.test(n); }).sort();
  names.forEach(function (n) {
    const full = path.join(DIR, n);
    let doc = null;
    try { doc = parseYaml(fs.readFileSync(full, 'utf8')); }
    catch (e) { warnings.push('agent-settings/' + n + ': ошибка разбора — ' + e.message); return; }
    const agentId = doc.agent !== undefined ? String(doc.agent) : n.replace(/\.ya?ml$/, '');
    const rec = {
      agent: agentId,
      file: full,
      fileName: n,
      updated: doc.updated !== undefined ? String(doc.updated) : null,
      status: doc.status !== undefined ? String(doc.status) : 'active',
      note: doc.note !== undefined ? String(doc.note) : null,
      schedule: doc.schedule || null,
      model: doc.model || null,
      priority: doc.priority || null,
      report: doc.report || null,
      delivery: doc.delivery || null,
      alerts: doc.alerts || null,
      limits: doc.limits || null,
      agent1: doc.agent1 ? Object.assign({}, doc.agent1, {
        // Карта доменов: удобное имя для интерфейса (в файле — snake_case).
        competitorDomains: doc.agent1.competitor_domains || {},
      }) : null,
      sourceAgent: doc.source_agent || null,
      editable: String(doc.status || 'active') !== 'stub',
    };
    out.byAgent[agentId] = rec;
    out.files.push({ agent: agentId, fileName: n, bytes: fs.statSync(full).size });
  });
  out.counts = { files: out.files.length, agents: Object.keys(out.byAgent).length, stub: Object.keys(out.byAgent).filter(function (k) { return !out.byAgent[k].editable; }).length };
  let newest = 0;
  out.files.forEach(function (f) {
    try { const st = fs.statSync(path.join(DIR, f.fileName)); if (st.mtimeMs > newest) newest = st.mtimeMs; } catch (e) { /* ignore */ }
  });
  out.newestMtimeMs = newest || null;
  return out;
}

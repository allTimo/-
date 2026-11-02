// Registry readers: agents.yaml, projects.yaml, tasks/*.yaml. Read-only.
import fs from 'node:fs';
import path from 'node:path';
import { parseYaml } from './yaml.mjs';
import { REGISTRY_DIR, TASKS_DIR } from './paths.mjs';

const AGENTS_FILE = path.join(REGISTRY_DIR, 'agents.yaml');
const PROJECTS_FILE = path.join(REGISTRY_DIR, 'projects.yaml');

function readYaml(file, warnings, label) {
  if (!fs.existsSync(file)) {
    warnings.push(label + ': файл не найден — ' + file);
    return null;
  }
  try { return parseYaml(fs.readFileSync(file, 'utf8')); }
  catch (e) {
    warnings.push(label + ': ошибка разбора ' + file + ' — ' + e.message);
    return null;
  }
}

function asArray(v) { return Array.isArray(v) ? v : (v === null || v === undefined ? [] : [v]); }

export function loadAgents(warnings) {
  const doc = readYaml(AGENTS_FILE, warnings, 'registry/agents.yaml');
  const list = [];
  if (!doc) return { agents: list, file: AGENTS_FILE, version: null, updated: null };
  for (const raw of asArray(doc.agents)) {
    if (!raw || typeof raw !== 'object' || raw.id === undefined) continue;
    list.push({
      id: String(raw.id),
      name: raw.name !== undefined && raw.name !== null ? String(raw.name) : String(raw.id),
      role: raw.role !== undefined && raw.role !== null ? String(raw.role) : '',
      enabled: raw.enabled === true,
      status: raw.status !== undefined && raw.status !== null ? String(raw.status) : 'unknown',
      model: raw.model !== undefined && raw.model !== null ? String(raw.model) : null,
      modelHint: raw.model_hint !== undefined && raw.model_hint !== null ? String(raw.model_hint) : null,
      projects: asArray(raw.projects).map(String),
      groups: asArray(raw.groups).map(String),
      schedule: raw.schedule !== undefined && raw.schedule !== null ? String(raw.schedule) : null,
      inputs: asArray(raw.inputs).map(String),
      outputs: asArray(raw.outputs).map(String),
      runbook: raw.runbook !== undefined && raw.runbook !== null ? String(raw.runbook) : null,
      notes: raw.notes !== undefined && raw.notes !== null ? String(raw.notes) : null,
      origin: 'registry',
    });
  }
  return { agents: list, file: AGENTS_FILE, version: doc.version === undefined ? null : doc.version, updated: doc.updated === undefined ? null : doc.updated };
}

export function loadProjects(warnings) {
  const doc = readYaml(PROJECTS_FILE, warnings, 'registry/projects.yaml');
  const list = [];
  if (!doc) return { projects: list, file: PROJECTS_FILE };
  for (const raw of asArray(doc.projects)) {
    if (!raw || typeof raw !== 'object' || raw.id === undefined) continue;
    list.push({
      id: String(raw.id),
      name: raw.name !== undefined && raw.name !== null ? String(raw.name) : String(raw.id),
      developer: raw.developer !== undefined && raw.developer !== null ? String(raw.developer) : null,
      klass: raw.class !== undefined && raw.class !== null ? String(raw.class) : null,
      agents: asArray(raw.agents).map(String),
      status: raw.status !== undefined && raw.status !== null ? String(raw.status) : 'unknown',
      origin: 'registry',
    });
  }
  return { projects: list, file: PROJECTS_FILE };
}

export function loadRegistryTasks(warnings) {
  const tasks = [];
  const files = [];
  if (!fs.existsSync(TASKS_DIR)) {
    warnings.push('registry/tasks/: папки пока нет — задачи берутся только из логов DSH-сессий');
    return { tasks: tasks, files: files, dir: TASKS_DIR, exists: false };
  }
  let names = [];
  try { names = fs.readdirSync(TASKS_DIR).filter(function (n) { return /\.ya?ml$/i.test(n); }).sort(); }
  catch (e) { warnings.push('registry/tasks/: не удалось прочитать — ' + e.message); return { tasks: tasks, files: files, dir: TASKS_DIR, exists: true }; }
  if (names.length === 0) warnings.push('registry/tasks/: файлов *.yaml пока нет — задачи берутся только из логов DSH-сессий');
  for (const name of names) {
    const file = path.join(TASKS_DIR, name);
    const doc = readYaml(file, warnings, 'registry/tasks/' + name);
    files.push(file);
    if (!doc) continue;
    const arr = Array.isArray(doc) ? doc : asArray(doc.tasks);
    for (const raw of arr) {
      if (!raw || typeof raw !== 'object' || raw.id === undefined) continue;
      tasks.push({
        id: String(raw.id),
        subject: raw.subject !== undefined && raw.subject !== null ? String(raw.subject) : String(raw.id),
        group: raw.group !== undefined && raw.group !== null ? String(raw.group) : null,
        category: raw.category !== undefined && raw.category !== null ? String(raw.category) : null,
        owner: raw.owner !== undefined && raw.owner !== null ? String(raw.owner) : null,
        status: raw.status !== undefined && raw.status !== null ? String(raw.status) : 'new',
        project: raw.project !== undefined && raw.project !== null ? String(raw.project) : null,
        due: raw.due !== undefined && raw.due !== null ? String(raw.due) : null,
        source: raw.source !== undefined && raw.source !== null ? String(raw.source) : 'registry',
        created: raw.created !== undefined && raw.created !== null ? String(raw.created) : null,
        quote: raw.quote !== undefined && raw.quote !== null ? String(raw.quote) : null,
        origin: 'registry',
        file: 'registry/tasks/' + name,
      });
    }
  }
  return { tasks: tasks, files: files, dir: TASKS_DIR, exists: true };
}

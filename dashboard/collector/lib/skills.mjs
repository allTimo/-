// Раздел «Скилы»: реестр скиллов агента + журнал прогонов.
// Только чтение: сборщик ничего не запускает и не меняет.
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_DIR } from './paths.mjs';

const SKILLS_DIR = path.join(PROJECT_DIR, 'skills');
const REGISTRY_FILE = path.join(SKILLS_DIR, 'registry', 'skills_registry.json');
const RUN_LOG_FILE = path.join(SKILLS_DIR, 'logs', 'skill-runs.jsonl');

function readRuns(warnings) {
  if (!fs.existsSync(RUN_LOG_FILE)) return [];
  let text = '';
  try { text = fs.readFileSync(RUN_LOG_FILE, 'utf8'); }
  catch (e) { warnings.push('журнал скиллов не прочитан: ' + e.message); return []; }
  const runs = [];
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try { runs.push(JSON.parse(s)); } catch (e) { /* битую строку журнала не считаем */ }
  }
  return runs;
}

export function buildSkillsDoc() {
  const warnings = [];
  let registry = null;
  try { registry = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8')); }
  catch (e) { warnings.push('skills_registry.json не прочитан: ' + e.message); }

  const entries = registry && Array.isArray(registry.skills) ? registry.skills : [];
  if (!entries.length) warnings.push('в реестре скиллов нет ни одной записи');

  const runs = readRuns(warnings);
  const lastBySkill = {};
  for (const run of runs) {
    if (!run || typeof run.skill !== 'string') continue;
    lastBySkill[run.skill] = run;      // журнал пишется по порядку: последняя запись перекрывает
  }
  const runsBySkill = {};
  for (const run of runs) {
    if (!run || typeof run.skill !== 'string') continue;
    runsBySkill[run.skill] = (runsBySkill[run.skill] || 0) + 1;
  }

  const skills = entries.map(function (entry) {
    const requiredEnv = Array.isArray(entry.required_env) ? entry.required_env : [];
    const last = lastBySkill[entry.name] || null;
    return {
      name: entry.name,
      title: entry.title || entry.name,
      purpose: entry.purpose || '',
      module: entry.module || '',
      group: entry.group || '',
      enabled: entry.enabled !== false,
      requiredEnv: requiredEnv,
      needsKey: requiredEnv.length > 0,
      freeTier: entry.free_tier || '',
      limits: entry.limits || '',
      verified: entry.verified || '',
      runs: runsBySkill[entry.name] || 0,
      lastRun: last ? {
        ts: last.ts || null,
        status: last.status || null,
        count: typeof last.count === 'number' ? last.count : null,
        error: last.error || null,
      } : null,
    };
  }).sort(function (a, b) { return a.name < b.name ? -1 : 1; });

  return {
    generatedAt: new Date().toISOString(),
    file: REGISTRY_FILE,
    skills: skills,
    counts: {
      total: skills.length,
      enabled: skills.filter(function (s) { return s.enabled; }).length,
      needsKey: skills.filter(function (s) { return s.needsKey; }).length,
      withRuns: skills.filter(function (s) { return s.lastRun; }).length,
      journalRuns: runs.length,
    },
    journal: {
      file: RUN_LOG_FILE,
      exists: fs.existsSync(RUN_LOG_FILE),
      runs: runs.length,
      ok: runs.filter(function (r) { return r.status === 'ok'; }).length,
      empty: runs.filter(function (r) { return r.status === 'empty'; }).length,
      errors: runs.filter(function (r) { return r.status === 'error'; }).length,
      skipped: runs.filter(function (r) { return r.status === 'skipped_no_key'; }).length,
    },
    honesty: 'Скилы — источники данных: расчёты, проверки и запись остаются в детерминированном движке агента. '
      + '«Прогонов нет» означает, что скил ещё не вызывался, а не что он сломан.',
    warnings: warnings,
  };
}

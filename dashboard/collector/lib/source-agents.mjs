// Явные связи «источник -> агенты реестра» из dashboard/config/source-agents.yaml.
import fs from 'node:fs';
import path from 'node:path';
import { parseYaml } from './yaml.mjs';
import { CONFIG_DIR } from './paths.mjs';

const FILE = path.join(CONFIG_DIR, 'source-agents.yaml');

export function loadSourceAgents(warnings) {
  const map = {};
  if (!fs.existsSync(FILE)) return { file: FILE, map: map, exists: false };
  let doc;
  try { doc = parseYaml(fs.readFileSync(FILE, 'utf8')); }
  catch (e) { warnings.push('source-agents.yaml: ошибка разбора — ' + e.message); return { file: FILE, map: map, exists: true }; }
  const block = doc && doc.sources && typeof doc.sources === 'object' ? doc.sources : (doc || {});
  for (const k of Object.keys(block)) {
    const v = block[k];
    if (Array.isArray(v)) map[k] = v.map(String);
    else if (typeof v === 'string') map[k] = [v];
  }
  return { file: FILE, map: map, exists: true };
}

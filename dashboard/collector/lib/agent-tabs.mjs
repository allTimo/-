// Вкладки раздела «Агенты»: читаем dashboard/config/agents-tabs.yaml.
import fs from 'node:fs';
import path from 'node:path';
import { parseYaml } from './yaml.mjs';
import { CONFIG_DIR } from './paths.mjs';

const TABS_FILE = path.join(CONFIG_DIR, 'agents-tabs.yaml');

export function loadAgentTabs(warnings) {
  if (!fs.existsSync(TABS_FILE)) {
    warnings.push('dashboard/config/agents-tabs.yaml не найден — раздел «Агенты» использует встроенные вкладки');
    return { tabs: [], file: TABS_FILE, exists: false };
  }
  let doc = null;
  try { doc = parseYaml(fs.readFileSync(TABS_FILE, 'utf8')); }
  catch (e) { warnings.push('agents-tabs.yaml: ошибка разбора — ' + e.message); return { tabs: [], file: TABS_FILE, exists: true }; }
  const section = doc.section || {};
  const tabs = (Array.isArray(doc.tabs) ? doc.tabs : []).filter(function (t) { return t && t.id; }).map(function (t) {
    return {
      id: String(t.id),
      label: t.label !== undefined ? String(t.label) : String(t.id),
      hint: t.hint !== undefined ? String(t.hint) : null,
      enabled: t.enabled !== false,
    };
  });
  if (tabs.length === 0) warnings.push('agents-tabs.yaml: ни одной вкладки — используются встроенные');
  return {
    section: { id: section.id !== undefined ? String(section.id) : 'agents', label: section.label !== undefined ? String(section.label) : 'Агенты', icon: section.icon !== undefined ? String(section.icon) : 'bot' },
    tabs: tabs, file: TABS_FILE, exists: true, total: tabs.length,
  };
}

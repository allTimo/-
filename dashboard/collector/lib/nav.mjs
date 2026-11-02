// Меню левой панели: читаем dashboard/config/nav.yaml.
// Один файл — новую группу агентов можно добавить правкой только этого файла.
import fs from 'node:fs';
import path from 'node:path';
import { parseYaml } from './yaml.mjs';
import { CONFIG_DIR } from './paths.mjs';

const NAV_FILE = path.join(CONFIG_DIR, 'nav.yaml');

export function loadNav(warnings) {
  if (!fs.existsSync(NAV_FILE)) {
    warnings.push('dashboard/config/nav.yaml не найден — меню будет построено по встроенной схеме');
    return { groups: [], file: NAV_FILE, exists: false };
  }
  let doc = null;
  try { doc = parseYaml(fs.readFileSync(NAV_FILE, 'utf8')); }
  catch (e) { warnings.push('nav.yaml: ошибка разбора — ' + e.message); return { groups: [], file: NAV_FILE, exists: true }; }
  const groups = (Array.isArray(doc.groups) ? doc.groups : []).filter(function (g) { return g && Array.isArray(g.items); }).map(function (g) {
    return {
      id: String(g.id),
      title: g.title !== undefined ? String(g.title) : String(g.id),
      items: g.items.filter(function (i) { return i && i.id; }).map(function (i) {
        return {
          id: String(i.id),
          label: i.label !== undefined ? String(i.label) : String(i.id),
          icon: i.icon !== undefined ? String(i.icon) : 'grid',
          counter: i.counter !== undefined && i.counter !== null ? String(i.counter) : null,
          counterKind: i.counter_kind !== undefined && i.counter_kind !== null ? String(i.counter_kind) : null,
        };
      }),
    };
  }).filter(function (g) { return g.items.length > 0; });
  const total = groups.reduce(function (a, g) { return a + g.items.length; }, 0);
  if (total === 0) warnings.push('nav.yaml: ни одной записи меню — используется встроенная схема');
  return { groups: groups, file: NAV_FILE, exists: true, total: total };
}

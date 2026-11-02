// История изменений тумблеров: читаем копии .bak-<timestamp>, которые делает
// дашборд при каждой правке реестра, и находим последнее расхождение с текущим
// значением enabled. Значения секретов тут не при чём — только поля реестра.
import fs from 'node:fs';
import path from 'node:path';
import { parseYaml } from './yaml.mjs';
import { REGISTRY_DIR } from './paths.mjs';

function backupsFor(file) {
  const dir = path.dirname(file);
  const base = path.basename(file) + '.bak-';
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return []; }
  return names
    .filter(function (n) { return n.indexOf(base) === 0; })
    .map(function (n) {
      const full = path.join(dir, n);
      let mtime = 0;
      try { mtime = fs.statSync(full).mtimeMs; } catch (e) { mtime = 0; }
      return { name: n, file: full, mtime: mtime };
    })
    .sort(function (a, b) { return b.mtime - a.mtime; });
}

function enabledMap(file, listKey) {
  const map = {};
  try {
    const doc = parseYaml(fs.readFileSync(file, 'utf8'));
    const list = Array.isArray(doc[listKey]) ? doc[listKey] : [];
    for (const item of list) {
      if (item && item.id !== undefined) map[String(item.id)] = item.enabled === true;
    }
  } catch (e) { /* битый файл — просто нет данных */ }
  return map;
}

export function scanHistory(warnings) {
  const targets = [
    { key: 'agents', file: path.join(REGISTRY_DIR, 'agents.yaml'), listKey: 'agents', what: 'агент' },
    { key: 'sources', file: path.join(REGISTRY_DIR, 'sources.yaml'), listKey: 'sources', what: 'источник' },
  ];
  const out = { agents: {}, sources: {}, backups: {} };

  for (const t of targets) {
    const backups = backupsFor(t.file);
    out.backups[t.key] = { count: backups.length, newestAt: backups.length ? backups[0].mtime : null };
    if (backups.length === 0 || !fs.existsSync(t.file)) continue;
    const current = enabledMap(t.file, t.listKey);

    // Идём от свежих копий к старым: первая копия, где значение отличается от
    // текущего, и есть момент последнего переключения.
    const found = {};
    for (const b of backups) {
      const past = enabledMap(b.file, t.listKey);
      for (const id of Object.keys(current)) {
        if (found[id]) continue;
        if (Object.prototype.hasOwnProperty.call(past, id) && past[id] !== current[id]) {
          found[id] = { at: b.mtime, previous: past[id], now: current[id], backup: b.name };
        }
      }
    }
    out[t.key] = found;
  }
  return out;
}

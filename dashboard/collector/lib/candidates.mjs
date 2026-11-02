// Кандидаты в конкуренты: читаем 01-competitor-watch/data/candidates/*.json
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_DIR } from './paths.mjs';

// Ключ кандидата должен быть одинаковым у движка и у панели.
// Берём id, который проставляет движок; если его нет — составляем из названия и застройщика.
export function candidateKey(c) {
  if (c && c.id !== undefined && c.id !== null && String(c.id) !== '') return String(c.id);
  const name = c && c.name !== undefined ? String(c.name) : '';
  const dev = c && c.developer !== undefined && c.developer !== null ? String(c.developer) : '';
  return name + ' | ' + dev;
}

var functions_decisions = [];

export function loadCandidates(warnings) {
  const dir = path.join(PROJECT_DIR, '01-competitor-watch', 'data', 'candidates');
  const out = { dir: dir, exists: false, projects: [], counts: { projects: 0, total: 0, approved: 0, rejected: 0, pending: 0 }, engineReady: false };
  if (!fs.existsSync(dir)) return out;
  out.exists = true;
  // Файлы движка: <project-id>.json. Файлы решений панели: <project-id>.decisions.json —
  // их читаем отдельно и накладываем статус, чтобы НЕ путать зоны записи.
  const allFiles = fs.readdirSync(dir).filter(function (n) { return /\.json$/.test(n); }).sort();
  const files = allFiles.filter(function (n) { return !/\.decisions\.json$/.test(n); });
  functions_decisions = allFiles.filter(function (n) { return /\.decisions\.json$/.test(n); });
  const decisionsByProject = {};
  functions_decisions.forEach(function (n) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
      decisionsByProject[n.replace(/\.decisions\.json$/, '')] = d;
    } catch (e) { warnings.push('candidates/' + n + ': решения не разобрались — ' + e.message); }
  });
  out.decisionsFiles = functions_decisions;
  files.forEach(function (n) {
    const full = path.join(dir, n);
    let doc = null;
    try { doc = JSON.parse(fs.readFileSync(full, 'utf8')); }
    catch (e) { warnings.push('candidates/' + n + ': не разобрался JSON — ' + e.message); return; }
    const projectIdGuess = n.replace(/\.json$/, '');
    const dec = decisionsByProject[projectIdGuess] || {};
    const items = (Array.isArray(doc) ? doc : (doc.candidates || [])).map(function (c) {
      const key = candidateKey(c);
      const d = dec[key] || null;
      return {
        key: key,
        decisionAt: d ? d.at : null,
        decisionSource: d ? 'decisions.json' : null,
        name: c.name !== undefined ? String(c.name) : null,
        developer: c.developer !== undefined && c.developer !== null ? String(c.developer) : null,
        klass: c.class !== undefined && c.class !== null ? String(c.class) : (c.klass !== undefined ? String(c.klass) : null),
        distanceKm: c.distance_km !== undefined && c.distance_km !== null ? Number(c.distance_km) : null,
        pricePerM2: c.price_per_m2 !== undefined && c.price_per_m2 !== null ? Number(c.price_per_m2) : null,
        sources: Array.isArray(c.sources) ? c.sources.map(function (s) { return typeof s === 'string' ? { platform: s, url: null } : { platform: s.platform !== undefined ? String(s.platform) : '—', url: s.url !== undefined ? String(s.url) : null }; }) : [],
        foundAt: c.found_at !== undefined && c.found_at !== null ? String(c.found_at) : null,
        confidence: c.confidence !== undefined && c.confidence !== null ? Number(c.confidence) : null,
        // Статус берём из решения панели, если оно есть; иначе — из файла движка.
        status: d ? String(d.status) : (c.status !== undefined ? String(c.status) : 'candidate'),
      };
    });
    const projectId = doc.project_id !== undefined ? String(doc.project_id) : n.replace(/\.json$/, '');
    out.projects.push({
      projectId: projectId, file: full, fileName: n,
      engine: doc.engine !== undefined ? String(doc.engine) : null,
      foundAt: doc.found_at !== undefined ? String(doc.found_at) : (doc.generated_at !== undefined ? String(doc.generated_at) : null),
      radiusKm: doc.radius_km !== undefined ? Number(doc.radius_km) : null,
      // Сводка и ограничения движка: нужны, чтобы объяснить «почему кандидатов нет», а не показать пустую таблицу.
      summary: doc.summary || null,
      limitations: Array.isArray(doc.limitations) ? doc.limitations.map(String) : [],
      platformAttempts: Array.isArray(doc.platform_attempts) ? doc.platform_attempts.map(function (p) { return { source: p.source !== undefined ? String(p.source) : '—', status: p.status !== undefined ? String(p.status) : '—', note: p.note !== undefined ? String(p.note) : null, found: p.found !== undefined ? Number(p.found) : null }; }) : [],
      items: items,
    });
    out.counts.total += items.length;
    out.counts.approved += items.filter(function (i) { return i.status === 'approved'; }).length;
    out.counts.rejected += items.filter(function (i) { return i.status === 'rejected'; }).length;
    out.counts.pending += items.filter(function (i) { return i.status === 'candidate'; }).length;
  });
  out.counts.projects = out.projects.length;
  // Свежесть: cамый новый mtime среди файлов кандидатов и решений.
  // Нужна, чтобы поймать случай «файл новее собранных данных» — панель тогда показывала пустоту.
  let newest = 0;
  allFiles.concat(functions_decisions).forEach(function (n) {
    try { const st = fs.statSync(path.join(dir, n)); if (st.mtimeMs > newest) newest = st.mtimeMs; } catch (e) { /* ignore */ }
  });
  out.newestMtimeMs = newest || null;
  return out;
}

// READ-ONLY audit probe. Writes nothing. Usage: node _probe-inventory.mjs <profileDir>
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const prof = process.argv[2];
const pkg = JSON.parse(readFileSync(join(prof, 'package.json'), 'utf8'));
const bundles = pkg.dsh?.profile?.bundles ?? [];
const deps = pkg.dependencies ?? {};
let yaml = null;
try { yaml = await import(join(prof, 'node_modules', 'js-yaml', 'index.js')); } catch {}
const patch = yaml ? yaml.load(readFileSync(join(prof, 'cordis.patch.yml'), 'utf8')) : null;

// index patch entries by referenced plugin name
const patchEntries = [];
function walk(node) {
  if (Array.isArray(node)) return node.forEach(walk);
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === 'id' || k === 'name') patchEntries.push({ key: k, value: String(v) });
      walk(v);
    }
  }
}
walk(patch);

const rows = [];
for (const b of bundles) {
  const dir = join(prof, 'node_modules', b);
  const installed = existsSync(dir);
  let meta = null, entry = null, patchFile = null, patchDeclared = false;
  if (installed) {
    const pj = join(dir, 'package.json');
    if (existsSync(pj)) {
      meta = JSON.parse(readFileSync(pj, 'utf8'));
      const e = meta.exports?.['.'] ?? meta.exports ?? meta.main;
      entry = typeof e === 'string' ? e : JSON.stringify(e)?.slice(0, 120);
    }
    for (const cand of ['cordis.patch.yml', 'cordis.patch.yaml', 'cordis.yml']) {
      if (existsSync(join(dir, cand))) { patchFile = cand; break; }
    }
    patchDeclared = Boolean(meta?.dsh?.bundle || meta?.dsh?.patch || patchFile);
  }
  const ver = meta?.version ?? null;
  const depSpec = deps[b] ?? null;
  const inPatch = patchEntries.filter((p) => p.value === b || p.value.includes(b)).length;
  rows.push({ bundle: b, inDeps: depSpec !== null, depSpec, installed, version: ver, entry, patchFile, patchRefs: inPatch });
}
console.log(JSON.stringify({ bundleCount: bundles.length, rows, patchTopLevelKeys: patch && typeof patch === 'object' ? Object.keys(patch).slice(0, 20) : null }, null, 1));

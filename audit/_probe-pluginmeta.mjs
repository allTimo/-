// READ-ONLY: per-plugin metadata + own patch entry ids + declared tools/services.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const prof = process.argv[2];
const nm = join(prof, 'node_modules');
const yaml = createRequire(join(prof, 'noop.cjs'))('js-yaml');
const plugins = process.argv.slice(3);
for (const p of plugins) {
  const dir = join(nm, p);
  console.log(`\n===== ${p} =====`);
  if (!existsSync(dir)) { console.log('  NOT INSTALLED at', dir); continue; }
  const pj = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  console.log('  version:', pj.version, '| main:', pj.main, '| exports:', JSON.stringify(pj.exports));
  console.log('  dsh:', JSON.stringify(pj.dsh));
  const pdeps = pj.dependencies ? Object.keys(pj.dependencies) : [];
  console.log('  deps:', pdeps.join(', '));
  for (const cand of ['cordis.patch.yml','cordis.patch.yaml','dsh/cordis.patch.yml']) {
    const f = join(dir, cand);
    if (!existsSync(f)) continue;
    try {
      const d = yaml.load(readFileSync(f, 'utf8'));
      const list = Array.isArray(d) ? d : (d?.patches ?? []);
      console.log(`  own patch ${cand}: ${list.length} entries`);
      for (const e of list) console.log(`     - id=${e?.id} name=${e?.name} disabled=${e?.disabled ?? null}`);
    } catch (err) { console.log(`  own patch ${cand}: PARSE ERROR ${err.message}`); }
  }
  // grep declared tool/service names in the built lib
  const libdir = join(dir, pj.exports?.default ? '.' : 'lib');
  console.log('  (skipped lib scan)');
}

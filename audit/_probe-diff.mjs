// READ-ONLY: compare two manifests, report added/removed/changed. Writes nothing.
import { readFileSync } from 'node:fs';
const [a, b] = process.argv.slice(2);
const read = (p) => JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
const A = read(a);
const B = read(b);
const ka = new Map(A.map((r) => [r.path.toLowerCase(), r]));
const kb = new Map(B.map((r) => [r.path.toLowerCase(), r]));
const added = [], removed = [], changed = [];
for (const [k, r] of kb) if (!ka.has(k)) added.push(r.path);
for (const [k, r] of ka) if (!kb.has(k)) removed.push(r.path);
for (const [k, r] of ka) {
  const o = kb.get(k);
  if (o && o.sha256 !== r.sha256) changed.push(`${r.path} (${r.sha256.slice(0, 12)} -> ${o.sha256.slice(0, 12)})`);
}
console.log(`BEFORE files=${A.length}  AFTER files=${B.length}`);
console.log(`ADDED=${added.length} REMOVED=${removed.length} CHANGED=${changed.length}`);
for (const l of added.slice(0, 40)) console.log('  + ' + l);
for (const l of removed.slice(0, 40)) console.log('  - ' + l);
for (const l of changed.slice(0, 40)) console.log('  ~ ' + l);

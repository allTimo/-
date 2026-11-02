// READ-ONLY: summarize cordis.patch.yml entries per bundle; secrets redacted (presence+kind only).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const prof = process.argv[2];
const yaml = createRequire(join(prof, 'noop.cjs'))('js-yaml');
const doc = yaml.load(readFileSync(join(prof, 'cordis.patch.yml'), 'utf8'));
const SECRET = /(apikey|api_key|key|token|secret|password|passwd|auth|cookie|credential)/i;
function redact(v) {
  if (v === null || v === undefined) return v;
  if (typeof v === 'string') return v.length > 0 ? `<REDACTED len=${v.length}>` : '<EMPTY>';
  if (Array.isArray(v)) return v.map(redact);
  if (typeof v === 'object') {
    const o = {};
    for (const [k, val] of Object.entries(v)) o[k] = SECRET.test(k) ? redact(val) : redact(val);
    return o;
  }
  return v;
}
const list = Array.isArray(doc) ? doc : (doc?.patches ?? []);
console.log('TOTAL PATCH ENTRIES:', list.length);
const seen = new Map();
for (const e of list) {
  const name = String(e?.name ?? '');
  if (!seen.has(name)) seen.set(name, []);
  seen.get(name).push({ id: e?.id, disabled: e?.disabled ?? null, keys: e?.config ? Object.keys(e.config) : [] });
}
for (const [name, es] of seen) {
  console.log(`\n## ${name}  (${es.length} entry)`);
  for (const e of es) console.log(`   - id=${e.id} disabled=${e.disabled} configKeys=[${e.keys.join(', ')}]`);
}

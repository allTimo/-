import fs from 'node:fs';

const file = process.argv[2];
const out = process.argv[3];
const text = fs.readFileSync(file, 'utf8');
const lines = text.split(/\r?\n/);
const cjkAny = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3000-\u303F\uFF00-\uFFEF]/u;
const isQuote = (c) => c === '`' || c === "'" || c === '"';

function literals(line) {
  const found = [];
  for (let i = 0; i < line.length; i += 1) {
    const q = line[i];
    if (!isQuote(q)) continue;
    if (i > 0 && line[i - 1] === '\\') continue;
    let j = i + 1;
    let depth = 0;
    for (; j < line.length; j += 1) {
      const c = line[j];
      if (c === '\\') { j += 1; continue; }
      if (q === '`' && c === '$' && line[j + 1] === '{') { depth += 1; j += 1; continue; }
      if (depth > 0) {
        if (c === '}') depth -= 1;
        continue;
      }
      if (c === q) break;
    }
    if (j < line.length) {
      const content = line.slice(i + 1, j);
      found.push({ open: i, close: j, q, content });
      i = j;
    }
  }
  return found;
}

const rows = [];
for (let i = 0; i < lines.length; i += 1) {
  const line = lines[i];
  if (!cjkAny.test(line)) continue;
  const lits = literals(line).filter((l) => cjkAny.test(l.content));
  rows.push(`### line ${i + 1} literals=${lits.length}`);
  for (const l of lits) {
    const parts = l.content.split(' / ');
    rows.push(`  [${l.q}] parts=${parts.length} cjkPart=${parts.findIndex((p) => cjkAny.test(p))} len=${l.content.length}`);
    for (let p = 0; p < l.content.length; p += 180) rows.push(`  ${p === 0 ? '' : '+'}${l.content.slice(p, p + 180)}`);
  }
}
fs.writeFileSync(out, rows.join('\n'), 'utf8');
console.log(`lines=${rows.filter((r) => r.startsWith('###')).length}`);

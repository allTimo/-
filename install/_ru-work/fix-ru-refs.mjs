import fs from 'node:fs';

const file = process.argv[2];
const text = fs.readFileSync(file, 'utf8');
const eol = text.includes('\r\n') ? '\r\n' : '\n';
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
      if (depth > 0) { if (c === '}') depth -= 1; continue; }
      if (c === q) break;
    }
    if (j < line.length) { found.push({ open: i, close: j, q, content: line.slice(i + 1, j) }); i = j; }
  }
  return found;
}

const targets = new Map([
  [298, 'zh'], [322, 'zh'], [524, 'zh'], [547, 'zh'], [577, 'zh'],
  [593, 'latestZh'], [600, 'zh'], [653, 'zh'],
]);
const rows = [];
for (const [lineNo, oldVar] of targets) {
  const idx = lineNo - 1;
  const line = lines[idx];
  const lits = literals(line).filter((l) => cjkAny.test(l.content));
  if (lits.length !== 1) { rows.push(`line ${lineNo}: expected 1 CJK literal, got ${lits.length}`); continue; }
  const lit = lits[0];
  const parts = lit.content.split(' / ');
  if (parts.length !== 3) { rows.push(`line ${lineNo}: parts=${parts.length}`); continue; }
  const before = parts[2];
  const after = before.split(`\${${oldVar}}`).join('${ru}');
  if (after === before) { rows.push(`line ${lineNo}: no \${${oldVar}} in ru part`); continue; }
  const newContent = `${parts[0]} / ${parts[1]} / ${after}`;
  lines[idx] = line.slice(0, lit.open + 1) + newContent + line.slice(lit.close);
}
if (rows.length) { console.error(rows.join('\n')); process.exit(1); }
fs.writeFileSync(file, lines.join(eol), 'utf8');
console.log(`replaced=${targets.size}`);

import fs from 'node:fs';

const file = process.argv[2];
const text = fs.readFileSync(file, 'utf8');
const lines = text.split(/\r?\n/);
const cjkAny = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3000-\u303F\uFF00-\uFFEF]/u;
const cjkChar = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/u;
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

const stats = { literals: 0, zhFirst: 0, enFirst: 0, multi: 0, noSeparator: 0, lastCjk: 0 };
const rows = [];
for (let i = 0; i < lines.length; i += 1) {
  const line = lines[i];
  if (!cjkAny.test(line)) continue;
  for (const lit of literals(line)) {
    if (!cjkAny.test(lit.content)) continue;
    stats.literals += 1;
    const parts = lit.content.split(' / ');
    if (parts.length === 1) { stats.noSeparator += 1; rows.push(`line ${i + 1} parts=1 :: ${lit.content.slice(0, 120)}`); continue; }
    if (parts.length > 3) { stats.multi += 1; rows.push(`line ${i + 1} parts=${parts.length} :: ${lit.content.slice(0, 160)}`); continue; }
    const [a, b, c] = parts;
    const ca = (a.match(cjkChar) ?? []).length;
    const cb = (b ?? '').match(cjkChar)?.length ?? 0;
    const cc = (c ?? '').match(cjkChar)?.length ?? 0;
    if (ca > 0 && cb === 0 && cc === 0) stats.zhFirst += 1;
    else if (ca === 0 && cb > 0) { stats.enFirst += 1; rows.push(`line ${i + 1} EN-FIRST parts=${parts.length} :: ${lit.content.slice(0, 140)}`); }
    else { stats.multi += 1; rows.push(`line ${i + 1} parts=${parts.length} cjk=[${ca},${cb},${cc}] :: ${lit.content.slice(0, 140)}`); }
    if (cc > 0) stats.lastCjk += 1;
  }
}
console.log(JSON.stringify(stats));
if (rows.length) console.log(rows.join('\n'));

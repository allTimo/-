import fs from 'node:fs';

const file = process.argv[2];
const text = fs.readFileSync(file, 'utf8');
const lines = text.split(/\r?\n/);
const cjkAny = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3000-\u303F\uFF00-\uFFEF]/u;
const cjkAll = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3000-\u303F\uFF00-\uFFEF]/gu;
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

const rows = [];
for (let i = 0; i < lines.length; i += 1) {
  const line = lines[i];
  if (!cjkAny.test(line)) continue;
  let masked = line;
  for (const lit of literals(line)) {
    masked = masked.slice(0, lit.open + 1) + ' '.repeat(lit.close - lit.open - 1) + masked.slice(lit.close);
  }
  const left = masked.match(cjkAll) ?? [];
  if (left.length) rows.push(`line ${i + 1} outsideLiterals=${left.length} :: ${masked.trim().slice(0, 140)}`);
}
console.log(rows.length ? rows.join('\n') : 'NO CJK OUTSIDE LITERALS');

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

const rows = [];
let cjkLiterals = 0;
let threePart = 0;
let twoPart = 0;
let onePart = 0;
let cjkInLast = 0;
for (let i = 0; i < lines.length; i += 1) {
  const line = lines[i];
  if (!cjkAny.test(line)) continue;
  for (const lit of literals(line)) {
    if (!cjkAny.test(lit.content)) continue;
    cjkLiterals += 1;
    const parts = lit.content.split(' / ');
    const last = parts.at(-1);
    const lastCjk = (last.match(cjkChar) ?? []).length;
    if (parts.length >= 3) threePart += 1;
    else if (parts.length === 2) twoPart += 1;
    else onePart += 1;
    if (lastCjk > 0) cjkInLast += 1;
    if (parts.length < 3 || lastCjk > 0) {
      rows.push(`line ${i + 1} q=${lit.q} parts=${parts.length} lastCjk=${lastCjk} :: ${lit.content.slice(0, 160)}`);
    }
  }
}
console.log(`cjkLiterals=${cjkLiterals} threePart=${threePart} twoPart=${twoPart} onePart=${onePart} cjkInLastPart=${cjkInLast}`);
if (rows.length) console.log(rows.join('\n'));

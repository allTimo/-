import fs from 'node:fs';

const [file, mapPath] = process.argv.slice(2);
const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
const text = fs.readFileSync(file, 'utf8');
const eol = text.includes('\r\n') ? '\r\n' : '\n';
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

const problems = [];
let applied = 0;
for (const item of map) {
  const idx = item.line - 1;
  if (!lines[idx]) { problems.push(`line ${item.line}: missing`); continue; }
  if (cjkAny.test(item.ru)) { problems.push(`line ${item.line}: ru contains CJK`); continue; }
  const lits = literals(lines[idx]).filter((l) => cjkAny.test(l.content));
  if (lits.length !== 1) { problems.push(`line ${item.line}: expected 1 CJK literal, got ${lits.length}`); continue; }
  const lit = lits[0];
  const parts = lit.content.split(' / ');
  if (parts.length > 2) { problems.push(`line ${item.line}: literal has ${parts.length} separator parts`); continue; }
  let zh;
  let en;
  if (parts.length === 2) {
    const zi = parts.findIndex((p) => cjkAny.test(p));
    if (zi < 0) { problems.push(`line ${item.line}: no CJK in split parts`); continue; }
    zh = parts[zi];
    en = parts[1 - zi];
  } else {
    zh = parts[0];
    if (typeof item.en !== 'string' || item.en === '') { problems.push(`line ${item.line}: Chinese-only literal needs en`); continue; }
    en = item.en;
  }
  const dz = (zh.match(/\$\{/g) ?? []).length;
  const dr = (item.ru.match(/\$\{/g) ?? []).length;
  if (dz !== dr) { problems.push(`line ${item.line}: placeholder count ${dz} -> ${dr}`); continue; }
  const newContent = `${zh} / ${en} / ${item.ru}`;
  lines[idx] = lines[idx].slice(0, lit.open + 1) + newContent + lines[idx].slice(lit.close);
  applied += 1;
}
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
const out = lines.join(eol);
fs.writeFileSync(file, out, 'utf8');
const cjk = (out.match(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/gu) ?? []).length;
console.log(`applied=${applied} totalCJK=${cjk}`);

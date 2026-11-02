import fs from 'node:fs';

const [file, mapPath] = process.argv.slice(2);
const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
const text = fs.readFileSync(file, 'utf8');
const eol = text.includes('\r\n') ? '\r\n' : '\n';
const lines = text.split(/\r?\n/);
const cjkRe = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3000-\u303F\uFF00-\uFFEF]/u;
const problems = [];
let applied = 0;
for (const item of map) {
  const { line, start, end, ru } = item;
  const idx = line - 1;
  if (!lines[idx]) { problems.push(`line ${line}: missing`); continue; }
  const s = lines[idx].indexOf(start);
  if (s < 0) { problems.push(`line ${line}: start marker not found`); continue; }
  if (lines[idx].indexOf(start, s + start.length) >= 0) { problems.push(`line ${line}: start marker not unique`); continue; }
  const e = lines[idx].indexOf(end, s + start.length);
  if (e < 0) { problems.push(`line ${line}: end marker not found`); continue; }
  const old = lines[idx].slice(s + start.length, e);
  if (!cjkRe.test(old)) { problems.push(`line ${line}: extracted region has no CJK (${old.slice(0, 60)})`); continue; }
  const dollarOld = (old.match(/\$\{/g) ?? []).length;
  const dollarNew = (ru.match(/\$\{/g) ?? []).length;
  if (dollarOld !== dollarNew) { problems.push(`line ${line}: placeholder count ${dollarOld} -> ${dollarNew}`); continue; }
  const tickOld = (old.match(/`/g) ?? []).length;
  const tickNew = (ru.match(/`/g) ?? []).length;
  if (tickOld !== tickNew) { problems.push(`line ${line}: backtick count ${tickOld} -> ${tickNew}`); continue; }
  lines[idx] = lines[idx].slice(0, s + start.length) + ru + lines[idx].slice(e);
  applied += 1;
}
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
const out = lines.join(eol);
fs.writeFileSync(file, out, 'utf8');
const left = (out.match(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/gu) ?? []).length;
console.log(`applied=${applied} remainingCJK=${left}`);

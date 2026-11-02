import fs from 'node:fs';

const file = process.argv[2];
const out = process.argv[3];
const text = fs.readFileSync(file, 'utf8');
const lines = text.split(/\r?\n/);
const cjkAny = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3000-\u303F\uFF00-\uFFEF]/u;
const cjkChar = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/u;
const isQuote = (c) => c === '`' || c === "'" || c === '"';
const isAlnum = (c) => /[A-Za-z0-9_$]/.test(c);

function outerQuoteBefore(line, first) {
  let depth = 0;
  for (let i = first - 1; i >= 0; i -= 1) {
    const c = line[i];
    if (c === '}') depth += 1;
    else if (c === '{') { if (depth > 0) depth -= 1; }
    else if (depth === 0 && isQuote(c)) {
      if (c === '`' && line[i - 1] === '\\') continue;
      if (isAlnum(line[i - 1] ?? '')) continue;
      return c;
    }
  }
  return null;
}
function outerQuoteIndexBefore(line, first, quote) {
  let depth = 0;
  for (let i = first - 1; i >= 0; i -= 1) {
    const c = line[i];
    if (c === '}') depth += 1;
    else if (c === '{') { if (depth > 0) depth -= 1; }
    else if (depth === 0 && c === quote) {
      if (c === '`' && line[i - 1] === '\\') continue;
      if (isAlnum(line[i - 1] ?? '')) continue;
      return i;
    }
  }
  return -1;
}
function closeQuoteAfter(line, last, quote) {
  for (let i = last + 1; i < line.length; i += 1) {
    const c = line[i];
    if (c === quote && line[i - 1] !== '\\') return i;
  }
  return -1;
}

const chunks = [];
let count = 0;
for (let i = 0; i < lines.length; i += 1) {
  const line = lines[i];
  if (!cjkAny.test(line)) continue;
  count += 1;
  const first = line.search(cjkAny);
  let last = -1;
  for (let p = 0; p < line.length; p += 1) if (cjkAny.test(line[p])) last = p;
  const sepBefore = line.lastIndexOf(' / ', first);
  const quote = outerQuoteBefore(line, first);
  const literalOpen = quote === null ? -1 : outerQuoteIndexBefore(line, first, quote);
  const start = sepBefore >= 0 ? sepBefore + 3 : literalOpen + 1;
  const sepAfter = line.indexOf(' / ', last + 1);
  const literalClose = quote === null ? -1 : closeQuoteAfter(line, last, quote);
  const end = sepAfter >= 0 ? sepAfter : literalClose;
  const region = end > start ? line.slice(start, end) : '';
  const placeholders = (region.match(/\$\{/g) ?? []).length;
  const wrapped = [];
  for (let p = 0; p < region.length; p += 180) wrapped.push(`${i + 1}${p === 0 ? '' : '+'}\t${region.slice(p, p + 180)}`);
  chunks.push(`### line ${i + 1} start=${start} end=${end} quote=${quote ?? '-'} placeholders=${placeholders} cjkChars=${(region.match(cjkChar) ?? []).length}\n${wrapped.join('\n')}`);
}
fs.writeFileSync(out, chunks.join('\n'), 'utf8');
console.log(`${file}: lines=${lines.length} cjkLines=${count} regions=${chunks.length}`);


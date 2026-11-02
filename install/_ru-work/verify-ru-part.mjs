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
for (let i = 0; i < lines.length; i += 1) {
  const line = lines[i];
  if (!cjkAny.test(line)) continue;
  for (const lit of literals(line)) {
    if (!cjkAny.test(lit.content)) continue;
    const parts = lit.content.split(' / ');
    if (parts.length !== 3) continue;
    const [zh, en, ru] = parts;
    const zhC = (zh.match(cjkChar) ?? []).length;
    const enC = (en.match(cjkChar) ?? []).length;
    const ruC = (ru.match(cjkChar) ?? []).length;
    const ruZhRefs = [...ru.matchAll(/\$\{([A-Za-z_$][\w$]*)\}/g)].map((m) => m[1]).filter((v) => /(^|[a-z])(zh|Zh)$/.test(v));
    const enZhRefs = [...en.matchAll(/\$\{([A-Za-z_$][\w$]*)\}/g)].map((m) => m[1]).filter((v) => /(^|[a-z])(zh|Zh)$/.test(v));
    if (zhC === 0 || enC > 0 || ruC > 0 || ruZhRefs.length || enZhRefs.length) {
      rows.push(`line ${i + 1} zhC=${zhC} enC=${enC} ruC=${ruC} ruZhRefs=${ruZhRefs.join(',')} enZhRefs=${enZhRefs.join(',')} :: ${lit.content.slice(0, 120)}`);
    }
  }
}
console.log(rows.length ? rows.join('\n') : 'ALL THREE-PART LITERALS OK');

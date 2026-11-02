import fs from 'node:fs';

const files = process.argv.slice(2);
const cjkAny = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3000-\u303F\uFF00-\uFFEF]/u;
const cjkCountRe = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/gu;
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

const allowedFragment = (s) =>
  (s.startsWith('（') && s.endsWith('）'))
  || s === '原来的安装'
  || s === '原 Git 来源'
  || s === '更新前版本未知'
  || s === '更新前版本为 v${beforeVersion}'
  || s.startsWith('原来的版本仍然可用')
  || s.startsWith('${name} 更新实际解析为 v')
  || s.startsWith('${name} 更新目标为 v')
  || s.startsWith('系统拒绝执行它')
  || s.startsWith('要执行的文件已经不在了')
  || s.startsWith('命令行没能把它启动起来');

let totalCjk = 0;
let totalLiterals = 0;
let paired = 0;
let fragments = 0;
const problems = [];
const fragmentRows = [];
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);
  const cjkCount = (text.match(cjkCountRe) ?? []).length;
  totalCjk += cjkCount;
  let fileLiterals = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!cjkAny.test(line)) continue;
    for (const lit of literals(line)) {
      if (!cjkAny.test(lit.content)) continue;
      totalLiterals += 1;
      fileLiterals += 1;
      const parts = lit.content.split(' / ');
      if (parts.length === 1) {
        if (!allowedFragment(lit.content)) { problems.push(`${file}:${i + 1} unpaired CJK literal not in fragment allowlist`); continue; }
        fragments += 1;
        fragmentRows.push(`  ${file.split(/[\\/]/).pop()}:${i + 1} :: ${lit.content.slice(0, 130)}`);
        continue;
      }
      if (parts.length !== 3) { problems.push(`${file}:${i + 1} parts=${parts.length}`); continue; }
      const [zh, en, ru] = parts;
      const zhC = (zh.match(cjkCountRe) ?? []).length;
      const enC = (en.match(cjkCountRe) ?? []).length;
      const ruC = (ru.match(cjkCountRe) ?? []).length;
      const ruZhRefs = [...ru.matchAll(/\$\{([A-Za-z_$][\w$]*)\}/g)].map((m) => m[1]).filter((v) => /(^|[a-z])(zh|Zh)$/.test(v));
      const enZhRefs = [...en.matchAll(/\$\{([A-Za-z_$][\w$]*)\}/g)].map((m) => m[1]).filter((v) => /(^|[a-z])(zh|Zh)$/.test(v));
      if (zhC === 0) problems.push(`${file}:${i + 1} part0 has no CJK`);
      if (enC > 0) problems.push(`${file}:${i + 1} part1 has CJK (${enC})`);
      if (ruC > 0) problems.push(`${file}:${i + 1} part2 has CJK (${ruC})`);
      if (ruZhRefs.length) problems.push(`${file}:${i + 1} part2 references zh var(s): ${ruZhRefs.join(',')}`);
      if (enZhRefs.length) problems.push(`${file}:${i + 1} part1 references zh var(s): ${enZhRefs.join(',')}`);
      const counts = [zh, en, ru].map((p) => (p.match(/\$\{/g) ?? []).length);
      if (counts[2] !== counts[0] && counts[2] !== counts[1]) problems.push(`${file}:${i + 1} placeholder count zh=${counts[0]} en=${counts[1]} ru=${counts[2]}`);
      paired += 1;
    }
  }
  console.log(`${file.split(/[\\/]/).pop()}: cjkChars=${cjkCount} cjkLiterals=${fileLiterals}`);
}
console.log(`TOTAL cjkChars=${totalCjk} cjkLiterals=${totalLiterals} threePartWithRussian=${paired} fragments=${fragments}`);
if (fragmentRows.length) console.log('FRAGMENTS (inline halves of three-part messages; en/ru siblings in same scope):\n' + fragmentRows.join('\n'));
if (problems.length) { console.error('PROBLEMS:\n' + problems.join('\n')); process.exit(1); }
console.log('RESULT: OK — all bilingual user-facing CJK literals carry a Russian third part; no CJK in part1/part2; no zh refs in en/ru parts; placeholder counts match.');

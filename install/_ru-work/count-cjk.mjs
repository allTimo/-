import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort();
const out = [];
for (const f of files) {
  const text = fs.readFileSync(path.join(dir, f), 'utf8');
  const chars = (text.match(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/gu) ?? []).length;
  const lines = text.split(/\r?\n/);
  const cjkRe = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3000-\u303F\uFF00-\uFFEF]/u;
  let cjkLines = 0;
  for (const line of lines) if (cjkRe.test(line)) cjkLines += 1;
  out.push({ file: f, cjk: chars, lines: lines.length, cjkLines });
}
fs.writeFileSync(process.argv[3], JSON.stringify(out, null, 2), 'utf8');
for (const row of out) if (row.cjk > 0) console.log(`${row.file}\t${row.cjk}\t${row.lines}\t${row.cjkLines}`);

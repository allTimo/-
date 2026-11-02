import fs from 'node:fs';

const file = process.argv[2];
const out = process.argv[3];
const width = Number(process.argv[4] ?? 160);
const text = fs.readFileSync(file, 'utf8');
const lines = text.split(/\r?\n/);
const cjk = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3000-\u303F\uFF00-\uFFEF]/u;
const chunks = [];
let count = 0;
for (let i = 0; i < lines.length; i += 1) {
  const line = lines[i];
  if (!cjk.test(line)) continue;
  count += 1;
  for (let p = 0; p < line.length; p += width) {
    chunks.push(`${i + 1}${p === 0 ? '' : '+'}\t${line.slice(p, p + width)}`);
  }
}
fs.writeFileSync(out, chunks.join('\n'), 'utf8');
console.log(`${file}: lines=${lines.length} cjkLines=${count} chunks=${chunks.length}`);

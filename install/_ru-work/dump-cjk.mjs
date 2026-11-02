import fs from 'node:fs';

const file = process.argv[2];
const out = process.argv[3];
const text = fs.readFileSync(file, 'utf8');
const lines = text.split(/\r?\n/);
const cjk = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3000-\u303F\uFF00-\uFFEF]/u;
const picked = [];
for (let i = 0; i < lines.length; i += 1) {
  if (cjk.test(lines[i])) picked.push(`${i + 1}\t${lines[i]}`);
}
fs.writeFileSync(out, picked.join('\n'), 'utf8');
console.log(`${file}: lines=${lines.length} cjkLines=${picked.length}`);

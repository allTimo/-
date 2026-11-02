import fs from "node:fs";
const file = process.argv[2];
const text = fs.readFileSync(file, "utf8");
const lines = text.split(/\r?\n/);
const cjkAny = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3000-\u303F\uFF00-\uFFEF]/u;
for (let i = 0; i < lines.length; i += 1) {
  const line = lines[i];
  if (!cjkAny.test(line)) continue;
  const parts = line.split(" / ");
  if (parts.length < 3) continue;
  const ru = parts.slice(2).join(" / ");
  if (/\bzh\b|\bZh\b|zh\s*===|zh\s*\?|zh\s*\|\||zh\s*&&/.test(ru)) console.log(`${i + 1}: ${ru.slice(0, 180)}`);
}

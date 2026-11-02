import fs from "node:fs";
const map = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const skip = new Set([292,316,339,366,518,541,569,587,648,738,842,847,851]);
const out = [];
for (const e of map) {
  if (skip.has(e.line)) continue;
  let ru = e.ru;
  if (e.line === 858) ru = ru.replace("${why.zh}", "${why.ru}");
  out.push({ line: e.line, ru });
}
fs.writeFileSync(process.argv[3], JSON.stringify(out, null, 2), "utf8");
console.log(`entries=${out.length}`);

#!/usr/bin/env node
// collect-developer-sites.mjs — сбор цен с ОФИЦИАЛЬНЫХ САЙТОВ ЗАСТРОЙЩИКОВ.
//
// Основной путь сбора Агента 1 (по решению пользователя от 2026-10-31):
// обычный HTTP + разбор HTML, БЕЗ Chrome/CDP и БЕЗ авторизации.
// Циан и Авито отложены.
//
// Что делает:
//   node collect-developer-sites.mjs --site zilart --out zilart.json
//   node collect-developer-sites.mjs --probe https://example.com/   (диагностика площадки)
//
// Адаптер site=zilart читает публичный каталог zilart.ru:
//   /api/premise-plans-catalog/items?page=N -> HTML-карточки:
//   корпус | тип квартиры | площадь | «от X ₽» (цена позиции каталога).
// Честность: сайт отдаёт цены «от» по позициям (корпус+тип+площадь), а не шахматку
// по каждому лоту; в JSON так и записано (granularity).

const args = process.argv.slice(2);
const flag = (n, d = null) => { const i = args.indexOf(n); return i < 0 ? d : (args[i + 1] ?? true); };
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36";
const site = flag("--site", null);
const probeUrl = flag("--probe", null);
const outFile = flag("--out", null);
const maxPages = Number(flag("--max-pages", 10));

const ROOM_WORDS = [
  [/студи/i, 0],
  [/1-?\s?к/i, 1],
  [/2-?\s?к/i, 2],
  [/3-?\s?к/i, 3],
  [/4-?\s?к/i, 4],
  [/5-?\s?к/i, 6],
];

function roomsFromType(text) {
  if (!text) return null;
  for (const [re, value] of ROOM_WORDS) if (re.test(text)) return value;
  return null;
}

function textOf(block, re) {
  const m = block.match(re);
  return m ? m[1].trim() : null;
}

function parseZilartCards(html) {
  const blocks = html.split('<div class="card-flat"').slice(1);
  const rows = [];
  for (const block of blocks) {
    const corpus = textOf(block, /text-secondary">([^<]+)</);
    const typeText = textOf(block, /text-subtitles-m">([^<]+)</);
    const areaText = textOf(block, /tag[^>]*>([\d.,]+)\s*м2</);
    const priceText = textOf(block, /text-subtitles-s">([^<]+)</);
    const priceDigits = priceText ? priceText.replace(/[^\d]/g, "") : "";
    rows.push({
      corpus,
      type_text: typeText,
      rooms: roomsFromType(typeText),
      area_m2: areaText ? areaText.replace(",", ".") : null,
      price_text: priceText,
      price_rub: priceDigits ? Number(priceDigits) : null,
    });
  }
  return rows;
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { "user-agent": UA, accept: "text/html,application/json;q=0.9,*/*;q=0.8" }, redirect: "follow" });
  const text = await res.text();
  return { status: res.status, finalUrl: res.url, text };
}

async function collectZilart() {
  const positions = [];
  const pages = [];
  for (let p = 1; p <= maxPages; p++) {
    const url = `https://zilart.ru/api/premise-plans-catalog/items?page=${p}`;
    const r = await fetchText(url);
    const rows = parseZilartCards(r.text);
    pages.push({ page: p, http: r.status, positions: rows.length });
    if (!rows.length) break;
    for (const row of rows) positions.push({ ...row, page: p, source_url: "https://zilart.ru/" });
    await new Promise((res) => setTimeout(res, 700));   // вежливая пауза
  }
  return {
    site: "zilart.ru",
    project: "ЗИЛАРТ",
    competitor: "Группа ЛСР",
    granularity: "цена «от» по позиции каталога (корпус + тип квартиры + площадь); это НЕ шахматка по каждому лоту",
    limitations: "нет этажа, нет номера лота и корпуса-секции лота, отделка и срок сдачи в карточке не указаны",
    pages,
    positions,
  };
}

async function probe(url) {
  const r = await fetchText(url);
  const prices = r.text.match(/\d[\d\s\u00a0]{5,}\s*(?:₽|руб)/g) || [];
  const scripts = (r.text.match(/<script[^>]+src=/g) || []).length;
  return {
    url, final_url: r.finalUrl, http: r.status, bytes: r.text.length,
    price_mentions_in_html: prices.length,
    price_samples: prices.slice(0, 5),
    script_tags: scripts,
    verdict: prices.length
      ? "цены есть в HTML — можно собирать обычным HTTP"
      : "цены в HTML не найдены: скорее всего подгружаются JS или нужен другой раздел",
  };
}

let payload;
if (probeUrl) payload = { kind: "probe", results: [] };
payload = probeUrl
  ? { kind: "probe", collected_at: new Date().toISOString(), result: await probe(probeUrl) }
  : site === "zilart"
    ? { kind: "site", collected_at: new Date().toISOString(), ...(await collectZilart()) }
    : null;

if (!payload) { console.error("нужен --site zilart или --probe <url>"); process.exit(2); }
const text = JSON.stringify(payload, null, 1);
if (outFile) { const fsmod = await import("node:fs"); (fsmod.default ?? fsmod).writeFileSync(outFile, text, "utf8"); }
console.log(text);
process.exit(0);

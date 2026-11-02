#!/usr/bin/env node
// cian-collect.mjs — реальный сбор лотов ЖК с Циан через Chrome over CDP.
//
// Источник данных: серверное состояние страницы выдачи Циан (window._cianConfig
// -> "frontend-serp" -> initialState.results.offers). Это те же данные, что видит
// оператор в своём браузере; защита не обходится, ничего не подделывается.
//
// Использование:
//   node cian-collect.mjs --newobject 7889 --project "ЗИЛАРТ" --competitor zhk-competitor-3 --pages 5 --out lots.json
//
// Флаги: --port, --newobject <id ЖК на Циан>, --project <название>, --competitor <id из competitors.yaml>,
//        --pages N (по умолчанию 1), --page-size фикс 28 (как отдаёт Циан), --out <файл JSON>,
//        --pause-ms (пауза между страницами, по умолчанию 1500)

const args = process.argv.slice(2);
const flag = (n, d = null) => { const i = args.indexOf(n); return i < 0 ? d : (args[i + 1] ?? true); };
const port = Number(flag("--port", 9222));
const newobject = flag("--newobject", null);
const project = flag("--project", "");
const competitor = flag("--competitor", "");
const pages = Number(flag("--pages", 1));
const outFile = flag("--out", null);
const pauseMs = Number(flag("--pause-ms", 1500));
const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!newobject) { console.error("нужен --newobject <id ЖК на Циан>"); process.exit(2); }

const EXTRACT = String.raw`(() => {
  const cfg = window._cianConfig || {};
  const serp = cfg["frontend-serp"] || [];
  const init = (serp.find((e) => e && e.key === "initialState") || {}).value || {};
  const res = init.results || {};
  const offers = res.offers || [];
  const house = (o) => {
    const addr = (o.geo && o.geo.address) || [];
    const h = addr.find((a) => a.geoType === "house");
    return h ? h.title : null;
  };
  const rows = offers.map((o) => {
    const bt = o.bargainTerms || {};
    const price = bt.priceRur || bt.price || null;
    const dl = (o.building && o.building.deadline) || {};
    const roomsRaw = o.roomsCount;
    let rooms;
    if (o.flatType === "studio") rooms = 0;
    else if (roomsRaw == null) rooms = null;
    else rooms = Number(roomsRaw) >= 5 ? 6 : Number(roomsRaw);
    return {
      lot_id: String(o.id),
      url: o.fullUrl ? String(o.fullUrl).split("?")[0] : null,
      rooms,
      area_m2: o.totalArea ? String(o.totalArea).replace(",", ".") : null,
      floor: o.floorNumber == null ? null : Number(o.floorNumber),
      floors_total: o.building && o.building.floorsCount ? Number(o.building.floorsCount) : null,
      building: house(o),
      price_rub: price == null ? null : Number(price),
      decoration: o.decoration || null,
      status_raw: o.status || null,
      is_booked: !!(o.isBookedFromDeveloper || o.booking),
      delivery_year: dl.year || null,
      delivery_quarter: dl.quarter || null,
      promo_raw: o.promoInfo ? JSON.stringify(o.promoInfo) : null,
      subsidised: !!o.isSubsidisedMortgage,
      is_apartments: !!o.isApartments,
    };
  });
  return JSON.stringify({ offers: rows, total: res.extendedOffersCount || null, page_url: location.href });
})()`;

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = [];
    ws.addEventListener("message", (ev) => { const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id);
        if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result); }
      else if (m.method) this.events.push(m.method); }); }
  send(method, params = {}) { const id = ++this.id;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error("таймаут CDP: " + method)); } }, 40000); }); }
}

const version = await (await fetch(base + "/json/version")).json();
const tab = await (await fetch(base + "/json/new?about:blank", { method: "PUT" })).json();
const cdp = await new Promise((resolve, reject) => {
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  ws.addEventListener("open", () => resolve(new Cdp(ws)));
  ws.addEventListener("error", (e) => reject(new Error("WebSocket: " + (e.message || "?"))));
});
await cdp.send("Runtime.enable");
await cdp.send("Page.enable");

const all = [];
let totalReported = null;
const errors = [];

for (let p = 1; p <= pages; p++) {
  const url = "https://www.cian.ru/cat.php?deal_type=sale&engine_version=2&from_developer=1&newobject%5B0%5D=" + newobject +
    "&offer_type=flat" + (p > 1 ? "&p=" + p : "");
  cdp.events.length = 0;
  await cdp.send("Page.navigate", { url });
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && !cdp.events.includes("Page.loadEventFired")) await sleep(300);
  await sleep(2500);
  const ev = await cdp.send("Runtime.evaluate", { expression: EXTRACT, awaitPromise: true, returnByValue: true });
  const raw = ev.result ? ev.result.value : null;
  if (!raw) {
    errors.push({ page: p, error: ev.exceptionDetails ? (ev.exceptionDetails.exception?.description || ev.exceptionDetails.text) : "нет данных" });
    continue;
  }
  const parsed = JSON.parse(raw);
  if (parsed.total) totalReported = parsed.total;
  all.push(...parsed.offers);
  process.stderr.write("страница " + p + ": " + parsed.offers.length + " лотов\n");
  if (p < pages) await sleep(pauseMs);
}

const uniq = new Map();
for (const row of all) if (!uniq.has(row.lot_id)) uniq.set(row.lot_id, row);
const payload = {
  collected_at: new Date().toISOString(),
  chrome: version.Browser,
  source: "cian",
  newobject: String(newobject),
  project,
  competitor,
  pages_requested: pages,
  total_in_project_reported_by_cian: totalReported,
  lots_collected: uniq.size,
  errors,
  lots: [...uniq.values()],
};
const text = JSON.stringify(payload, null, 1);
if (outFile) { const fsmod = await import("node:fs"); (fsmod.default ?? fsmod).writeFileSync(outFile, text, "utf8"); }
console.log(text);
await fetch(base + "/json/close/" + tab.id).catch(() => {});
cdp.ws.close();
process.exit(0);

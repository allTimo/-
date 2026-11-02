#!/usr/bin/env node
// cdp-eval.mjs — маленький драйвер Chrome over CDP для Агента 1.
//
// Зачем: скилы cian-connector / avito-connector в этом профиле DSH не подключены
// (нужен локальный клон сервера + uv). Этот скрипт говорит с тем же Chrome по тому же
// протоколу CDP напрямую, чтобы можно было проверить доступность площадки и снять данные.
// Никаких обходов защиты: используется обычная сессия оператора в его Chrome.
//
// Использование:
//   node cdp-eval.mjs --url https://www.cian.ru/ --expr "document.title"
//   node cdp-eval.mjs --url <url> --wait-ms 8000 --expr "..." --keep
//
// Флаги:
//   --port N        порт CDP (по умолчанию 9222)
//   --url URL       адрес, который открыть в новой вкладке
//   --expr JS       выражение; поддерживает await (выполняется как async)
//   --wait-ms N     сколько ждать после загрузки (по умолчанию 5000)
//   --keep          не закрывать вкладку после выполнения
//   --json          печатать результат как JSON (по умолчанию так и есть)

const args = process.argv.slice(2);
function flag(name, def = null) {
  const i = args.indexOf(name);
  if (i < 0) return def;
  return args[i + 1] ?? true;
}
const port = Number(flag("--port", 9222));
const url = flag("--url", null);
let expr = flag("--expr", null);
const exprFile = flag("--expr-file", null);
if (exprFile) {
  const fsmod = await import("node:fs");
  expr = (fsmod.default ?? fsmod).readFileSync(exprFile, "utf8");
}
if (!expr) expr = "document.title";
const waitMs = Number(flag("--wait-ms", 5000));
const keep = args.includes("--keep");
const netRegex = flag("--net", null);
const netLimit = Number(flag("--net-limit", 5));
const base = `http://127.0.0.1:${port}`;

if (!url) {
  console.error("нужен --url");
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function jsonGet(path) {
  const res = await fetch(base + path);
  return res.json();
}

// Chrome >= 111 требует PUT для /json/new
async function newTab(target) {
  const res = await fetch(base + "/json/new?" + encodeURIComponent(target), { method: "PUT" });
  if (!res.ok) throw new Error("не удалось открыть вкладку: HTTP " + res.status);
  return res.json();
}

async function closeTab(id) {
  try { await fetch(base + "/json/close/" + id); } catch { /* ignore */ }
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    this.raw = [];
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg.method);
        if (this.raw) this.raw.push(msg);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error("таймаут CDP: " + method));
        }
      }, 30000);
    });
  }
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.addEventListener("open", () => resolve(new Cdp(ws)));
    ws.addEventListener("error", (e) => reject(new Error("ошибка WebSocket: " + (e.message || "неизвестно"))));
  });
}

const version = await jsonGet("/json/version");
const tab = await newTab(url);
const cdp = await connect(tab.webSocketDebuggerUrl);
await cdp.send("Runtime.enable");
await cdp.send("Page.enable");
if (netRegex) await cdp.send("Network.enable");

// ждём завершения навигации + дополнительная пауза на отрисовку/запросы
const navDeadline = Date.now() + 20000;
while (Date.now() < navDeadline && !cdp.events.includes("Page.loadEventFired")) {
  await sleep(300);
}
await sleep(waitMs);

// Если в выражении есть return — это тело функции; иначе выражение оборачивается
// в выражение-стрелку, чтобы его значение вернулось наружу.
const isBody = /\breturn\b/.test(expr);
const wrapped = isBody
  ? `(async () => { ${expr} })()`
  : `(async () => ( ${expr} ))()`;

// --- перехват сетевых ответов (по желанию) ---------------------------------
let captured = [];
if (netRegex) {
  const re = new RegExp(netRegex);
  const seen = new Set();
  for (const ev of cdp.raw) {
    if (ev.method !== "Network.responseReceived") continue;
    const { requestId, response } = ev.params;
    if (!re.test(response.url) || seen.has(requestId)) continue;
    seen.add(requestId);
    if (captured.length >= netLimit) continue;
    let body = null;
    try {
      const rr = await cdp.send("Network.getResponseBody", { requestId });
      body = rr.base64Encoded ? "<base64>" : String(rr.body).slice(0, 1500);
    } catch (e) {
      body = "<body недоступен: " + e.message + ">";
    }
    captured.push({ url: response.url, status: response.status, mime: response.mimeType, body });
  }
}

const evaluated = await cdp.send("Runtime.evaluate", {
  expression: wrapped,
  awaitPromise: true,
  returnByValue: true,
  userGesture: true,
});

const payload = {
  ok: true,
  chrome: version.Browser,
  target_url: url,
  result: evaluated.result ? evaluated.result.value : null,
  exception: evaluated.exceptionDetails
    ? (evaluated.exceptionDetails.exception?.description || evaluated.exceptionDetails.text)
    : null,
  loaded: cdp.events.includes("Page.loadEventFired"),
  captured: captured.length ? captured : undefined,
};
console.log(JSON.stringify(payload, null, 2));

if (!keep) await closeTab(tab.id);
cdp.ws.close();
process.exit(0);

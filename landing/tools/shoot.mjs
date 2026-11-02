#!/usr/bin/env node
// Снимок страницы через Chrome по CDP (тот же отладочный Chrome, что у коннекторов).
//
// Зачем: лендинг нужно проверять глазами — на 1920, 1280, 768, 390 и 360 px.
// Скрипт задаёт размер вьюпорта, ждёт отрисовку и сохраняет PNG.
//
// Запуск:
//   node marketing-agents/landing/tools/shoot.mjs --url http://127.0.0.1:8910/landing/index.html \
//     --width 390 --height 844 --out marketing-agents/landing/screenshots/landing-mobile.png --full
//
// Флаги:
//   --port 9222   порт CDP
//   --url URL     что открыть (обязательно)
//   --width N     ширина вьюпорта (по умолчанию 1440)
//   --height N    высота вьюпорта (по умолчанию 900)
//   --dpr N       плотность пикселей (по умолчанию 1)
//   --out PATH    куда сохранить PNG (обязательно)
//   --full        снимать страницу целиком, а не только первый экран
//   --wait-ms N   пауза после загрузки (по умолчанию 700)
//   --eval FILE   выполнить JS из файла до снимка (например, раскрыть блок)
//   --mobile      включить мобильные метрики (эмуляция тач-устройства)

import { promises as fs } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const argOf = (name, def = undefined) => { const i = args.indexOf(name); return i >= 0 ? (args[i + 1] ?? true) : def; };
const has = (name) => args.includes(name);

const port = Number(argOf('--port', 9222));
const url = argOf('--url');
const width = Number(argOf('--width', 1440));
const height = Number(argOf('--height', 900));
const dpr = Number(argOf('--dpr', 1));
const out = argOf('--out');
const full = has('--full');
const mobile = has('--mobile');
const waitMs = Number(argOf('--wait-ms', 700));
const evalFile = argOf('--eval', null);

if (!url || !out) { console.error('нужны --url и --out'); process.exit(2); }

const base = 'http://127.0.0.1:' + port;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    const events = [];
    let id = 0;
    let ready = false;
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve: res, reject: rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message)); else res(msg.result);
      } else if (msg.method) { events.push(msg.method); }
    });
    ws.addEventListener('error', (e) => reject(new Error('websocket: ' + (e.message || 'ошибка'))));
    ws.addEventListener('open', () => {
      ready = true;
      resolve({
        events,
        send(method, params = {}) {
          const mid = ++id;
          return new Promise((res, rej) => {
            pending.set(mid, { resolve: res, reject: rej });
            ws.send(JSON.stringify({ id: mid, method, params }));
            setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error('таймаут CDP: ' + method)); } }, 30000);
          });
        },
        close() { ws.close(); },
        get isOpen() { return ready; }
      });
    });
  });
}

const version = await (await fetch(base + '/json/version')).json();
const tab = await (await fetch(base + '/json/new?' + encodeURIComponent('about:blank'), { method: 'PUT' })).json();
const cdp = await connect(tab.webSocketDebuggerUrl);
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('Emulation.setDeviceMetricsOverride', {
  width, height, deviceScaleFactor: dpr, mobile
});
await cdp.send('Emulation.setVisibleSize', { width, height }).catch(() => {});
await cdp.send('Page.navigate', { url });

const deadline = Date.now() + 25000;
while (Date.now() < deadline && !cdp.events.includes('Page.loadEventFired')) await sleep(200);
await sleep(waitMs);

if (evalFile) {
  const code = await fs.readFile(evalFile, 'utf8');
  const r = await cdp.send('Runtime.evaluate', {
    expression: '(async () => { ' + code + ' })()',
    awaitPromise: true, returnByValue: true, userGesture: true
  });
  if (r.exceptionDetails) console.error('eval error: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  else if (r.result && r.result.value !== undefined) console.log('eval: ' + JSON.stringify(r.result.value));
  await sleep(300);
}

let shotParams = { format: 'png', fromSurface: true };
if (full) {
  const metrics = await cdp.send('Page.getLayoutMetrics');
  const size = metrics.cssContentSize || metrics.contentSize;
  shotParams = {
    ...shotParams, captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: Math.ceil(size.width), height: Math.ceil(size.height), scale: 1 }
  };
}
const shot = await cdp.send('Page.captureScreenshot', shotParams);
await fs.mkdir(path.dirname(path.resolve(out)), { recursive: true });
await fs.writeFile(path.resolve(out), Buffer.from(shot.data, 'base64'));

console.log(JSON.stringify({
  ok: true, chrome: version.Browser, url, width, height, dpr, full,
  out: path.resolve(out), bytes: Buffer.from(shot.data, 'base64').length
}, null, 2));

await fetch(base + '/json/close/' + tab.id).catch(() => {});
cdp.close();
process.exit(0);

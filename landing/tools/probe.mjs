#!/usr/bin/env node
// Фактическая проверка формы заявки на лендинге через Chrome (CDP).
//
// Сценарий A (--mode ready): сервер с приёмом заявок.
//   1) открывает лендинг, 2) заполняет форму, 3) нажимает «Отправить заявку»,
//   4) ждёт перехода на thanks.html, 5) проверяет, что заявка реально записана в leads.ndjson.
// Сценарий B (--mode not-ready): сервер с выключенным приёмом (serve.mjs --no-lead).
//   Проверяет, что форма НЕ делает вид, что отправила: показывает «Заявка не отправлена»,
//   остаётся на странице и заявка нигде не сохраняется.
//
// Запуск:
//   node marketing-agents/landing/tools/probe.mjs --mode ready --base http://127.0.0.1:8910
//   node marketing-agents/landing/tools/probe.mjs --mode not-ready --base http://127.0.0.1:8911

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LANDING = path.resolve(HERE, '..');
const LEADS = path.join(LANDING, 'data', 'leads.ndjson');

const args = process.argv.slice(2);
const argOf = (name, def = undefined) => { const i = args.indexOf(name); return i >= 0 ? (args[i + 1] ?? true) : def; };
const port = Number(argOf('--port', 9222));
const mode = argOf('--mode', 'ready');
const base = String(argOf('--base', 'http://127.0.0.1:8910')).replace(/\/$/, '');
const shotOut = argOf('--shot', null);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cdpBase = 'http://127.0.0.1:' + port;

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    const events = [];
    let id = 0;
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
      } else if (msg.method) { events.push({ method: msg.method, params: msg.params }); }
    });
    ws.addEventListener('error', (e) => reject(new Error('websocket: ' + (e.message || 'ошибка'))));
    ws.addEventListener('open', () => resolve({
      events,
      send(method, params = {}) {
        const mid = ++id;
        return new Promise((res, rej) => {
          pending.set(mid, { resolve: res, reject: rej });
          ws.send(JSON.stringify({ id: mid, method, params }));
          setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error('таймаут CDP: ' + method)); } }, 30000);
        });
      },
      close() { ws.close(); }
    }));
  });
}

async function evaluate(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', {
    expression: '(async () => { ' + expression + ' })()',
    awaitPromise: true, returnByValue: true, userGesture: true
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result ? r.result.value : null;
}

const uniqueMark = 'ПРОВЕРКА-' + Date.now();
const fillLines = [
  '  const set = (id, v) => {',
  '    const el = document.getElementById(id);',
  "    if (!el) throw new Error('нет поля ' + id);",
  '    el.value = v;',
  "    el.dispatchEvent(new Event('input', { bubbles: true }));",
  "    el.dispatchEvent(new Event('change', { bubbles: true }));",
  '  };',
  "  set('lf-name', 'Проверка Формы');",
  "  set('lf-contact', '+7 999 123-45-67');",
  "  set('lf-object', 'ЖК Проверочный');",
  "  set('lf-competitors', 'ЗИЛАРТ, ЛСР');",
  "  set('lf-comment', MARK);",
  "  const c = document.getElementById('lf-consent');",
  "  c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true }));",
  "  const form = document.getElementById('lead-form');",
  "  const visible = { name: document.getElementById('lf-name').value, consent: c.checked, endpoint: form.getAttribute('data-endpoint') };",
  "  document.getElementById('lf-submit').click();",
  '  return visible;'
];
const fillJs = 'const MARK = ' + JSON.stringify(uniqueMark) + ';\n' + fillLines.join('\n');

let leadsBefore = [];
try { leadsBefore = (await fs.readFile(LEADS, 'utf8')).split('\n').filter((l) => l.trim() !== ''); } catch (e) { leadsBefore = []; }

const version = await (await fetch(cdpBase + '/json/version')).json();
const tab = await (await fetch(cdpBase + '/json/new?' + encodeURIComponent('about:blank'), { method: 'PUT' })).json();
const cdp = await connect(tab.webSocketDebuggerUrl);
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 950, deviceScaleFactor: 1, mobile: false });
await cdp.send('Page.navigate', { url: base + '/landing/index.html' });
const dl = Date.now() + 25000;
while (Date.now() < dl && !cdp.events.some((e) => e.method === 'Page.loadEventFired')) await sleep(200);
await sleep(500);

const afterFill = await evaluate(cdp, fillJs);

let navigated = false, finalUrl = null, statusText = '';
const stateExpr = 'return { url: location.href, status: (document.getElementById("lf-status") || {}).innerText || "" };';
const deadline2 = Date.now() + 12000;
while (Date.now() < deadline2) {
  const nav = cdp.events.find((e) => e.method === 'Page.frameNavigated' && e.params && e.params.frame && e.params.frame.url && e.params.frame.url.indexOf('thanks.html') >= 0);
  if (nav) { navigated = true; break; }
  const state = await evaluate(cdp, stateExpr).catch(() => null);
  if (state) {
    statusText = state.status || '';
    if (state.url && state.url.indexOf('thanks.html') >= 0) { navigated = true; finalUrl = state.url; break; }
    if (statusText && /Проверьте поля|не отправлена|не принял|не отвечает/.test(statusText)) break;
  }
  await sleep(400);
}
if (!finalUrl) finalUrl = await evaluate(cdp, 'return location.href;').catch(() => null);
const statusFinal = await evaluate(cdp, 'return (document.getElementById("lf-status") || {}).innerText || "";').catch(() => '');
const errFinal = await evaluate(cdp, 'return Array.from(document.querySelectorAll(".f-err")).filter(function (e) { return !e.hidden; }).map(function (e) { return e.textContent.trim(); });').catch(() => []);

let leadsAfter = [];
try { leadsAfter = (await fs.readFile(LEADS, 'utf8')).split('\n').filter((l) => l.trim() !== ''); } catch (e) { leadsAfter = []; }
const stored = leadsAfter.filter((l) => l.indexOf(uniqueMark) >= 0);

if (shotOut) {
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  await fs.mkdir(path.dirname(path.resolve(shotOut)), { recursive: true });
  await fs.writeFile(path.resolve(shotOut), Buffer.from(shot.data, 'base64'));
}

const result = {
  mode, chrome: version.Browser, base,
  filled: afterFill,
  navigatedToThanks: navigated,
  finalUrl,
  statusText: (statusFinal || statusText || '').trim(),
  fieldErrors: errFinal,
  leadsBefore: leadsBefore.length,
  leadsAfter: leadsAfter.length,
  storedLead: stored[0] ? JSON.parse(stored[0]) : null,
  verdict: null
};

if (mode === 'ready') {
  result.verdict = (navigated && result.finalUrl && result.finalUrl.indexOf('thanks.html') >= 0 && stored.length === 1)
    ? 'PASS: заявка отправлена, сохранена и открылась страница «спасибо»'
    : 'FAIL: ' + JSON.stringify({ navigated, finalUrl: result.finalUrl, stored: stored.length, status: result.statusText });
} else {
  const honest = /Заявка не отправлена/.test(result.statusText) || /Приём заявок на сервере ещё не включён/.test(result.statusText);
  result.verdict = (!navigated && honest && stored.length === 0)
    ? 'PASS: форма честно сообщила, что заявка не отправлена (имитации нет)'
    : 'FAIL: ' + JSON.stringify({ navigated, stored: stored.length, status: result.statusText });
}

console.log(JSON.stringify(result, null, 2));
await fetch(cdpBase + '/json/close/' + tab.id).catch(() => {});
cdp.close();
process.exit(result.verdict.startsWith('PASS') ? 0 : 1);

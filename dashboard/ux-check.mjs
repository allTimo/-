#!/usr/bin/env node
/**
 * ux-check.mjs — поведенческий автотест панели через Chrome DevTools Protocol.
 *
 * ЗАЧЕМ: приёмка «по наличию элементов в DOM» пропускает дефекты вида
 * «кнопка подсветилась, а содержимое не изменилось». Этот тест сравнивает
 * СОДЕРЖИМОЕ до/после действия, а не разметку.
 *
 * Запуск:
 *   node marketing-agents\dashboard\ux-check.mjs
 *   node ux-check.mjs --url http://127.0.0.1:8787 --cdp http://127.0.0.1:9222
 *   node ux-check.mjs --allow-known     # exit 0, если упали только известные дефекты
 *
 * Если Chrome с отладкой не поднят, тест сам поднимает headless Chrome
 * со временным профилем и случайным портом (см. --no-launch).
 *
 * Результат: dashboard/ux-report.json + сводка в stdout.
 * Код выхода: 0 — OK (или только известные дефекты при --allow-known),
 *             1 — есть провалы, 2 — не удалось подключиться/поднять браузер или панель.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));

// Известные дефекты: тест обязан их ловить, но они ещё не исправлены.
const KNOWN_DEFECTS = ['analytics.modes'];

function parseArgs(argv) {
  const a = {
    url: process.env.UX_URL || 'http://127.0.0.1:8787',
    cdp: process.env.UX_CDP || 'http://127.0.0.1:9222',
    out: join(HERE, 'ux-report.json'),
    launch: true, allowKnown: false, timeoutMs: 60000, verbose: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--url') a.url = argv[++i];
    else if (k === '--cdp') a.cdp = argv[++i];
    else if (k === '--out') a.out = argv[++i];
    else if (k === '--no-launch') a.launch = false;
    else if (k === '--allow-known') a.allowKnown = true;
    else if (k === '--timeout') a.timeoutMs = Number(argv[++i]) || 60000;
    else if (k === '--verbose') a.verbose = true;
    else if (k === '--help' || k === '-h') { printHelp(); process.exit(0); }
  }
  a.url = a.url.replace(/\/+$/, '');
  a.cdp = a.cdp.replace(/\/+$/, '');
  return a;
}

function printHelp() {
  console.log([
    'ux-check.mjs — поведенческий UX-автотест панели (Chrome DevTools Protocol)',
    '',
    '  --url <u>       адрес панели (по умолчанию http://127.0.0.1:8787)',
    '  --cdp <u>       адрес CDP Chrome (по умолчанию http://127.0.0.1:9222)',
    '  --out <file>    JSON-отчёт (по умолчанию dashboard/ux-report.json)',
    '  --no-launch     не поднимать Chrome, если CDP недоступен (выход 2)',
    '  --allow-known   exit 0, если упали только известные дефекты',
    '  --verbose       печатать детали',
  ].join('\n'));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, timeoutMs = 4000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally { clearTimeout(t); }
}

async function probe(url, timeoutMs = 4000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    return { ok: res.ok, status: res.status, len: (await res.text()).length };
  } catch (e) {
    return { ok: false, status: 0, error: String((e && e.message) || e) };
  } finally { clearTimeout(t); }
}

function findChrome() {
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env['LOCALAPPDATA'] || '';
  const cands = [
    join(pf, 'Google\\Chrome\\Application\\chrome.exe'),
    join(pf86, 'Google\\Chrome\\Application\\chrome.exe'),
    local ? join(local, 'Google\\Chrome\\Application\\chrome.exe') : '',
  ].filter(Boolean);
  for (const c of cands) if (existsSync(c)) return c;
  return null;
}

class CDP {
  constructor(wsUrl) {
    this.wsUrl = wsUrl; this.id = 0; this.pending = new Map(); this.listeners = new Map();
  }
  static async browserEndpoint(base) {
    const v = await getJson(base + '/json/version');
    if (!v.webSocketDebuggerUrl) throw new Error('CDP не отдал webSocketDebuggerUrl');
    return { wsUrl: v.webSocketDebuggerUrl, version: v };
  }
  open() {
    return new Promise((res, rej) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      const to = setTimeout(() => rej(new Error('таймаут подключения к CDP')), 15000);
      ws.addEventListener('open', () => { clearTimeout(to); res(this); });
      ws.addEventListener('error', () => { clearTimeout(to); rej(new Error('ошибка WebSocket CDP')); });
      ws.addEventListener('message', (ev) => this._onMessage(ev.data));
      ws.addEventListener('close', () => {
        for (const [, p] of this.pending) p.reject(new Error('CDP закрыт'));
        this.pending.clear();
      });
    });
  }
  _onMessage(raw) {
    let msg;
    try { msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString()); } catch { return; }
    if (msg.id && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || 'CDP error'));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method) {
      for (const fn of (this.listeners.get(msg.method) || [])) fn(msg);
      for (const fn of (this.listeners.get('*') || [])) fn(msg);
    }
  }
  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
    return this;
  }
  send(method, params, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params: params || {} };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => { this.pending.delete(id); reject(new Error('таймаут CDP ' + method)); }, 30000);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(to); resolve(v); },
        reject: (e) => { clearTimeout(to); reject(e); },
      });
      this.ws.send(JSON.stringify(payload));
    });
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

const HELPERS = [
  '(() => {',
  '  const norm = (s) => String(s == null ? "" : s).replace(/\\s+/g, " ").trim();',
  '  const q = (sel) => document.querySelector(sel);',
  '  window.__ux = {',
  '    norm,',
  '    text(sel, max) { const e = q(sel); return e ? norm(e.innerText).slice(0, max || 600) : ""; },',
  '    fp(sel) {',
  '      const t = this.text(sel, 300000); let h = 5381;',
  '      for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) | 0;',
  '      return h + "/" + t.length;',
  '    },',
  '    fpAll(sel) {',
  '      const e = q(sel); const t = e ? norm(e.textContent).slice(0, 300000) : ""; let h = 5381;',
  '      for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) | 0;',
  '      return h + "/" + t.length;',
  '    },',
  '    count: (sel) => document.querySelectorAll(sel).length,',
  '    rows: () => document.querySelectorAll("#view table.data tbody tr").length,',
  '    firstCol: (n) => Array.from(document.querySelectorAll("#view table.data tbody tr")).slice(0, n || 8)',
  '      .map((tr) => { const td = tr.querySelector("td"); return td ? norm(td.innerText) : ""; }),',
  '    click(sel, idx) { const els = document.querySelectorAll(sel); const e = els[idx || 0]; if (!e) return false; e.click(); return true; },',
  '    setVal(sel, val) { const e = q(sel); if (!e) return false; e.focus(); e.value = val;',
  '      e.dispatchEvent(new Event("input", { bubbles: true })); e.dispatchEvent(new Event("change", { bubbles: true })); return true; },',
  '    setSel(sel, val) { const e = q(sel); if (!e) return false; e.value = val; e.dispatchEvent(new Event("change", { bubbles: true })); return true; },',
  '    esc() { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); },',
  '    visible(sel) { const e = q(sel); if (!e) return false; const st = getComputedStyle(e); const r = e.getBoundingClientRect();',
  '      return !e.hidden && st.display !== "none" && st.visibility !== "hidden" && (r.width > 0 || r.height > 0); },',
  '    anyVisible(sel) { return Array.from(document.querySelectorAll(sel)).some((e) => { const st = getComputedStyle(e); const r = e.getBoundingClientRect();',
  '      return !e.hidden && st.display !== "none" && (r.width > 0 || r.height > 0); }); },',
  '    hash: () => location.hash,',
  '    setHash(h) { location.hash = h; },',
  '    scrollLocked() { return getComputedStyle(document.body).overflow === "hidden" || getComputedStyle(document.documentElement).overflow === "hidden"; },',
  '    list(sel) { return Array.from(document.querySelectorAll(sel)).map((e, i) => ({ i, text: norm(e.innerText).slice(0, 70) })); },',
  '    labels(sel) { return Array.from(document.querySelectorAll(sel)).map((e) => norm(e.innerText).slice(0, 40)); },',
  '    attrs(sel, attr) { return Array.from(document.querySelectorAll(sel)).map((e) => e.getAttribute(attr)); },',
  '    startMutations() { this._m = 0; if (this._obs) this._obs.disconnect();',
  '      this._obs = new MutationObserver((ms) => { this._m += ms.length; });',
  '      this._obs.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true }); },',
  '    stopMutations() { if (this._obs) this._obs.disconnect(); return this._m || 0; },',
  '    empties() {',
  '      const bad = [];',
  '      document.querySelectorAll("#view table.data").forEach((t, i) => {',
  '        if (t.querySelectorAll("tbody tr").length > 0) return;',
  '        let node = t.parentElement; let txt = "";',
  '        for (let k = 0; k < 4 && node; k++) { txt += " " + norm(node.innerText); node = node.parentElement; }',
  '        if (!/нет данных|данных нет|пусто|не найден|появятся|ничего|пока нет|не удалось|недоступн/i.test(txt)) bad.push({ table: i, text: norm(t.innerText).slice(0, 120) });',
  '      });',
  '      return bad;',
  '    },',
  '  };',
  '})();',
].join('\n');

async function connectAndOpenPage(args) {
  let cdpBase = args.cdp; let version = null; let launched = null;
  try {
    version = (await CDP.browserEndpoint(cdpBase)).version;
  } catch (e) {
    if (!args.launch) throw new Error('CDP недоступен (' + cdpBase + '): ' + e.message + ' — запустите marketing-agents\\00-admin\\scripts\\start-chrome-cdp.ps1');
    const chrome = findChrome();
    if (!chrome) throw new Error('CDP недоступен и chrome.exe не найден');
    const profile = join(tmpdir(), 'dsh-ux-check-' + Date.now().toString(36));
    mkdirSync(profile, { recursive: true });
    const proc = spawn(chrome, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--disable-extensions', '--mute-audio', '--window-size=1600,1100',
      '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank',
    ], { stdio: 'ignore' });
    launched = { proc, profile };
    const portFile = join(profile, 'DevToolsActivePort');
    const deadline = Date.now() + 20000;
    let port = null;
    while (Date.now() < deadline) {
      if (existsSync(portFile)) {
        const line = readFileSync(portFile, 'utf8').split(/\r?\n/)[0].trim();
        if (/^\d+$/.test(line)) { port = Number(line); break; }
      }
      await sleep(200);
    }
    if (!port) throw new Error('headless Chrome не открыл отладочный порт за 20 с');
    cdpBase = 'http://127.0.0.1:' + port;
    version = (await CDP.browserEndpoint(cdpBase)).version;
  }
  const ep = await CDP.browserEndpoint(cdpBase);
  const cdp = await new CDP(ep.wsUrl).open();
  const t = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const att = await cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
  cdp.sessionId = att.sessionId;
  return { cdp, cdpBase, version, launched, targetId: t.targetId };
}

class Page {
  constructor(cdp) {
    this.cdp = cdp;
    this.errors = [];
    cdp.on('Runtime.exceptionThrown', (m) => {
      if (m.sessionId !== cdp.sessionId) return;
      const d = m.params && m.params.exceptionDetails;
      this.errors.push({ kind: 'uncaught', text: (d && ((d.exception && d.exception.description) || d.text)) || 'unknown' });
    });
    cdp.on('Runtime.consoleAPICalled', (m) => {
      if (m.sessionId !== cdp.sessionId) return;
      if (m.params && m.params.type === 'error') {
        this.errors.push({ kind: 'console.error', text: (m.params.args || []).map((a) => a.value || a.description || a.type).join(' ') });
      }
    });
    cdp.on('Log.entryAdded', (m) => {
      if (m.sessionId !== cdp.sessionId) return;
      const e = m.params && m.params.entry;
      if (e && e.level === 'error') this.errors.push({ kind: 'log', text: e.text || '' });
    });
    // Подтверждения (confirm) блокируют рендерер и вешают CDP — отклоняем их.
    cdp.on('Page.javascriptDialogOpening', (m) => {
      if (m.sessionId !== cdp.sessionId) return;
      this.dialogs = (this.dialogs || 0) + 1;
      cdp.send('Page.handleJavaScriptDialog', { accept: false }, cdp.sessionId).catch(() => {});
    });
  }
  async enable() {
    await this.cdp.send('Page.enable', {}, this.cdp.sessionId);
    await this.cdp.send('Runtime.enable', {}, this.cdp.sessionId);
    await this.cdp.send('Log.enable', {}, this.cdp.sessionId);
  }
  async goto(url) { await this.cdp.send('Page.navigate', { url }, this.cdp.sessionId); await this.waitReady(); }
  async waitReady(timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try { if ((await this.eval('document.readyState')) === 'complete') return true; } catch { /* navigating */ }
      await sleep(120);
    }
    return false;
  }
  async waitFor(expr, timeoutMs = 8000, interval = 120) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try { if (await this.eval(expr)) return true; } catch { /* retry */ }
      await sleep(interval);
    }
    return false;
  }
  async eval(expr) {
    const r = await this.cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true }, this.cdp.sessionId);
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error((d.exception && d.exception.description) || d.text || 'ошибка в странице');
    }
    return r.result && r.result.value;
  }
  async helpers() { await this.eval(HELPERS); }
}

class Runner {
  constructor() { this.steps = []; }
  push(status, id, title, detail, extra) { this.steps.push(Object.assign({ id, title, status, detail: detail || '' }, extra || {})); }
  ok(id, t, d, e) { this.push('OK', id, t, d, e); }
  fail(id, t, d, e) { this.push('FAIL', id, t, d, e); }
  skip(id, t, d) { this.push('SKIP', id, t, d); }
  info(id, t, d, e) { this.push('INFO', id, t, d, e); }
}

const CLICK = (sel, i) => '__ux.click(' + JSON.stringify(sel) + ',' + (i || 0) + ')';
const HASH = '__ux.hash()';

async function checkBoot(page, r, args) {
  const http = await probe(args.url + '/', 8000);
  if (!http.ok) { r.fail('boot.http', 'Панель отвечает по HTTP', 'GET / -> ' + (http.status || http.error)); return false; }
  r.ok('boot.http', 'Панель отвечает по HTTP', 'GET / -> ' + http.status + ', ' + http.len + ' байт');
  page.baseUrl = args.url + '/';
  await page.goto(page.baseUrl);
  await page.helpers();
  const ready = await page.waitFor("(() => { const v = document.querySelector('#view'); if (!v) return false; const t = v.innerText.replace(/\\s+/g,' ').trim(); return t.length > 40 && !/Загружаю данные панели/.test(v.innerText); })()", 20000);
  if (!ready) { r.fail('boot.render', 'Панель отрисовалась', 'в #view плейсхолдер «Загружаю данные панели…» или пусто'); return false; }
  r.ok('boot.render', 'Панель отрисовалась', await page.eval("__ux.text('#view', 80)"));
  return true;
}

async function checkSidebar(page, r) {
  const items = await page.eval("__ux.list('#sidebar .sb-item')");
  if (!items || items.length < 5) { r.fail('sidebar.items', 'Боковое меню: пункты', 'найдено: ' + (items ? items.length : 0)); return; }
  const bad = [];
  let prevHash = await page.eval(HASH);
  let prevSig = await page.eval("__ux.text('#view', 400)");
  for (const it of items) {
    const wasActive = await page.eval("(() => { const e = document.querySelectorAll('#sidebar .sb-item')[" + it.i + "]; return !!(e && e.classList.contains('active')); })()");
    if (!(await page.eval(CLICK('#sidebar .sb-item', it.i)))) { bad.push(it.text + ': не кликается'); continue; }
    await sleep(230); await page.helpers();
    const hash = await page.eval(HASH);
    const sig = await page.eval("__ux.text('#view', 400)");
    if (wasActive) { prevHash = hash; prevSig = sig; continue; }
    if (hash === prevHash) bad.push(it.text + ': адрес не изменился (' + hash + ')');
    else if (sig === prevSig) bad.push(it.text + ': содержимое не изменилось');
    prevHash = hash; prevSig = sig;
  }
  if (bad.length) r.fail('sidebar.items', 'Боковое меню: каждый пункт открывает свой раздел', bad.slice(0, 6).join('; '), { failures: bad });
  else r.ok('sidebar.items', 'Боковое меню: каждый пункт открывает свой раздел', 'проверено пунктов: ' + items.length);
}

async function checkAnalyticsModes(page, r) {
  await page.eval("__ux.setHash('#analytics')");
  await page.waitFor("/#analytics/.test(__ux.hash())", 5000);
  await sleep(600); await page.helpers();
  const labels = await page.eval("__ux.labels('.seg-btn[data-cr-mode]')");
  const modes = await page.eval("__ux.attrs('.seg-btn[data-cr-mode]', 'data-cr-mode')");
  if (!labels || labels.length < 2) { r.skip('analytics.modes', 'Аналитика: переключатели меняют содержимое', 'не найдено .seg-btn[data-cr-mode]'); return; }
  const seen = [];
  for (let i = 0; i < labels.length; i++) {
    await page.eval(CLICK('.seg-btn[data-cr-mode]', i));
    await sleep(450); await page.helpers();
    seen.push({
      label: labels[i], mode: modes[i],
      hash: await page.eval(HASH),
      active: await page.eval("(() => { const e = document.querySelector('.seg-btn[data-cr-mode].on'); return e ? __ux.norm(e.innerText) : ''; })()"),
      fp: await page.eval("__ux.fp('#view')"),
      fpAll: await page.eval("__ux.fpAll('#view')"),
      sample: await page.eval("__ux.text('#view', 140)"),
    });
  }
  // ВАЖНО: fp считается по ВИДИМОМУ тексту (innerText не включает display:none/hidden).
  // fpAll — по всему textContent, включая скрытое; он приводится для контраста.
  const uniq = new Set(seen.map((s) => s.fp));
  const uniqAll = new Set(seen.map((s) => s.fpAll));
  const activeMoved = seen.every((s) => s.active === s.label);
  const detail = seen.map((s) => s.label + ' [' + s.mode + '] hash=' + s.hash + ' active="' + s.active + '" fpВИДИМ=' + s.fp + ' fpВЕСЬ=' + s.fpAll).join(' | ');
  const note = 'Отпечаток fpВИДИМ — по видимому содержимому #view (innerText: скрытое через display:none/hidden не учитывается); fpВЕСЬ — по полному textContent, включая скрытое. Вердикт — по fpВИДИМ.';
  if (uniq.size === labels.length && activeMoved) r.ok('analytics.modes', 'Аналитика: переключатели меняют содержимое', note + ' ' + detail, { modes: seen, visibleOnly: true, uniqueVisible: uniq.size, uniqueAll: uniqAll.size, note });
  else if (uniq.size <= 1) r.fail('analytics.modes', 'Аналитика: переключатели меняют содержимое',
    'ПОДСВЕТКА МЕНЯЕТСЯ, ВИДИМОЕ СОДЕРЖИМОЕ — НЕТ: все ' + labels.length + ' режима дают одинаковый fpВИДИМ (уникальных по полному тексту: ' + uniqAll.size + '). ' + note + ' ' + detail, { modes: seen, defect: 'highlight-only', visibleOnly: true, uniqueVisible: uniq.size, uniqueAll: uniqAll.size, note });
  else r.fail('analytics.modes', 'Аналитика: переключатели меняют содержимое',
    'уникальных fpВИДИМ ' + uniq.size + ' из ' + labels.length + ' (по полному тексту: ' + uniqAll.size + '). ' + note + ' ' + detail, { modes: seen, visibleOnly: true, uniqueVisible: uniq.size, uniqueAll: uniqAll.size, note });
}

async function checkAgentsTabs(page, r) {
  await page.eval("__ux.setHash('#agents')");
  await page.waitFor("/#agents/.test(__ux.hash())", 5000);
  await sleep(600); await page.helpers();
  const allTabs = await page.eval("__ux.list('#view .seg-switch .seg-btn')");
  const tabs = (allTabs || []).filter((t) => !/скоро/.test(t.text));
  const stubs = (allTabs || []).length - tabs.length;
  if (tabs.length < 2) { r.skip('agents.tabs', 'Агенты: вкладки меняют содержимое', 'рабочих вкладок ' + tabs.length + ', заглушек «скоро»: ' + stubs); return; }
  const seen = [];
  for (const t of tabs) {
    await page.eval(CLICK('#view .seg-switch .seg-btn', t.i));
    await sleep(380); await page.helpers();
    seen.push({ label: t.text, hash: await page.eval(HASH), fp: await page.eval("__ux.fp('#view')") });
  }
  const uniq = new Set(seen.map((s) => s.fp));
  const detail = seen.map((s) => s.label + ' fp=' + s.fp + ' hash=' + s.hash).join(' | ');
  if (uniq.size >= tabs.length) r.ok('agents.tabs', 'Агенты: вкладки меняют содержимое', detail + ' (заглушек «скоро» пропущено: ' + stubs + ')', { tabs: seen });
  else r.fail('agents.tabs', 'Агенты: вкладки меняют содержимое', 'уникальных отпечатков ' + uniq.size + ' из ' + tabs.length + ': ' + detail, { tabs: seen });
}

async function checkAccordions(page, r) {
  await page.eval("__ux.setHash('#analytics/competitors')");
  await sleep(900); await page.helpers();
  const total = await page.eval("__ux.count('#view details')");
  if (!total) { r.skip('accordion', 'Аккордеоны меняют содержимое', 'нет details на #analytics'); return; }
  const before = await page.eval("__ux.count('#view details[open]')");
  const fpBefore = await page.eval("__ux.fp('#view')");
  const info = await page.eval("(() => { const d = Array.from(document.querySelectorAll('#view details')).find((x) => !x.open) || document.querySelector('#view details'); if (!d) return null; const s = d.querySelector('summary'); if (s) s.click(); return { open: d.open, title: __ux.norm((s && s.innerText) || '').slice(0, 60) }; })()");
  await sleep(380); await page.helpers();
  const after = await page.eval("__ux.count('#view details[open]')");
  const fpAfter = await page.eval("__ux.fp('#view')");
  if (info && (before !== after || fpBefore !== fpAfter)) r.ok('accordion', 'Аккордеоны меняют содержимое', 'details ' + total + ', открытых ' + before + ' → ' + after + '; «' + info.title + '»');
  else r.fail('accordion', 'Аккордеоны меняют содержимое', 'клик по summary не изменил ни открытые (' + before + '), ни содержимое');
}

async function checkSearch(page, r) {
  await page.eval("__ux.setHash('#analytics')");
  await sleep(700); await page.helpers();
  const hasInput = await page.eval("!!document.querySelector('#view input[type=text]')");
  if (!hasInput) { r.skip('search.view', 'Поиск сужает строки', 'нет input[type=text] в #view'); return; }
  const before = await page.eval('__ux.rows()');
  const firstCell = await page.eval("(__ux.firstCol(1)[0] || '')");
  let query = String(firstCell || '').split(/\s+/)[0].slice(0, 12) || 'а';
  await page.eval("__ux.setVal('#view input[type=text]', " + JSON.stringify(query) + ")");
  await sleep(450); await page.helpers();
  const after = await page.eval('__ux.rows()');
  await page.eval("__ux.setVal('#view input[type=text]', '__нет_такого_жк__')");
  await sleep(450); await page.helpers();
  const none = await page.eval('__ux.rows()');
  const emptyText = await page.eval("__ux.text('#view', 500)");
  const explained = /нет данных|данных нет|не найден|ничего|пусто/i.test(emptyText);
  const detail = 'строк ' + before + ' → «' + query + '» ' + after + ' → пустой запрос ' + none + (explained ? ' (есть текст-причина)' : '');
  if (after < before || none < before) {
    if (none === 0 && !explained) r.fail('search.empty', 'Пустой результат поиска объяснён', 'нет текста-причины. ' + detail);
    else r.ok('search.view', 'Поиск сужает строки', detail);
  } else r.fail('search.view', 'Поиск сужает строки', 'ввод «' + query + '» не изменил число строк: ' + detail);
}

const FILTER_SEL = '#view .cr-tools .filters select';

const resetFilters = "(() => { document.querySelectorAll(" + JSON.stringify(FILTER_SEL) + ").forEach((s) => { s.value = 'all'; s.dispatchEvent(new Event('change', { bubbles: true })); }); return true; })()";
const filterMeta = "(i) => { const s = document.querySelectorAll(" + JSON.stringify(FILTER_SEL) + ")[i]; return s ? { label: __ux.norm((s.options[s.selectedIndex] || {}).text || ''), first: __ux.norm((s.options[0] || {}).text || ''), values: Array.from(s.options).map((o) => o.value) } : null; }";
const setFilter = "(i, v) => { const s = document.querySelectorAll(" + JSON.stringify(FILTER_SEL) + ")[i]; if (!s) return false; s.value = v; s.dispatchEvent(new Event('change', { bubbles: true })); return true; }";

async function checkFilters(page, r) {
  await page.eval("__ux.setHash('#analytics/competitors')");
  await sleep(1000); await page.helpers();
  const n = await page.eval("__ux.count(" + JSON.stringify(FILTER_SEL) + ")");
  if (!n) { r.skip('filters', 'Фильтры меняют количество строк', 'нет select в .cr-tools .filters'); return; }
  // сбрасываем поиск предыдущих проверок, иначе строки уже отфильтрованы
  await page.eval("__ux.setVal('#view .cr-tools .filters input[type=text]', '')");
  await sleep(500); await page.helpers();
  const results = [];
  const broken = [];
  for (let i = 0; i < n; i++) {
    const meta = await page.eval("(function(){ const s = document.querySelectorAll(" + JSON.stringify(FILTER_SEL) + ")[" + i + "]; return s ? { first: __ux.norm((s.options[0] || {}).text || '') , values: Array.from(s.options).map((o) => o.value) } : null; })()");
    if (!meta) { broken.push(i); results.push('select#' + i + ': не найден'); continue; }
    await page.eval(resetFilters);
    await sleep(500);
    const before = await page.eval('__ux.rows()');
    let changed = null;
    for (const v of meta.values.slice(1, 4)) {
      const fired = await page.eval("(function(){ const s = document.querySelectorAll(" + JSON.stringify(FILTER_SEL) + ")[" + i + "]; if (!s) return false; s.value = " + JSON.stringify(v) + "; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()");
      if (!fired) continue;
      await sleep(550); await page.helpers();
      const after = await page.eval('__ux.rows()');
      if (after !== before) { changed = { value: v, before, after }; break; }
    }
    await page.eval(resetFilters);
    await sleep(350);
    if (changed) results.push('select#' + i + ' «' + meta.first + '» = «' + changed.value + '»: строк ' + changed.before + '→' + changed.after);
    else { results.push('select#' + i + ' «' + meta.first + '»: строки не изменились ни на одном значении'); broken.push(i); }
  }
  if (broken.length) r.fail('filters', 'Фильтры меняют количество строк', results.join('; '), { broken });
  else r.ok('filters', 'Фильтры меняют количество строк', results.join('; '));
}

// Таблицу после клика ЗАНОВО ищем в DOM по индексу (сортировка добавляет « ↑/↓»
// в заголовок, поэтому искать по тексту нельзя — узел считается отсоединённым).
const SORT_PICK_TABLE = "(() => { const tables = Array.from(document.querySelectorAll('#view table.data')); for (let i = 0; i < tables.length; i++) { const t = tables[i]; const th = t.querySelector('th[title*=\"Сортировать\"]'); if (!th || t.querySelectorAll('tbody tr').length < 2) continue; const col = Array.from(th.parentElement.children).indexOf(th); return { tableIndex: i, col, title: __ux.norm(th.innerText), tablesCount: tables.length }; } return null; })()";
const SORT_STATE_I = "(i) => { const tables = Array.from(document.querySelectorAll('#view table.data')); const t = tables[i] || null; if (!t) return { exists: false, tables: tables.length, rows: 0, values: [] }; const th = t.querySelector('th[title*=\"Сортировать\"]'); const col = Array.from(t.querySelectorAll('tbody tr')).length ? Array.from(t.querySelectorAll('tbody tr'))[0] : null; const c = th ? Array.from(th.parentElement.children).indexOf(th) : 0; return { exists: true, tables: tables.length, rows: t.querySelectorAll('tbody tr').length, headers: Array.from(t.querySelectorAll('th')).map((x) => __ux.norm(x.innerText)).slice(0, 6), values: Array.from(t.querySelectorAll('tbody tr')).slice(0, 8).map((tr) => { const td = tr.children[c]; return td ? __ux.norm(td.innerText) : ''; }) }; }";

async function checkSort(page, r) {
  await page.eval("__ux.setHash('#analytics/competitors')");
  await sleep(900); await page.helpers();
  await page.eval("__ux.setVal('#view .cr-tools .filters input[type=text]', '')");
  await sleep(600); await page.helpers();
  const pick = await page.eval(SORT_PICK_TABLE);
  if (!pick) { r.skip('sort', 'Сортировка меняет порядок строк', 'нет сортируемых заголовков th[title*="Сортировать"] в таблице с данными'); return; }
  const before = await page.eval("(" + SORT_STATE_I + ")(" + pick.tableIndex + ")");
  const clicked = await page.eval("(() => { const t = Array.from(document.querySelectorAll('#view table.data'))[" + pick.tableIndex + "]; if (!t) return false; const th = t.querySelector('th[title*=\"Сортировать\"]'); if (!th) return false; th.click(); return true; })()");
  await sleep(700); await page.helpers();
  const after = await page.eval("(" + SORT_STATE_I + ")(" + pick.tableIndex + ")");
  const diff = !!(after && after.exists && after.rows >= 2 && JSON.stringify(before.values) !== JSON.stringify(after.values));
  const evidence = {
    column: before.headers && before.headers[pick.col],
    before: { exists: before.exists, tables: before.tables, rows: before.rows, values: before.values },
    after: { exists: after && after.exists, tables: after && after.tables, rows: after && after.rows, values: (after && after.values) || [] },
    afterHeaders: (after && after.headers) || [],
    clicked,
  };
  const detail = 'столбец «' + (before.headers && before.headers[pick.col]) + '»; до: rows=' + before.rows + ' [' + (before.values || []).slice(0, 4).join(' / ') + '] | после: rows=' + (after ? after.rows : 'нет') + ' exists=' + (after ? after.exists : false) + ' [' + ((after && after.values) || []).slice(0, 4).join(' / ') + ']';
  if (!clicked) r.fail('sort', 'Сортировка меняет порядок строк', 'клик по заголовку не сработал', evidence);
  else if (diff) r.ok('sort', 'Сортировка меняет порядок строк', detail, evidence);
  else r.fail('sort', 'Сортировка меняет порядок строк', 'порядок не изменился или таблица исчезла: ' + detail, evidence);
}

async function checkMenus(page, r) {
  await page.eval("__ux.setHash('#overview')");
  await sleep(500); await page.helpers();
  await page.eval(CLICK('.sb-create'));
  await sleep(280); await page.helpers();
  const cItems = await page.eval("__ux.count('.sb-popup .sb-popup-item')");
  const cVis = await page.eval("__ux.anyVisible('.sb-popup')");
  await page.eval('__ux.esc()');
  await sleep(280);
  const cClosed = !(await page.eval("__ux.anyVisible('.sb-popup')"));
  if (cVis && cItems >= 1 && cClosed) r.ok('menu.create', 'Меню «+ Создать» открывается и закрывается Esc', 'пунктов: ' + cItems);
  else r.fail('menu.create', 'Меню «+ Создать» открывается и закрывается Esc', 'visible=' + cVis + ' items=' + cItems + ' closed=' + cClosed);

  await page.eval(CLICK('.sb-user-menu'));
  await sleep(280); await page.helpers();
  const uItems = await page.eval("__ux.count('.sb-popup .sb-popup-item')");
  const uVis = await page.eval("__ux.anyVisible('.sb-popup')");
  const uLabels = await page.eval("__ux.labels('.sb-popup .sb-popup-item')");
  await page.eval('__ux.esc()');
  await sleep(220);
  if (uVis && uItems >= 5) r.ok('menu.user', 'Меню пользователя: пункты реагируют', 'пунктов: ' + uItems + ' — ' + (uLabels || []).join(', '));
  else r.fail('menu.user', 'Меню пользователя: пункты реагируют', 'visible=' + uVis + ' items=' + uItems + ' (ожидалось ≥5)');

  await page.eval(CLICK('.sb-search'));
  await sleep(320); await page.helpers();
  const pVis = await page.eval("__ux.visible('#palette')");
  const pAll = await page.eval("__ux.count('#palette .palette-item')");
  await page.eval("__ux.setVal('#palette input', 'создать')");
  await sleep(320); await page.helpers();
  const pFiltered = await page.eval("__ux.count('#palette .palette-item')");
  await page.eval('__ux.esc()');
  await sleep(280);
  const pClosed = !(await page.eval("__ux.visible('#palette')"));
  if (pVis && pAll >= 1 && pFiltered >= 1 && pFiltered <= pAll && pClosed) r.ok('menu.palette', 'Палитра поиска: открытие, фильтрация, Esc', 'было ' + pAll + ', по «создать» — ' + pFiltered);
  else r.fail('menu.palette', 'Палитра поиска: открытие, фильтрация, Esc', 'visible=' + pVis + ' all=' + pAll + ' filtered=' + pFiltered + ' closed=' + pClosed);
}

async function checkDrawer(page, r) {
  await page.eval("__ux.setHash('#agents/executors')");
  await sleep(900); await page.helpers();
  const cards = await page.eval("__ux.count('#view .agent-card')");
  if (!cards) { r.skip('drawer', 'Модальные окна: открытие, Esc, клик вне', 'нет .agent-card на #agents/executors'); return; }
  let used = -1;
  for (let i = 0; i < Math.min(cards, 6); i++) {
    await page.eval(CLICK('#view .agent-card', i));
    await sleep(400);
    if (await page.eval("!document.getElementById('drawer').hidden")) { used = i; break; }
  }
  await page.helpers();
  const opened = await page.eval("!document.getElementById('drawer').hidden");
  const hasClose = await page.eval("__ux.count('#drawer .drawer-close')");
  await page.eval('__ux.esc()');
  await sleep(350);
  const closedEsc = await page.eval("document.getElementById('drawer').hidden");
  const lockedEsc = await page.eval('__ux.scrollLocked()');
  await page.eval(CLICK('#view .agent-card'));
  await sleep(400);
  await page.eval("(() => { document.getElementById('drawerBackdrop').click(); return true; })()");
  await sleep(350);
  const closedBackdrop = await page.eval("document.getElementById('drawer').hidden");
  const locked = await page.eval('__ux.scrollLocked()');
  const detail = 'открылось=' + opened + ' (карточка #' + used + ')' + ' close=' + hasClose + ' Esc=' + closedEsc + ' вне=' + closedBackdrop + ' скролл-заблокирован=' + locked;
  if (opened && hasClose >= 1 && closedEsc && closedBackdrop && !locked && !lockedEsc) r.ok('drawer', 'Модальные окна: открытие, Esc, клик вне', detail);
  else r.fail('drawer', 'Модальные окна: открытие, Esc, клик вне', detail);
}

async function checkHashRouting(page, r) {
  const bad = [];
  await page.eval("__ux.setHash('#analytics')");
  await sleep(450); await page.helpers();
  if ((await page.eval(HASH)) !== '#analytics') bad.push('#analytics не установился');
  await page.eval("__ux.setHash('#agents/sources')");
  await sleep(550); await page.helpers();
  const nested = await page.eval("(() => !/Требует внимания/.test(__ux.text('#view', 500)) && __ux.count('#view .seg-switch .seg-btn') > 0)()");
  if (!nested) bad.push('#agents/sources не открыл «Агенты» с вкладками');
  await page.eval("__ux.setHash('#no-such-section')");
  await sleep(450); await page.helpers();
  if ((await page.eval(HASH)) === '#no-such-section') bad.push('неизвестный адрес не обработан');
  await page.eval("__ux.setHash('#usage')");
  await sleep(450);
  await page.eval('history.back()');
  await sleep(600); await page.helpers();
  if ((await page.eval(HASH)) === '#usage') bad.push('history.back() не вернул предыдущий раздел');
  if (bad.length) r.fail('hash.routing', 'Адреса и назад/вперёд', bad.join('; '));
  else r.ok('hash.routing', 'Адреса и назад/вперёд', '#analytics, #agents/sources, неизвестный раздел, back() — ок');
}

async function checkEmptyStates(page, r) {
  const broken = [];
  for (const hash of ['#overview', '#analytics', '#usage', '#economy', '#integrations', '#objects', '#results']) {
    await page.eval("__ux.setHash(" + JSON.stringify(hash) + ")");
    await sleep(500); await page.helpers();
    const bad = await page.eval('__ux.empties()');
    if (bad && bad.length) broken.push(hash + ': ' + bad.length + ' пустых таблиц без пояснения');
  }
  if (broken.length) r.fail('empty.states', 'Пустые состояния объясняют причину', broken.join('; '));
  else r.ok('empty.states', 'Пустые состояния объясняют причину', 'проверено 7 разделов: пустых таблиц без текста-причины нет');
}

async function checkDeadButtons(page, r) {
  await page.eval("__ux.setHash('#overview')");
  await sleep(600); await page.helpers();
  const labels = await page.eval("__ux.labels('#view button')");
  const risky = /обновить|пересобрать|запустить|сбор|отправить|оплатить|удалить|выход|выйти|создать|применить|сохранить|очистить|сброс|переключ|включ|выключ|экспорт|скачать|добавить/i;
  const uniq = [...new Set((labels || []).map((t) => String(t).trim()).filter((t) => t && t.length <= 60))].slice(0, 12);
  const scanned = [];
  const suspicious = [];
  for (const txt of uniq) {
    if (risky.test(txt)) continue;
    scanned.push(txt);
    try {
      await page.helpers();
      const h0 = await page.eval(HASH);
      const body0 = await page.eval('document.body.innerText.length');
      await page.eval('__ux.startMutations()');
      const clicked = await page.eval("(() => { const els = Array.from(document.querySelectorAll('#view button')); const e = els.find((x) => __ux.norm(x.innerText) === " + JSON.stringify(txt) + "); if (!e) return false; e.click(); return true; })()");
      if (!clicked) { await page.eval('__ux.stopMutations()'); continue; }
      await sleep(800);
      const mut = await page.eval('__ux.stopMutations()');
      const h1 = await page.eval(HASH);
      const body1 = await page.eval('document.body.innerText.length');
      const dialog = await page.eval("(!document.getElementById('drawer').hidden) || __ux.anyVisible('[role=dialog], .modal')");
      if (mut === 0 && h1 === h0 && body1 === body0 && !dialog) suspicious.push(txt);
      if (h1 !== h0) { await page.eval("__ux.setHash('#overview')"); await sleep(350); await page.helpers(); }
    } catch (err) {
      try { await page.goto(page.baseUrl); await page.helpers(); } catch { /* ignore */ }
    }
  }
  if (!suspicious.length) r.ok('dead.buttons', 'Нет «мёртвых» кнопок без эффекта', 'проверено read-only кнопок: ' + scanned.length + ' (рисковые пропущены)');
  else r.info('dead.buttons', 'Нет «мёртвых» кнопок без эффекта', 'без наблюдаемого эффекта: ' + suspicious.slice(0, 10).join(' | ') + ' — проверить вручную', { suspicious, scanned });
}

// Кнопки-действия с подтверждением: первый клик обязан дать ВИДИМУЮ реакцию
// внутри #view, второй — выполнить действие (блок результата / обновление).
const ACTIONS = [
  { id: 'actions.collect', label: 'Собрать данные сейчас' },
  { id: 'actions.report', label: 'Сформировать отчёт за неделю' },
];

async function checkActions(page, r) {
  const stale = [];
  for (const act of ACTIONS) {
    const title = 'Действие «' + act.label + '»: видимая реакция и выполнение';
    await page.goto(page.baseUrl + '#overview');
    await page.helpers();
    await page.waitFor("__ux.labels('#view button').indexOf(" + JSON.stringify(act.label) + ") >= 0", 15000);
    await sleep(600);
    const found = await page.eval("__ux.labels('#view button').indexOf(" + JSON.stringify(act.label) + ") >= 0");
    if (!found) { r.skip(act.id, title, 'кнопка не найдена на #overview'); continue; }
    const clickExpr = "(() => { const b = Array.from(document.querySelectorAll('#view button')).find((x) => __ux.norm(x.innerText) === " + JSON.stringify(act.label) + "); if (!b) return false; b.click(); return true; })()";
    const noteText = "(() => { const n = document.querySelector('#view .confirm-note'); return n ? __ux.norm(n.innerText).slice(0, 160) : null; })()";
    // хост результата — соседний блок после кнопки (туда runAction пишет «Выполняю…» и результат)
    const hostText = "(() => { const b = Array.from(document.querySelectorAll('#view button')).find((x) => __ux.norm(x.innerText) === " + JSON.stringify(act.label) + "); if (!b) return null; let n = b.parentElement; for (let k = 0; k < 4 && n; k++) { const t = __ux.norm(n.innerText); if (/Выполняю|сессий:|задач:|Не получилось|Ошибка запроса|Файл:|за \\d/.test(t)) return t.slice(0, 220); n = n.nextElementSibling || n.parentElement; } return ''; })()";
    const before = await page.eval(hostText);
    const c1 = await page.eval(clickExpr);
    await sleep(900); await page.helpers();
    const confirm = await page.eval(noteText);
    const confirmVisible = !!confirm;
    const c2 = await page.eval(clickExpr);
    let resultText = '';
    let waited = 0;
    while (waited < 70000) {
      await sleep(1500); waited += 1500;
      await page.helpers();
      resultText = (await page.eval(hostText)) || '';
      if (/сессий:|задач:|Не получилось|Ошибка запроса|Файл:|отчёт|данные пересобраны|за \d+[.,]\d+ с/i.test(resultText)) break;
    }
    const resultVisible = /сессий:|задач:|Не получилось|Ошибка запроса|Файл:|пересобран|готов|за \d+[.,]\d+ с/i.test(resultText);
    const staleNote = await page.eval(noteText);
    if (staleNote) stale.push(act.label + ': «' + String(staleNote).slice(0, 70) + '…»');
    const evidence = { clicked1: c1, clicked2: c2, confirmVisible, confirmText: confirm, resultVisible, resultText, before, waitedMs: waited, staleConfirmAfterResult: !!staleNote };
    if (!c1 || !c2) r.fail(act.id, title, 'кнопка не кликнулась (clicked1=' + c1 + ', clicked2=' + c2 + ')', evidence);
    else if (!confirmVisible) r.fail(act.id, title, 'первый клик не дал видимой плашки подтверждения внутри #view', evidence);
    else if (!resultVisible) r.fail(act.id, title, 'второй клик не дал результата за ' + Math.round(waited / 1000) + ' с (хост действия: «' + String(resultText).slice(0, 120) + '»)', evidence);
    else r.ok(act.id, title, '1-й клик: плашка подтверждения в #view; 2-й клик: результат за ' + Math.round(waited / 1000) + ' с — «' + String(resultText).slice(0, 120) + '»', evidence);
  }
  if (stale.length) r.fail('actions.staleConfirm', 'После выполнения действия плашка подтверждения убирается',
    'плашка «нажмите ту же кнопку ещё раз» осталась на экране после успешного выполнения: ' + stale.join(' | ') + '. Пользователь может решить, что действие ещё не выполнено.',
    { stale });
  else if (r.steps.some((s) => s.id === 'actions.collect' || s.id === 'actions.report')) r.ok('actions.staleConfirm', 'После выполнения действия плашка подтверждения убирается', 'плашки подтверждения после результата не остаётся');
}

function checkDialogs(page, r) {
  const n = page.dialogs || 0;
  if (!n) r.ok('dialogs.native', 'Нет нативных диалогов (confirm/alert)', 'за время обхода диалогов не было');
  else r.fail('dialogs.native', 'Нет нативных диалогов (confirm/alert)',
    'панель показала ' + n + ' нативных диалогов. Нативный confirm/alert блокирует интерфейс и ломает автоматизацию — в панели допустим только свой модал с Esc и кликом вне.',
    { dialogs: n });
}

function checkJsErrors(page, r) {
  const real = page.errors.filter((e) => {
    const t = String(e.text || '');
    if (!t) return false;
    if (/favicon|net::ERR_|Failed to load resource/i.test(t)) return false;
    return true;
  });
  if (!real.length) r.ok('js.errors', 'Нет ошибок JS за время обхода', 'ошибок не зафиксировано');
  else r.fail('js.errors', 'Нет ошибок JS за время обхода', real.slice(0, 5).map((e) => e.kind + ': ' + e.text).join(' | '), { errors: real.slice(0, 20) });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = new Date();
  const r = new Runner();
  let browser = null; let fatal = null; let uiVersion = null;

  try {
    const health = await probe(args.url + '/api/health', 5000);
    if (!health.ok) throw new Error('панель не отвечает: ' + args.url + '/api/health — ' + (health.error || health.status));
    try {
      const state = await getJson(args.url + '/api/state', 30000);
      uiVersion = state && state.uiVersion ? state.uiVersion : null;
    } catch { /* версия не критична для проверок */ }
    browser = await connectAndOpenPage(args);
    const page = new Page(browser.cdp);
    await page.enable();
    if (await checkBoot(page, r, args)) {
      await checkSidebar(page, r);
      await checkAnalyticsModes(page, r);
      await checkAgentsTabs(page, r);
      await checkAccordions(page, r);
      await checkSearch(page, r);
      await checkFilters(page, r);
      await checkSort(page, r);
      await checkMenus(page, r);
      await checkDrawer(page, r);
      await checkHashRouting(page, r);
      await checkEmptyStates(page, r);
      await checkDeadButtons(page, r);
      await checkActions(page, r);
      checkDialogs(page, r);
      checkJsErrors(page, r);
    }
  } catch (e) {
    fatal = String((e && e.message) || e);
    r.fail('fatal', 'Подключение и прогон', fatal);
  } finally {
    if (browser) {
      try { await browser.cdp.send('Target.closeTarget', { targetId: browser.targetId }); } catch { /* ignore */ }
      browser.cdp.close();
      if (browser.launched && browser.launched.proc) { try { browser.launched.proc.kill(); } catch { /* ignore */ } }
      if (browser.launched && browser.launched.profile) { try { rmSync(browser.launched.profile, { recursive: true, force: true }); } catch { /* ignore */ } }
    }
  }

  const counts = { ok: 0, fail: 0, skip: 0, info: 0 };
  for (const s of r.steps) counts[String(s.status).toLowerCase()]++;
  const known = r.steps.filter((s) => s.status === 'FAIL' && KNOWN_DEFECTS.includes(s.id));
  const unknown = r.steps.filter((s) => s.status === 'FAIL' && !KNOWN_DEFECTS.includes(s.id));
  const verdict = counts.fail === 0 ? 'OK' : (known.length && !unknown.length ? 'ПРОВАЛ (только известные дефекты)' : 'ПРОВАЛ');
  const report = {
    schemaVersion: 1,
    tool: 'dashboard/ux-check.mjs',
    generatedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    url: args.url,
    uiVersion: uiVersion ? (uiVersion.version || null) : null,
    uiBuiltAt: uiVersion ? (uiVersion.builtAt || null) : null,
    uiVersionRaw: uiVersion,
    method: {
      principle: 'проверяется ПОВЕДЕНИЕ, а не разметка: сравнивается содержимое до/после действия',
      toggleFingerprint: 'fpВИДИМ — хеш видимого текста (#view.innerText): скрытое через display:none/hidden в него не попадает. fpВЕСЬ — хеш полного textContent, включая скрытое (для контраста). Вердикт по переключателям — по fpВИДИМ.',
      highlightOnly: 'если активный класс переключателя меняется, а fpВИДИМ всех режимов совпадает — это дефект «подсветка без изменения содержимого»',
      jsErrors: 'собираются Runtime.exceptionThrown, console.error и Log.entryAdded(level=error)',
      dialogs: 'нативные confirm/alert автоматически отклоняются (Page.handleJavaScriptDialog) и фиксируются отдельной находкой',
      domFreshness: 'после каждого действия DOM запрашивается заново; узлы между перерисовками не удерживаются (сортировка опознаётся по индексу таблицы и столбца, а не по тексту заголовка)',
    },
    cdp: browser ? browser.cdpBase : args.cdp,
    chrome: browser && browser.version ? browser.version.Browser : null,
    launchedChrome: !!(browser && browser.launched),
    summary: {
      total: r.steps.length, ok: counts.ok, fail: counts.fail, skip: counts.skip, info: counts.info,
      knownDefectsFailed: known.map((s) => s.id),
      unknownFailed: unknown.map((s) => s.id),
      verdict,
    },
    knownDefects: KNOWN_DEFECTS,
    steps: r.steps,
    fatal,
  };

  try {
    mkdirSync(dirname(resolve(args.out)), { recursive: true });
    writeFileSync(resolve(args.out), JSON.stringify(report, null, 2), 'utf8');
  } catch (e) { console.error('не удалось записать отчёт: ' + e.message); }

  console.log('UX-проверка панели: ' + verdict + (uiVersion && uiVersion.version ? ' · версия интерфейса ' + uiVersion.version + ' (' + (uiVersion.builtAt || '?') + ')' : ' · версия интерфейса: не получена'));
  for (const s of r.steps) {
    const mark = s.status === 'OK' ? 'OK' : s.status === 'FAIL' ? 'ПРОВАЛ' : s.status === 'SKIP' ? 'ПРОПУСК' : 'ИНФО';
    const tag = s.status === 'FAIL' && KNOWN_DEFECTS.includes(s.id) ? ' [известный дефект]' : '';
    console.log('  ' + mark.padEnd(8) + s.title + tag + (s.detail ? ' — ' + s.detail : ''));
    if (args.verbose && s.failures) for (const f of s.failures) console.log('      · ' + f);
  }
  console.log('  Итого: OK ' + counts.ok + ', ПРОВАЛ ' + counts.fail + ', ПРОПУСК ' + counts.skip + ', ИНФО ' + counts.info);
  console.log('  Отчёт: ' + resolve(args.out));

  if (fatal) process.exit(2);
  if (counts.fail === 0) process.exit(0);
  if (args.allowKnown && unknown.length === 0) process.exit(0);
  process.exit(1);
}

main().catch((e) => { console.error('ux-check: непредвиденная ошибка: ' + ((e && e.stack) || e)); process.exit(2); });

// Сборка автономных HTML-стендов панели для визуальной проверки без сервера.
//
// Зачем: ux-check.mjs требует Chrome с отладочным портом, а в песочнице агента
// Chrome не запускается. Стенд использует штатный автономный режим панели
// (window.__DASHBOARD_STANDALONE__ + window.__DASHBOARD_DATA__) и реальные
// собранные данные, поэтому показывает ТО ЖЕ, что живая панель, без сети.
//
//   node marketing-agents/dashboard/_ux-harness/build-harness.mjs
//
// Ничего вне dashboard/_ux-harness/ не пишет.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DASH = path.dirname(HERE);
const PUBLIC = path.join(DASH, 'public');
const DATA = path.join(PUBLIC, 'data');

const DATA_FILES = ['meta.json', 'agents.json', 'tasks.json', 'projects.json', 'sessions.json', 'usage.json',
  'prices.json', 'integrations.json', 'sources.json', 'analytics.json', 'settings.json', 'alerts.json',
  'service.json', 'nav.json', 'analytics2.json', 'ads.json', 'agent-tabs.json', 'agent-settings.json',
  'candidates.json', 'competitor-report.json', 'agent1-status.json', 'competitor-analytics.json'];

const state = { ok: true, uiVersion: { version: 'harness', builtAt: null, files: 0 } };
for (const name of DATA_FILES) {
  const key = name.replace(/\.json$/, '');
  try { state[key] = JSON.parse(fs.readFileSync(path.join(DATA, name), 'utf8')); }
  catch (e) { state[key] = null; console.error('нет данных: ' + name); }
}

const indexHtml = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

function harness(hash, title, extraScript) {
  let html = indexHtml.replace('<link rel="stylesheet" href="styles.css">', '<link rel="stylesheet" href="../public/styles.css">');
  html = html.replace(/<script src="([^"]+)"><\/script>/g, '<script src="../public/$1"></script>');
  html = html.replace('<script src="../public/app.js"></script>',
    '<script>window.__DASHBOARD_STANDALONE__ = true; window.__DASHBOARD_DATA__ = ' + JSON.stringify(state) + ';' +
    ' window.__HARNESS__ = true; location.hash = ' + JSON.stringify(hash) + ';</script>\n' +
    '<script src="../public/app.js"></script>');
  html = html.replace('</body>', '<script>\n' + extraScript + '\n</script>\n</body>');
  html = html.replace('<title>', '<title>' + title + ' · ');
  return html;
}

// Встроенный самоотчёт: стенд сам считает ключевые элементы и пишет результат
// в <pre id="harness-report">, чтобы проверяющий видел PASS/FAIL на снимке и в DOM.
const selfReport = [
  'function harnessReport() {',
  '  var lines = [];',
  '  try {',
  '  var groupTitles = Array.prototype.map.call(document.querySelectorAll("#view .ag-group-title"), function (e) { return e.textContent; });',
  '  var analyticsGroup = Array.prototype.filter.call(document.querySelectorAll("#view .ag-group"), function (g) {',
  '    var t = g.querySelector(".ag-group-title"); return t && t.textContent.indexOf("Аналитика конкурентов") >= 0; });',
  '  var toggles = analyticsGroup.length ? analyticsGroup[0].querySelectorAll(".ag-field button.switch") : [];',
  '  var queryInput = document.querySelector("#view .ag-field input");',
  '  var moreBoxes = document.querySelectorAll("#view details.ag-more");',
  '  var status = document.querySelector("#view .a1-status");',
  '  var caBox = document.querySelector("#view .ca-box");',
  '  function add(label, ok, detail) { lines.push((ok ? "PASS " : "FAIL ") + label + (detail ? "  (" + detail + ")" : "")); }',
  '  add("группа тумблеров аналитики есть", analyticsGroup.length === 1, analyticsGroup.length + " групп");',
  '  add("в группе 8 тумблеров", toggles.length === 8, toggles.length + " шт.");',
  '  add("одно поле ввода заполнено значением из файла", !!queryInput && String(queryInput.value).length > 0, queryInput ? queryInput.value : "поля нет");',
  '  add("параметры по умолчанию спрятаны под «дополнительно»", moreBoxes.length >= 1, moreBoxes.length + " блок(ов)");',
  '  add("индикатор прогона виден в карточке", !!status, status ? status.textContent.replace(/\\s+/g, " ").slice(0, 120) : "нет блока");',
  '  add("блок аналитики конкурентов есть", !!caBox, caBox ? (caBox.textContent.replace(/\\s+/g, " ").slice(0, 160)) : "нет блока");',
  '  } catch (err) { lines.push("FAIL самоотчёт упал: " + err.message); }',
  '  var pre = document.createElement("pre");',
  '  pre.id = "harness-report";',
  '  pre.style.cssText = "position:fixed;left:0;top:0;z-index:999;background:#000;color:#0f0;font:12px monospace;padding:6px;max-width:60%;white-space:pre-wrap";',
  '  pre.textContent = lines.join("\\n");',
  '  document.body.appendChild(pre);',
  '}'
].join('\n');

// На экране агентов раскрываем настройки Агента 1 и блок «дополнительно»,
// чтобы в снимок попали тумблеры аналитики и одно поле ввода.
const agentsScript = [
  selfReport,
  'setTimeout(function () {',
  '  document.querySelectorAll("#view details.ag-settings").forEach(function (d) { d.open = true; });',
  '  document.querySelectorAll("#view details.ag-more").forEach(function (d) { d.open = true; });',
  '  var s = document.querySelector("#view .a1-status"); if (s) s.scrollIntoView({ block: "start" });',
  '  var t = document.querySelector("#view .agent-card"); if (t) t.scrollIntoView({ block: "start" });',
  '  harnessReport();',
  '}, 1500);'
].join('\n');

const analyticsScript = [
  selfReport,
  'setTimeout(function () {',
  '  document.querySelectorAll("#view details").forEach(function (d) { d.open = true; });',
  '  var c = document.querySelector("#view .ca-box"); if (c) c.scrollIntoView({ block: "start" });',
  '  harnessReport();',
  '}, 1500);'
].join('\n');

fs.mkdirSync(HERE, { recursive: true });
fs.writeFileSync(path.join(HERE, 'agents.html'), harness('#agents/executors', 'Агенты Агента 1', agentsScript), 'utf8');
fs.writeFileSync(path.join(HERE, 'analytics.html'), harness('#analytics', 'Аналитика конкурентов', analyticsScript), 'utf8');
fs.writeFileSync(path.join(HERE, 'state.json'), JSON.stringify(state, null, 1), 'utf8');
console.log('Стенды собраны:');
console.log('  ' + path.join(HERE, 'agents.html'));
console.log('  ' + path.join(HERE, 'analytics.html'));
console.log('  ' + path.join(HERE, 'state.json'));

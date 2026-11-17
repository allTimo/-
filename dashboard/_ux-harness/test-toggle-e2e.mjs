// Сквозная проверка тумблеров аналитики и поля query БЕЗ записи в registry/**.
//
// Работает против отдельного экземпляра панели, которому папка тонких настроек
// подменена копией в dashboard/_ux-harness/tmp/ (DASHBOARD_AGENT_SETTINGS_DIR).
// Проверяет всю цепочку: атомарная запись -> .bak -> свежее состояние в /api/state
// -> список копий -> откат -> побайтовое совпадение SHA-256 с исходным файлом.
//
//   node marketing-agents/dashboard/_ux-harness/test-toggle-e2e.mjs http://127.0.0.1:8789
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DASH = path.dirname(HERE);
const PROJECT = path.dirname(DASH);
const REAL_DIR = path.join(PROJECT, 'registry', 'agent-settings');
const TMP_DIR = path.join(HERE, 'tmp', 'agent-settings');
const BASE = (process.argv[2] || 'http://127.0.0.1:8789').replace(/\/+$/, '');
const AGENT = 'agent-1-competitor-watch';
const TARGET = path.join(TMP_DIR, AGENT + '.yaml');

let ok = 0, fail = 0;
function check(label, cond, detail) {
  console.log('  ' + (cond ? 'OK  ' : 'FAIL') + ' ' + label + (detail ? '  (' + detail + ')' : ''));
  if (cond) ok++; else fail++;
}
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
async function post(url, body) {
  const r = await fetch(BASE + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let j = null;
  try { j = await r.json(); } catch (e) { j = null; }
  return { status: r.status, body: j };
}
async function getState() {
  const r = await fetch(BASE + '/api/state', { cache: 'no-store' });
  return r.json();
}

// --- подготовка: копия реальных настроек в свою папку (registry не трогаем) ---
fs.mkdirSync(TMP_DIR, { recursive: true });
for (const n of fs.readdirSync(TMP_DIR)) fs.rmSync(path.join(TMP_DIR, n), { recursive: true, force: true });
for (const n of fs.readdirSync(REAL_DIR)) {
  if (!/\.ya?ml$/.test(n)) continue;
  fs.copyFileSync(path.join(REAL_DIR, n), path.join(TMP_DIR, n));
}
const original = fs.readFileSync(TARGET);
const originalSha = sha(original);
console.log('Стенд: ' + BASE + ', копия настроек: ' + TMP_DIR);
check('копия настроек агента A1 подготовлена', original.length > 0 && originalSha.length === 64, originalSha.slice(0, 12) + '…');

const health = await fetch(BASE + '/api/health').then(r => r.json()).catch(() => null);
check('тестовая панель отвечает', !!(health && health.ok), health ? ('port ' + health.port + ', dataDir ' + health.dataDir) : 'нет ответа');
if (!health || !health.ok) { console.log('Итог: OK ' + ok + ', ПРОВАЛ ' + fail); process.exit(1); }

// --- 1. панель видит тумблеры и поле query из файла ---
let st = await getState();
const a1 = (((st['agent-settings'] || {}).byAgent || {})[AGENT]) || {};
check('тумблеры аналитики читаются панелью', a1.agent1 && typeof a1.agent1.analytics.forecast === 'boolean', JSON.stringify(a1.agent1 && a1.agent1.analytics));
check('одно поле ввода agent1.watch.query читается панелью', typeof a1.agent1.watch.query === 'string' && a1.agent1.watch.query.length > 0, String(a1.agent1.watch.query));

// --- 2. выключение тумблера forecast: атомарная запись + .bak + свежее состояние ---
const setRes = await post('/api/agent-settings/set', { agent: AGENT, group: 'agent1.analytics', field: 'forecast', value: false });
check('тумблер аналитики сохраняется', setRes.status === 200 && setRes.body && setRes.body.ok === true, 'HTTP ' + setRes.status + ' ' + (setRes.body && (setRes.body.message || setRes.body.target)));
check('создана копия .bak', !!(setRes.body && /\.bak-/.test(String(setRes.body.backup))), setRes.body && setRes.body.backup);
const afterToggle = fs.readFileSync(TARGET, 'utf8');
check('в файле появилось forecast: false', /^\s*forecast:\s*false\s*$/m.test(afterToggle), 'строка в ' + path.basename(TARGET));
check('остальные тумблеры не тронуты', /^\s*enabled:\s*true\s*$/m.test(afterToggle) && /^\s*dedup_promos:\s*true\s*$/m.test(afterToggle), 'enabled/dedup_promos = true');

st = await getState();
const a1b = (((st['agent-settings'] || {}).byAgent || {})[AGENT]) || {};
check('панель сразу показывает новое значение тумблера', a1b.agent1 && a1b.agent1.analytics.forecast === false, 'forecast=' + (a1b.agent1 && a1b.agent1.analytics.forecast));

// --- 3. список копий и откат по SHA-256 ---
const bk = await fetch(BASE + '/api/settings/backups?file=' + encodeURIComponent('agent-settings/' + AGENT)).then(r => r.json());
check('маршрут списка копий отвечает', bk.ok === true && Array.isArray(bk.backups) && bk.backups.length > 0, 'копий: ' + ((bk.backups || []).length) + ', sha текущего ' + String(bk.current && bk.current.sha256).slice(0, 12) + '…');
check('SHA-256 текущего файла посчитан', bk.current && /^[0-9a-f]{64}$/.test(String(bk.current.sha256)), String(bk.current && bk.current.sha256).slice(0, 12) + '…');

const rev = await post('/api/settings/revert', { file: 'agent-settings/' + AGENT, backup: bk.backups[0].name });
check('откат выполняется', rev.status === 200 && rev.body && rev.body.ok === true, rev.body && rev.body.message);
const restored = fs.readFileSync(TARGET);
check('файл после отката побайтово равен исходному', sha(restored) === originalSha, sha(restored).slice(0, 12) + '… / ' + originalSha.slice(0, 12) + '…');
check('SHA-256 отката совпал с SHA-256 копии', rev.body && rev.body.sha256 === rev.body.sha256Restored, String(rev.body && rev.body.sha256).slice(0, 12) + '…');

// --- 4. сохранение одного поля query (и откат) ---
const newQuery = 'ЖК «Свет» / https://svetdom.ru/';
const q1 = await post('/api/agent-settings/set', { agent: AGENT, group: 'agent1.watch', field: 'query', value: newQuery });
check('поле query сохраняется', q1.status === 200 && q1.body && q1.body.ok === true, q1.body && (q1.body.target || q1.body.message));
const withQuery = fs.readFileSync(TARGET, 'utf8');
check('в файле обновилось agent1.watch.query', withQuery.indexOf('query: "' + newQuery + '"') >= 0, 'строка watch.query');
check('параметры по умолчанию ЖК на месте (не удалены)',
  /^\s*radius_km:\s*10\s*$/m.test(withQuery) && /^\s*max_candidates:\s*20\s*$/m.test(withQuery) && /^\s*sources:\s*\[/m.test(withQuery),
  'radius_km=10, max_candidates=20, sources=[…]');
const q2 = await post('/api/settings/revert', { file: 'agent-settings/' + AGENT, backup: (await fetch(BASE + '/api/settings/backups?file=' + encodeURIComponent('agent-settings/' + AGENT)).then(r => r.json())).backups[0].name });
check('откат после правки query возвращает исходный файл', q2.body && q2.body.ok === true && sha(fs.readFileSync(TARGET)) === originalSha, sha(fs.readFileSync(TARGET)).slice(0, 12) + '…');

// --- 5. запреты: недопустимое значение и неизвестное поле ---
const bad1 = await post('/api/agent-settings/set', { agent: AGENT, group: 'agent1.analytics', field: 'forecast', value: 'maybe' });
check('недопустимое значение тумблера отклонено', bad1.status === 400 && /true или false/.test(String(bad1.body && bad1.body.message)), 'HTTP ' + bad1.status + ' ' + (bad1.body && bad1.body.message));
const bad2 = await post('/api/agent-settings/set', { agent: AGENT, group: 'agent1.analytics', field: 'не_существует', value: true });
check('неизвестный тумблер отклонён', bad2.status === 400 && /не разрешено/.test(String(bad2.body && bad2.body.message)), 'HTTP ' + bad2.status + ' ' + (bad2.body && bad2.body.message));
const bad3 = await post('/api/agent-settings/set', { agent: AGENT, group: 'agent1.unknown', field: 'x', value: true });
check('неизвестная группа настроек отклонена', bad3.status === 400 && /неизвестная группа/.test(String(bad3.body && bad3.body.message)), 'HTTP ' + bad3.status + ' ' + (bad3.body && bad3.body.message));
check('после всех запретов файл не изменился', sha(fs.readFileSync(TARGET)) === originalSha, 'совпадает с исходным');

// --- 6. блока analytics в файле ещё нет: тумблер обязан создать его, а не упасть ---
const lines = original.toString('utf8').split(/\r?\n/);
const stripped = [];
let skipBlock = false;
for (const l of lines) {
  if (/^\s*analytics:\s*$/.test(l)) { skipBlock = true; continue; }
  if (skipBlock) {
    if (/^\s{4}[a-z_]+:\s*(true|false)\s*$/.test(l)) continue;
    skipBlock = false;
  }
  stripped.push(l);
}
fs.writeFileSync(TARGET, stripped.join('\n'), 'utf8');
const withoutBlock = fs.readFileSync(TARGET, 'utf8');
check('блок analytics удалён из копии (условие теста)', withoutBlock.indexOf('analytics:') < 0 && /^\s*schedule:/m.test(withoutBlock), 'строк: ' + withoutBlock.split('\n').length);
// Файл правлен МИМО панели (руками), а /api/state — это СНИМОК данных, а не живое
// чтение файлов: он обновляется действиями панели и кнопкой «Обновить данные»
// (POST /api/collect). Поэтому перед проверкой честного пустого состояния
// пересобираем снимок ровно так же, как это делает кнопка.
await post('/api/collect', {});
st = await getState();
const a1c = (((st['agent-settings'] || {}).byAgent || {})[AGENT]) || {};
check('панель честно сообщает, что блока нет в файле', a1c.agent1 && a1c.agent1.analyticsPresent === false, 'analyticsPresent=' + (a1c.agent1 && a1c.agent1.analyticsPresent));
check('показывает безопасный дефолт (включено)', a1c.agent1 && a1c.agent1.analytics.dedup_promos === true, 'dedup_promos=' + (a1c.agent1 && a1c.agent1.analytics.dedup_promos));
const created = await post('/api/agent-settings/set', { agent: AGENT, group: 'agent1.analytics', field: 'dedup_promos', value: false });
check('тумблер сохраняется, когда блока нет: блок создаётся', created.status === 200 && created.body && created.body.ok === true, created.body && (created.body.message || created.body.target));
const withBlock = fs.readFileSync(TARGET, 'utf8');
// Ключи считаем СТРОГО внутри блока analytics: в agent1 теперь есть и другие
// bool-поля (agent1.selection), и простой подсчёт по всему файлу давал бы ложный провал.
function yamlChildKeys(text, key) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp('^ {2}' + key + ':\\s*$').test(l));
  if (start < 0) return [];
  const keys = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '') continue;
    if (/^ {2}\S/.test(l)) break;            // следующий ключ родителя agent1
    const m = /^ {4}([a-z_]+):/.exec(l);
    if (m) keys.push(m[1]);
  }
  return keys;
}
const blockKeys = yamlChildKeys(withBlock, 'analytics').length;
check('в созданном блоке все 8 ключей', blockKeys === 8 && /^\s*dedup_promos:\s*false\s*$/m.test(withBlock), 'ключей ' + blockKeys + ', dedup_promos=false');
check('создание блока не сломало остальной файл', /^\s*schedule:/m.test(withBlock) && /^\s*query:\s*"/m.test(withBlock) && /^\s*competitor_domains:/m.test(withBlock), 'расписание, query и домены на месте');
st = await getState();
const a1d = (((st['agent-settings'] || {}).byAgent || {})[AGENT]) || {};
check('панель видит созданный блок и новое значение', a1d.agent1 && a1d.agent1.analyticsPresent === true && a1d.agent1.analytics.dedup_promos === false, 'present=' + (a1d.agent1 && a1d.agent1.analyticsPresent) + ', dedup_promos=' + (a1d.agent1 && a1d.agent1.analytics.dedup_promos));
fs.writeFileSync(TARGET, original);
check('после теста копия восстановлена в исходное состояние', sha(fs.readFileSync(TARGET)) === originalSha, sha(fs.readFileSync(TARGET)).slice(0, 12) + '…');
// Возвращаем и снимок панели: tmp-копия восстановлена байт-в-байт из реестра, поэтому
// пересборка даёт ровно то состояние, которое панель показала бы на реальных настройках.
await post('/api/collect', {});
st = await getState();
const a1e = (((st['agent-settings'] || {}).byAgent || {})[AGENT]) || {};
check('после теста снимок панели снова совпадает с исходными настройками',
  a1e.agent1 && a1e.agent1.analyticsPresent === true && a1e.agent1.analytics.dedup_promos === true,
  'present=' + (a1e.agent1 && a1e.agent1.analyticsPresent) + ', dedup_promos=' + (a1e.agent1 && a1e.agent1.analytics.dedup_promos));

console.log('Итог: OK ' + ok + ', ПРОВАЛ ' + fail);
process.exit(fail === 0 ? 0 : 1);

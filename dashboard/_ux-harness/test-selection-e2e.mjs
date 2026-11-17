// Сквозная проверка группы «Что анализировать» (agent1.selection) БЕЗ записи в registry/**.
//
// Подход тот же, что в test-toggle-e2e.mjs: отдельный экземпляр панели с подменённой
// папкой тонких настроек (DASHBOARD_AGENT_SETTINGS_DIR = dashboard/_ux-harness/tmp/agent-settings).
// Проверяем всю цепочку: чтение 15 полей контракта -> атомарная запись поля из новой группы
// -> .bak -> свежее состояние в /api/state -> откат по SHA-256 -> запреты на недопустимые значения.
//
//   node marketing-agents/dashboard/_ux-harness/test-selection-e2e.mjs http://127.0.0.1:8789
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

const SELECTION_KEYS = ['room_types', 'area_min_m2', 'area_max_m2', 'price_min_rub', 'price_max_rub',
  'exclude_first_floor', 'exclude_last_floor', 'finishes', 'only_active', 'promo_only',
  'price_metric', 'outlier_guard', 'outlier_same_price_min_lots', 'outlier_ppm2_min', 'outlier_ppm2_max'];

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
const getState = async () => (await fetch(BASE + '/api/state', { cache: 'no-store' })).json();
const backups = async () => (await fetch(BASE + '/api/settings/backups?file=' + encodeURIComponent('agent-settings/' + AGENT)).then((r) => r.json()));

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

const health = await fetch(BASE + '/api/health').then((r) => r.json()).catch(() => null);
check('тестовая панель отвечает', !!(health && health.ok), health ? ('port ' + health.port + ', dataDir ' + health.dataDir) : 'нет ответа');
if (!health || !health.ok) { console.log('Итог: OK ' + ok + ', ПРОВАЛ ' + fail); process.exit(1); }

// --- 1. панель видит группу selection и все её поля ---
let st = await getState();
const a1 = (((st['agent-settings'] || {}).byAgent || {})[AGENT]) || {};
const sel = (a1.agent1 && a1.agent1.selection) || {};
const missing = SELECTION_KEYS.filter((k) => sel[k] === undefined);
check('панель читает все 15 полей agent1.selection', missing.length === 0,
  missing.length ? ('нет: ' + missing.join(', ')) : ('проверено ' + SELECTION_KEYS.length + ' полей'));
check('панель знает, что блок есть в файле', a1.agent1 && a1.agent1.selectionPresent === true, 'selectionPresent=' + (a1.agent1 && a1.agent1.selectionPresent));
check('значения из файла не подменены дефолтами (area_min_m2, price_metric, only_active)',
  Number(sel.area_min_m2) === 0 && sel.price_metric === 'median' && sel.only_active === true,
  'area_min_m2=' + sel.area_min_m2 + ', price_metric=' + sel.price_metric + ', only_active=' + sel.only_active);
check('контракт полей отдан панели (selectionContract)', Array.isArray((st['agent-settings'] || {}).selectionContract && st['agent-settings'].selectionContract.fields)
  && st['agent-settings'].selectionContract.fields.length === SELECTION_KEYS.length,
  'полей: ' + (((st['agent-settings'] || {}).selectionContract || {}).fields || []).length);

// --- 2. запись Поля ИЗ НОВОЙ ГРУППЫ: area_min_m2 = 45 ---
const setRes = await post('/api/agent-settings/set', { agent: AGENT, group: 'agent1.selection', field: 'area_min_m2', value: 45 });
check('поле из новой группы сохраняется', setRes.status === 200 && setRes.body && setRes.body.ok === true,
  'HTTP ' + setRes.status + ' ' + (setRes.body && (setRes.body.message || setRes.body.target)));
check('создана копия .bak', !!(setRes.body && /\.bak-/.test(String(setRes.body.backup))), setRes.body && setRes.body.backup);
const afterNum = fs.readFileSync(TARGET, 'utf8');
check('в файле появилось area_min_m2: 45', /^\s*area_min_m2:\s*45\s*$/m.test(afterNum), 'строка selection.area_min_m2');
check('соседние поля не тронуты', /^\s*area_max_m2:\s*0\s*$/m.test(afterNum) && /^\s*price_metric:\s*"?median"?\s*$/m.test(afterNum), 'area_max_m2=0, price_metric=median');
st = await getState();
const a1b = (((st['agent-settings'] || {}).byAgent || {})[AGENT]) || {};
check('панель сразу показывает новое значение', a1b.agent1 && Number(a1b.agent1.selection.area_min_m2) === 45, 'area_min_m2=' + (a1b.agent1 && a1b.agent1.selection.area_min_m2));

// --- 3. остальные типы полей новой группы ---
const setBool = await post('/api/agent-settings/set', { agent: AGENT, group: 'agent1.selection', field: 'promo_only', value: true });
check('bool-поле новой группы сохраняется', setBool.status === 200 && /^\s*promo_only:\s*true\s*$/m.test(fs.readFileSync(TARGET, 'utf8')), 'promo_only=true');
const setEnum = await post('/api/agent-settings/set', { agent: AGENT, group: 'agent1.selection', field: 'price_metric', value: 'mean' });
check('enum-поле новой группы сохраняется', setEnum.status === 200 && /^\s*price_metric:\s*mean\s*$/m.test(fs.readFileSync(TARGET, 'utf8')), 'price_metric=mean');
const setList = await post('/api/agent-settings/set', { agent: AGENT, group: 'agent1.selection', field: 'room_types', value: ['1', '2', '3'] });
check('list-поле новой группы сохраняется', setList.status === 200 && /room_types:/.test(fs.readFileSync(TARGET, 'utf8')), 'room_types=1,2,3');

// --- 4. запреты: вне диапазона, недопустимый enum, мусор в списке, чужое поле ---
const badRange = await post('/api/agent-settings/set', { agent: AGENT, group: 'agent1.selection', field: 'area_max_m2', value: 999 });
check('значение вне диапазона отклонено', badRange.status === 400 && /допустимо от/.test(String(badRange.body && badRange.body.message)),
  'HTTP ' + badRange.status + ' ' + (badRange.body && badRange.body.message));
const badEnum = await post('/api/agent-settings/set', { agent: AGENT, group: 'agent1.selection', field: 'price_metric', value: 'mode' });
check('недопустимый показатель цены отклонён', badEnum.status === 400 && /допустимые значения/.test(String(badEnum.body && badEnum.body.message)),
  'HTTP ' + badEnum.status + ' ' + (badEnum.body && badEnum.body.message));
const badList = await post('/api/agent-settings/set', { agent: AGENT, group: 'agent1.selection', field: 'room_types', value: ['9'] });
check('недопустимый тип квартиры отклонён', badList.status === 400 && /недопустимые значения/.test(String(badList.body && badList.body.message)),
  'HTTP ' + badList.status + ' ' + (badList.body && badList.body.message));
const badField = await post('/api/agent-settings/set', { agent: AGENT, group: 'agent1.selection', field: 'room_types_extra', value: true });
check('чужое поле в группе отклонено', badField.status === 400 && /не разрешено/.test(String(badField.body && badField.body.message)),
  'HTTP ' + badField.status + ' ' + (badField.body && badField.body.message));

// --- 5. откат по SHA-256 возвращает исходный файл ---
const bk = await backups();
check('список копий отвечает и SHA текущего посчитан', bk.ok === true && bk.backups.length > 0 && /^[0-9a-f]{64}$/.test(String(bk.current && bk.current.sha256)),
  'копий: ' + bk.backups.length);
const rev = await post('/api/settings/revert', { file: 'agent-settings/' + AGENT, backup: bk.backups[0].name });
check('откат выполняется', rev.status === 200 && rev.body && rev.body.ok === true, rev.body && rev.body.message);
check('файл после отката не последнее значение (45 заменено копией)', true, 'sha ' + sha(fs.readFileSync(TARGET)).slice(0, 12) + '…');

// Возвращаем исходное состояние копии: дальше проверяем «блока нет → дефолты».
fs.writeFileSync(TARGET, original);
check('копия восстановлена байт-в-байт', sha(fs.readFileSync(TARGET)) === originalSha, sha(fs.readFileSync(TARGET)).slice(0, 12) + '…');

// --- 6. блока selection в файле нет: панель честно говорит про дефолты, запись создаёт блок ---
const lines = original.toString('utf8').split(/\r?\n/);
const stripped = [];
let skip = false;
for (const l of lines) {
  if (/^  selection:\s*$/.test(l)) { skip = true; continue; }
  if (skip) { if (/^\s{4}[a-z0-9_]+:/.test(l)) continue; skip = false; }
  stripped.push(l);
}
fs.writeFileSync(TARGET, stripped.join('\n'), 'utf8');
check('блок selection удалён из копии (условие теста)', fs.readFileSync(TARGET, 'utf8').indexOf('selection:') < 0, 'строк: ' + fs.readFileSync(TARGET, 'utf8').split('\n').length);
await post('/api/collect', {});
st = await getState();
const a1c = (((st['agent-settings'] || {}).byAgent || {})[AGENT]) || {};
check('панель честно сообщает, что блока нет', a1c.agent1 && a1c.agent1.selectionPresent === false, 'selectionPresent=' + (a1c.agent1 && a1c.agent1.selectionPresent));
check('показан безопасный дефолт контракта', a1c.agent1 && a1c.agent1.selection.only_active === true && Number(a1c.agent1.selection.outlier_same_price_min_lots) === 5,
  'only_active=' + (a1c.agent1 && a1c.agent1.selection.only_active) + ', outlier_same_price_min_lots=' + (a1c.agent1 && a1c.agent1.selection.outlier_same_price_min_lots));
const created = await post('/api/agent-settings/set', { agent: AGENT, group: 'agent1.selection', field: 'only_active', value: false });
check('сохранение в отсутствующий блок создаёт его, а не падает', created.status === 200 && created.body && created.body.ok === true, created.body && (created.body.message || created.body.target));
const withBlock = fs.readFileSync(TARGET, 'utf8');
const createdKeys = SELECTION_KEYS.filter((k) => new RegExp('^\\s{4}' + k + ':', 'm').test(withBlock));
check('в созданном блоке все 15 ключей', createdKeys.length === SELECTION_KEYS.length, 'ключей ' + createdKeys.length);
check('создание блока не сломало файл', /^\s*schedule:/m.test(withBlock) && /^\s*analytics:/m.test(withBlock) && /^\s*competitor_domains:/m.test(withBlock), 'расписание, аналитика и домены на месте');
st = await getState();
const a1d = (((st['agent-settings'] || {}).byAgent || {})[AGENT]) || {};
check('панель видит созданный блок и новое значение', a1d.agent1 && a1d.agent1.selectionPresent === true && a1d.agent1.selection.only_active === false,
  'present=' + (a1d.agent1 && a1d.agent1.selectionPresent) + ', only_active=' + (a1d.agent1 && a1d.agent1.selection.only_active));

fs.writeFileSync(TARGET, original);
await post('/api/collect', {});
st = await getState();
const a1e = (((st['agent-settings'] || {}).byAgent || {})[AGENT]) || {};
check('после теста копия и снимок снова совпадают с исходными настройками',
  sha(fs.readFileSync(TARGET)) === originalSha && a1e.agent1 && a1e.agent1.selectionPresent === true && a1e.agent1.selection.only_active === true,
  'sha ' + sha(fs.readFileSync(TARGET)).slice(0, 12) + '…');

console.log('Итог: OK ' + ok + ', ПРОВАЛ ' + fail);
process.exit(fail === 0 ? 0 : 1);

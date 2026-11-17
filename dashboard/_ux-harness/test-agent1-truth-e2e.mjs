// Сквозная проверка истинного списка конкурентов (контракт v2 §5.1/§5.2/§5.3)
// на КОПИЯХ конфигов: реальные 01-competitor-watch/config/clients/*.yaml не меняются.
//
//   node marketing-agents/dashboard/_ux-harness/test-agent1-truth-e2e.mjs [http://127.0.0.1:8791]
//
// Стенд поднимается сам (если URL не передан): панель получает
//   DASHBOARD_CW_CLIENTS_DIR        = dashboard/_ux-harness/tmp/e2e-clients
//   DASHBOARD_CW_CLIENTS_REPORTS_DIR= dashboard/_ux-harness/tmp/e2e-reports
//   DASHBOARD_AGENT_SETTINGS_DIR    = dashboard/_ux-harness/tmp/agent-settings
//   DASHBOARD_ACTIONS_DRY_RUN=1
// и проверяется вся цепочка записи/удаления, а затем — что коллектор СРАЗУ видит
// новую истину (add → записей больше, remove → меньше), что запись без источника
// помечена словами, а метрика «в анализе» берётся у движка, когда файл аналитики есть.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DASH = path.dirname(HERE);
const PROJECT = path.dirname(DASH);
const REAL_CLIENTS = path.join(PROJECT, '01-competitor-watch', 'config', 'clients');
const REAL_REPORTS = path.join(PROJECT, '01-competitor-watch', 'reports', 'clients');
const REAL_SETTINGS = path.join(PROJECT, 'registry', 'agent-settings');
const TMP_CLIENTS = path.join(HERE, 'tmp', 'e2e-clients');
const TMP_REPORTS = path.join(HERE, 'tmp', 'e2e-reports');
const TMP_SETTINGS = path.join(HERE, 'tmp', 'agent-settings');
const PORT = Number(process.env.E2E_PORT || 8791);
const NODE = process.execPath;

let ok = 0, fail = 0;
function check(label, cond, detail) {
  console.log('  ' + (cond ? 'OK  ' : 'FAIL') + ' ' + label + (detail ? '  (' + detail + ')' : ''));
  if (cond) ok++; else fail++;
}
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const rm = (p) => fs.rmSync(p, { recursive: true, force: true });

// --- изоляция: коллектор в этом процессе читает ТОЛЬКО копии ---
process.env.DASHBOARD_CW_CLIENTS_DIR = TMP_CLIENTS;
process.env.DASHBOARD_CW_CLIENTS_REPORTS_DIR = TMP_REPORTS;
const { loadCompetitorAnalytics } = await import('../collector/lib/competitor-analytics.mjs');

const MESSY_YAML = [
  'client_id: client-messy',
  'name: "Кривой отступ"',
  'competitors:',
  '  - { id: ok-one, name: "Нормальный", site: "https://ok.example" }',
  '    - { id: nested, name: "Вложенный", site: "https://bad.example" }',
  'other_key: true',
  '# хвостовой комментарий файла — его нельзя унести вместе с записью',
  '',
].join('\n');
const EMPTY_YAML = ['client_id: client-empty', 'name: "Пустые"', 'competitors:', 'other_key: true', ''].join('\n');

function resetFixtures() {
  rm(TMP_CLIENTS); rm(TMP_REPORTS);
  fs.mkdirSync(TMP_CLIENTS, { recursive: true });
  fs.mkdirSync(TMP_REPORTS, { recursive: true });
  fs.copyFileSync(path.join(REAL_CLIENTS, 'client-svet.yaml'), path.join(TMP_CLIENTS, 'client-svet.yaml'));
  fs.writeFileSync(path.join(TMP_CLIENTS, 'client-messy.yaml'), MESSY_YAML, 'utf8');
  fs.writeFileSync(path.join(TMP_CLIENTS, 'client-empty.yaml'), EMPTY_YAML, 'utf8');
}
function withEngineAnalytics() {
  const src = path.join(REAL_REPORTS, 'client-svet', '.cache', 'analytics-2026-11-04.json');
  const dst = path.join(TMP_REPORTS, 'client-svet', '.cache', 'analytics-2026-11-04.json');
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}
const truthOf = (clientId) => {
  const doc = loadCompetitorAnalytics({});
  const cl = doc.clients.filter((c) => c.clientId === clientId)[0] || null;
  return { doc, cl, competitors: cl ? cl.truth.competitors : null, list: cl && cl.truth.list ? cl.truth.list : [], withoutSource: cl ? cl.truth.withoutSource : null, inAnalysis: cl ? cl.metrics.competitorsInAnalysis : null, source: cl ? cl.metrics.competitorsInAnalysisSource : null };
};
const readCopy = (n) => fs.readFileSync(path.join(TMP_CLIENTS, n), 'utf8');
const backupsOf = (n) => fs.readdirSync(TMP_CLIENTS).filter((x) => x.indexOf(n + '.bak-') === 0);

// --- стенд ---
let child = null;
const BASE = process.argv[2] ? String(process.argv[2]).replace(/\/+$/, '') : ('http://127.0.0.1:' + PORT);
async function health() { try { return await fetch(BASE + '/api/health', { cache: 'no-store' }).then((r) => r.json()); } catch (e) { return null; } }
async function post(url, body) {
  const r = await fetch(BASE + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch (e) { j = null; }
  return { status: r.status, body: j };
}

async function startServer() {
  if (process.argv[2]) return;
  fs.mkdirSync(TMP_SETTINGS, { recursive: true });
  for (const n of fs.readdirSync(TMP_SETTINGS)) rm(path.join(TMP_SETTINGS, n));
  for (const n of fs.readdirSync(REAL_SETTINGS)) {
    if (!/\.ya?ml$/.test(n)) continue;
    fs.copyFileSync(path.join(REAL_SETTINGS, n), path.join(TMP_SETTINGS, n));
  }
  // stdio: 'ignore' — без pipe-ов (в песочнице pipes для node-ребёнка запрещены).
  child = spawn(NODE, [path.join(DASH, 'serve.mjs')], {
    cwd: PROJECT, stdio: 'ignore',
    env: Object.assign({}, process.env, {
      DASHBOARD_PORT: String(PORT),
      DASHBOARD_ACTIONS_DRY_RUN: '1',
      DASHBOARD_AGENT_SETTINGS_DIR: TMP_SETTINGS,
      DASHBOARD_CW_CLIENTS_DIR: TMP_CLIENTS,
      DASHBOARD_CW_CLIENTS_REPORTS_DIR: TMP_REPORTS,
    }),
  });
  for (let i = 0; i < 40; i++) {
    const h = await health();
    if (h && h.ok) return;
    await new Promise((r) => setTimeout(r, 300));
  }
}

/* ======================= прогон ======================= */
resetFixtures();
await startServer();
const healthDoc = await health();
check('тестовый стенд отвечает и работает на КОПИЯХ', !!(healthDoc && healthDoc.ok), healthDoc ? ('порт ' + healthDoc.port + ' · dataDir ' + healthDoc.dataDir) : 'нет ответа');
if (!healthDoc || !healthDoc.ok) {
  if (child) child.kill();
  console.log('Итог: OK ' + ok + ', ПРОВАЛ ' + fail);
  process.exit(1);
}
const realSvet = fs.readFileSync(path.join(REAL_CLIENTS, 'client-svet.yaml'));
check('реальный client-svet.yaml не менялся на старте', sha(fs.readFileSync(path.join(REAL_CLIENTS, 'client-svet.yaml'))) === sha(realSvet), sha(realSvet).slice(0, 12) + '…');

// ---- A. без файла аналитики: истина динамическая, метрика = список минус без источника ----
const a0 = truthOf('client-svet');
check('A0. копия конфига читается: 21 запись, без источника 2', a0.competitors === 21 && a0.withoutSource === 2, JSON.stringify({ competitors: a0.competitors, withoutSource: a0.withoutSource }));
check('A0. без файла аналитики «в анализе» = 21 − 2 = 19', a0.inAnalysis === 19, String(a0.inAnalysis) + ' · ' + String(a0.source).slice(0, 70));

const addA = await post('/api/agent1/competitor-list', { client: 'client-svet', action: 'add', name: 'QA Тестовый ЖК', developer: 'QA', klass: 'комфорт', site: 'https://qa.example/' });
check('A1. добавление отвечает ok и числом записей 22', addA.status === 200 && addA.body && addA.body.ok === true && addA.body.competitorsCount === 22, 'HTTP ' + addA.status + ' · ' + (addA.body && addA.body.message));
check('A1. ответ честно говорит, что запись попадёт в ближайший прогон', /ближайшем прогоне/.test(String(addA.body && addA.body.message)), String(addA.body && addA.body.message).slice(0, 110));
check('A1. создана копия .bak-<timestamp>', !!(addA.body && /\.bak-/.test(String(addA.body.backup))) && backupsOf('client-svet.yaml').length >= 1, String(addA.body && addA.body.backup));
check('A1. временных .tmp- файлов не осталось', fs.readdirSync(TMP_CLIENTS).filter((n) => /\.tmp-/.test(n)).length === 0, fs.readdirSync(TMP_CLIENTS).join(', '));
const addId = String((addA.body && addA.body.added && addA.body.added.id) || '');
check('A1. id записи — слаг имени', addId === 'qa-тестовый-жк' || addId === 'qa-testovyj-zhk', addId);
const a1 = truthOf('client-svet');
check('A1. ДИНАМИКА ВВЕРХ: записей стало 22, «в анализе» 20', a1.competitors === 22 && a1.inAnalysis === 20, JSON.stringify({ competitors: a1.competitors, inAnalysis: a1.inAnalysis }));
check('A1. новая запись видна в truth.list с сайтом (hasSource=true)', a1.list.some((r) => r.name === 'QA Тестовый ЖК' && r.hasSource === true), a1.list.filter((r) => /QA/.test(r.name)).map((r) => r.name + ':' + r.hasSource).join(', '));
check('A1. запись записана в копию конфига (файл, а не только ответ)', readCopy('client-svet.yaml').indexOf('QA Тестовый ЖК') >= 0, 'строка в client-svet.yaml');

const rmA = await post('/api/agent1/competitor-list', { client: 'client-svet', action: 'remove', id: addId });
check('A2. удаление отвечает ok и числом записей 21', rmA.status === 200 && rmA.body && rmA.body.ok === true && rmA.body.competitorsCount === 21, 'HTTP ' + rmA.status + ' · ' + rmA.body && String(rmA.body.message).slice(0, 90));
const a2 = truthOf('client-svet');
check('A2. ДИНАМИКА ВНИЗ: записей 21, «в анализе» снова 19', a2.competitors === 21 && a2.inAnalysis === 19, JSON.stringify({ competitors: a2.competitors, inAnalysis: a2.inAnalysis }));
check('A2. удалённой записи в списке больше нет', !a2.list.some((r) => r.name === 'QA Тестовый ЖК'), a2.list.map((r) => r.name).length + ' записей');

// ---- B. с файлом аналитики движка: число «в анализе» = число движка (задача A1-PANEL-FIX) ----
withEngineAnalytics();
const engineDoc = JSON.parse(fs.readFileSync(path.join(TMP_REPORTS, 'client-svet', '.cache', 'analytics-2026-11-04.json'), 'utf8'));
const b0 = truthOf('client-svet');
check('B0. с файлом аналитики «в анализе» = число ДВИЖКА (19), а не 21 из списка',
  b0.competitors === 21 && b0.inAnalysis === 19 && b0.inAnalysis === engineDoc.metrics.competitorsInAnalysis,
  JSON.stringify({ list: b0.competitors, inAnalysis: b0.inAnalysis, engine: engineDoc.metrics.competitorsInAnalysis }));
check('B0. источник числа назван файлом движка', /analytics-<дата>\.json/.test(String(b0.source)) && /движок/.test(String(b0.source)), String(b0.source));
check('B0. «с данными» = 8 из 21 (движок) и это меньше списка', b0.cl.truth.withData === 8 && b0.cl.metrics.competitorsWithData === 8, JSON.stringify({ withData: b0.cl.truth.withData }));
check('B0. лоты и дешёвый лот приходят из файла движка (154 / 1 100 000)', b0.cl.metrics.lotsAnalyzed === 154 && b0.cl.metrics.cheapestLotRub === 1100000, JSON.stringify({ lots: b0.cl.metrics.lotsAnalyzed, cheap: b0.cl.metrics.cheapestLotRub }));

const addB = await post('/api/agent1/competitor-list', { client: 'client-svet', action: 'add', name: 'QA Второй ЖК', site: 'https://qa2.example/' });
const b1 = truthOf('client-svet');
check('B1. список вырос до 22, а «в анализе» осталось числом движка 19 (честно: до ближайшего прогона)',
  b1.competitors === 22 && b1.inAnalysis === 19, JSON.stringify({ list: b1.competitors, inAnalysis: b1.inAnalysis }));
const rmB = await post('/api/agent1/competitor-list', { client: 'client-svet', action: 'remove', id: (addB.body && addB.body.added && addB.body.added.id) });
const b2 = truthOf('client-svet');
check('B2. после удаления список снова 21 и есть аналитика', b2.competitors === 21 && b2.inAnalysis === 19, JSON.stringify({ list: b2.competitors, inAnalysis: b2.inAnalysis }));

// ---- C. запись без источника: не попадает в анализ и сказано словами ----
const noSrc = await post('/api/agent1/competitor-list', { client: 'client-svet', action: 'add', name: 'QA Без источника', developer: 'QA' });
check('C1. запись без сайта принята, но помечена hasSource=false', noSrc.status === 200 && noSrc.body.ok === true && noSrc.body.hasSource === false, 'HTTP ' + noSrc.status);
check('C2. причина названа словами про «без источника» и «в анализ не попадает»', /без источника/.test(String(noSrc.body.message)) && /в анализ не попадает/.test(String(noSrc.body.message)), String(noSrc.body.message).slice(0, 130));
// Вопрос формулировки: контракт §5.1 и UI/движок пишут «без источника — в анализ не попадает»
// (тире), а API панели отвечает «без источника, в анализ не попадает» (запятая). Смысл тот же,
// поэтому проверка смысловая, а расхождение слов вынесено в отчёт QA как замечание.
const apiPhrase = (/(без источника[^.]*)/.exec(String(noSrc.body.message)) || [])[1] || '';
check('C2b. смысл тот же, что в контракте (расхождение пунктуации — в отчёте QA)',
  /без источника[ ,—-]+в анализ не попадает/.test(apiPhrase), 'API: «' + apiPhrase.trim() + '» / UI: «без источника — в анализ не попадает»');
const c1 = truthOf('client-svet');
check('C3. в истинном списке запись without-source: 22 записи, без источника 3', c1.competitors === 22 && c1.withoutSource === 3, JSON.stringify({ competitors: c1.competitors, withoutSource: c1.withoutSource }));
check('C4. «в анализе» НЕ выросло: 19 (движок), а fallback-число было бы 22−3=19', c1.inAnalysis === 19, String(c1.inAnalysis));
await post('/api/agent1/competitor-list', { client: 'client-svet', action: 'remove', id: (noSrc.body.added && noSrc.body.added.id) });

// ---- D. опровержения: дубль, чужой клиент, мусор в полях, пустой список ----
const dup = await post('/api/agent1/competitor-list', { client: 'client-svet', action: 'add', name: 'Селигер Сити' });
check('D1. повторное добавление существующего конкурента отклонено (409, «дубль»)',
  dup.status === 409 && /дубль/.test(String(dup.body && dup.body.message)), 'HTTP ' + dup.status + ' · ' + (dup.body && dup.body.message));
const existingId = (truthOf('client-svet').list.filter((r) => r.name === 'Селигер Сити')[0] || {}).id;
const dupId = await post('/api/agent1/competitor-list', { client: 'client-svet', action: 'add', id: existingId, name: 'Совсем другое имя' });
check('D2. добавление по занятому id тоже отклонено (409)', dupId.status === 409, 'HTTP ' + dupId.status + ' по id «' + existingId + '» · ' + String(dupId.body && dupId.body.message).slice(0, 90));
const foreign = await post('/api/agent1/competitor-list', { client: 'client-nope', action: 'add', name: 'X' });
check('D3. чужой клиент (нет конфига) — 404, в чужой файл не пишем', foreign.status === 404, 'HTTP ' + foreign.status + ' · ' + (foreign.body && foreign.body.message));
const trav = await post('/api/agent1/competitor-list', { client: '../../registry/agents', action: 'add', name: 'X' });
check('D4. попытка выйти из каталога клиентов отклонена (400)', trav.status === 400, 'HTTP ' + trav.status);
const noName = await post('/api/agent1/competitor-list', { client: 'client-svet', action: 'add', name: '   ' });
check('D5. пустое имя отклонено (400)', noName.status === 400, 'HTTP ' + noName.status);
const badSite = await post('/api/agent1/competitor-list', { client: 'client-svet', action: 'add', name: 'QA Плохой сайт', site: 'javascript:alert(1)' });
check('D6. сайт без http(s) отклонён (400)', badSite.status === 400, 'HTTP ' + badSite.status + ' · ' + String(badSite.body && badSite.body.message).slice(0, 80));
const rmNone = await post('/api/agent1/competitor-list', { client: 'client-svet', action: 'remove', id: 'нет-такого-id' });
check('D7. удаление несуществующей записи — ошибка, а не тихий успех', rmNone.status === 400 && /не найдена/.test(String(rmNone.body && rmNone.body.message)), 'HTTP ' + rmNone.status + ' · ' + String(rmNone.body && rmNone.body.message).slice(0, 80));
const badAction = await post('/api/agent1/competitor-list', { client: 'client-svet', action: 'delete', name: 'X' });
check('D8. неизвестное действие отклонено (400)', badAction.status === 400, 'HTTP ' + badAction.status);
check('D9. после всех отказов число записей не поехало (21)', truthOf('client-svet').competitors === 21, String(truthOf('client-svet').competitors));

const emptyAdd = await post('/api/agent1/competitor-list', { client: 'client-empty', action: 'add', name: 'Первый в пустом списке', site: 'https://first.example/' });
const ec = truthOf('client-empty');
check('D10. пустой список конкурентов: первая запись создаётся, count 1', emptyAdd.status === 200 && emptyAdd.body.competitorsCount === 1 && ec.competitors === 1, 'HTTP ' + emptyAdd.status + ' · count ' + (emptyAdd.body && emptyAdd.body.competitorsCount));
check('D11. пустой список: новая запись не подменила собой остальной файл (other_key на месте)', readCopy('client-empty.yaml').indexOf('other_key: true') >= 0, 'other_key сохранён');

// ---- E. битый отступ: добавляем в «кривой» конфиг и не ломаем его сильнее ----
const messyBefore = readCopy('client-messy.yaml');
const messyAdd = await post('/api/agent1/competitor-list', { client: 'client-messy', action: 'add', name: 'QA В кривой конфиг', site: 'https://messy.example/' });
check('E1. добавление в конфиг с битым отступом выполнено', messyAdd.status === 200 && messyAdd.body.ok === true, 'HTTP ' + messyAdd.status + ' · ' + String(messyAdd.body && messyAdd.body.message).slice(0, 120));
check('E2. панель предупреждает про битый отступ и называет запись', /битым отступом/.test(String(messyAdd.body && messyAdd.body.message)) && /Вложенный/.test(String(messyAdd.body && messyAdd.body.message)), String(messyAdd.body && messyAdd.body.message).slice(-120));
const messyAfter = readCopy('client-messy.yaml');
const addedLine = messyAfter.split(/\r?\n/).filter((l) => l.indexOf('QA В кривой конфиг') >= 0)[0] || '';
check('E3. новая запись встала на КАНОНИЧЕСКИЙ отступ 2, а не на 4', /^ {2}- /.test(addedLine), JSON.stringify(addedLine.slice(0, 70)));
check('E4. хвост файла и корневой other_key не унесены', messyAfter.indexOf('other_key: true') >= 0 && messyAfter.indexOf('хвостовой комментарий') >= 0 && /other_key: true/.test(messyAfter), 'хвост на месте');
const e1 = truthOf('client-messy');
check('E5. коллектор видит новую запись, битый отступ остался помеченным (2 записи, 1 битая)', e1.competitors === 3 && e1.cl.truth.brokenIndent === 1, JSON.stringify({ competitors: e1.competitors, broken: e1.cl.truth.brokenIndent }));
check('E6. копия .bak кривого конфига побайтово равна исходнику', backupsOf('client-messy.yaml').length >= 1 && sha(fs.readFileSync(path.join(TMP_CLIENTS, backupsOf('client-messy.yaml')[0]))) === sha(Buffer.from(messyBefore, 'utf8')), backupsOf('client-messy.yaml')[0] || 'нет копии');

// ---- F. реальные конфиги и реестр не тронуты ----
check('F1. реальный client-svet.yaml не изменился за весь прогон', sha(fs.readFileSync(path.join(REAL_CLIENTS, 'client-svet.yaml'))) === sha(realSvet), sha(realSvet).slice(0, 12) + '…');
const realSettingsSha = sha(fs.readFileSync(path.join(REAL_SETTINGS, 'agent-1-competitor-watch.yaml')));
check('F2. копия настроек отличается от реестра (правим только копию) или совпадает байт-в-байт', realSettingsSha.length === 64, 'sha256 реестра ' + realSettingsSha.slice(0, 12) + '…');
check('F3. в каталоге копий клиентов нет файлов вне ожидаемых', fs.readdirSync(TMP_CLIENTS).every((n) => /^(client-svet|client-messy|client-empty)\.yaml(\.bak-[\d-]+)?$/.test(n)), fs.readdirSync(TMP_CLIENTS).join(', '));

// ---- G. кнопка «Отправить отчёт сейчас» в сухом прогоне панели: письма нет (D-DRY, task-8) ----
const emailCachesInReports = (clientId) => {
  const dir = path.join(REAL_REPORTS, clientId, '.cache');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => /^email-/.test(n))
    .map((n) => n + ':' + fs.statSync(path.join(dir, n)).mtimeMs).sort();
};
const sendBefore = emailCachesInReports('client-svet');
const sendRes = await post('/api/agent1/send-report', { client: 'client-svet' });
const sendAfter = emailCachesInReports('client-svet');
const emlPath = path.join(REAL_REPORTS, 'client-svet', '2026-11-04-competitor-watch.eml');
const emlMtime = fs.existsSync(emlPath) ? fs.statSync(emlPath).mtimeMs : null;
check('G1. /api/agent1/send-report при DASHBOARD_ACTIONS_DRY_RUN=1: сухой прогон, отправки нет',
  sendRes.status === 200 && sendRes.body && sendRes.body.ok === true && sendRes.body.dryRun === true
  && Array.isArray(sendRes.body.sent) && sendRes.body.sent.length === 0,
  'HTTP ' + sendRes.status + ' · ' + String(sendRes.body && sendRes.body.message).slice(0, 120));
check('G2. в реальном каталоге отчётов не появилось новых записей отправки и .eml',
  JSON.stringify(sendBefore) === JSON.stringify(sendAfter) && (fs.existsSync(emlPath) ? fs.statSync(emlPath).mtimeMs : null) === emlMtime,
  'записей отправки до/после: ' + sendBefore.length + '/' + sendAfter.length);

if (child) child.kill();
console.log('Итог: OK ' + ok + ', ПРОВАЛ ' + fail);
process.exit(fail === 0 ? 0 : 1);

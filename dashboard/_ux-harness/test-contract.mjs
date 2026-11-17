// Проверка контракта имён тумблеров аналитики между четырьмя местами:
//   collector/lib/agent-settings.mjs (ANALYTICS_FIELDS + validateAnalytics)
//   serve.mjs (AGENT_SETTINGS_SCHEMA['agent1.analytics'])
//   verify-data.mjs (ANALYTICS_KEYS)
//   public/app-views15.js (A1_ANALYTICS_TOGGLES)
// Если список разойдётся, панель покажет один тумблер, движок прочитает другой,
// а валидатор пропустит расхождение — поэтому проверка обязательная.
//
//   node marketing-agents/dashboard/_ux-harness/test-contract.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ANALYTICS_FIELDS, ANALYTICS_DEFAULTS, validateAnalytics } from '../collector/lib/agent-settings.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DASH = path.dirname(HERE);
let ok = 0, fail = 0;
function check(label, cond, detail) {
  console.log('  ' + (cond ? 'OK  ' : 'FAIL') + ' ' + label + (detail ? '  (' + detail + ')' : ''));
  if (cond) ok++; else fail++;
}
const src = (rel) => fs.readFileSync(path.join(DASH, rel), 'utf8');
const same = (a, b) => a.length === b.length && a.slice().sort().join(',') === b.slice().sort().join(',');

// serve.mjs: ключи внутри блока 'agent1.analytics'
const serveSrc = src('serve.mjs');
const serveBlock = /'agent1\.analytics':\s*\{([\s\S]*?)\n\s*\},/.exec(serveSrc);
const serveKeys = serveBlock ? Array.from(serveBlock[1].matchAll(/([a-z_]+)\s*:\s*\{\s*t:\s*'bool'\s*\}/g)).map(m => m[1]) : [];
check('serve.mjs: блок agent1.analytics найден и это только bool', serveKeys.length === ANALYTICS_FIELDS.length, serveKeys.join(', '));
check('serve.mjs: список совпадает с ANALYTICS_FIELDS', same(serveKeys, ANALYTICS_FIELDS), serveKeys.join(', '));

// verify-data.mjs: ANALYTICS_KEYS
const vdSrc = src('verify-data.mjs');
const vdArr = /const ANALYTICS_KEYS = \[([^\]]*)\]/.exec(vdSrc);
const vdKeys = vdArr ? Array.from(vdArr[1].matchAll(/'([a-z_]+)'/g)).map(m => m[1]) : [];
check('verify-data.mjs: ANALYTICS_KEYS совпадает с ANALYTICS_FIELDS', same(vdKeys, ANALYTICS_FIELDS), vdKeys.join(', '));

// app-views15.js: A1_ANALYTICS_TOGGLES
const viewSrc = src(path.join('public', 'app-views15.js'));
const viewArr = /var A1_ANALYTICS_TOGGLES = \[([\s\S]*?)\n\];/.exec(viewSrc);
const viewKeys = viewArr ? Array.from(viewArr[1].matchAll(/\['([a-z_]+)',/g)).map(m => m[1]) : [];
check('app-views15.js: список тумблеров совпадает с ANALYTICS_FIELDS', same(viewKeys, ANALYTICS_FIELDS), viewKeys.join(', '));

// serve.mjs: поле query разрешено к правке
check("serve.mjs: agent1.watch.query разрешён к правке", /'agent1\.watch':\s*\{[\s\S]{0,80}query:\s*\{\s*t:\s*'str'\s*\}/.test(serveSrc), 'query → str');

// validateAnalytics: допустимые, отсутствующие, недопустимые и неизвестные значения
const all = validateAnalytics({ enabled: false, forecast: true });
check('validateAnalytics: отсутствующие ключи берут безопасный дефолт (включено)',
  all.values.lots_all_on_sale === true && all.values.promos === true && all.values.enabled === false && all.values.forecast === true,
  JSON.stringify(all.values));
check('validateAnalytics: отсутствие блока отмечается (analyticsPresent=false)',
  validateAnalytics(undefined).present === false && all.present === true, 'нет блока → present=false, блок есть → present=true');
const bad = validateAnalytics({ forecast: 'нет', promos: true, лишний_ключ: true });
check('validateAnalytics: недопустимое значение попадает в invalid и заменяется дефолтом',
  bad.invalid.length === 1 && bad.values.forecast === true, 'invalid=' + JSON.stringify(bad.invalid) + ', forecast=' + bad.values.forecast);
check('validateAnalytics: неизвестный ключ виден отдельно', bad.unknown.length === 1 && bad.unknown[0] === 'лишний_ключ', JSON.stringify(bad.unknown));
check('validateAnalytics: контракт дефолтов покрывает все поля',
  ANALYTICS_FIELDS.every(k => typeof ANALYTICS_DEFAULTS[k] === 'boolean'), JSON.stringify(ANALYTICS_DEFAULTS));

console.log('Итог: OK ' + ok + ', ПРОВАЛ ' + fail);
process.exit(fail === 0 ? 0 : 1);

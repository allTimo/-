// Тонкие настройки агентов: читаем registry/agent-settings/<agent-id>.yaml
import fs from 'node:fs';
import path from 'node:path';
import { parseYaml } from './yaml.mjs';
import { AGENT_SETTINGS_DIR } from './paths.mjs';

const DIR = AGENT_SETTINGS_DIR;

// ТУМБЛЕРЫ АНАЛИТИКИ АГЕНТА 1 (agent1.analytics.*).
// Контракт имён зафиксирован Lead (WP1/WP2/WP3): панель, движок и валидатор
// обязаны понимать один и тот же список. Менять список можно только всем трём сразу.
// Дублируется в: dashboard/serve.mjs (AGENT_SETTINGS_SCHEMA['agent1.analytics']),
// dashboard/verify-data.mjs и в публичной панели (public/app-views15.js).
export const ANALYTICS_FIELDS = [
  'enabled',
  'lots_all_on_sale',
  'price_dynamics',
  'promos',
  'new_promos_only',
  'dedup_promos',
  'developers_sites',
  'forecast',
];

// Умолчание — «включено»: если движок прочитает настройку раньше, чем панель
// создаст блок, аналитика не должна молча выключиться (решение WP2, «безопасный дефолт true»).
export const ANALYTICS_DEFAULTS = {
  enabled: true,
  lots_all_on_sale: true,
  price_dynamics: true,
  promos: true,
  new_promos_only: true,
  dedup_promos: true,
  developers_sites: true,
  forecast: true,
};

// ЧТО АНАЛИЗИРОВАТЬ (Агент 1) — группа agent1.selection.
// Контракт: docs/agent-1-marketing-settings-contract.md, группа 2.
// Дублируется в: serve.mjs (AGENT_SETTINGS_SCHEMA['agent1.selection'],
// SETTINGS_BLOCK_DEFAULTS), dashboard/verify-data.mjs, публичной панели
// (public/app-views12.js/13.js). Менять список можно только всем сразу.
export const SELECTION_FIELDS = [
  'room_types',
  'area_min_m2',
  'area_max_m2',
  'price_min_rub',
  'price_max_rub',
  'exclude_first_floor',
  'exclude_last_floor',
  'finishes',
  'only_active',
  'promo_only',
  'price_metric',
  'outlier_guard',
  'outlier_same_price_min_lots',
  'outlier_ppm2_min',
  'outlier_ppm2_max',
];

// Дефолты контракта. Пустое ограничение = 0 (без ограничения) — НЕ «данных нет»:
// так решил контракт, и это же значение показывает панель.
export const SELECTION_DEFAULTS = {
  room_types: ['0', '1', '2', '3', '4', '5+'],
  area_min_m2: 0,
  area_max_m2: 0,
  price_min_rub: 0,
  price_max_rub: 0,
  exclude_first_floor: false,
  exclude_last_floor: false,
  finishes: ['без отделки', 'white box', 'чистовая', 'с мебелью', 'unknown'],
  only_active: true,
  promo_only: false,
  price_metric: 'median',
  outlier_guard: true,
  outlier_same_price_min_lots: 5,
  outlier_ppm2_min: 150000,
  outlier_ppm2_max: 800000,
};

// Типы и допустимые значения — те же, что в AGENT_SETTINGS_SCHEMA панели.
export const SELECTION_SPEC = {
  room_types: { kind: 'list', values: ['0', '1', '2', '3', '4', '5+'] },
  area_min_m2: { kind: 'num', min: 0, max: 400 },
  area_max_m2: { kind: 'num', min: 0, max: 400 },
  price_min_rub: { kind: 'int', min: 0, max: 1000000000 },
  price_max_rub: { kind: 'int', min: 0, max: 1000000000 },
  exclude_first_floor: { kind: 'bool' },
  exclude_last_floor: { kind: 'bool' },
  finishes: { kind: 'list', values: ['без отделки', 'white box', 'чистовая', 'с мебелью', 'unknown'] },
  only_active: { kind: 'bool' },
  promo_only: { kind: 'bool' },
  price_metric: { kind: 'enum', values: ['median', 'mean', 'min_max'] },
  outlier_guard: { kind: 'bool' },
  outlier_same_price_min_lots: { kind: 'int', min: 2, max: 50 },
  outlier_ppm2_min: { kind: 'int', min: 0, max: 10000000 },
  outlier_ppm2_max: { kind: 'int', min: 0, max: 10000000 },
};

// Нормализация agent1.selection ровно по контракту: значение + present + invalid + unknown.
// Недопустимое значение не подменяется молча: в values уходит дефолт, а в invalid — причина,
// чтобы панель честно написала «показано значение по умолчанию».
export function validateSelection(raw) {
  const out = { values: {}, present: false, invalid: [], unknown: [] };
  const has = raw !== null && raw !== undefined && typeof raw === 'object' && !Array.isArray(raw);
  out.present = has;
  SELECTION_FIELDS.forEach(function (k) {
    const spec = SELECTION_SPEC[k];
    const v = has ? raw[k] : undefined;
    if (spec.kind === 'bool') {
      if (typeof v === 'boolean') { out.values[k] = v; return; }
    } else if (spec.kind === 'int' || spec.kind === 'num') {
      if (v !== undefined && v !== null && v !== '' && isFinite(Number(v))) {
        const n = Number(v);
        const intOk = spec.kind !== 'int' || Math.round(n) === n;
        const rangeOk = n >= spec.min && n <= spec.max;
        if (intOk && rangeOk) { out.values[k] = n; return; }
        if (has) out.invalid.push(k + '=' + JSON.stringify(v));
      }
    } else if (spec.kind === 'enum') {
      const s = v === undefined || v === null ? '' : String(v);
      if (spec.values.indexOf(s) >= 0) { out.values[k] = s; return; }
    } else if (spec.kind === 'list') {
      if (Array.isArray(v)) {
        // Числовые элементы приводим к строкам: в YAML 0 и "0" — одно и то же значение.
        const arr = v.map(function (x) { return String(x).trim(); }).filter(function (x) { return x !== ''; });
        const bad = arr.filter(function (x) { return spec.values.indexOf(x) < 0; });
        if (bad.length === 0) { out.values[k] = arr; return; }
        if (has) out.invalid.push(k + '=[' + bad.join(', ') + ']');
      }
    }
    out.values[k] = SELECTION_DEFAULTS[k];
    if (has && v !== undefined) {
      const already = out.invalid.some(function (x) { return x.indexOf(k + '=') === 0; });
      if (!already) out.invalid.push(k + '=' + JSON.stringify(v));
    }
  });
  if (has) {
    Object.keys(raw).forEach(function (k) {
      if (SELECTION_FIELDS.indexOf(k) < 0) out.unknown.push(k);
    });
  }
  return out;
}

// Допустимые значения тумблера аналитики: только boolean. Всё остальное — дефект файла,
// о нём честно сообщаем в warnings, а не подставляем молча.
export function validateAnalytics(raw) {
  const out = { values: {}, present: false, invalid: [], unknown: [] };
  const has = raw !== null && raw !== undefined && typeof raw === 'object' && !Array.isArray(raw);
  out.present = has;
  ANALYTICS_FIELDS.forEach(function (k) {
    const v = has ? raw[k] : undefined;
    if (typeof v === 'boolean') { out.values[k] = v; return; }
    out.values[k] = ANALYTICS_DEFAULTS[k];
    if (has && v !== undefined) out.invalid.push(k + '=' + JSON.stringify(v));
  });
  if (has) {
    Object.keys(raw).forEach(function (k) {
      if (ANALYTICS_FIELDS.indexOf(k) < 0) out.unknown.push(k);
    });
  }
  return out;
}

export function loadAgentSettings(warnings) {
  const out = { byAgent: {}, files: [], dir: DIR, exists: false, counts: {}, warnings: [] };
  if (!fs.existsSync(DIR)) {
    warnings.push('registry/agent-settings не найден — тонкие настройки агентов недоступны');
    return out;
  }
  out.exists = true;
  const names = fs.readdirSync(DIR).filter(function (n) { return /\.ya?ml$/.test(n); }).sort();
  names.forEach(function (n) {
    const full = path.join(DIR, n);
    let doc = null;
    try { doc = parseYaml(fs.readFileSync(full, 'utf8')); }
    catch (e) { warnings.push('agent-settings/' + n + ': ошибка разбора — ' + e.message); return; }
    const agentId = doc.agent !== undefined ? String(doc.agent) : n.replace(/\.ya?ml$/, '');
    // agent1: нормализуем analytics (тумблеры) и watch.query (одно поле ввода),
    // чтобы панель и валидатор видели одинаковые значения и знали, откуда они.
    let agent1 = doc.agent1 ? Object.assign({}, doc.agent1) : null;
    if (agent1) {
      const av = validateAnalytics(doc.agent1.analytics);
      agent1.analytics = av.values;
      agent1.analyticsPresent = av.present;
      agent1.analyticsInvalid = av.invalid;
      agent1.analyticsUnknown = av.unknown;
      const w = (doc.agent1.watch && typeof doc.agent1.watch === 'object') ? doc.agent1.watch : {};
      const q = typeof w.query === 'string' ? w.query.trim() : '';
      agent1.watch = Object.assign({}, w, { query: q === '' ? null : q, queryPresent: q !== '' });
      // «Что анализировать» (agent1.selection): значения, признак наличия блока,
      // недопустимые значения и неизвестные ключи — ровно как у analytics.
      const sv = validateSelection(doc.agent1.selection);
      agent1.selection = sv.values;
      agent1.selectionPresent = sv.present;
      agent1.selectionInvalid = sv.invalid;
      agent1.selectionUnknown = sv.unknown;
      agent1.competitorDomains = doc.agent1.competitor_domains || {};
      if (sv.invalid.length) {
        warnings.push('agent-settings/' + n + ': agent1.selection — недопустимые значения (' + sv.invalid.join(', ') + '); показаны значения по умолчанию');
      }
      if (sv.unknown.length) {
        warnings.push('agent-settings/' + n + ': agent1.selection — неизвестные ключи (' + sv.unknown.join(', ') + '); панель их не показывает');
      }
      if (av.invalid.length) {
        warnings.push('agent-settings/' + n + ': agent1.analytics — недопустимые значения (' + av.invalid.join(', ') + '); показаны значения по умолчанию');
      }
      if (av.unknown.length) {
        warnings.push('agent-settings/' + n + ': agent1.analytics — неизвестные ключи (' + av.unknown.join(', ') + '); панель их не показывает');
      }
    }
    const rec = {
      agent: agentId,
      file: full,
      fileName: n,
      updated: doc.updated !== undefined ? String(doc.updated) : null,
      status: doc.status !== undefined ? String(doc.status) : 'active',
      note: doc.note !== undefined ? String(doc.note) : null,
      schedule: doc.schedule || null,
      model: doc.model || null,
      priority: doc.priority || null,
      report: doc.report || null,
      delivery: doc.delivery || null,
      alerts: doc.alerts || null,
      limits: doc.limits || null,
      agent1: agent1,
      sourceAgent: doc.source_agent || null,
      editable: String(doc.status || 'active') !== 'stub',
    };
    out.byAgent[agentId] = rec;
    out.files.push({ agent: agentId, fileName: n, bytes: fs.statSync(full).size });
  });
  out.counts = { files: out.files.length, agents: Object.keys(out.byAgent).length, stub: Object.keys(out.byAgent).filter(function (k) { return !out.byAgent[k].editable; }).length };
  let newest = 0;
  out.files.forEach(function (f) {
    try { const st = fs.statSync(path.join(DIR, f.fileName)); if (st.mtimeMs > newest) newest = st.mtimeMs; } catch (e) { /* ignore */ }
  });
  out.newestMtimeMs = newest || null;
  // Справочник для интерфейса и валидатора: какие поля тумблеров и какое умолчание.
  out.analyticsContract = { fields: ANALYTICS_FIELDS, defaults: ANALYTICS_DEFAULTS };
  // И то же для «Что анализировать»: verify-data сверяет этот список
  // со схемой панели (serve.mjs) — расхождение обязано ловиться.
  out.selectionContract = { fields: SELECTION_FIELDS, defaults: SELECTION_DEFAULTS, spec: SELECTION_SPEC };
  return out;
}

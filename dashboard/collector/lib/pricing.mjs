// Model prices. THE ONLY source of truth is registry/prices.yaml (schema prices/v1,
// written by T11). There is deliberately NO fallback price file: two price cards with
// different numbers would silently change every ruble figure in the dashboard.
// Nothing is invented: a model without a published price is reported as
// 'цена неизвестна' all the way to the UI.
//
// The registry card is RUB-native (rub_per_1m_in/out/cache_read) with a USD mirror,
// so we bill in rubles directly and derive USD from rate.usd_rub.
import fs from 'node:fs';
import path from 'node:path';
import { parseYaml } from './yaml.mjs';
import { REGISTRY_DIR, CONFIG_DIR } from './paths.mjs';

const REGISTRY_PRICES = path.join(REGISTRY_DIR, 'prices.yaml');
// Never used as a price source. If it exists, it is a mistake and we say so loudly.
const STALE_LOCAL_PRICES = path.join(CONFIG_DIR, 'prices.yaml');
const EXAMPLE_PRICES = path.join(CONFIG_DIR, 'prices.example.yaml');

const IN_USD = ['usd_per_1m_in', 'usd_per_1m_input', 'usd_per_1m_uncached_input', 'input_usd_per_1m', 'prompt'];
const OUT_USD = ['usd_per_1m_out', 'usd_per_1m_output', 'output_usd_per_1m', 'completion'];
const CACHE_USD = ['usd_per_1m_cache_read', 'usd_per_1m_cacheread', 'cached_input'];
const IN_RUB = ['rub_per_1m_in', 'rub_per_1m_input', 'rub_per_1m_uncached_input', 'input_rub_per_1m'];
const OUT_RUB = ['rub_per_1m_out', 'rub_per_1m_output', 'output_rub_per_1m'];
const CACHE_RUB = ['rub_per_1m_cache_read', 'rub_per_1m_cacheread'];
const RATE_KEYS = ['usd_rub', 'usdrub', 'usd_rub_rate', 'rub_per_usd', 'currency_rate'];

function pick(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of keys) {
    for (const own of Object.keys(obj)) {
      if (own.toLowerCase() === k) {
        const v = obj[own];
        if (typeof v === 'number') return v;
        if (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))) return Number(v);
      }
    }
  }
  return null;
}

function pickRaw(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of keys) {
    for (const own of Object.keys(obj)) if (own.toLowerCase() === k) return obj[own];
  }
  return undefined;
}

function pickText(obj, keys) {
  const v = pickRaw(obj, keys);
  return typeof v === 'string' ? v : null;
}

function pickBool(obj, keys) {
  const v = pickRaw(obj, keys);
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.toLowerCase() === 'true';
  return null;
}

function normalizeModelEntry(id, raw) {
  const e = { id: id, inUsd: null, outUsd: null, cacheUsd: null, inRub: null, outRub: null, cacheRub: null, cachePricePublished: true, acceptsImages: null, contextTokens: null, typicalTurnRub: null, source: null, note: null };
  if (raw === null || raw === undefined) return e;
  if (typeof raw === 'number') { e.inUsd = raw; return e; }
  if (typeof raw !== 'object') return e;
  e.inUsd = pick(raw, IN_USD);
  e.outUsd = pick(raw, OUT_USD);
  e.cacheUsd = pick(raw, CACHE_USD);
  e.inRub = pick(raw, IN_RUB);
  e.outRub = pick(raw, OUT_RUB);
  e.cacheRub = pick(raw, CACHE_RUB);
  e.acceptsImages = pickBool(raw, ['accepts_images', 'vision', 'images']);
  e.contextTokens = pick(raw, ['context_tokens', 'context']);
  e.typicalTurnRub = pick(raw, ['rub_per_typical_turn_100k_in_20k_out', 'typical_turn_rub']);
  e.source = pickText(raw, ['source']);
  e.note = pickText(raw, ['note', 'comment']);
  const hasCache = (e.cacheUsd !== null && e.cacheUsd !== undefined) || (e.cacheRub !== null && e.cacheRub !== undefined);
  e.cachePricePublished = hasCache;
  if (!hasCache) {
    // No published cache-read tariff: bill cached input at the input tariff (upper estimate).
    e.cacheUsd = e.inUsd;
    e.cacheRub = e.inRub;
  }
  return e;
}

function collectModelEntries(doc, into, warnings, where) {
  if (!doc || typeof doc !== 'object') return;
  const containers = [];
  for (const key of Object.keys(doc)) {
    const lk = key.toLowerCase();
    if (lk === 'models' || lk === 'prices' || lk === 'model_prices' || lk === 'modelprices') containers.push(doc[key]);
  }
  if (containers.length === 0) containers.push(doc);
  for (const container of containers) {
    if (Array.isArray(container)) {
      for (const item of container) {
        if (!item || typeof item !== 'object') continue;
        let id = item.id !== undefined ? item.id : (item.model !== undefined ? item.model : item.name);
        if (id === undefined || id === null) continue;
        id = String(id);
        into[id] = normalizeModelEntry(id, item);
      }
    } else if (container && typeof container === 'object') {
      for (const key of Object.keys(container)) {
        const val = container[key];
        if (val === null || typeof val !== 'object') {
          if (typeof val === 'number') into[key] = normalizeModelEntry(key, val);
          continue;
        }
        const id = (val.id !== undefined && val.id !== null) ? String(val.id)
          : (val.model !== undefined && val.model !== null) ? String(val.model) : key;
        into[id] = normalizeModelEntry(id, val);
      }
    } else {
      warnings.push('prices: не удалось разобрать блок моделей в ' + where);
    }
  }
}

function parseWindows(list) {
  const out = [];
  if (!Array.isArray(list)) return out;
  for (const item of list) {
    const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(String(item).trim());
    if (m) out.push([Number(m[1]) * 60 + Number(m[2]), Number(m[3]) * 60 + Number(m[4])]);
  }
  return out;
}

export function loadPrices() {
  const warnings = [];
  let source = 'none';
  let filePath = null;
  let doc = null;

  if (fs.existsSync(REGISTRY_PRICES)) { filePath = REGISTRY_PRICES; source = 'registry'; }

  if (filePath) {
    try { doc = parseYaml(fs.readFileSync(filePath, 'utf8')); }
    catch (e) { warnings.push('prices: не удалось прочитать ' + filePath + ' (' + e.message + ')'); doc = null; }
  } else {
    warnings.push('registry/prices.yaml не найден — расход в рублях недоступен, все модели помечены «цена неизвестна». Прайс кладётся ТОЛЬКО в registry/prices.yaml (схема prices/v1, образец схемы: dashboard/config/prices.example.yaml)');
  }
  if (fs.existsSync(STALE_LOCAL_PRICES)) {
    warnings.push('dashboard/config/prices.yaml найден, но ИГНОРИРУЕТСЯ: единственный источник цен — registry/prices.yaml. Удалите локальный файл, иначе легко получить два разных прайса и разъехавшиеся суммы в рублях.');
  }

  let usdRub = null;
  let usdRubNote = null;
  let rateDate = null;
  let rateSource = null;
  const models = {};
  let peakMultiplier = 1;
  let peakWindows = [];
  let peakWeekdays = [];
  let peakNote = null;
  let schema = null;
  let fetchedAt = null;
  let priceKind = null;
  let currencyOfSource = null;
  let priceUnit = null;
  let recommendations = null;
  let cardNote = null;

  if (doc && typeof doc === 'object') {
    usdRub = pick(doc, RATE_KEYS);
    const rateBlock = doc.rate && typeof doc.rate === 'object' ? doc.rate : (doc.currency && typeof doc.currency === 'object' ? doc.currency : null);
    if (rateBlock) {
      if (usdRub === null) usdRub = pick(rateBlock, RATE_KEYS);
      rateDate = pickText(rateBlock, ['date', 'fetched_at']);
      rateSource = pickText(rateBlock, ['source', 'note']);
    }
    if (usdRub === null && doc.meta && typeof doc.meta === 'object') usdRub = pick(doc.meta, RATE_KEYS);
    usdRubNote = [rateSource, rateDate].filter(Boolean).join(' ') || pickText(doc, ['rate_note', 'source', 'date']);

    schema = doc.schema !== undefined ? String(doc.schema) : null;
    fetchedAt = doc.fetched_at !== undefined ? String(doc.fetched_at) : (doc.date !== undefined ? String(doc.date) : null);
    priceKind = doc.price_kind !== undefined ? String(doc.price_kind) : null;
    currencyOfSource = doc.currency_of_source !== undefined ? String(doc.currency_of_source) : null;
    priceUnit = doc.price_unit !== undefined ? String(doc.price_unit) : null;
    cardNote = pickText(doc, ['note', 'comment']);
    if (doc.recommendations && typeof doc.recommendations === 'object') recommendations = doc.recommendations;

    const peak = doc.peak && typeof doc.peak === 'object' ? doc.peak : null;
    if (peak) {
      const mult = pick(peak, ['multiplier', 'factor', 'koef']);
      if (mult && mult > 1) peakMultiplier = mult;
      peakWindows = parseWindows(peak.windows_utc || peak.windows || peak.hours_utc);
      const wd = peak.weekdays !== undefined ? peak.weekdays : peak.days;
      if (Array.isArray(wd)) peakWeekdays = wd.map(Number).filter(function (n) { return !isNaN(n); });
      peakNote = pickText(peak, ['note', 'comment']);
    }
    collectModelEntries(doc, models, warnings, filePath);
  }

  const ids = Object.keys(models);
  const usable = ids.filter(function (id) { const m = models[id]; return m.inUsd !== null || m.outUsd !== null || m.inRub !== null || m.outRub !== null; });
  for (const id of ids) {
    if (usable.indexOf(id) === -1) warnings.push('prices: у модели "' + id + '" не распознаны поля цены — считается «цена неизвестна»');
  }
  if (filePath && usable.length === 0) warnings.push('prices: в ' + filePath + ' не найдено ни одной распознанной цены');
  if (usable.length > 0 && usdRub === null) warnings.push('prices: не найден курс usd_rub — расход будет показан только в долларах');

  const noCachePrice = usable.filter(function (id) { return models[id].cachePricePublished === false; });
  if (noCachePrice.length > 0) {
    warnings.push('prices: для ' + noCachePrice.length + ' моделей не опубликована цена чтения из кэша (' + noCachePrice.slice(0, 3).join(', ') + ') — кэш считается по цене входа, это ОЦЕНКА СВЕРХУ');
  }

  return {
    source: source, path: filePath, found: filePath !== null,
    usdRub: usdRub, usdRubNote: usdRubNote, rateDate: rateDate, rateSource: rateSource,
    cardNote: cardNote, schema: schema, fetchedAt: fetchedAt, priceKind: priceKind,
    currencyOfSource: currencyOfSource, priceUnit: priceUnit,
    peakMultiplier: peakMultiplier, peakWindowsUtc: peakWindows, peakWeekdays: peakWeekdays, peakNote: peakNote,
    models: models, modelCount: usable.length, recommendations: recommendations,
    cachePriceAssumedFor: noCachePrice,
    warnings: warnings,
  };
}

// Tolerant model-id lookup: exact -> case-insensitive -> without provider prefix.
export function lookupPrice(prices, modelId) {
  if (!prices || !modelId) return null;
  const models = prices.models;
  if (models[modelId]) return models[modelId];
  const lower = String(modelId).toLowerCase();
  const keys = Object.keys(models);
  for (const k of keys) if (k.toLowerCase() === lower) return models[k];
  const short = lower.indexOf('/') >= 0 ? lower.slice(lower.indexOf('/') + 1) : lower;
  for (const k of keys) {
    const kl = k.toLowerCase();
    const ks = kl.indexOf('/') >= 0 ? kl.slice(kl.indexOf('/') + 1) : kl;
    if (ks === short) return models[k];
  }
  return null;
}

export function isPeak(ms, prices) {
  if (!prices || !prices.peakMultiplier || prices.peakMultiplier <= 1) return false;
  const windows = prices.peakWindowsUtc;
  if (!windows || windows.length === 0) return false;
  const d = new Date(Number(ms));
  if (isNaN(d.getTime())) return false;
  const iso = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  if (prices.peakWeekdays && prices.peakWeekdays.length > 0 && prices.peakWeekdays.indexOf(iso) === -1) return false;
  const minutes = d.getUTCHours() * 60 + d.getUTCMinutes();
  for (const w of windows) if (minutes >= w[0] && minutes < w[1]) return true;
  return false;
}

function zero() { return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }; }

export function costOf(prices, modelId, tokens, tokensPeak) {
  const price = lookupPrice(prices, modelId);
  const t = tokens || {};
  const out = { usd: null, usdPeak: 0, usdOffPeak: 0, rub: null, priceKnown: false, model: modelId, price: price || null, cachePriceAssumed: false };
  if (!price) return out;
  const hasRub = price.inRub !== null || price.outRub !== null;
  const hasUsd = price.inUsd !== null || price.outUsd !== null;
  if (!hasRub && !hasUsd) return out;
  out.cachePriceAssumed = price.cachePricePublished === false;

  const inRub = price.inRub !== null ? price.inRub : (hasRub ? 0 : null);
  const outRub = price.outRub !== null ? price.outRub : 0;
  const cacheRub = price.cacheRub !== null ? price.cacheRub : inRub;
  const inUsd = price.inUsd !== null ? price.inUsd : 0;
  const outUsd = price.outUsd !== null ? price.outUsd : 0;
  const cacheUsd = price.cacheUsd !== null ? price.cacheUsd : inUsd;

  const mult = prices && prices.peakMultiplier > 1 ? prices.peakMultiplier : 1;
  const pk = tokensPeak ? {
    inputTokens: Math.max(0, Number(tokensPeak.inputTokens || 0)),
    outputTokens: Math.max(0, Number(tokensPeak.outputTokens || 0)),
    cacheReadTokens: Math.max(0, Number(tokensPeak.cacheReadTokens || 0)),
  } : zero();
  const hasPeak = mult > 1 && (pk.inputTokens + pk.outputTokens + pk.cacheReadTokens) > 0;

  function amount(x, kind) {
    const i = Number(x.inputTokens || 0) / 1e6;
    const o = Number(x.outputTokens || 0) / 1e6;
    const c = Number(x.cacheReadTokens || 0) / 1e6;
    if (kind === 'rub') return i * (inRub || 0) + o * outRub + c * cacheRub;
    return i * inUsd + o * outUsd + c * cacheUsd;
  }
  const kind = hasRub ? 'rub' : 'usd';
  let value;
  if (hasPeak) {
    const off = {
      inputTokens: Math.max(0, Number(t.inputTokens || 0) - pk.inputTokens),
      outputTokens: Math.max(0, Number(t.outputTokens || 0) - pk.outputTokens),
      cacheReadTokens: Math.max(0, Number(t.cacheReadTokens || 0) - pk.cacheReadTokens),
    };
    out.usdOffPeak = amount(off, kind);
    out.usdPeak = amount(pk, kind) * mult;
    value = out.usdOffPeak + out.usdPeak;
  } else {
    out.usdOffPeak = amount(t, kind);
    value = out.usdOffPeak;
  }
  out.priceKnown = true;
  const rate = prices && typeof prices.usdRub === 'number' && prices.usdRub > 0 ? prices.usdRub : null;
  if (kind === 'rub') {
    out.rub = value;
    out.usd = rate ? value / rate : (hasUsd ? amount(t, 'usd') : null);
  } else {
    out.usd = value;
    out.rub = rate ? value * rate : null;
  }
  return out;
}

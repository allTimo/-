// Раздел «Реклама и кэшбэк»: бюджеты, расходы, вознаграждение за ведение.
import fs from 'node:fs';
import path from 'node:path';
import { parseYaml } from './yaml.mjs';
import { REGISTRY_DIR } from './paths.mjs';

const CHANNELS_FILE = path.join(REGISTRY_DIR, 'ad-channels.yaml');
const BUDGETS_FILE = path.join(REGISTRY_DIR, 'ad-budgets.yaml');
const CASHBACK_FILE = path.join(REGISTRY_DIR, 'cashback.yaml');
const OPERATORS_FILE = path.join(REGISTRY_DIR, 'operators.yaml');
const CLIENTS_FILE = path.join(REGISTRY_DIR, 'clients.yaml');

const MODE_LABEL = {
  'client-pays': 'клиент платит площадке сам',
  'through-service': 'бюджет через сервис',
};
const SOURCE_LABEL = { api: 'по API', export: 'импорт выгрузки', manual: 'вручную' };
const ACC_STATUS_LABEL = { 'начислено': 'начислено', 'ожидает': 'ожидает', 'выплачено': 'выплачено' };

function asArray(v) { return Array.isArray(v) ? v : (v === null || v === undefined ? [] : [v]); }
function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }
function r2(v) { return Math.round(v * 100) / 100; }

export function readAdsDoc(warnings) {
  function read(file, label) {
    if (!fs.existsSync(file)) { warnings.push(label + ': файл не найден — ' + file); return null; }
    try { return parseYaml(fs.readFileSync(file, 'utf8')); }
    catch (e) { warnings.push(label + ': ошибка разбора — ' + e.message); return null; }
  }
  return {
    channels: read(CHANNELS_FILE, 'registry/ad-channels.yaml'),
    budgets: read(BUDGETS_FILE, 'registry/ad-budgets.yaml'),
    cashback: read(CASHBACK_FILE, 'registry/cashback.yaml'),
    operators: read(OPERATORS_FILE, 'registry/operators.yaml'),
    clientsRaw: read(CLIENTS_FILE, 'registry/clients.yaml'),
    files: { channels: CHANNELS_FILE, budgets: BUDGETS_FILE, cashback: CASHBACK_FILE, operators: OPERATORS_FILE },
  };
}

export function buildAdsDoc(ctx) {
  const warnings = [];
  const raw = readAdsDoc(warnings);
  const clients = (ctx.clients || []);
  const clientName = {};
  clients.forEach(function (c) { clientName[c.id] = c.name; });
  function cname(id) { return clientName[id] || id; }

  // ---------- ТРЁХУРОВНЕВАЯ МОДЕЛЬ: платформа -> оператор -> клиент оператора ----------
  const opDoc = raw.operators || {};
  const opSettings = opDoc.settings || {};
  const commissionPct = num(opSettings.platform_commission_pct) || 0;
  const ipoRegistered = opSettings.ipo_registered === true;

  const operators = asArray(opDoc.operators).filter(function (o) { return o && o.id; }).map(function (o) {
    return {
      id: String(o.id),
      name: o.name !== undefined ? String(o.name) : String(o.id),
      contact: o.contact !== undefined ? String(o.contact) : null,
      cashbackPct: num(o.cashback_pct),
      status: o.status !== undefined ? String(o.status) : 'active',
      statusLabel: o.status === 'active' ? 'активен' : (o.status === 'paused' ? 'на паузе' : String(o.status)),
      contract: o.contract !== undefined ? String(o.contract) : null,
    };
  });
  const opById = {};
  operators.forEach(function (o) { opById[o.id] = o; });

  // связь клиента с оператором — из registry/clients.yaml (поле operator_id)
  const clientOperator = {};
  asArray((raw.clientsRaw || {}).clients).forEach(function (c) {
    if (c && c.id) clientOperator[String(c.id)] = c.operator_id !== undefined && c.operator_id !== null ? String(c.operator_id) : null;
  });

  const chDoc = raw.channels || {};
  const settings = chDoc.settings || {};
  const defaultRate = num(settings.default_rate_pct) || 10;
  const threshold = num(settings.low_balance_threshold_rub) || 0;
  const rounding = settings.rounding !== undefined ? String(settings.rounding) : 'до копейки, половина вверх';

  const channels = asArray(chDoc.channels).filter(function (c) { return c && c.id; }).map(function (c) {
    return {
      id: String(c.id),
      name: c.name !== undefined ? String(c.name) : String(c.id),
      status: c.status !== undefined ? String(c.status) : 'active',
      source: c.source !== undefined ? String(c.source) : 'manual',
      sourceLabel: SOURCE_LABEL[c.source] || String(c.source || 'вручную'),
      ratePct: num(c.rate_pct) || defaultRate,
      fixedRub: num(c.fixed_rub),
      note: c.note !== undefined ? String(c.note) : null,
      urgentNote: (c.source === 'manual' || c.source === 'export') ? 'расходы вносятся вручную или импортом' : null,
      returnPct: num(c.return_pct),
      agreement: c.agreement === true,
      returnNote: c.agreement === true ? ('возврат ' + num(c.return_pct) + '% по договору') : 'партнёрского договора нет: возврат 0%',
    };
  });
  const chById = {};
  channels.forEach(function (c) { chById[c.id] = c; });

  const bDoc = raw.budgets || {};
  const topups = asArray(bDoc.topups).filter(function (t) { return t && t.id; }).map(function (t) {
    return { id: String(t.id), client: String(t.client), channel: String(t.channel), date: String(t.date || ''), amountRub: num(t.amount_rub), by: t.by !== undefined ? String(t.by) : null, kind: 'topup' };
  });
  const spends = asArray(bDoc.spends).filter(function (s) { return s && s.id; }).map(function (s) {
    return { id: String(s.id), client: String(s.client), channel: String(s.channel), date: String(s.date || ''), amountRub: num(s.amount_rub), period: s.period !== undefined ? String(s.period) : null, kind: 'spend' };
  });
  // ВОЗВРАТ ОТ ПЛОЩАДКИ (факт) и ОТСРОЧКА ПЛАТЕЖА (учёт).
  const returns = asArray(bDoc.returns).filter(function (r) { return r && r.client; }).map(function (r) {
    return { id: r.id !== undefined ? String(r.id) : null, client: String(r.client), channel: String(r.channel), period: r.period !== undefined ? String(r.period) : null, amountRub: num(r.amount_rub), note: r.note !== undefined ? String(r.note) : null };
  });
  const deferred = asArray(bDoc.deferred).filter(function (d) { return d && d.client; }).map(function (d) {
    const days = num(d.days);
    const since = d.since !== undefined && d.since !== null ? String(d.since) : null;
    let dueDate = null;
    if (since && days) {
      const dt = new Date(since + 'T00:00:00Z');
      dt.setUTCDate(dt.getUTCDate() + days);
      dueDate = dt.toISOString().slice(0, 10);
    }
    const todayD = new Date(ctx.today + 'T00:00:00Z');
    const dueD = dueDate ? new Date(dueDate + 'T00:00:00Z') : null;
    const daysLeft = dueD ? Math.round((dueD - todayD) / 86400000) : null;
    return { client: String(d.client), days: days, since: since, dueDate: dueDate, daysLeft: daysLeft, overdue: daysLeft !== null && daysLeft < 0, note: d.note !== undefined ? String(d.note) : null };
  });

  const rateOverrides = asArray(bDoc.rates).filter(function (r) { return r && r.id; }).map(function (r) {
    return { id: String(r.id), client: String(r.client), channel: String(r.channel), ratePct: num(r.rate_pct), fixedRub: num(r.fixed_rub), since: r.since !== undefined ? String(r.since) : null, reason: r.reason !== undefined ? String(r.reason) : null };
  });
  // режим по клиенту и каналу: считаем «through-service», если он задан хотя бы раз в комментарии-поле mode
  const modes = asArray(bDoc.modes).filter(function (m) { return m && m.client; }).map(function (m) {
    return { client: String(m.client), channel: m.channel !== undefined && m.channel !== null ? String(m.channel) : null, mode: String(m.mode || 'client-pays'), since: m.since !== undefined && m.since !== null ? String(m.since) : null, reason: m.reason !== undefined && m.reason !== null ? String(m.reason) : null };
  });

  function overrideFor(clientId, channelId) {
    const exact = rateOverrides.filter(function (r) { return r.client === clientId && r.channel === channelId; })[0];
    if (exact) return exact;
    return null;
  }
  // Берём ПОСЛЕДНЮЮ запись: новые режимы дописываются в конец, история сохраняется.
  function modeFor(clientId, channelId) {
    const exact = modes.filter(function (m) { return m.client === clientId && m.channel === channelId; });
    if (exact.length) return exact[exact.length - 1].mode;
    const byClient = modes.filter(function (m) { return m.client === clientId && !m.channel; });
    return byClient.length ? byClient[byClient.length - 1].mode : 'client-pays';
  }

  // --- агрегаты по каналам и клиентам ---
  const chAgg = {};
  channels.forEach(function (c) { chAgg[c.id] = { id: c.id, name: c.name, spend: 0, topup: 0, balance: 0, cashback: 0, clients: {} }; });
  topups.forEach(function (t) { if (chAgg[t.channel]) { chAgg[t.channel].topup = r2(chAgg[t.channel].topup + t.amountRub); } });
  spends.forEach(function (s) { if (chAgg[s.channel]) { chAgg[s.channel].spend = r2(chAgg[s.channel].spend + s.amountRub); } });

  const clientAgg = {};
  clients.forEach(function (c) {
    clientAgg[c.id] = { id: c.id, name: c.name, topup: 0, spend: 0, balance: 0, cashback: 0, paid: 0, mode: modeFor(c.id, null), modeLabel: MODE_LABEL[modeFor(c.id, null)], channels: {}, low: false };
  });

  topups.forEach(function (t) {
    if (clientAgg[t.client]) { clientAgg[t.client].topup = r2(clientAgg[t.client].topup + t.amountRub); }
    if (chAgg[t.channel]) { chAgg[t.channel].clients[t.client] = true; }
  });
  spends.forEach(function (s) {
    if (clientAgg[s.client]) { clientAgg[s.client].spend = r2(clientAgg[s.client].spend + s.amountRub); }
    const key = s.client + '|' + s.channel;
    clientAgg[s.client] && (clientAgg[s.client].channels[s.channel] = r2(((clientAgg[s.client].channels[s.channel]) || 0) + s.amountRub));
  });

  // --- кэшбэк ---
  const accDoc = raw.cashback || {};
  const accruals = asArray(accDoc.accruals).filter(function (a) { return a && a.id; }).map(function (a) {
    const base = num(a.base_rub);
    const rate = num(a.rate_pct);
    const fixed = num(a.fixed_rub);
    const expected = r2(base * rate / 100 + fixed);
    const stored = num(a.amount_rub);
    return {
      id: String(a.id), client: String(a.client), clientName: cname(String(a.client)), channel: String(a.channel),
      channelName: chById[String(a.channel)] ? chById[String(a.channel)].name : String(a.channel),
      period: a.period !== undefined ? String(a.period) : null,
      baseRub: base, ratePct: rate, fixedRub: fixed,
      amountRub: stored,
      expectedRub: expected,
      formulaOk: Math.abs(expected - stored) < 0.01,
      formula: (base + ' × ' + rate + '%' + (fixed ? ' + ' + fixed + ' ₽' : '') + ' = ' + stored + ' ₽'),
      status: a.status !== undefined ? String(a.status) : 'начислено',
      statusLabel: ACC_STATUS_LABEL[a.status] || String(a.status || 'начислено'),
      doc: a.doc !== undefined && a.doc !== null ? String(a.doc) : null,
    };
  });
  const payouts = asArray(accDoc.payouts).filter(function (p) { return p && p.id; }).map(function (p) {
    return {
      id: String(p.id), client: String(p.client), clientName: cname(String(p.client)),
      date: p.date !== undefined ? String(p.date) : null,
      amountRub: num(p.amount_rub),
      method: p.method !== undefined ? String(p.method) : null,
      status: p.status !== undefined ? String(p.status) : 'ожидает',
      statusLabel: ACC_STATUS_LABEL[p.status] || String(p.status || 'ожидает'),
      doc: p.doc !== undefined && p.doc !== null ? String(p.doc) : null,
    };
  });

  accruals.forEach(function (a) {
    if (clientAgg[a.client]) clientAgg[a.client].cashback = r2(clientAgg[a.client].cashback + a.amountRub);
    if (chAgg[a.channel]) chAgg[a.channel].cashback = r2(chAgg[a.channel].cashback + a.amountRub);
  });
  payouts.forEach(function (p) { if (clientAgg[p.client]) clientAgg[p.client].paid = r2(clientAgg[p.client].paid + p.amountRub); });

  // --- ЕДИНЫЙ КОШЕЛЁК КЛИЕНТА: пополнение -> расход -> возврат -> кэшбэк ---
  // Объявлено функцией, потому что clientRows строится ниже; вызов — после агрегации операторов.
  function computeWallet(c) {
    c.returnRub = r2(returns.filter(function (r) { return r.client === c.id; }).reduce(function (a, r) { return a + r.amountRub; }, 0));
    c.returnExpectedRub = r2(spends.filter(function (s) { return s.client === c.id; }).reduce(function (a, s) {
      const ch = chById[s.channel] || {};
      return a + s.amountRub * (num(ch.returnPct) || 0) / 100;
    }, 0));
    // Сколько платформа ДОЛЖНА оператору за оборот этого клиента (его ставка × оборот клиента).
    const op = c.operatorId && opById[c.operatorId] ? opById[c.operatorId] : null;
    c.operatorRatePct = op ? op.cashbackPct : 0;
    c.operatorName = op ? op.name : c.operatorName;
    c.cashbackDueRub = r2(c.spend * c.operatorRatePct / 100);
    // Кэшбэк платится ИЗ ВОЗВРАТА площадки. Если возврата нет — это убыток платформы.
    c.cashbackFundedRub = r2(Math.min(c.cashbackDueRub, c.returnRub));
    c.cashbackFromReturnRub = r2(c.returnRub * 0.6);
    // маржа платформы по клиенту: возврат − кэшбэк оператору + комиссия за сервис
    c.platformMarginRub = r2(c.returnRub - c.cashbackDueRub + c.commissionRub);
    // ПРЕДОХРАНИТЕЛЬ ОТ УБЫТКА: кэшбэк оператору не покрыт возвратом площадки
    c.lossRub = r2(Math.max(0, c.cashbackDueRub - c.returnRub));
    c.loss = c.lossRub > 0.01;
    const dl = deferred.filter(function (d) { return d.client === c.id; })[0] || null;
    c.deferred = dl;
    c.deferredDays = dl ? dl.days : null;
    c.deferredDue = dl ? dl.dueDate : null;
    c.deferredDaysLeft = dl ? dl.daysLeft : null;
    c.deferredOverdue = dl ? dl.overdue : false;
  }

  const totalReturn = r2(returns.reduce(function (a, r) { return a + r.amountRub; }, 0));
  const wallet = {
    topupRub: 0, spendRub: 0, returnRub: totalReturn, cashbackRub: 0, commissionRub: 0, marginRub: 0, balanceRub: 0,
  };

  const totalTopup = r2(topups.reduce(function (a, t) { return a + t.amountRub; }, 0));
  const totalSpend = r2(spends.reduce(function (a, s) { return a + s.amountRub; }, 0));
  const totalCashback = r2(accruals.reduce(function (a, x) { return a + x.amountRub; }, 0));
  const totalPaid = r2(payouts.filter(function (p) { return p.status === 'выплачено'; }).reduce(function (a, p) { return a + p.amountRub; }, 0));

  const channelRows = Object.keys(chAgg).map(function (id) {
    const c = chAgg[id];
    const ch = chById[id] || {};
    c.balance = r2(c.topup - c.spend);
    c.share = totalSpend > 0 ? c.spend / totalSpend : 0;
    c.ratePct = ch.ratePct !== undefined ? ch.ratePct : defaultRate;
    c.sourceLabel = ch.sourceLabel;
    c.urgentNote = ch.urgentNote;
    c.status = ch.status;
    c.clients = Object.keys(c.clients).length;
    return c;
  }).sort(function (a, b) { return b.spend - a.spend; });

  const clientRows = clients.map(function (c) {
    const a = clientAgg[c.id];
    a.balance = r2(a.topup - a.spend);
    a.low = threshold > 0 && a.balance < threshold && a.topup > 0;
    a.channelList = Object.keys(a.channels).map(function (cid) {
      return { id: cid, name: chById[cid] ? chById[cid].name : cid, spend: a.channels[cid], mode: modeFor(c.id, cid), modeLabel: MODE_LABEL[modeFor(c.id, cid)] };
    });
    a.throughService = a.channelList.some(function (x) { return x.mode === 'through-service'; });
    a.status = a.topup === 0 ? 'нет бюджета' : (a.low ? 'низкий остаток' : 'ок');
    a.effRate = a.spend > 0 ? a.cashback / a.spend : null;
    return a;
  }).filter(function (a) { return a.topup > 0 || a.spend > 0; });

  // --- динамика расхода по каналам по датам (мини-график) ---
  const dates = Array.from(new Set(spends.map(function (s) { return s.date; }))).sort();
  const timeline = dates.map(function (d) {
    const row = { date: d, total: 0 };
    channels.forEach(function (c) { row[c.id] = 0; });
    spends.filter(function (s) { return s.date === d; }).forEach(function (s) { row[s.channel] = r2((row[s.channel] || 0) + s.amountRub); row.total = r2(row.total + s.amountRub); });
    return row;
  });

  const alerts = [];
  clientRows.forEach(function (a) {
    if (a.low) alerts.push({ level: a.balance <= 0 ? 'critical' : 'warning', title: 'Низкий остаток бюджета: ' + a.name, what: 'Остаток ' + a.balance.toFixed(2) + ' ₽ при пороге ' + threshold + ' ₽.', meaning: 'Реклама может остановиться: площадка перестанет показывать объявления.', action: 'Попросить клиента пополнить или перевести на режим «клиент платит сам».', client: a.id });
  });
  clientRows.filter(function (a) { return a.throughService; }).forEach(function (a) {
    alerts.push({ level: 'info', title: 'Агентская схема у клиента ' + a.name, what: 'Бюджет проходит через сервис.', meaning: 'По 422-ФЗ НПД не применяется к агентской деятельности. Нужно ИП или ООО; при НПД выставляйте вознаграждение за ведение.', action: 'Проверить схему и документы до выставления счёта.', client: a.id });
  });
  accruals.filter(function (a) { return !a.formulaOk; }).forEach(function (a) {
    alerts.push({ level: 'critical', title: 'Начисление не сходится с формулой: ' + a.id, what: 'В файле ' + a.amountRub + ' ₽, по формуле ' + a.expectedRub + ' ₽.', meaning: 'В кэшбэке ошибка — пересчитайте или поправьте ставку.', action: 'Открыть cashback.yaml и исправить сумму или ставку.', client: a.client });
  });

  // ---------- ОБОРОТ, КОМИССИЯ ПЛАТФОРМЫ, КЭШБЭК ОПЕРАТОРОВ ----------
  // Оборот — чужие деньги, прошедшие через платформу. Это НЕ доход.
  const turnover = totalSpend;
  // Комиссия за сервис: глобальная ставка, переопределение по клиенту и по каналу.
  const commissions = asArray((raw.budgets || {}).commissions).filter(function (c) { return c; }).map(function (c) {
    return { client: c.client !== undefined && c.client !== null ? String(c.client) : null, channel: c.channel !== undefined && c.channel !== null ? String(c.channel) : null, pct: num(c.pct) };
  });
  function commissionFor(clientId, channelId) {
    const both = commissions.filter(function (c) { return c.client === clientId && c.channel === channelId; });
    if (both.length) return both[both.length - 1].pct;
    const byClient = commissions.filter(function (c) { return c.client === clientId && !c.channel; });
    if (byClient.length) return byClient[byClient.length - 1].pct;
    const byChannel = commissions.filter(function (c) { return !c.client && c.channel === channelId; });
    if (byChannel.length) return byChannel[byChannel.length - 1].pct;
    return commissionPct;
  }

  // кэшбэк операторов: начисления и выплаты
  const opAccruals = asArray((raw.cashback || {}).operator_accruals).filter(function (a) { return a && a.id; }).map(function (a) {
    const base = num(a.base_rub);
    const rate = num(a.rate_pct);
    const expected = r2(base * rate / 100);
    const stored = num(a.amount_rub);
    const op = opById[String(a.operator)];
    return {
      id: String(a.id), operator: String(a.operator), operatorName: op ? op.name : String(a.operator),
      period: a.period !== undefined ? String(a.period) : null,
      baseRub: base, ratePct: rate, amountRub: stored, expectedRub: expected,
      formulaOk: Math.abs(expected - stored) < 0.01,
      formula: base + ' × ' + rate + '% = ' + stored + ' ₽',
      status: a.status !== undefined ? String(a.status) : 'начислено',
      statusLabel: ACC_STATUS_LABEL[a.status] || String(a.status || 'начислено'),
    };
  });
  const opPayouts = asArray((raw.cashback || {}).operator_payouts).filter(function (p) { return p && p.id; }).map(function (p) {
    const op = opById[String(p.operator)];
    return {
      id: String(p.id), operator: String(p.operator), operatorName: op ? op.name : String(p.operator),
      date: p.date !== undefined ? String(p.date) : null, amountRub: num(p.amount_rub),
      method: p.method !== undefined ? String(p.method) : null,
      status: p.status !== undefined ? String(p.status) : 'ожидает',
      statusLabel: ACC_STATUS_LABEL[p.status] || String(p.status || 'ожидает'),
      doc: p.doc !== undefined && p.doc !== null ? String(p.doc) : null,
    };
  });

  // агрегаты по операторам
  const opAgg = {};
  operators.forEach(function (o) { opAgg[o.id] = { id: o.id, name: o.name, ratePct: o.cashbackPct, status: o.status, statusLabel: o.statusLabel, contract: o.contract, clients: [], turnover: 0, commission: 0, cashback: 0, paid: 0, due: 0 }; });
  clientRows.forEach(function (c) {
    const opId = clientOperator[c.id];
    c.operatorId = opId || null;
    c.operatorName = opId && opById[opId] ? opById[opId].name : (opId || null);
    c.commissionPct = commissionFor(c.id, null);
    c.commissionRub = r2(c.spend * c.commissionPct / 100);
    if (opId && opAgg[opId]) {
      opAgg[opId].clients.push(c.id);
      opAgg[opId].turnover = r2(opAgg[opId].turnover + c.spend);
      opAgg[opId].commission = r2(opAgg[opId].commission + c.commissionRub);
      c.operatorCashbackRub = r2(c.spend * (opAgg[opId].ratePct || 0) / 100);
    } else {
      c.operatorCashbackRub = 0;
    }
  });
  opAccruals.forEach(function (a) {
    if (opAgg[a.operator]) opAgg[a.operator].cashback = r2(opAgg[a.operator].cashback + a.amountRub);
  });
  opPayouts.forEach(function (p) {
    if (opAgg[p.operator]) { if (p.status === 'выплачено') opAgg[p.operator].paid = r2(opAgg[p.operator].paid + p.amountRub); }
  });
  const operatorRows = Object.keys(opAgg).map(function (id) {
    const o = opAgg[id];
    o.due = r2(o.cashback - o.paid);
    o.clientsCount = o.clients.length;
    o.hasClients = o.clients.length > 0;
    o.effRate = o.turnover > 0 ? o.cashback / o.turnover : null;
    return o;
  }).sort(function (a, b) { return b.turnover - a.turnover; });

  clientRows.forEach(computeWallet);
  const lossRows = clientRows.filter(function (c) { return c.loss; });
  const totalLoss = r2(lossRows.reduce(function (a, c) { return a + c.lossRub; }, 0));

  const commissionTotal = r2(clientRows.reduce(function (a, c) { return a + c.commissionRub; }, 0));
  const opCashbackTotal = r2(opAccruals.reduce(function (a, x) { return a + x.amountRub; }, 0));
  const opPaidTotal = r2(opPayouts.filter(function (p) { return p.status === 'выплачено'; }).reduce(function (a, p) { return a + p.amountRub; }, 0));
  const platform = {
    commissionPct: commissionPct,
    ipoRegistered: ipoRegistered,
    turnoverRub: turnover,
    commissionRub: commissionTotal,
    operatorsCashbackRub: opCashbackTotal,
    operatorsPaidRub: opPaidTotal,
    operatorsDueRub: r2(opCashbackTotal - opPaidTotal),
    marginRub: r2(commissionTotal - opCashbackTotal),
    marginPct: commissionTotal > 0 ? (commissionTotal - opCashbackTotal) / commissionTotal : null,
    turnoverToCommission: turnover > 0 ? commissionTotal / turnover : null,
    formula: 'оборот ' + turnover + ' ₽ × ' + commissionPct + '% = комиссия ' + commissionTotal + ' ₽',
    legalNote: ipoRegistered
      ? 'ИП оформлен: режим «бюджет через сервис» доступен.'
      : 'ДО РЕГИСТРАЦИИ ИП ЭТОТ РЕЖИМ ИСПОЛЬЗОВАТЬ НЕЛЬЗЯ: НПД не допускает агентскую схему (422-ФЗ). Оформляйте ИП или работайте по схеме «клиент платит площадке сам».',
  };

  // Наполняем кошелёк итогами (после того как clientRows посчитан).
  wallet.topupRub = totalTopup;
  wallet.spendRub = totalSpend;
  wallet.balanceRub = r2(totalTopup - totalSpend);
  wallet.cashbackRub = r2(clientRows.reduce(function (a, c) { return a + c.cashbackDueRub; }, 0));
  wallet.commissionRub = r2(clientRows.reduce(function (a, c) { return a + c.commissionRub; }, 0));
  wallet.marginRub = r2(clientRows.reduce(function (a, c) { return a + c.platformMarginRub; }, 0));
  wallet.returnRub = totalReturn;

  const platformAlerts = [];
  if (!ipoRegistered) platformAlerts.push({ level: 'critical', title: 'ИП ещё не оформлен', what: 'Режим «бюджет через сервис» — агентский.', meaning: 'По 422-ФЗ НПД не применяется к агентской деятельности: до регистрации ИП этот режим использовать нельзя.', action: 'Оформить ИП либо перевести клиентов на схему «клиент платит площадке сам».', client: null });
  if (commissionTotal + opCashbackTotal > turnover + 0.01) platformAlerts.push({ level: 'critical', title: 'Комиссия и кэшбэк превышают оборот', what: 'Комиссия ' + commissionTotal + ' ₽ + кэшбэк ' + opCashbackTotal + ' ₽ > оборот ' + turnover + ' ₽.', meaning: 'Платформа платит больше, чем прошло денег — ошибка в ставках.', action: 'Проверить ставки комиссии и кэшбэка операторов.', client: null });

  return {
    generatedAtMs: Date.now(),
    today: ctx.today,
    platform: platform,
    operators: operators,
    operatorRows: operatorRows,
    operatorAccruals: opAccruals,
    operatorPayouts: opPayouts,
    clientOperator: clientOperator,
    defaults: { ratePct: defaultRate, lowBalanceThresholdRub: threshold, rounding: rounding },
    channels: channels,
    channelRows: channelRows,
    clientRows: clientRows,
    topups: topups.sort(function (a, b) { return a.date < b.date ? 1 : -1; }),
    spends: spends.sort(function (a, b) { return a.date < b.date ? 1 : -1; }),
    rateOverrides: rateOverrides,
    modeHistory: modes.slice().sort(function (a, b) { return String(a.since || '') < String(b.since || '') ? 1 : -1; }),
    accruals: accruals,
    payouts: payouts,
    timeline: timeline,
    modes: { 'client-pays': MODE_LABEL['client-pays'], 'through-service': MODE_LABEL['through-service'], legal: 'Прогон бюджета через сервис — агентская схема. По 422-ФЗ НПД к ней не применяется: нужно ИП или ООО. При НПД выставляем вознаграждение за ведение рекламы.' },
    totals: {
      topupRub: totalTopup, spendRub: totalSpend, balanceRub: r2(totalTopup - totalSpend),
      cashbackRub: totalCashback, paidRub: totalPaid, dueRub: r2(totalCashback - totalPaid),
      avgRatePct: totalSpend > 0 ? r2(totalCashback / totalSpend * 100) : null,
      clients: clientRows.length, channels: channels.filter(function (c) { return c.status === 'active'; }).length,
      lowBalance: clientRows.filter(function (a) { return a.low; }).length,
      throughService: clientRows.filter(function (a) { return a.throughService; }).length,
    },
    returns: returns,
    deferred: deferred,
    wallet: wallet,
    risk: { lossClients: lossRows.length, lossRub: totalLoss, rows: lossRows.map(function (c) { return { id: c.id, name: c.name, cashback: c.cashbackDueRub, returnRub: c.returnRub, lossRub: c.lossRub, spend: c.spend, operatorRatePct: c.operatorRatePct }; }) },
    utp: { text: 'Кэшбэк с любого оборота — без минимального порога', detail: 'Мы не ставим условие «пополнение от 50 000 ₽» и не пишем «до 22% при соблюдении условий»: ставки в панели — наши фактические по договорам с площадками, а кэшбэк считается с первого рубля оборота.' },
    counts: { channels: channels.length, clients: clientRows.length, topups: topups.length, spends: spends.length, accruals: accruals.length, payouts: payouts.length, alerts: alerts.length + platformAlerts.length, operators: operators.length, operatorAccruals: opAccruals.length, operatorPayouts: opPayouts.length, returns: returns.length, deferred: deferred.length, lossClients: lossRows.length },
    alerts: alerts.concat(platformAlerts, lossRows.map(function (c) {
      return { level: 'critical', title: 'УБЫТОК на клиенте: ' + c.name, what: 'Кэшбэк оператору ' + c.cashbackDueRub.toFixed(2) + ' ₽ (оборот ' + c.spend + ' ₽ × ' + c.operatorRatePct + '%) не покрыт возвратом площадки: возврат ' + c.returnRub.toFixed(2) + ' ₽.', meaning: 'На этом клиенте вы теряете ' + c.lossRub.toFixed(2) + ' ₽ своих денег — кэшбэк платится не из возврата, а из вашего кармана.', action: 'Снизить ставку кэшбэка оператору до уровня возврата или заключить партнёрский договор с площадкой.', client: c.id };
    }), deferred.filter(function (d) { return d.daysLeft !== null && d.daysLeft <= 14; }).map(function (d) {
      const cl = clientRows.filter(function (c) { return c.id === d.client; })[0];
      return { level: d.overdue ? 'critical' : 'warning', title: d.overdue ? 'Просрочена отсрочка платежа: ' + (cl ? cl.name : d.client) : 'Скоро срок отсрочки: ' + (cl ? cl.name : d.client), what: 'Отсрочка ' + d.days + ' дней с ' + d.since + ', срок ' + d.dueDate + '.', meaning: d.overdue ? 'Платёж просрочен на ' + Math.abs(d.daysLeft) + ' дн. Напоминание клиенту.' : 'До срока ' + d.daysLeft + ' дн. Это учёт, финансирование не реализовано.', action: 'Напомнить клиенту о платеже.', client: d.client };
    })),
    warnings: warnings,
  };
}

export { CHANNELS_FILE, BUDGETS_FILE, CASHBACK_FILE, OPERATORS_FILE, CLIENTS_FILE };

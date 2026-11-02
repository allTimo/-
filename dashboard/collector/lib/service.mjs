// Каркас сервиса: клиенты, подписки, услуги, очередь прогонов, счета, экономика.
import fs from 'node:fs';
import path from 'node:path';
import { parseYaml } from './yaml.mjs';
import { REGISTRY_DIR } from './paths.mjs';

const CLIENTS = path.join(REGISTRY_DIR, 'clients.yaml');
const SERVICES = path.join(REGISTRY_DIR, 'services.yaml');
const SUBS = path.join(REGISTRY_DIR, 'subscriptions.yaml');
const INVOICES = path.join(REGISTRY_DIR, 'invoices.yaml');
const RUNS = path.join(REGISTRY_DIR, 'runs.jsonl');
const RESULTS = path.join(REGISTRY_DIR, 'results.yaml');

const SENT_STATUS = { 'отправлено': 'отправлено', 'ожидает': 'ожидает', 'ошибка': 'ошибка', 'не отправлялось': 'не отправлялось' };
const SENT_CHANNEL = { telegram: 'Telegram', vk: 'VK', whatsapp: 'WhatsApp', email: 'Почта', link: 'Ссылка', download: 'Скачивание', none: 'не отправлялось' };

const CLIENT_STATUS = { lead: 'лид', active: 'активен', paused: 'на паузе', churned: 'ушёл' };
const SUB_STATUS = { active: 'активна', paused: 'приостановлена', overdue: 'просрочена', closed: 'закрыта' };
const INV_STATUS = { draft: 'черновик', issued: 'выставлен', paid: 'оплачен' };
const RUN_STATUS = { ok: 'успешно', partial: 'частично', failed: 'ошибка' };
const SVC_STATUS = { active: 'работает', planned: 'запланирована', paused: 'на паузе' };

function asArray(v) { return Array.isArray(v) ? v : (v === null || v === undefined ? [] : [v]); }
function readYaml(file, warnings, label) {
  if (!fs.existsSync(file)) { warnings.push(label + ': файл не найден — ' + file); return null; }
  try { return parseYaml(fs.readFileSync(file, 'utf8')); }
  catch (e) { warnings.push(label + ': ошибка разбора — ' + e.message); return null; }
}

export function loadRuns(warnings) {
  if (!fs.existsSync(RUNS)) return [];
  const out = [];
  let bad = 0;
  for (const line of fs.readFileSync(RUNS, 'utf8').split(/\r?\n/)) {
    if (line.trim() === '') continue;
    try { const o = JSON.parse(line); if (o && typeof o === 'object') out.push(o); else bad++; }
    catch (e) { bad++; }
  }
  if (bad > 0) warnings.push('runs.jsonl: ' + bad + ' строк не разобрались');
  out.sort(function (a, b) { return String(b.ts) < String(a.ts) ? -1 : 1; });
  return out;
}

export function buildServiceDoc(ctx) {
  const warnings = [];
  const clientsDoc = readYaml(CLIENTS, warnings, 'registry/clients.yaml');
  const servicesDoc = readYaml(SERVICES, warnings, 'registry/services.yaml');
  const subsDoc = readYaml(SUBS, warnings, 'registry/subscriptions.yaml');
  const invoicesDoc = readYaml(INVOICES, warnings, 'registry/invoices.yaml');
  const runs = loadRuns(warnings);
  const resultsDoc = readYaml(RESULTS, warnings, 'registry/results.yaml');
  const today = ctx.today;

  const clients = asArray(clientsDoc && clientsDoc.clients).filter(function (c) { return c && c.id; }).map(function (c) {
    const id = String(c.id);
    const mySubs = asArray(subsDoc && subsDoc.subscriptions).filter(function (s) { return s && String(s.client) === id; });
    const myRuns = runs.filter(function (r) { return String(r.client) === id; });
    const myInvoices = asArray(invoicesDoc && invoicesDoc.invoices).filter(function (i) { return i && String(i.client) === id; });
    const mrr = mySubs.filter(function (s) { return s.status === 'active' || s.status === 'overdue'; })
      .reduce(function (acc, s) { return acc + (Number(s.price_rub) || 0); }, 0);
    const debt = myInvoices.filter(function (i) { return i.status === 'issued'; }).reduce(function (acc, i) { return acc + (Number(i.amount_rub) || 0); }, 0);
    return {
      id: id,
      name: c.name !== undefined ? String(c.name) : id,
      contact: c.contact !== undefined ? String(c.contact) : null,
      status: c.status !== undefined ? String(c.status) : 'lead',
      statusLabel: CLIENT_STATUS[c.status] || String(c.status || '—'),
      plan: c.plan !== undefined ? String(c.plan) : null,
      since: c.since !== undefined ? String(c.since) : null,
      objects: asArray(c.objects).map(String),
      services: asArray(c.services).map(String),
      note: c.note !== undefined ? String(c.note) : null,
      mrrRub: mrr,
      debtRub: debt,
      subscriptions: mySubs.length,
      runs: myRuns.length,
      lastRun: myRuns.length ? myRuns[0].ts : null,
      nextReport: mySubs.map(function (s) { return s.end; }).filter(Boolean).sort()[0] || null,
      invoices: myInvoices.length,
    };
  });

  const services = asArray(servicesDoc && servicesDoc.services).filter(function (s) { return s && s.id; }).map(function (s) {
    const id = String(s.id);
    const subs = asArray(subsDoc && subsDoc.subscriptions).filter(function (x) { return x && String(x.service) === id && (x.status === 'active' || x.status === 'overdue'); });
    const myRuns = runs.filter(function (r) { return String(r.service) === id; });
    const cost = Number(s.cost_rub) || 0;
    const price = Number(s.price_rub) || 0;
    const revenue = subs.reduce(function (acc, x) { return acc + (Number(x.price_rub) || 0); }, 0);
    const marginRub = price - cost;
    const marginPct = price > 0 ? (price - cost) / price : null;
    return {
      id: id,
      name: s.name !== undefined ? String(s.name) : id,
      what: s.what !== undefined ? String(s.what) : null,
      agent: s.agent !== undefined ? String(s.agent) : null,
      schedule: s.schedule !== undefined ? String(s.schedule) : null,
      artifacts: asArray(s.artifacts).map(String),
      costRub: cost,
      priceRub: price,
      status: s.status !== undefined ? String(s.status) : 'planned',
      statusLabel: SVC_STATUS[s.status] || String(s.status || '—'),
      enabled: s.enabled === true,
      note: s.note !== undefined ? String(s.note) : null,
      subscribers: subs.length,
      mrrRub: revenue,
      marginRub: marginRub,
      marginPct: marginPct,
      runs: myRuns.length,
      lastRun: myRuns.length ? myRuns[0].ts : null,
      runsFailed: myRuns.filter(function (r) { return r.status === 'failed'; }).length,
    };
  });

  const objById = {};
  if (ctx.objects) for (const o of ctx.objects) objById[o.id] = o.name;

  const subscriptions = asArray(subsDoc && subsDoc.subscriptions).filter(function (s) { return s && s.id; }).map(function (s) {
    const cl = clients.filter(function (c) { return c.id === String(s.client); })[0];
    const sv = services.filter(function (x) { return x.id === String(s.service); })[0];
    const end = s.end !== undefined && s.end !== null ? String(s.end) : null;
    const daysLeft = end ? Math.round((new Date(end + 'T00:00:00') - new Date(today + 'T00:00:00')) / 86400000) : null;
    return {
      id: String(s.id),
      client: String(s.client),
      clientName: cl ? cl.name : String(s.client),
      service: String(s.service),
      serviceName: sv ? sv.name : String(s.service),
      plan: s.plan !== undefined ? String(s.plan) : null,
      period: s.period !== undefined ? String(s.period) : null,
      start: s.start !== undefined ? String(s.start) : null,
      end: end,
      status: s.status !== undefined ? String(s.status) : 'active',
      statusLabel: SUB_STATUS[s.status] || String(s.status || '—'),
      priceRub: Number(s.price_rub) || 0,
      invoiced: s.invoiced === true,
      daysLeft: daysLeft,
      expiring: daysLeft !== null && daysLeft <= 7,
    };
  });

  const invoices = asArray(invoicesDoc && invoicesDoc.invoices).filter(function (i) { return i && i.id; }).map(function (i) {
    const cl = clients.filter(function (c) { return c.id === String(i.client); })[0];
    return {
      id: String(i.id),
      client: String(i.client),
      clientName: cl ? cl.name : String(i.client),
      period: i.period !== undefined ? String(i.period) : null,
      amountRub: Number(i.amount_rub) || 0,
      status: i.status !== undefined ? String(i.status) : 'draft',
      statusLabel: INV_STATUS[i.status] || String(i.status || '—'),
      issued: i.issued !== undefined && i.issued !== null ? String(i.issued) : null,
      file: i.file !== undefined && i.file !== null ? String(i.file) : null,
    };
  });

  const runsOut = runs.map(function (r) {
    const cl = clients.filter(function (c) { return c.id === String(r.client); })[0];
    const sv = services.filter(function (s) { return s.id === String(r.service); })[0];
    return {
      runId: r.run_id !== undefined ? String(r.run_id) : null,
      ts: r.ts !== undefined ? String(r.ts) : null,
      service: r.service !== undefined ? String(r.service) : null,
      serviceName: sv ? sv.name : (r.service !== undefined ? String(r.service) : null),
      client: r.client !== undefined ? String(r.client) : null,
      clientName: cl ? cl.name : (r.client !== undefined ? String(r.client) : null),
      agent: r.agent !== undefined ? String(r.agent) : null,
      status: r.status !== undefined ? String(r.status) : 'ok',
      statusLabel: RUN_STATUS[r.status] || String(r.status || '—'),
      durationMs: r.duration_ms !== undefined ? Number(r.duration_ms) : null,
      costRub: r.cost_rub !== undefined ? Number(r.cost_rub) : null,
      artifact: r.artifact !== undefined && r.artifact !== null ? String(r.artifact) : null,
      error: r.error !== undefined && r.error !== null ? String(r.error) : null,
    };
  });

  // --- ЭКОНОМИКА ---
  const revenue = subscriptions.filter(function (s) { return s.status === 'active' || s.status === 'overdue'; })
    .reduce(function (acc, s) { return acc + s.priceRub; }, 0);
  const runCost = runsOut.reduce(function (acc, r) { return acc + (r.costRub || 0); }, 0);
  const planRevenue = subscriptions.filter(function (s) { return s.status === 'active' || s.status === 'overdue'; })
    .reduce(function (acc, s) {
      const sv = services.filter(function (x) { return x.id === s.service; })[0];
      return acc + (sv ? sv.costRub : 0);
    }, 0);
  const byService = services.map(function (s) {
    const runsOfService = runsOut.filter(function (r) { return r.service === s.id; });
    const realCost = runsOfService.reduce(function (acc, r) { return acc + (r.costRub || 0); }, 0);
    return {
      id: s.id, name: s.name, priceRub: s.priceRub, costRub: s.costRub,
      subscribers: s.subscribers, mrrRub: s.mrrRub,
      plannedCostRub: s.subscribers * s.costRub,
      actualCostRub: realCost,
      marginRub: s.priceRub - s.costRub,
      marginPct: s.marginPct,
      runs: s.runs,
    };
  }).sort(function (a, b) { return b.mrrRub - a.mrrRub; });

  const byClient = clients.map(function (c) {
    const clientRuns = runsOut.filter(function (r) { return r.client === c.id; });
    const cost = clientRuns.reduce(function (acc, r) { return acc + (r.costRub || 0); }, 0);
    const income = subscriptions.filter(function (s) { return s.client === c.id && (s.status === 'active' || s.status === 'overdue'); })
      .reduce(function (acc, s) { return acc + s.priceRub; }, 0);
    return {
      id: c.id, name: c.name, plan: c.plan, status: c.statusLabel,
      incomeRub: income, costRub: cost, marginRub: income - cost,
      marginPct: income > 0 ? (income - cost) / income : null,
      runs: clientRuns.length, debtRub: c.debtRub,
    };
  }).sort(function (a, b) { return b.marginRub - a.marginRub; });

  const results = asArray(resultsDoc && resultsDoc.results).filter(function (r) { return r && r.id; }).map(function (r) {
    const clientId = r.client !== undefined && r.client !== null ? String(r.client) : null;
    const cl = clients.filter(function (c) { return c.id === clientId; })[0];
    const sv = services.filter(function (s) { return s.id === String(r.service || ''); })[0];
    return {
      id: String(r.id),
      title: r.title !== undefined ? String(r.title) : String(r.id),
      summary: r.summary !== undefined ? String(r.summary) : null,
      client: clientId,
      clientName: cl ? cl.name : (clientId || 'без клиента'),
      project: r.project !== undefined && r.project !== null ? String(r.project) : null,
      period: r.period !== undefined && r.period !== null ? String(r.period) : null,
      agent: r.agent !== undefined ? String(r.agent) : null,
      service: r.service !== undefined ? String(r.service) : null,
      serviceName: sv ? sv.name : null,
      created: r.created !== undefined && r.created !== null ? String(r.created) : null,
      createdMs: r.created ? Date.parse(String(r.created)) : null,
      artifacts: asArray(r.artifacts).map(String),
      sentChannel: r.sent_channel !== undefined ? String(r.sent_channel) : 'none',
      sentChannelLabel: SENT_CHANNEL[r.sent_channel] || String(r.sent_channel || 'не отправлялось'),
      sentTo: r.sent_to !== undefined && r.sent_to !== null ? String(r.sent_to) : '',
      sentAt: r.sent_at !== undefined && r.sent_at !== null ? String(r.sent_at) : null,
      sentStatus: r.sent_status !== undefined ? String(r.sent_status) : 'не отправлялось',
    };
  }).sort(function (a, b) { return (b.createdMs || 0) - (a.createdMs || 0); });

  const economy = {
    revenueRub: revenue,
    plannedCostRub: planRevenue,
    actualCostRub: runCost,
    marginRub: revenue - runCost,
    marginPct: revenue > 0 ? (revenue - runCost) / revenue : null,
    runsTotal: runsOut.length,
    runsOk: runsOut.filter(function (r) { return r.status === 'ok'; }).length,
    runsFailed: runsOut.filter(function (r) { return r.status === 'failed'; }).length,
    clientsActive: clients.filter(function (c) { return c.status === 'active'; }).length,
    clientsTotal: clients.length,
    debtRub: invoices.filter(function (i) { return i.status === 'issued'; }).reduce(function (acc, i) { return acc + i.amountRub; }, 0),
    byService: byService,
    byClient: byClient,
    note: 'Себестоимость и расход считаются по данным панели: прогоны берутся из registry/runs.jsonl, план — из services.yaml. Цена модели без прайса помечается «цена неизвестна».',
  };

  return {
    generatedAtMs: Date.now(),
    today: today,
    files: { clients: CLIENTS, services: SERVICES, subscriptions: SUBS, invoices: INVOICES, runs: RUNS, results: RESULTS },
    labels: { clientStatus: CLIENT_STATUS, subStatus: SUB_STATUS, invoiceStatus: INV_STATUS, runStatus: RUN_STATUS, serviceStatus: SVC_STATUS },
    clients: clients,
    services: services,
    subscriptions: subscriptions,
    invoices: invoices,
    runs: runsOut,
    results: results,
    sentChannels: SENT_CHANNEL,
    economy: economy,
    counts: {
      clients: clients.length, active: clients.filter(function (c) { return c.status === 'active'; }).length,
      services: services.length, servicesEnabled: services.filter(function (s) { return s.enabled; }).length,
      subscriptions: subscriptions.length, subsActive: subscriptions.filter(function (s) { return s.status === 'active'; }).length,
      expiring: subscriptions.filter(function (s) { return s.expiring; }).length,
      overdue: subscriptions.filter(function (s) { return s.status === 'overdue'; }).length,
      invoices: invoices.length, unpaid: invoices.filter(function (i) { return i.status === 'issued'; }).length,
      runs: runsOut.length, runsOk: economy.runsOk, runsFailed: economy.runsFailed,
      results: results.length,
      resultsSent: results.filter(function (r) { return r.sentStatus === 'отправлено'; }).length,
      resultsPending: results.filter(function (r) { return r.sentStatus === 'ожидает'; }).length,
    },
    warnings: warnings,
  };
}

export function appendRun(entry) {
  fs.appendFileSync(RUNS, JSON.stringify(entry) + '\n', 'utf8');
  return entry;
}

export { CLIENTS, SERVICES, SUBS, INVOICES, RUNS };

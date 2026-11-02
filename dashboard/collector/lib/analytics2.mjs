// Аналитика-2: серии, столбцы, доли, воронка, тепловая карта, срезы, метрики, топы.
// Ключ недели ISO: год + номер недели. Считаем на месте, чтобы 180 дней
// честно сжимались в ~26 недель, а не давали 180 уникальных ключей.
function weekKey(day) {
  const dt = new Date(day + 'T00:00:00Z');
  const dow = dt.getUTCDay() === 0 ? 7 : dt.getUTCDay();
  dt.setUTCDate(dt.getUTCDate() + 4 - dow);
  const ys = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const wk = Math.ceil(((dt - ys) / 86400000 + 1) / 7);
  return dt.getUTCFullYear() + '-W' + String(wk).padStart(2, '0');
}

function pad2(n) { return String(n).padStart(2, '0'); }
function dayKey(d) { return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()); }
function addDays(s, n) { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return dayKey(d); }
function monthKey(s) { return s.slice(0, 7); }

export function buildAnalytics2Doc(ctx) {
  const warnings = [];
  const today = ctx.today;
  const usage = ctx.usage;
  const service = ctx.service || { clients: [], services: [], subscriptions: [], invoices: [], runs: [], results: [], economy: {} };
  const tasksDoc = ctx.tasksDoc || { tasks: [] };
  const sourcesDoc = ctx.sourcesDoc || { sources: [], summary: {} };
  const agents = (ctx.agents && ctx.agents.agents) ? ctx.agents.agents : [];

  // --- период по умолчанию: всё время, но не длиннее 180 дней для серий ---
  const runs = service.runs || [];
  const results = service.results || [];

  function rangeDays(from, to) {
    const out = [];
    let cur = from;
    let guard = 0;
    while (cur <= to && guard++ < 400) { out.push(cur); cur = addDays(cur, 1); }
    return out;
  }

  // --- раскладка выручки по дням: цена подписки / 30 за каждый день действия ---
  function revenueOnDay(day) {
    let sum = 0;
    (service.subscriptions || []).forEach(function (s) {
      if (s.status !== 'active' && s.status !== 'overdue') return;
      if (s.start && day < s.start) return;
      if (s.end && day > s.end) return;
      sum += (Number(s.priceRub) || 0) / 30;
    });
    return Math.round(sum * 100) / 100;
  }

  const allDays = rangeDays(addDays(today, -179), today);

  const daySeries = allDays.map(function (d) {
    const cost = runs.filter(function (r) { return r.ts && r.ts.slice(0, 10) === d; }).reduce(function (a, r) { return a + (r.costRub || 0); }, 0);
    const rev = revenueOnDay(d);
    return {
      key: d, revenue: rev, cost: cost, margin: Math.round((rev - cost) * 100) / 100,
      runs: runs.filter(function (r) { return r.ts && r.ts.slice(0, 10) === d; }).length,
      results: results.filter(function (r) { return r.created && r.created.slice(0, 10) === d; }).length,
      sent: results.filter(function (r) { return r.sentAt && r.sentAt.slice(0, 10) === d; }).length,
    };
  });

  function groupSeries(days, keyFn) {
    const map = new Map();
    days.forEach(function (d) {
      const k = keyFn(d.key);
      if (!map.has(k)) map.set(k, { key: k, revenue: 0, cost: 0, margin: 0, runs: 0, results: 0, sent: 0 });
      const g = map.get(k);
      g.revenue += d.revenue; g.cost += d.cost; g.margin += d.margin;
      g.runs += d.runs; g.results += d.results; g.sent += d.sent;
    });
    const arr = Array.from(map.values()).sort(function (a, b) { return a.key < b.key ? -1 : 1; });
    arr.forEach(function (g) { g.revenue = Math.round(g.revenue * 100) / 100; g.margin = Math.round(g.margin * 100) / 100; });
    return arr;
  }

  const weekSeries = groupSeries(daySeries, weekKey);
  const monthSeries = groupSeries(daySeries, monthKey);

  // накопительные столбцы по неделям
  let acc = { revenue: 0, cost: 0, margin: 0 };
  const bars = weekSeries.map(function (w) {
    acc.revenue += w.revenue; acc.cost += w.cost; acc.margin += w.margin;
    return { week: w.key, revenue: Math.round(acc.revenue), cost: Math.round(acc.cost), margin: Math.round(acc.margin), runs: w.runs };
  });

  // --- доли ---
  const byService = (service.services || []).map(function (s) {
    return { id: s.id, name: s.name, value: s.mrrRub, runs: s.runs, margin: s.marginRub, color: null };
  }).filter(function (x) { return x.value > 0; });
  const serviceTotal = byService.reduce(function (a, x) { return a + x.value; }, 0);
  byService.forEach(function (x) { x.share = serviceTotal > 0 ? x.value / serviceTotal : 0; });

  const byClient = (service.clients || []).map(function (c) {
    return { id: c.id, name: c.name, value: c.mrrRub, runs: c.runs, status: c.status };
  }).filter(function (x) { return x.value > 0; }).sort(function (a, b) { return b.value - a.value; });
  const clientTotal = byClient.reduce(function (a, x) { return a + x.value; }, 0);
  byClient.forEach(function (x) { x.share = clientTotal > 0 ? x.value / clientTotal : 0; });

  // --- воронка ---
  const funnel = {
    runs: runs.length,
    results: results.length,
    sent: results.filter(function (r) { return r.sentStatus === 'отправлено'; }).length,
    pending: results.filter(function (r) { return r.sentStatus === 'ожидает'; }).length,
  };

  // --- тепловая карта: день недели × час (местное время) ---
  const heat = [];
  for (let d = 0; d < 7; d++) { heat.push(new Array(24).fill(0)); }
  runs.forEach(function (r) {
    if (!r.ts) return;
    const dt = new Date(Date.parse(r.ts));
    if (isNaN(dt.getTime())) return;
    const local = new Date(dt.getTime() + 3 * 3600 * 1000); // Москва
    const dow = (local.getUTCDay() + 6) % 7; // 0 = понедельник
    heat[dow][local.getUTCHours()] += 1;
  });

  // --- срезы ---
  function slice(list, keyFn, valueFn) {
    const m = new Map();
    list.forEach(function (x) {
      const k = keyFn(x);
      if (k === null || k === undefined || k === '') return;
      const cur = m.get(k) || { key: k, count: 0, value: 0 };
      cur.count += 1;
      cur.value += Number(valueFn ? valueFn(x) : 0) || 0;
      m.set(k, cur);
    });
    return Array.from(m.values()).sort(function (a, b) { return b.count - a.count; });
  }

  const slices = {
    client: slice(service.subscriptions || [], function (s) { return s.clientName; }, function (s) { return s.priceRub; }),
    service: slice(service.subscriptions || [], function (s) { return s.serviceName; }, function (s) { return s.priceRub; }),
    agent: slice(runs, function (r) { return r.agent; }, function (r) { return r.costRub; }),
    source: slice(sourcesDoc.sources || [], function (s) { return s.name; }, function (s) { return (s.stats || {}).lots || 0; }),
    channel: slice(results, function (r) { return r.sentChannelLabel; }),
    plan: slice(service.subscriptions || [], function (s) { return s.plan; }, function (s) { return s.priceRub; }),
    project: slice(service.results || [], function (r) { return r.project; }),
    status: slice(service.clients || [], function (c) { return c.statusLabel; }),
    runStatus: slice(runs, function (r) { return r.statusLabel; }),
  };

  // --- метрики ---
  const subActive = (service.subscriptions || []).filter(function (s) { return s.status === 'active'; });
  const subOverdue = (service.subscriptions || []).filter(function (s) { return s.status === 'overdue'; });
  const subExpiring = (service.subscriptions || []).filter(function (s) { return s.expiring; });
  const revenue = (service.economy || {}).revenueRub || 0;
  const cost = (service.economy || {}).actualCostRub || 0;
  const margin = (service.economy || {}).marginRub || 0;
  const activeClients = (service.clients || []).filter(function (c) { return c.status === 'active'; }).length;
  const leads = (service.clients || []).filter(function (c) { return c.status === 'lead'; }).length;
  const paused = (service.clients || []).filter(function (c) { return c.status === 'paused'; }).length;
  const runsOk = runs.filter(function (r) { return r.status === 'ok'; }).length;
  const runsFailed = runs.filter(function (r) { return r.status === 'failed'; }).length;
  const avgMs = runs.length ? Math.round(runs.reduce(function (a, r) { return a + (r.durationMs || 0); }, 0) / runs.length) : null;
  const tasks = tasksDoc.tasks || [];
  const tasksDone = tasks.filter(function (t) { return t.status === 'done' || t.status === 'completed'; }).length;
  const tasksOverdue = tasks.filter(function (t) { return t.due && t.due < today && t.status !== 'done' && t.status !== 'completed'; }).length;
  const sourcesLots = (sourcesDoc.sources || []).reduce(function (a, s) { return a + ((s.stats || {}).lots || 0); }, 0);
  const snapshots = (sourcesDoc.sources || []).reduce(function (a, s) { return a + ((s.stats || {}).snapshots || 0); }, 0);

  const metrics = {
    revenue: { label: 'Доход по подпискам', value: revenue, unit: '₽', hint: 'сумма цен активных и просроченных подписок' },
    cost: { label: 'Себестоимость прогонов', value: cost, unit: '₽', hint: 'сумма себестоимости всех записей в runs.jsonl' },
    margin: { label: 'Маржа', value: margin, unit: '₽', hint: 'доход − себестоимость' },
    marginPct: { label: 'Маржинальность', value: revenue > 0 ? margin / revenue : null, unit: '%', hint: 'маржа / доход' },
    arpu: { label: 'Средний чек (ARPU)', value: activeClients > 0 ? revenue / activeClients : null, unit: '₽', hint: 'доход / число активных клиентов' },
    runsTotal: { label: 'Прогонов всего', value: runs.length, unit: '', hint: 'записи в registry/runs.jsonl' },
    successRate: { label: 'Успешность прогонов', value: runs.length ? runsOk / runs.length : null, unit: '%', hint: 'успешные / все прогоны' },
    avgRunSec: { label: 'Среднее время прогона', value: avgMs === null ? null : avgMs / 1000, unit: 'с', hint: 'среднее по колонке duration_ms' },
    tokensTotal: { label: 'Токенов израсходовано', value: usage.totals.tokens.totalTokens, unit: '', hint: 'все токены из логов DSH, включая чтение кэша' },
    tokensIn: { label: 'Токенов на вход', value: usage.totals.tokens.inputTokens, unit: '', hint: 'входные токены' },
    tokensOut: { label: 'Токенов на выход', value: usage.totals.tokens.outputTokens, unit: '', hint: 'выходные токены' },
    tokensCache: { label: 'Токенов из кэша', value: usage.totals.tokens.cacheReadTokens, unit: '', hint: 'чтение кэша: дешевле обычных' },
    costPanel: { label: 'Расход панели', value: usage.totals.rub, unit: '₽', hint: 'расход моделей по логам сессий' },
    costPerRun: { label: 'Стоимость одного прогона', value: runs.length ? cost / runs.length : null, unit: '₽', hint: 'себестоимость / число прогонов' },
    results: { label: 'Результатов готово', value: results.length, unit: '', hint: 'записи в registry/results.yaml' },
    resultsSent: { label: 'Отправлено клиенту', value: funnel.sent, unit: '', hint: 'результаты со статусом «отправлено»' },
    resultsPending: { label: 'Ожидает отправки', value: funnel.pending, unit: '', hint: 'результаты со статусом «ожидает»' },
    manualShare: { label: 'Доля ручной отправки', value: results.length ? results.filter(function (r) { return r.sentChannel === 'none' || r.sentStatus !== 'отправлено'; }).length / results.length : null, unit: '%', hint: 'не отправлено автоматически / все результаты' },
    clientsActive: { label: 'Клиенты: активные', value: activeClients, unit: '', hint: 'status = active' },
    clientsLead: { label: 'Клиенты: лиды', value: leads, unit: '', hint: 'status = lead' },
    clientsPaused: { label: 'Клиенты: на паузе', value: paused, unit: '', hint: 'status = paused' },
    subsActive: { label: 'Подписки активные', value: subActive.length, unit: '', hint: 'status = active' },
    subsExpiring: { label: 'Подписки истекают', value: subExpiring.length, unit: '', hint: 'до конца ≤ 7 дней' },
    subsOverdue: { label: 'Подписки просрочены', value: subOverdue.length, unit: '', hint: 'status = overdue' },
    debt: { label: 'Долг по счетам', value: (service.economy || {}).debtRub || 0, unit: '₽', hint: 'счета со статусом «выставлен»' },
    leadConversion: { label: 'Конверсия лид → клиент', value: (activeClients + leads + paused) > 0 ? activeClients / (activeClients + leads + paused) : null, unit: '%', hint: 'активные / все клиенты' },
    tasksTotal: { label: 'Задач создано', value: tasks.length, unit: '', hint: 'записи в реестре задач' },
    tasksDone: { label: 'Задач готово', value: tasksDone, unit: '', hint: 'status = done' },
    tasksOverdue: { label: 'Задач просрочено', value: tasksOverdue, unit: '', hint: 'срок прошёл, задача не закрыта' },
    sourcesLots: { label: 'Лотов в источниках', value: sourcesLots, unit: '', hint: 'сумма по последним снимкам' },
    snapshots: { label: 'Снимков собрано', value: snapshots, unit: '', hint: 'число снимков по всем источникам' },
    sourcesSuccess: { label: 'Успешность сбора', value: (sourcesDoc.sources || []).length ? (sourcesDoc.sources || []).filter(function (s) { return s.status === 'working'; }).length / (sourcesDoc.sources || []).length : null, unit: '%', hint: 'работающие источники / все' },
  };

  // --- спарклайны: последние 14 дней ---
  const spark = daySeries.slice(-14).map(function (d) { return d.revenue - d.cost; });

  // --- топы ---
  const tops = {
    servicesByMargin: (service.services || []).slice().sort(function (a, b) { return b.marginRub - a.marginRub; }).slice(0, 5).map(function (s) { return { name: s.name, value: s.marginRub, unit: '₽', extra: s.marginPct === null ? '' : Math.round(s.marginPct * 100) + '% от цены' }; }),
    clientsByRevenue: (service.clients || []).slice().sort(function (a, b) { return b.mrrRub - a.mrrRub; }).slice(0, 5).map(function (c) { return { name: c.name, value: c.mrrRub, unit: '₽', extra: c.statusLabel + ' · прогонов ' + c.runs }; }),
    sourcesByLots: (sourcesDoc.sources || []).slice().sort(function (a, b) { return ((b.stats || {}).lots || 0) - ((a.stats || {}).lots || 0); }).slice(0, 5).map(function (s) { return { name: s.name, value: (s.stats || {}).lots || 0, unit: 'лотов', extra: s.statusLabel || '' }; }),
    modelsByCost: (usage.byModel || []).slice().sort(function (a, b) { return b.rub - a.rub; }).slice(0, 5).map(function (m) { return { name: m.model, value: m.rub, unit: '₽', extra: m.rubComplete ? '' : 'цена неизвестна' }; }),
  };

  return {
    generatedAtMs: Date.now(),
    today: today,
    series: { day: daySeries.slice(-90), week: weekSeries, month: monthSeries },
    bars: bars,
    byService: byService,
    byClient: byClient,
    serviceTotal: serviceTotal,
    clientTotal: clientTotal,
    funnel: funnel,
    heatmap: heat,
    slices: slices,
    metrics: metrics,
    spark: spark,
    tops: tops,
    counts: { metrics: Object.keys(metrics).length, slices: Object.keys(slices).length, charts: 6 },
    warnings: warnings,
  };
}

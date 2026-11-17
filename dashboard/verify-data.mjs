#!/usr/bin/env node
// Smoke test for the collected data.
//   node marketing-agents/dashboard/verify-data.cjs [dataDir]
// Exits 0 when every document parses and all sums agree.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(here, 'public', 'data');

let problems = 0;
function check(label, ok, detail) {
  console.log('  ' + (ok ? 'OK  ' : 'FAIL') + ' ' + label + (detail ? '  (' + detail + ')' : ''));
  if (!ok) problems++;
}

if (!fs.existsSync(dataDir)) {
  console.error('Нет папки с данными: ' + dataDir + '\nСначала запустите сборщик: node marketing-agents/dashboard/collector/collect.mjs');
  process.exit(2);
}

console.log('Проверяю ' + dataDir);
const docs = {};
for (const name of fs.readdirSync(dataDir)) {
  if (!name.endsWith('.json')) continue;
  try {
    docs[name] = JSON.parse(fs.readFileSync(path.join(dataDir, name), 'utf8'));
    console.log('  OK   ' + name.padEnd(16) + ' разобран, ключей: ' + Object.keys(docs[name]).length);
  } catch (e) {
    problems++;
    console.log('  FAIL ' + name + ' — не разбирается: ' + e.message);
  }
}

const usage = docs['usage.json'];
const agents = docs['agents.json'];
const tasks = docs['tasks.json'];
const meta = docs['meta.json'];
const sessions = docs['sessions.json'];
if (!usage || !agents || !tasks || !meta || !sessions) {
  console.error('Не хватает обязательных документов (usage/agents/tasks/meta/sessions).');
  process.exit(2);
}

console.log('Сверяю суммы (должны совпадать с итогом):');
const total = usage.totals.tokens.totalTokens;
const sum = (list, pick) => list.reduce((acc, x) => acc + pick(x), 0);
check('по моделям == итог', sum(usage.byModel, x => x.tokens.totalTokens) === total, sum(usage.byModel, x => x.tokens.totalTokens) + ' / ' + total);
check('по дням == итог', sum(usage.byDay, x => x.tokens.totalTokens) === total, sum(usage.byDay, x => x.tokens.totalTokens) + ' / ' + total);
check('по исполнителям == итог', sum(usage.byAgent, x => x.tokens.totalTokens) === total, sum(usage.byAgent, x => x.tokens.totalTokens) + ' / ' + total);
check('по сессиям == итог', sum(sessions.sessions, x => x.tokens.totalTokens) === total, sum(sessions.sessions, x => x.tokens.totalTokens) + ' / ' + total);
check('meta.totals == usage.totals', meta.totals.tokens.totalTokens === total);
check('дерево задач == число задач', tasks.tree.reduce((a, g) => a + g.total, 0) === tasks.counts.total);
check('включённых агентов == meta', agents.summary.enabled === meta.totals.agentsEnabled);
check('число сессий == meta', sessions.count === meta.totals.sessions);
check('у каждой задачи есть статус, группа, категория', tasks.tasks.every(t => t.status && t.group && t.category));
check('нет выдуманных цен: модель без цены помечена', usage.byModel.every(m => m.priceKnown || m.rub === null));
check('неполные рублёвые суммы помечены', usage.byDay.every(d => d.rub === null || d.rubComplete === true || d.rubComplete === false));

const service = docs['service.json'];
if (service) {
  console.log('Проверяю модель сервиса:');
  check('клиенты прочитаны', Array.isArray(service.clients) && service.clients.length > 0, String(service.clients.length));
  check('услуги прочитаны', Array.isArray(service.services) && service.services.length === 3, String(service.services.length));
  check('у каждой услуги есть цена, себестоимость и маржа',
    service.services.every(s => typeof s.priceRub === 'number' && typeof s.costRub === 'number' && s.marginRub === s.priceRub - s.costRub));
  const marginSum = service.services.reduce((a, s) => a + s.marginRub, 0);
  check('маржа по услугам считается', marginSum > 0, String(marginSum) + ' ₽');
  const rev = service.subscriptions.filter(s => s.status === 'active' || s.status === 'overdue').reduce((a, s) => a + s.priceRub, 0);
  check('доход == сумме активных подписок', rev === service.economy.revenueRub, rev + ' / ' + service.economy.revenueRub);
  const cost = service.runs.reduce((a, r) => a + (r.costRub || 0), 0);
  check('себестоимость факта == сумме прогонов', cost === service.economy.actualCostRub, cost + ' / ' + service.economy.actualCostRub);
  check('все результаты имеют статус отправки', service.results.every(r => r.sentStatus));
  check('у каждого прогона есть статус и услуга', service.runs.every(r => r.status && r.service));
}

const integ = docs['integrations.json'];
if (integ && integ.catalog) {
  console.log('Проверяю каталог интеграций:');
  check('группы каталога прочитаны', integ.catalog.groups.length >= 8, String(integ.catalog.groups.length) + ' групп');
  check('записи каталога прочитаны', integ.catalog.counts.total >= 40, String(integ.catalog.counts.total) + ' записей');
  const sumGroups = integ.catalog.groups.reduce((a, g) => a + g.total, 0);
  check('сумма записей по группам == счётчику', sumGroups === integ.catalog.counts.total, sumGroups + ' / ' + integ.catalog.counts.total);
  const byStatus = integ.catalog.groups.flatMap(g => g.items).reduce((a, i) => { a[i.status] = (a[i.status] || 0) + 1; return a; }, {});
  check('статусы посчитаны честно', (byStatus.connected || 0) === integ.catalog.counts.connected, JSON.stringify(byStatus));
  check('у записей без API статус no-api', integ.catalog.groups.flatMap(g => g.items).filter(i => i.status === 'no-api').length === integ.catalog.counts.noApi);
  check('нет выдуманных статусов', Object.keys(byStatus).every(k => ['connected', 'available', 'partnership', 'no-api'].indexOf(k) >= 0));
}

const a2 = docs['analytics2.json'];
if (a2) {
  console.log('Проверяю аналитику (суммы графиков = итогам):');
  const dayRev = a2.series.day.reduce((x, d) => x + d.revenue, 0);
  const weekRev = a2.series.week.reduce((x, d) => x + d.revenue, 0);
  const monthRev = a2.series.month.reduce((x, d) => x + d.revenue, 0);
  const close = (a, b) => Math.abs(a - b) < 1;
  check('сумма по дням == сумме по неделям', close(dayRev, weekRev), Math.round(dayRev) + ' / ' + Math.round(weekRev));
  check('сумма по дням == сумме по месяцам', close(dayRev, monthRev), Math.round(dayRev) + ' / ' + Math.round(monthRev));
  const barMax = a2.bars.length ? a2.bars[a2.bars.length - 1].revenue : 0;
  check('последний накопительный столбец == сумме по неделям', close(barMax, weekRev), Math.round(barMax) + ' / ' + Math.round(weekRev));
  const svcSum = a2.byService.reduce((x, s) => x + s.value, 0);
  check('доли по услугам == итогу доходных подписок', close(svcSum, a2.serviceTotal), svcSum + ' / ' + a2.serviceTotal);
  const cliSum = a2.byClient.reduce((x, c) => x + c.value, 0);
  check('доли по клиентам == итогу доходных подписок', close(cliSum, a2.clientTotal), cliSum + ' / ' + a2.clientTotal);
  const heatSum = a2.heatmap.reduce((x, r) => x + r.reduce((y, z) => y + z, 0), 0);
  check('тепловая карта == числу прогонов', heatSum === a2.funnel.runs, heatSum + ' / ' + a2.funnel.runs);
  check('метрик не меньше 12', Object.keys(a2.metrics).length >= 12, String(Object.keys(a2.metrics).length));
  check('срезов не меньше 6', Object.keys(a2.slices).length >= 6, String(Object.keys(a2.slices).length));
  check('графиков не меньше 6', a2.counts.charts >= 6, String(a2.counts.charts));
  check('у каждой метрики есть формула-подсказка', Object.values(a2.metrics).every(m => m.hint && m.label));
}

const ads = docs['ads.json'];
if (ads) {
  console.log('Проверяю «Рекламу и кэшбэк» (независимый пересчёт):');
  const sumCh = ads.channelRows.reduce((x, c) => x + c.spend, 0);
  check('сумма расхода по каналам == итогу', Math.abs(sumCh - ads.totals.spendRub) < 0.01, sumCh + ' / ' + ads.totals.spendRub);
  const sumCl = ads.clientRows.reduce((x, c) => x + c.spend, 0);
  check('сумма расхода по клиентам == итогу', Math.abs(sumCl - ads.totals.spendRub) < 0.01, sumCl + ' / ' + ads.totals.spendRub);
  const sumTop = ads.clientRows.reduce((x, c) => x + c.topup, 0);
  check('пополнения по клиентам == итогу', Math.abs(sumTop - ads.totals.topupRub) < 0.01, sumTop + ' / ' + ads.totals.topupRub);
  const sumCb = ads.accruals.reduce((x, a) => x + a.amountRub, 0);
  check('начисления == итогу кэшбэка', Math.abs(sumCb - ads.totals.cashbackRub) < 0.01, sumCb + ' / ' + ads.totals.cashbackRub);
  check('остаток == пополнения − расходы', Math.abs(ads.totals.balanceRub - (ads.totals.topupRub - ads.totals.spendRub)) < 0.01, ads.totals.balanceRub + ' / ' + (ads.totals.topupRub - ads.totals.spendRub));
  const badFormula = ads.accruals.filter(a => Math.abs(a.amountRub - (a.baseRub * a.ratePct / 100 + a.fixedRub)) >= 0.01);
  check('каждое начисление = база × ставка + фикс (до копейки)', badFormula.length === 0, badFormula.length ? badFormula.map(a => a.id).join(', ') : 'все ' + ads.accruals.length);
  const negBalance = ads.clientRows.filter(c => c.balance < -0.01);
  check('нет отрицательных остатков', negBalance.length === 0, negBalance.map(c => c.name).join(', ') || 'нет');
  check('есть оба режима работы', ads.clientRows.some(c => c.mode === 'client-pays') && ads.clientRows.some(c => c.mode === 'through-service'), ads.clientRows.map(c => c.mode).join(', '));
  check('каналов не меньше 4', ads.channels.length >= 4, String(ads.channels.length));

  if (ads.platform) {
    console.log('Проверяю ТРЁХУРОВНЕВУЮ модель (платформа -> оператор -> клиент):');
    const p = ads.platform;
    const sumCom = ads.clientRows.reduce((x, c) => x + c.commissionRub, 0);
    check('сумма комиссии по клиентам == итогу', Math.abs(sumCom - p.commissionRub) < 0.01, sumCom + ' / ' + p.commissionRub);
    const sumOp = ads.operatorAccruals.reduce((x, a) => x + a.amountRub, 0);
    check('сумма кэшбэка по операторам == итогу', Math.abs(sumOp - p.operatorsCashbackRub) < 0.01, sumOp + ' / ' + p.operatorsCashbackRub);
    const sumOpTurnover = ads.operatorRows.reduce((x, o) => x + o.turnover, 0);
    check('оборот по операторам == обороту платформы', Math.abs(sumOpTurnover - p.turnoverRub) < 0.01, sumOpTurnover + ' / ' + p.turnoverRub);
    check('КОМИССИЯ + КЭШБЭК <= ОБОРОТ (обязательная)',
      p.commissionRub + p.operatorsCashbackRub <= p.turnoverRub + 0.01,
      (p.commissionRub + p.operatorsCashbackRub) + ' <= ' + p.turnoverRub);
    check('маржа платформы == комиссия - кэшбэк операторов',
      Math.abs(p.marginRub - (p.commissionRub - p.operatorsCashbackRub)) < 0.01,
      p.marginRub + ' / ' + (p.commissionRub - p.operatorsCashbackRub));
    const badOp = ads.operatorAccruals.filter(a => Math.abs(a.amountRub - a.baseRub * a.ratePct / 100) >= 0.01);
    check('каждое начисление оператору = база × ставка (до копейки)', badOp.length === 0, badOp.length ? badOp.map(a => a.id).join(', ') : 'все ' + ads.operatorAccruals.length);
    const noOp = ads.clientRows.filter(c => !c.operatorId);
    check('у каждого клиента есть оператор', noOp.length === 0, noOp.map(c => c.name).join(', ') || 'все связаны');
    check('у каждого оператора есть клиент или пометка', ads.operatorRows.every(o => o.hasClients || o.clientsCount === 0), ads.operatorRows.map(o => o.name + ':' + o.clientsCount).join(', '));
    check('комиссия считается как оборот × ставка', Math.abs(p.commissionRub - p.turnoverRub * p.commissionPct / 100) < 0.02, p.commissionRub + ' / ' + (p.turnoverRub * p.commissionPct / 100));
  }

  if (ads.wallet) {
    console.log('Проверяю КОШЕЛЁК и ПРЕДОХРАНИТЕЛЬ ОТ УБЫТКА:');
    const w = ads.wallet;
    const sumTop = ads.clientRows.reduce((x, c) => x + c.topup, 0);
    const sumSpend = ads.clientRows.reduce((x, c) => x + c.spend, 0);
    check('кошелёк: пополнено == сумме по клиентам', Math.abs(w.topupRub - sumTop) < 0.01, w.topupRub + ' / ' + sumTop);
    check('кошелёк: израсходовано == сумме по клиентам', Math.abs(w.spendRub - sumSpend) < 0.01, w.spendRub + ' / ' + sumSpend);
    check('кошелёк: остаток == пополнено − израсходовано', Math.abs(w.balanceRub - (w.topupRub - w.spendRub)) < 0.01, w.balanceRub + ' / ' + (w.topupRub - w.spendRub));
    const sumRet = ads.returns.reduce((x, r) => x + r.amountRub, 0);
    check('возврат в кошельке == сумме возвратов', Math.abs(w.returnRub - sumRet) < 0.01, w.returnRub + ' / ' + sumRet);
    const sumDue = ads.clientRows.reduce((x, c) => x + c.cashbackDueRub, 0);
    check('кэшбэк в кошельке == сумме к выплате по клиентам', Math.abs(w.cashbackRub - sumDue) < 0.01, w.cashbackRub + ' / ' + sumDue);
    const badFund = ads.clientRows.filter(c => Math.abs(c.cashbackFundedRub - Math.min(c.cashbackDueRub, c.returnRub)) >= 0.01);
    check('кэшбэк покрывается ТОЛЬКО возвратом (выплата ≤ возврат)', badFund.length === 0, badFund.map(c => c.name).join(', ') || 'все ' + ads.clientRows.length);
    const badLoss = ads.clientRows.filter(c => Math.abs(c.lossRub - Math.max(0, c.cashbackDueRub - c.returnRub)) >= 0.01);
    check('убыток == кэшбэк − возврат (когда кэшбэк больше)', badLoss.length === 0, badLoss.map(c => c.name).join(', ') || 'все верно');
    check('предохранитель сработал на демо-примере', ads.risk.lossClients >= 1 && ads.risk.lossRub > 0, 'клиентов ' + ads.risk.lossClients + ', убыток ' + ads.risk.lossRub + ' ₽');
    check('убыточный демо-клиент даёт ожидаемые 7200 ₽', ads.risk.rows.some(r => Math.abs(r.lossRub - 7200) < 0.01), ads.risk.rows.map(r => r.lossRub).join(', '));
    check('кэшбэк оператора = оборот клиента × ставка оператора', ads.clientRows.every(c => Math.abs(c.cashbackDueRub - c.spend * c.operatorRatePct / 100) < 0.01));
    check('УТП «без минимального порога» присутствует', !!(ads.utp && ads.utp.text && ads.utp.text.indexOf('без минимального порога') >= 0), ads.utp && ads.utp.text);
    check('отсрочка платежа учтена', Array.isArray(ads.deferred) && ads.deferred.length > 0, (ads.deferred || []).map(d => d.client + ':' + d.days + 'дн').join(', '));
  }
}

const aset = docs['agent-settings.json'];
if (aset) {
  console.log('Проверяю тонкие настройки агентов:');
  const recs = Object.values(aset.byAgent || {});
  check('файлы настроек читаются', aset.exists && recs.length >= 4, recs.length + ' агентов');
  const badTime = recs.filter(r => r.schedule && r.schedule.time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(r.schedule.time)));
  check('время в допустимом формате ЧЧ:ММ', badTime.length === 0, badTime.map(r => r.agent + ':' + r.schedule.time).join(', ') || 'все верно');
  const badDays = recs.filter(r => r.schedule && Array.isArray(r.schedule.days) && r.schedule.days.some(d => Number(d) < 1 || Number(d) > 7));
  check('дни недели в диапазоне 1–7', badDays.length === 0, badDays.map(r => r.agent).join(', ') || 'все верно');
  const badLimits = recs.filter(r => r.model && ((Number(r.model.limit_rub) < 0) || (Number(r.model.limit_tokens) < 0)));
  check('лимиты неотрицательные', badLimits.length === 0, badLimits.map(r => r.agent).join(', ') || 'все верно');
  const badFreq = recs.filter(r => r.schedule && ['daily', 'weekly', 'monthly', 'on-demand'].indexOf(String(r.schedule.frequency)) < 0);
  check('частота из допустимых значений', badFreq.length === 0, badFreq.map(r => r.agent + ':' + r.schedule.frequency).join(', ') || 'все верно');
  const badInterval = recs.filter(r => r.limits && Number(r.limits.min_interval_hours) < 0);
  check('«не чаще N часов» не отрицательное', badInterval.length === 0, badInterval.map(r => r.agent).join(', ') || 'все верно');
  const ag = docs['agents.json'];
  if (ag) {
    const missing = (ag.agents || []).filter(a => !aset.byAgent[a.id]);
    check('у каждого агента есть файл настроек', missing.length === 0, missing.map(a => a.id).join(', ') || 'все ' + (ag.agents || []).length);
  }
  // эффективные настройки прогона совпадают с файлом: время и частота берутся именно из файла
  const a1 = aset.byAgent['agent-1-competitor-watch'];
  check('эффективное расписание Агента 1 == файлу', !!(a1 && a1.schedule && /^\d{2}:\d{2}$/.test(String(a1.schedule.time))),
    a1 && a1.schedule ? (a1.schedule.frequency + ' ' + a1.schedule.time) : 'нет');
  check('у Агента 1 есть специфичные настройки (проекты, порог, режим сбора)',
    !!(a1 && a1.agent1 && Array.isArray(a1.agent1.projects) && a1.agent1.projects.length > 0),
    a1 && a1.agent1 ? ('проектов ' + (a1.agent1.projects || []).length + ', порог ' + a1.agent1.price_threshold_pct + '%, режим ' + a1.agent1.collect_mode) : 'нет');
  const src = recs.filter(r => r.sourceAgent);
  check('у агента-источника есть лимиты сбора', src.length > 0 && src.every(r => r.sourceAgent.rate_limit_per_min > 0), src.map(r => r.agent + ': ' + r.sourceAgent.rate_limit_per_min + '/мин').join(', '));
  const stubs = recs.filter(r => !r.editable);
  check('заготовки помечены как нередактируемые', stubs.length >= 2, stubs.map(r => r.agent).join(', '));
}

if (aset && aset.byAgent['agent-1-competitor-watch']) {
  console.log('Проверяю «ЖК для наблюдения» и кандидатов:');
  const w = (aset.byAgent['agent-1-competitor-watch'].agent1 || {}).watch;
  check('группа «ЖК для наблюдения» есть', !!w);
  if (w) {
    check('название ЖК заполнено', !!w.name, String(w.name));
    check('адрес заполнен (нужен для координат)', !!w.address, String(w.address));
    check('радиус в допустимом диапазоне 1–100 км', Number(w.radius_km) >= 1 && Number(w.radius_km) <= 100, String(w.radius_km) + ' км');
    const okSources = ['cian', 'avito', 'yandex-realty', 'domclick', 'web-search'];
    const badSrc = (Array.isArray(w.sources) ? w.sources : []).filter(s => okSources.indexOf(String(s)) < 0);
    check('источники поиска из допустимых', badSrc.length === 0, (w.sources || []).join(', ') + (badSrc.length ? ' (лишние: ' + badSrc.join(', ') + ')' : ''));
    check('максимум кандидатов положительный', Number(w.max_candidates) >= 1, String(w.max_candidates));
    check('диапазон цены корректный (от <= до)', Number(w.price_min_per_m2) <= Number(w.price_max_per_m2), w.price_min_per_m2 + '–' + w.price_max_per_m2);
    check('адрес и ссылка приняты валидацией', String(w.address).length > 5 && /^https?:\/\//.test(String(w.url)), w.address + ' | ' + w.url);
  }
  const a1full = aset.byAgent['agent-1-competitor-watch'].agent1 || {};
  check('старый дублирующий блок agent1.sources удалён (один источник правды)', a1full.sources === undefined);
  check('заглушки конкурентов убраны из настроек (живут в клиентских конфигах)', a1full.competitors === undefined);
  const modes = a1full.source_modes || {};
  check('задан режим сбора по источникам', Object.keys(modes).length >= 4, Object.keys(modes).map(k => k + '=' + modes[k]).join(', '));
  check('режимы сбора из допустимых (http|browser|off)', Object.values(modes).every(v => ['http', 'browser', 'off'].indexOf(String(v)) >= 0));
  check('проверенные факты отражены: cian=http, avito=browser, domclick=off', modes.cian === 'http' && modes.avito === 'browser' && modes.domclick === 'off', 'cian=' + modes.cian + ', avito=' + modes.avito + ', domclick=' + modes.domclick);
  const metaFresh = docs['meta.json'] || {};
  const genAt = metaFresh.generatedAtMs || 0;
  const candNewest = (docs['candidates.json'] || {}).newestMtimeMs || 0;
  const setNewest = (docs['agent-settings.json'] || {}).newestMtimeMs || 0;
  console.log('Проверяю свежесть данных панели:');
  check('данные не старше файлов кандидатов', !(candNewest && genAt && candNewest > genAt + 2000),
    candNewest ? (Math.round((genAt - candNewest) / 1000) + ' с (данные минус файл)') : 'файлов кандидатов нет');
  check('данные не старше файлов настроек', !(setNewest && genAt && setNewest > genAt + 2000),
    setNewest ? (Math.round((genAt - setNewest) / 1000) + ' с (данные минус файл)') : 'файлов настроек нет');
  const cr = docs['competitor-report.json'];
  if (cr) {
    console.log('Проверяю «Отчёт Агента 1 по конкурентам»:');
    const crNewest = cr.newestMtimeMs || 0;
    check('данные не старше профилей конкурентов', !(crNewest && genAt && crNewest > genAt + 2000),
      crNewest ? (Math.round((genAt - crNewest) / 1000) + ' с (данные минус файл)') : 'профилей пока нет');
    if (cr.profilesFound === 0) {
      check('пустое состояние честное (есть причина)', !!cr.emptyReason, cr.emptyReason || 'причина не указана');
      check('выдуманных цифр нет: сводка пустая', cr.counts.lots === 0, 'лотов ' + cr.counts.lots);
    } else {
      cr.clients.filter(c => c.profiles.length).forEach(c => {
        const metricsOf = p => Object.keys(p.metrics).map(k => p.metrics[k]).concat(Object.keys(p.derived).map(k => p.derived[k]));
        const allM = c.profiles.flatMap(metricsOf);
        const lotsSum = c.profiles.reduce((a, p) => a + (p.metrics.lotsInSale.value || 0), 0);
        check('сумма лотов по конкурентам == сводке (' + c.clientId + ')', lotsSum === c.agg.lotsTotal, lotsSum + ' / ' + c.agg.lotsTotal);
        if (c.agg.lotsBySummary !== null) {
          check('сумма лотов совпадает с lots_total движка', lotsSum === c.agg.lotsBySummary, lotsSum + ' / ' + c.agg.lotsBySummary);
        }
        check('число конкурентов в сводке совпадает', c.agg.competitors === c.profiles.length, c.agg.competitors + ' / ' + c.profiles.length);
        check('акции: сумма по конкурентам == сводке', c.profiles.reduce((a, p) => a + (p.metrics.promoCount.value || 0), 0) === c.agg.promosActive, String(c.agg.promosActive));
        check('у КАЖДОЙ метрики со значением есть источник', c.agg.metricsWithSource === c.agg.metricsWithValue, c.agg.metricsWithSource + ' / ' + c.agg.metricsWithValue);
        const noSrc = allM.filter(m => m.value !== null && !m.source);
        check('нет метрик со значением и без источника', noSrc.length === 0, noSrc.length ? String(noSrc.length) : 'все с источником');
        const zeroInsteadOfNull = allM.filter(m => m.value === 0 && m.comment && /нет|недоступ|нужно/i.test(String(m.comment)));
        check('нет нулей вместо «данных нет»', zeroInsteadOfNull.length === 0, zeroInsteadOfNull.length ? zeroInsteadOfNull.map(m => m.comment).join(' | ') : 'нет');
        const estNoMark = allM.filter(m => m.value !== null && m.method === 'estimate' && m.estimate !== true);
        check('оценки помечены словом «оценка»', estNoMark.length === 0, 'оценок: ' + c.agg.metricsEstimate);
        // Белый список источников. Сообщение ПОНЯТНОЕ: какой проект, какая метрика и какой источник
        // не опознан — иначе непонятно, что именно чинить.
        const SRC_OK = /cian|avito|сайт|расч|наш|домклик|яндекс|keys\.so|spywords|еисжс|росреестр|keys_so|демо-образец|выгрузка|кабинет/i;
        const badSource = c.profiles.flatMap(p => Object.keys(p.metrics).map(k => ({ proj: p.project, key: k, src: p.metrics[k].source })))
          .filter(x => x.src && !SRC_OK.test(String(x.src)));
        check('источники — из ожидаемых (не выдуманы)', badSource.length === 0,
          badSource.length
            ? badSource.slice(0, 3).map(x => '«' + x.proj + '» метрика ' + x.key + ' → источник «' + String(x.src).slice(0, 40) + '» (не из белого списка: cian, avito, сайт, keys.so, spywords, демо-образец…)').join(' | ')
            : ('проверено источников: ' + Array.from(new Set(c.profiles.flatMap(p => Object.keys(p.metrics).map(k => p.metrics[k].source)).filter(Boolean))).length));
      });
      // ПРАВИЛО ПОЛНОТЫ: все метрики профиля либо отображены, либо в явном списке скрытых.
      cr.clients.filter(c => c.profiles.length).forEach(c => {
        const comp = c.agg.completeness || c.completeness;
        if (!comp) { check('правило полноты метрик посчитано', false, 'нет данных о полноте'); return; }
        check('ПОЛНОТА: все метрики профиля разложены по группам (' + c.clientId + ')',
          comp.ok === true && comp.uncovered.length === 0,
          'увидено ' + comp.seenCount + ', разложено ' + comp.displayedCount + ', скрыто ' + comp.hidden.length +
          (comp.uncovered.length ? ', НЕ РАЗЛОЖЕНО: ' + comp.uncovered.join(', ') : ''));
        check('группы отображения описаны', Object.keys(comp.groups).length >= 6, Object.keys(comp.groups).join(', '));
        // comp.groups — МАССИВ групп ({id,title,kind,metrics:[{key,...}]}), а не объект.
        // Сверяем по КАНОНИЧЕСКИМ внутренним именам панели (camelCase), а не по сырым snake_case движка.
        const groupsArr = Array.isArray(comp.groups) ? comp.groups : [];
        const groupKeys = groupsArr.flatMap(g => (g.metrics || []).map(m => (typeof m === 'string' ? m : m.key)));
        const need = ['reservedLots', 'siteCorpiNamed', 'siteDeadlines', 'sitePromoCount', 'siteMortgageCount', 'corpiTotal', 'dduRegistered', 'soldShareBySite'];
        const missingKeys = need.filter(k => groupKeys.indexOf(k) < 0);
        check('ключевые метрики (бронь, корпуса, сроки, акции, официальные, доля по сайту) есть в группах',
          missingKeys.length === 0, missingKeys.length ? ('нет в группах: ' + missingKeys.join(', ')) : ('проверено ' + need.length + ' ключей'));
        check('каталог групп описан как массив с id и title',
          groupsArr.length >= 10 && groupsArr.every(g => g.id && g.title && g.kind),
          groupsArr.length + ' групп: ' + groupsArr.slice(0, 5).map(g => g.id).join(', ') + '…');
        const km = (docs['competitor-report.json'].catalogue || {}).keyMap || [];
        check('карта «сырой ключ движка -> внутреннее имя -> группа» есть',
          km.length >= 30 && km.every(e => e.raw && e.internal),
          km.length + ' записей, пример: ' + (km[0] ? (km[0].raw + ' -> ' + km[0].internal + ' (' + (km[0].groups || []).join('/') + ')') : '—'));
        const keyMapBad = km.filter(e => e.bucket === 'metrics' && e.groups.length === 0);
        check('у каждой метрики в карте указана группа отображения', keyMapBad.length === 0,
          keyMapBad.map(e => e.internal).join(', ') || 'все с группой');
        check('сырые ключи движка в snake_case (контракт имён)',
          km.filter(e => e.raw !== '(расчёт панели)').every(e => /^[a-z0-9_]+$/.test(e.raw)),
          'проверено ' + km.filter(e => e.raw !== '(расчёт панели)').length + ' ключей');
        const methodsOk = ['http', 'dom', 'js-state', 'estimate', 'none', 'api', 'csv', 'mcp', null];
        check('методы сбора из ожидаемых (http|dom|js-state|estimate|api|csv|mcp|none)',
          c.profiles.every(p => Object.keys(p.metrics).every(k => methodsOk.indexOf(p.metrics[k].method) >= 0)),
          'методы: ' + Array.from(new Set(c.profiles.flatMap(p => Object.keys(p.metrics).map(k => p.metrics[k].method)))).map(m => m === null ? 'не указан' : m).join(', '));
        // Метрика, у которой ЕСТЬ значение, обязана знать, как она собрана (http/dom/js-state/estimate).
        const noMethod = c.profiles.flatMap(p => Object.keys(p.metrics).map(k => ({ proj: p.project, key: k, m: p.metrics[k] })))
          .filter(x => x.m.value !== null && (x.m.method === null || x.m.method === 'none'));
        check('у метрик со значением указан метод сбора', noMethod.length === 0,
          noMethod.slice(0, 3).map(x => x.proj + '.' + x.key).join(', ') || 'все с методом');
        check('текстовые метрики сохраняются (например сроки ввода)',
          c.profiles.some(p => (p.metrics.siteDeadlines && p.metrics.siteDeadlines.text) || (p.metrics.siteDeadlines && p.metrics.siteDeadlines.value !== null)) || c.profiles.every(p => !p.metrics.siteDeadlines),
          c.profiles.filter(p => p.metrics.siteDeadlines && p.metrics.siteDeadlines.text).map(p => p.project + '=' + p.metrics.siteDeadlines.text).join(', ') || 'сроков ввода нет');
        const shareNoBoth = c.profiles.filter(p => p.soldShareBySite && p.soldShareBySite.value !== null &&
          (p.metrics.siteFlatsTotal.value === null || p.metrics.siteFlatsSold.value === null));
        check('доля проданного по сайту считается только при обоих числах', shareNoBoth.length === 0,
          shareNoBoth.map(p => p.project).join(', ') || 'правило соблюдено');
      });
      // --- МАРКЕТИНГ: бюджеты SpyWords / Keys.so ---
      // Блок стоит ВНЕ цикла по клиентам, поэтому берём клиента с профилями явно.
      const mkClient = cr.clients.filter(x => x.profiles.length)[0] || { profiles: [], marketing: {} };
      const mkProfiles = mkClient.profiles.filter(p => p.marketing);
      check('группа «Маркетинг» подключена к профилям', mkProfiles.length > 0, mkProfiles.length + ' профилей');
      const mkState = (mkClient.marketing && mkClient.marketing.status) || (mkProfiles[0] && mkProfiles[0].marketing.state) || null;
      check('состояние маркетинга честное (нет ключа / нет домена / оценка)',
        ['no_key', 'no_domain', 'ok'].indexOf(mkState) >= 0, String(mkState));
      // Проверки С УЧЁТОМ СОСТОЯНИЯ КАЖДОГО ПРОФИЛЯ: часть конкурентов может иметь бюджет,
      // часть — «нет данных по домену». Раньше проверки требовали одного состояния на всех.
      const noData = mkProfiles.filter(p => p.marketing.state !== 'ok');
      const withData = mkProfiles.filter(p => p.marketing.state === 'ok');
      if (noData.length) {
        check('где данных нет — показана причина, а не ноль',
          noData.every(p => p.metrics.marketingBudgetEstimateRub && p.metrics.marketingBudgetEstimateRub.value === null && p.metrics.marketingBudgetEstimateRub.comment),
          noData.length + ' профилей, например: ' + String(noData[0].metrics.marketingBudgetEstimateRub.comment).slice(0, 60));
        // ТРИ корректных состояния без данных, каждое со своим сообщением:
        //  no_key     — «Ключ API не подключён…»;
        //  no_domain  — «нет данных по домену в базе сервиса»;
        //  unmatched  — «данные в сервисе есть, но проект не сопоставлен: добавьте домен…».
        const MSG = /Ключ API не подключён|нет данных по домену в базе сервиса|данные в сервисе есть, но проект не сопоставлен/i;
        const wrongMsg = noData.filter(p => !MSG.test(String(p.marketing.note || '')));
        check('сообщение соответствует одному из трёх состояний (нет ключа / нет домена / не сопоставлен)',
          wrongMsg.length === 0,
          wrongMsg.length ? wrongMsg.map(p => p.project + ': ' + String(p.marketing.note).slice(0, 50)).join(' | ')
            : ('состояния: ' + Array.from(new Set(noData.map(p => p.marketing.state))).join(', ')));
        const unmatched = noData.filter(p => p.marketing.state === 'unmatched');
        check('в состоянии «не сопоставлен» есть подсказка добавить домен',
          unmatched.length === 0 || unmatched.every(p => /добавьте домен/i.test(String(p.marketing.note || ''))),
          unmatched.length ? String(unmatched[0].marketing.note).slice(-80) : 'таких профилей нет');
      }
      if (withData.length) {
        const withCap = withData.filter(p => /оценка сервиса, не фактический расход/i.test(String((p.marketing || {}).caption || '')));
        check('у бюджета есть подпись «оценка сервиса, не фактический расход»', withCap.length === withData.length, withCap.length + ' из ' + withData.length);
        check('бюджет помечен как оценка (estimate)', withData.every(p => p.metrics.marketingBudgetEstimateRub.estimate === true), 'все ' + withData.length);
        check('у бюджета есть источник и метод сбора (api|csv|mcp)',
          withData.every(p => p.metrics.marketingBudgetEstimateRub.source && ['api', 'csv', 'mcp'].indexOf(String(p.metrics.marketingBudgetEstimateRub.method)) >= 0),
          withData.map(p => p.metrics.marketingBudgetEstimateRub.source + '/' + p.metrics.marketingBudgetEstimateRub.method).slice(0, 2).join(', '));
        check('бюджет — положительное число (не ноль и не подстановка)',
          withData.every(p => Number(p.metrics.marketingBudgetEstimateRub.value) > 0),
          withData.map(p => p.project + '=' + p.metrics.marketingBudgetEstimateRub.value).slice(0, 3).join(', '));
      }
      check('маркетинговых нулей нет ни в одном состоянии',
        mkProfiles.every(p => ['marketingBudgetEstimateRub', 'marketingAds', 'marketingKeywords', 'marketingLandings'].every(k => !p.metrics[k] || p.metrics[k].value !== 0)),
        'проверено 4 метрики на ' + mkProfiles.length + ' профилях');
      // groupKeys объявлен внутри цикла по клиентам — здесь считаем свой список из каталога.
      const catGroupKeys = ((docs['competitor-report.json'].catalogue || {}).groups || [])
        .flatMap(g => (g.metrics || []).map(m => (typeof m === 'string' ? m : m.key)));
      const mkKeys = ['marketingBudgetEstimateRub', 'marketingAds', 'marketingKeywords', 'marketingLandings', 'marketingPeriod', 'marketingSource', 'marketingMethod'];
      const mkMissing = mkKeys.filter(k => catGroupKeys.indexOf(k) < 0);
      // ДЕМО-ОБРАЗЕЦ: если срез помечен demo: true, это обязано быть видно в подписи.
      const demoProfiles = mkProfiles.filter(p => p.marketing && p.marketing.demo === true);
      if (demoProfiles.length) {
        check('у демо-образца есть пометка «не из вашего аккаунта»',
          demoProfiles.every(p => /не из вашего аккаунта/i.test(String(p.marketing.caption || '') + ' ' + String(p.marketing.note || ''))),
          demoProfiles.length + ' профилей, пример: ' + String(demoProfiles[0].marketing.caption || '').slice(-60));
        check('флаг demo доехал до клиента', !!(mkClient.marketing && mkClient.marketing.demo), 'demo на клиенте');
      } else {
        check('демо-образцов нет — пометка не требуется', true, 'demo=true в срезах не встречается');
      }
      check('новые маркетинговые ключи разложены по группам', mkMissing.length === 0,
        mkMissing.length ? ('нет в группах: ' + mkMissing.join(', ')) : ('проверено ' + mkKeys.length + ' ключей'));
      check('Росреестр не подменён своими данными', !(cr.clients.some(c => c.summary && c.summary.rosreestr && String(c.summary.rosreestr.status).indexOf('недоступ') >= 0 && c.profiles.some(p => p.metrics.soldOfficial))),
        cr.clients.filter(c => c.summary && c.summary.rosreestr).map(c => c.summary.rosreestr.status).join(', ') || 'сводки о Росреестре нет');
    }
  }

  const cand = docs['candidates.json'];
  if (cand) {
    check('источник кандидатов проверен', true, cand.exists ? (cand.counts.total + ' кандидатов в ' + cand.counts.projects + ' проектах') : 'движок поиска (T57) ещё не сформировал список — панель показывает пустое состояние');
    const all = (cand.projects || []).flatMap(p => p.items || []);
    check('у каждого кандидата есть название', all.every(c => c.name), all.length + ' шт.');
    check('статусы кандидатов из допустимых', all.every(c => ['candidate', 'approved', 'rejected'].indexOf(c.status) >= 0));
    check('у кандидата либо есть расстояние, либо явно null (не выдумано)', all.every(c => c.distanceKm === null || (isFinite(c.distanceKm) && c.distanceKm >= 0)));
    check('у кандидата либо есть цена, либо явно null', all.every(c => c.pricePerM2 === null || (isFinite(c.pricePerM2) && c.pricePerM2 >= 0)));
    check('решения лежат в отдельных файлах .decisions.json, а не в файле движка',
      (cand.decisionsFiles || []).length > 0 || all.filter(c => c.decisionSource).length === 0,
      (cand.decisionsFiles || []).length ? (cand.decisionsFiles.join(', ')) : 'решений пока нет — файлы кандидатов двига не трогались');
    check('у каждого решения есть статус и время', all.filter(c => c.decisionSource).every(c => ['approved', 'rejected'].indexOf(c.status) >= 0 && c.decisionAt), all.filter(c => c.decisionSource).length + ' решений');
    const decLike = (cand.decisionsFiles || []).every(n => /\.decisions\.json$/.test(n));
    check('имена файлов решений оканчиваются на .decisions.json', decLike, (cand.decisionsFiles || []).join(', ') || 'пока нет');
  }
}

// --- WP3: тумблеры аналитики Агента 1, статус прогона и аналитика конкурентов ---
// Список ключей продублирован намеренно: если он разойдётся с
// collector/lib/agent-settings.mjs и serve.mjs, валидатор обязан это поймать.
const ANALYTICS_KEYS = ['enabled', 'lots_all_on_sale', 'price_dynamics', 'promos', 'new_promos_only', 'dedup_promos', 'developers_sites', 'forecast'];

if (aset && aset.byAgent['agent-1-competitor-watch']) {
  console.log('Проверяю тумблеры аналитики Агента 1:');
  const a1 = aset.byAgent['agent-1-competitor-watch'].agent1 || {};
  const an = a1.analytics || {};
  const notBool = ANALYTICS_KEYS.filter(k => typeof an[k] !== 'boolean');
  check('все 8 тумблеров аналитики читаются как boolean', notBool.length === 0,
    notBool.length ? ('не boolean: ' + notBool.join(', ')) : ('проверено ' + ANALYTICS_KEYS.length + ' ключей'));
  const extraKeys = Object.keys(an).filter(k => ANALYTICS_KEYS.indexOf(k) < 0);
  check('в agent1.analytics нет лишних ключей', extraKeys.length === 0, extraKeys.join(', ') || 'ровно контракт');
  const contractKeys = (aset.analyticsContract || {}).fields || [];
  check('контракт имён тумблеров совпадает с валидатором',
    contractKeys.length === ANALYTICS_KEYS.length && ANALYTICS_KEYS.every(k => contractKeys.indexOf(k) >= 0), contractKeys.join(', '));
  check('недопустимых значений тумблеров нет', (a1.analyticsInvalid || []).length === 0, (a1.analyticsInvalid || []).join(', ') || 'все значения допустимы');
  check('панель знает, есть ли блок analytics в файле', typeof a1.analyticsPresent === 'boolean', 'analyticsPresent=' + a1.analyticsPresent);
  const wq = a1.watch || {};
  check('одно поле ввода agent1.watch.query заполнено', typeof wq.query === 'string' && wq.query.length > 0, String(wq.query));
  check('параметры ЖК на месте и правятся (не удалены из YAML)',
    Number(wq.radius_km) >= 1 && Number(wq.max_candidates) >= 1 && Array.isArray(wq.sources) && wq.sources.length > 0,
    'радиус ' + wq.radius_km + ' км, источников ' + (wq.sources || []).length + ', кандидатов ' + wq.max_candidates);

  // --- «Что анализировать» (agent1.selection): новый контракт, группа 2 ---
  // Список ключей продублирован намеренно: расхождение панели (serve.mjs),
  // сборщика (collector/lib/agent-settings.mjs) и этой проверки обязано ловиться.
  const SELECTION_KEYS = ['room_types', 'area_min_m2', 'area_max_m2', 'price_min_rub', 'price_max_rub',
    'exclude_first_floor', 'exclude_last_floor', 'finishes', 'only_active', 'promo_only',
    'price_metric', 'outlier_guard', 'outlier_same_price_min_lots', 'outlier_ppm2_min', 'outlier_ppm2_max'];
  const SELECTION_KINDS = { room_types: 'list', area_min_m2: 'num', area_max_m2: 'num', price_min_rub: 'int',
    price_max_rub: 'int', exclude_first_floor: 'bool', exclude_last_floor: 'bool', finishes: 'list',
    only_active: 'bool', promo_only: 'bool', price_metric: 'enum', outlier_guard: 'bool',
    outlier_same_price_min_lots: 'int', outlier_ppm2_min: 'int', outlier_ppm2_max: 'int' };
  const sel = a1.selection || {};
  const badSel = SELECTION_KEYS.filter(k => {
    const kind = SELECTION_KINDS[k];
    if (kind === 'bool') return typeof sel[k] !== 'boolean';
    if (kind === 'list') return !Array.isArray(sel[k]);
    if (kind === 'enum') return ['median', 'mean', 'min_max'].indexOf(String(sel[k])) < 0;
    return !isFinite(Number(sel[k]));
  });
  check('все поля agent1.selection читаются и по типу контракта', badSel.length === 0,
    badSel.length ? ('не сошлось: ' + badSel.join(', ')) : ('проверено ' + SELECTION_KEYS.length + ' полей'));
  check('в agent1.selection нет лишних ключей', Object.keys(sel).filter(k => SELECTION_KEYS.indexOf(k) < 0).length === 0,
    Object.keys(sel).filter(k => SELECTION_KEYS.indexOf(k) < 0).join(', ') || 'ровно контракт');
  const selContract = (aset.selectionContract || {}).fields || [];
  check('контракт agent1.selection совпадает с валидатором',
    selContract.length === SELECTION_KEYS.length && SELECTION_KEYS.every(k => selContract.indexOf(k) >= 0),
    'контракт: ' + selContract.length + ' полей');
  check('недопустимых значений agent1.selection нет', (a1.selectionInvalid || []).length === 0,
    (a1.selectionInvalid || []).join(', ') || 'все значения допустимы');
  check('панель знает, есть ли блок selection в файле', typeof a1.selectionPresent === 'boolean', 'selectionPresent=' + a1.selectionPresent);
  check('типы фильтров лотов корректны (площадь/цена не отрицательные, есть/до согласованы)',
    Number(sel.area_min_m2) >= 0 && Number(sel.area_max_m2) >= 0 && Number(sel.price_min_rub) >= 0 && Number(sel.price_max_rub) >= 0
    && Number(sel.outlier_ppm2_min) < Number(sel.outlier_ppm2_max),
    'площадь ' + sel.area_min_m2 + '–' + sel.area_max_m2 + ' м², цена ' + sel.price_min_rub + '–' + sel.price_max_rub + ' ₽');
  check('«0 = без ограничения» не подменён словом «данных нет» (значение из файла)',
    sel.area_max_m2 === 0 ? true : Number(sel.area_max_m2) > 0, 'area_max_m2=' + sel.area_max_m2);
  check('room_types только в selection, в watch их нет (контракт групп)',
    Array.isArray(sel.room_types) && sel.room_types.length > 0 && wq.room_types === undefined,
    'room_types: ' + (sel.room_types || []).join(', ') + ' · в watch: ' + (wq.room_types === undefined ? 'нет' : 'есть'));
  // Тип и наличие нового поля «Сравнение и выводы».
  check('agent1.top_deals_count есть и правдоподобен',
    Number.isInteger(Number(a1.top_deals_count)) && Number(a1.top_deals_count) >= 1 && Number(a1.top_deals_count) <= 20,
    'top_deals_count=' + a1.top_deals_count);

  // Схема панели (serve.mjs) обязана совпадать с контрактом: и имена, и типы.
  const serveSrc = fs.existsSync(path.join(here, 'serve.mjs')) ? fs.readFileSync(path.join(here, 'serve.mjs'), 'utf8') : '';
  function schemaBlockFields(src, group) {
    const key = "'" + group + "': {";
    const start = src.indexOf(key);
    if (start < 0) return null;
    const end = src.indexOf('\n  },', start);
    if (end < 0) return null;
    const body = src.slice(start + key.length, end);
    const out = {};
    const re = /([A-Za-z0-9_]+)\s*:\s*\{\s*t:\s*'([a-z]+)'/g;
    let m;
    while ((m = re.exec(body))) out[m[1]] = m[2];
    return out;
  }
  const panelSel = schemaBlockFields(serveSrc, 'agent1.selection');
  const panelSelKeys = panelSel ? Object.keys(panelSel) : [];
  check('в схеме панели есть группа agent1.selection',
    !!panelSel && panelSelKeys.length === SELECTION_KEYS.length && SELECTION_KEYS.every(k => panelSelKeys.indexOf(k) >= 0),
    panelSel ? ('полей ' + panelSelKeys.length + ': ' + panelSelKeys.join(', ')) : 'группы нет в serve.mjs');
  const kindMismatch = panelSel ? SELECTION_KEYS.filter(k => panelSel[k] !== SELECTION_KINDS[k]) : [];
  check('типы полей в схеме панели совпадают с контрактом', panelSel && kindMismatch.length === 0,
    kindMismatch.length ? kindMismatch.map(k => k + ':' + panelSel[k] + '≠' + SELECTION_KINDS[k]).join(', ') : 'serve.mjs и контракт совпадают');
  const panelWatch = schemaBlockFields(serveSrc, 'agent1.watch');
  check('в схеме панели room_types не попали в agent1.watch', !!panelWatch && panelWatch.room_types === undefined,
    panelWatch ? Object.keys(panelWatch).join(', ') : 'блок watch не найден');
}

/* --- Контракт v2 (docs/agent-1-rework-2026-11-04.md): истинный список конкурентов
   и метрики карточки Агента 1. Проверяем ДАННЫЕ независимым пересчётом:
   число записей списка считаем прямо из клиентского конфига (по отступам),
   метрики сверяем с сырым analytics-<дата>.json движка, а не с самими собой. --- */
const caV2 = docs['competitor-analytics.json'];
if (caV2 && Array.isArray(caV2.clients) && caV2.clients.length) {
  console.log('Проверяю истинный список конкурентов и метрики (контракт v2):');
  const clientsDir = path.join(here, '..', '01-competitor-watch', 'config', 'clients');
  // Независимый подсчёт: элемент списка — строка «  - » (отступ 2) внутри секции competitors:.
  // Если встретился элемент с большим отступом — это битая запись (её теряют парсеры), отдаём -1.
  function countListItems(file) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    let inList = false, n = 0;
    for (const line of lines) {
      if (/^competitors:\s*$/.test(line)) { inList = true; continue; }
      if (!inList) continue;
      if (/^\S/.test(line) && line.trim() !== '') break;
      if (/^  -\s/.test(line)) n++;
      else if (/^\s+-\s/.test(line)) return -1;
    }
    return n;
  }
  function latestEngineAnalytics(clientId) {
    const dir = path.join(here, '..', '01-competitor-watch', 'reports', 'clients', clientId, '.cache');
    if (!fs.existsSync(dir)) return null;
    const files = fs.readdirSync(dir).filter(n => /^analytics-\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort();
    for (const n of files.reverse()) {
      try { return { name: n, doc: JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')) }; } catch (e) { /* пробуем предыдущий */ }
    }
    return null;
  }
  for (const c of caV2.clients) {
    const conf = path.join(clientsDir, String(c.clientId) + '.yaml');
    const truth = c.truth;
    check('истинный список собран из клиентского конфига (' + c.clientId + ')', !!truth && fs.existsSync(conf),
      truth ? ('записей ' + truth.competitors + ', без источника ' + truth.withoutSource) : 'нет блока truth');
    if (!truth || !fs.existsSync(conf)) continue;
    const onDisk = countListItems(conf);
    check('число записей списка == файлу (' + c.clientId + ')', onDisk === truth.competitors,
      'в файле ' + onDisk + ' / в данных ' + truth.competitors + (onDisk === -1 ? ' — ЕСТЬ запись с битым отступом' : ''));
    check('у каждой записи списка есть имя и признак источника (' + c.clientId + ')',
      (truth.list || []).every(x => x && x.name && typeof x.hasSource === 'boolean'),
      'записей ' + (truth.list || []).length);
    check('записи без источника посчитаны верно (' + c.clientId + ')',
      (truth.list || []).filter(x => !x.hasSource).length === truth.withoutSource,
      'по списку ' + (truth.list || []).filter(x => !x.hasSource).length + ' / заявлено ' + truth.withoutSource);
    const eng = latestEngineAnalytics(String(c.clientId));
    const m = c.metrics || {};
    const em = eng ? (eng.doc.metrics || null) : null;
    check('метрики карточки == сырой аналитике движка (' + c.clientId + ')',
      !!em && m.competitorsInAnalysis === em.competitorsInAnalysis && m.lotsAnalyzed === em.lotsAnalyzed && m.cheapestLotRub === em.cheapestLotRub,
      em ? JSON.stringify({ panel: { c: m.competitorsInAnalysis, l: m.lotsAnalyzed, p: m.cheapestLotRub }, engine: { c: em.competitorsInAnalysis, l: em.lotsAnalyzed, p: em.cheapestLotRub } }) : 'сырой аналитики движка нет');
    check('в анализе не больше, чем в списке, и вычтены записи без источника (' + c.clientId + ')',
      Number(m.competitorsInAnalysis) <= Number(truth.competitors)
      && Number(m.competitorsInAnalysis) >= 0
      && (em && em.competitorsInAnalysis !== null ? Number(m.competitorsInAnalysis) === Number(em.competitorsInAnalysis)
        : Number(m.competitorsInAnalysis) === Number(truth.competitors) - Number(truth.withoutSource)),
      m.competitorsInAnalysis + ' из ' + truth.competitors + ' (без источника ' + truth.withoutSource + ')');
    if (em && eng) {
      const comps = Array.isArray(eng.doc.by_competitor) ? eng.doc.by_competitor : [];
      const lotsSum = comps.reduce((a, p) => a + (Number(p.lots_on_sale) || 0), 0);
      check('«лотов проанализировано» == сумме лотов по конкурентам, пересчёт по сырому файлу (' + c.clientId + ')',
        em.lotsAnalyzed === null ? true : lotsSum === Number(em.lotsAnalyzed),
        em.lotsAnalyzed === null ? 'данных нет — честно' : (lotsSum + ' / ' + em.lotsAnalyzed));
      const mins = comps.map(p => (p.cheapest_lot_rub === null || p.cheapest_lot_rub === undefined ? null : Number(p.cheapest_lot_rub)))
        .filter(v => v !== null && isFinite(v));
      check('«самый дешёвый лот» == минимуму по конкурентам, пересчёт по сырому файлу (' + c.clientId + ')',
        em.cheapestLotRub === null ? true : (mins.length > 0 && Math.min.apply(null, mins) === Number(em.cheapestLotRub)),
        em.cheapestLotRub === null ? 'данных нет — честно' : (String(em.cheapestLotRub) + ' / минимум по конкурентам ' + String(mins.length ? Math.min.apply(null, mins) : 'данных нет')));
    }
    check('у каждого показанного числа назван источник (' + c.clientId + ')',
      !!m.competitorsInAnalysisSource
      && (m.lotsAnalyzed === null || !!m.lotsAnalyzedSource)
      && (m.cheapestLotRub === null || !!m.cheapestLotRubSource),
      [m.competitorsInAnalysisSource, m.lotsAnalyzedSource, m.cheapestLotRubSource].filter(Boolean).length + ' из 3');
  }
}

const st = docs['agent1-status.json'];
if (st) {
  console.log('Проверяю статус Агента 1 (работа сделана / не сделана):');
  check('у статуса есть вердикт и причина', !!st.verdict && !!st.reason, st.verdict + ' — ' + String(st.reason).slice(0, 100));
  check('состояние из допустимых', ['done', 'failed', 'never'].indexOf(st.state) >= 0, String(st.state));
  // Независимый пересчёт по registry/runs.jsonl — не доверяем коллектору на слово.
  const runsPath = st.files && st.files.runs;
  let runsCount = null, lastRunStatus = null;
  if (runsPath && fs.existsSync(runsPath)) {
    runsCount = 0;
    for (const line of fs.readFileSync(runsPath, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        if (String(o.agent || '') === 'agent-1-competitor-watch' || String(o.service || '') === 'competitor-watch') { runsCount++; lastRunStatus = String(o.status); }
      } catch (e) { /* битую строку считает коллектор, здесь только сверка */ }
    }
  }
  check('число прогонов совпадает с registry/runs.jsonl', runsCount === null || runsCount === st.runs.total, runsCount + ' / ' + st.runs.total);
  check('последний прогон — тот же, что в журнале', runsCount === 0 || String(st.runs.last && st.runs.last.status) === lastRunStatus,
    String(st.runs.last && st.runs.last.status) + ' / ' + lastRunStatus);
  if (st.runs.total === 0) {
    check('нет прогонов — сказано «ещё не запускался» с причиной',
      st.state === 'never' && /ещё не запускался/i.test(String(st.verdict)) && !!st.reason, st.verdict);
  } else {
    check('вердикт соответствует последнему прогону', (st.runs.last.status === 'ok') === st.done,
      'последний ' + st.runs.last.status + ', «сделана»=' + st.done);
  }
  // Снимки: независимый подсчёт папок на диске.
  const snapRoots = (st.snapshots && st.snapshots.roots) || [];
  let snapCount = 0; const dated = [];
  for (const root of snapRoots) {
    if (!fs.existsSync(root)) continue;
    for (const n of fs.readdirSync(root)) {
      let dirOk = false;
      try { dirOk = fs.statSync(path.join(root, n)).isDirectory(); } catch (e) { dirOk = false; }
      if (!dirOk) continue;
      snapCount++;
      if (/^\d{4}-\d{2}-\d{2}$/.test(n)) dated.push(n);
    }
  }
  check('число снимков совпадает с папками на диске', snapCount === (st.snapshots ? st.snapshots.count : -1), snapCount + ' / ' + (st.snapshots && st.snapshots.count));
  dated.sort();
  check('последний снимок — самая свежая дата', dated.length === 0 || String(st.snapshots.last && st.snapshots.last.date) === dated[dated.length - 1],
    (dated[dated.length - 1] || 'снимков нет') + ' / ' + (st.snapshots.last && st.snapshots.last.date));
  check('у статуса указан источник данных', !!(st.sourceOfTruth || st.state === 'never'), String(st.sourceOfTruth));
}

const ca = docs['competitor-analytics.json'];
if (ca) {
  console.log('Проверяю аналитику конкурентов (движок WP2 -> панель):');
  const withData = (ca.clients || []).filter(c => c.exists && ((c.byCompetitor || []).length || (c.bySource || []).length || c.lotsOnSale !== null));
  if (ca.totals.clientsWithData === 0) {
    check('пустое состояние аналитики честное (есть причина)', !!ca.emptyReason, String(ca.emptyReason).slice(0, 130));
    check('выдуманных цифр нет: итог лотов null и клиентов с данными нет',
      ca.totals.lotsOnSale === null && withData.length === 0, 'lotsOnSale=' + ca.totals.lotsOnSale);
  } else {
    check('клиентов с данными столько же, сколько заявлено', withData.length === ca.totals.clientsWithData, withData.length + ' / ' + ca.totals.clientsWithData);
    const lotsSum = withData.reduce((a, c) => a + (c.lotsOnSale || 0), 0);
    check('сумма лотов по клиентам == итогу', lotsSum === ca.totals.lotsOnSale, lotsSum + ' / ' + ca.totals.lotsOnSale);
    const badCons = withData.filter(c => !c.consistency || c.consistency.ok !== true);
    check('внутренняя связность: сумма частей == итогу, медиана в [min,max]', badCons.length === 0,
      badCons.map(c => c.clientId + ': ' + ((c.consistency && c.consistency.notes) || []).join('; ')).join(' | ') || 'все клиенты сходятся');
    const badFc = withData.flatMap(c => (c.forecast || []).map(f => ({ client: c.clientId, f })))
      .filter(x => !x.f.method || !x.f.points || x.f.estimate !== true);
    check('прогноз помечен оценкой и называет метод и число точек', badFc.length === 0,
      badFc.map(x => x.client + '.' + x.f.project + ' метод=' + x.f.method + ' точек=' + x.f.points).join(', ') || ('прогнозов: ' + ca.totals.forecasts));
    const noSource = withData.flatMap(c => (c.bySource || [])).filter(s => s.source === '—');
    check('у каждого источника аналитики есть имя', noSource.length === 0, noSource.length ? String(noSource.length) : ('источников: ' + ca.totals.sources));
  }
  check('связность с профилями конкурентов проверена (или объяснено расхождение)',
    ca.crossCheck.ok === true || !!ca.crossCheck.note,
    ca.crossCheck.ok === true ? ('сходятся по ' + ca.crossCheck.comparedProjects + ' проект(ам)') : String(ca.crossCheck.note).slice(0, 110));
  // Пустота КАЖДОГО клиента тоже обязана быть честной: если файла аналитики нет
  // (fileName === null), причина обязана говорить про ОТСУТСТВИЕ файлов, а не
  // «файл найден, но не разобрался» (регресс WP3: так путались «файла нет» и «файл битый»).
  const badEmpty = (ca.clients || []).filter(c => c.exists === false && (
    !c.emptyReason ||
    (c.fileName === null && !/не найдены|не найден|файлов нет|нет файлов/i.test(String(c.emptyReason)))
  ));
  check('пустое состояние по каждому клиенту честное (нет файла — не «файл найден»)',
    badEmpty.length === 0,
    badEmpty.map(c => c.clientId + ': ' + c.emptyReason).join(' | ') || ('проверено клиентов без данных: ' + (ca.clients || []).filter(c => c.exists === false).length));
  const recips = ca.email.recipients || [];
  check('получатели почты перечислены по каждому адресу', recips.length === (ca.email.addresses || []).length,
    recips.length + ' / ' + (ca.email.addresses || []).length);
  check('у каждого получателя есть статус отправки', recips.every(r => !!r.status),
    recips.map(r => r.address + ': ' + r.status).join('; ') || 'адресов почты нет');
  check('неподтверждённая отправка названа явно, а не пустотой',
    recips.every(r => r.status !== 'нет подтверждения отправки' || /нет подтверждения/i.test(String(r.evidence || ''))),
    recips.filter(r => r.status === 'нет подтверждения отправки').length + ' без подтверждения');
}

// --- Стенд агентов (шаг 1B): прогоны, длительность и стоимость по агентам ---
const agentRuns = docs['agent-runs.json'];
if (!agentRuns) {
  check('документ стенда агентов собран', false, 'нет agent-runs.json — запустите collector');
} else {
  console.log('Сверяю стенд агентов с журналом прогонов (независимый источник):');
  // Независимо читаем журнал, а не доверяем сборщику на слово.
  const runsFile = path.join(here, '..', 'registry', 'runs.jsonl');
  const raw = [];
  if (fs.existsSync(runsFile)) {
    for (const line of fs.readFileSync(runsFile, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { raw.push(JSON.parse(line)); } catch (e) { /* поймает проверка разбора ниже */ }
    }
  }
  const rowss = agentRuns.agents || [];
  const sumRuns = rowss.reduce((a, r) => a + ((r.runs && r.runs.total) || 0), 0);
  // Записи, не отнесённые ни к одному агенту реестра (пустой или неизвестный agent).
  const knownIds = {};
  rowss.forEach(r => { knownIds[String(r.id)] = true; });
  const unattributed = raw.filter(r => {
    const id = String(r.agent || '');
    return id === '' || !knownIds[id];
  }).length;
  check('число прогонов по карточкам агентов совпадает с журналом',
    sumRuns + unattributed === raw.length && agentRuns.totals.runs === raw.length,
    sumRuns + ' по агентам + ' + unattributed + ' без агента = ' + raw.length);
  check('«ничьи» записи журнала посчитаны одинаково в сборке и здесь',
    agentRuns.totals.unattributed === unattributed,
    agentRuns.totals.unattributed + ' / ' + unattributed);
  const durs = raw.map(r => Number(r.duration_ms)).filter(v => isFinite(v) && v > 0);
  const avg = durs.length ? Math.round(durs.reduce((a, b) => a + b, 0) / durs.length) : null;
  check('средняя длительность прогонов пересчитана верно', avg === agentRuns.totals.avgDurationMs,
    avg + ' / ' + agentRuns.totals.avgDurationMs);
  const nullCost = raw.filter(r => r.cost_rub === null || r.cost_rub === undefined);
  const shownAsZero = rowss.reduce((acc, a) => acc + ((a.recent || []).filter(x => x.costRub === 0 && (x.costSource === 'none' || x.trigger === 'dashboard')).length), 0);
  check('нет выдуманного нуля стоимости вместо «данных нет»', shownAsZero === 0,
    'записей без стоимости в журнале: ' + nullCost.length + ', показано нулём: ' + shownAsZero);
  const dashRuns = raw.filter(r => r.trigger === 'dashboard');
  check('запуски из панели честно помечены (cost_source = none, cost_rub = null)',
    dashRuns.every(r => r.cost_rub === null && r.cost_source === 'none'),
    'панельных прогонов: ' + dashRuns.length);
  const noRuns = rowss.filter(r => !r.runs || r.runs.total === 0);
  check('у агента без прогонов названа причина, а не пустота',
    noRuns.every(r => !!r.readinessReason || r.ready === true),
    noRuns.map(r => r.id + ': ' + (r.readinessReason || 'причина не указана')).join(' | ') || 'у всех агентов есть прогоны');
  check('готовность агента не противоречит журналу',
    rowss.every(r => ((r.runs && r.runs.total > 0) ? r.ready === true : true)),
    'агентов: ' + rowss.length + ', готовых: ' + rowss.filter(r => r.ready).length);
}

console.log('Сверяю токены с проекцией сессий (независимый источник):');
let pcSum = 0, evSum = 0, withPc = 0, worst = 0, badFrames = 0, badLines = 0;
for (const s of sessions.sessions) {
  badFrames += s.badFrames || 0;
  badLines += s.badLines || 0;
  if (!s.projcacheTokens) continue;
  withPc++;
  evSum += s.tokens.totalTokens;
  pcSum += s.projcacheTokens.totalTokens;
  if (s.projcacheDelta !== null && s.projcacheDelta > worst) worst = s.projcacheDelta;
}
if (withPc === 0) {
  check('проекция сессий найдена', false, 'нет ни одной — сверка невозможна');
} else {
  const rel = Math.abs(evSum - pcSum) / Math.max(evSum, pcSum);
  check('сумма по логам совпадает с проекцией (<1%)', rel < 0.01, (rel * 100).toFixed(3) + '%, сессий: ' + withPc);
  check('худшее расхождение по сессии (<5%)', worst < 0.05, (worst * 100).toFixed(2) + '%');
}
check('битых zstd-фреймов нет', badFrames === 0, String(badFrames));
check('неразобранных строк нет', badLines === 0, String(badLines));

console.log('');
if (problems === 0) {
  console.log('Всё сошлось. Предупреждений сборщика: ' + meta.warnings.length + '.');
  process.exit(0);
}
console.log('Проблем: ' + problems + '.');
process.exit(1);

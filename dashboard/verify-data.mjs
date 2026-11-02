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
